// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-PUB-API · SDK:RULE-PUB-DUPLEX-SWITCH · SDK:RULE-PUB-DENIED · SDK:RULE-PUB-FMTP · SDK:RULE-SRC-PROFILE · SDK:RULE-SRC-DEVICES · SDK:IMPL-SRC-BLOCKS · SDK:RULE-MOD-TEARDOWN · SDK:IMPL-DIAG-PROBE · SDK:IMPL-MOD-TABLE domain/media-registry · model: claude-opus-5-5
import * as PUB from './gen/publish_client.js'
import * as PBn from './gen/pub_binding.js'
import type { Publication, ProbeResult, PublishTrack } from '../internal/wire/ws.js'
import type { SendSlot, Encoding } from '../internal/transport.js'
import * as Probe from '../internal/probe.js'
import { Emitter } from '../platform/emitter.js'
import { Fault, fromFailure, stateFault, closedFault, negotiationFault } from '../platform/fault.js'
import { capture, enumerate, permission, deviceChanges, describe, canSetSink, documentTarget, type DeviceKind, type PermState } from '../platform/env.js'
import { Timer, sleep } from '../platform/clock.js'
import type { Core } from './session.js'
import type { RoomCore } from './rooms.js'
import type { Layer } from './defaults.js'

export type Owner = 'app' | 'sdk' | 'external'
export type LocalState = 'idle' | 'acquired' | 'staged' | 'registered' | 'sending'
export type Source = 'microphone' | 'camera' | 'screen' | 'external'
export type Profile = 'ptt' | 'conference'
export type EndReason = 'stopped' | 'revoked' | 'device_lost'

export interface AudioCapture {
  readonly deviceId?: string
  readonly autoGainControl?: boolean
  readonly echoCancellation?: boolean
  readonly noiseSuppression?: boolean
  readonly voiceIsolation?: boolean
  readonly channelCount?: number
  readonly sampleRate?: number
  readonly latency?: number
}

export interface AudioEncoding {
  readonly preset?: 'telephone' | 'speech' | 'music'
  readonly dtx?: boolean
  readonly fec?: boolean
  readonly stereo?: boolean
  readonly maxBitrate?: number
}

export interface VideoEncoding {
  readonly maxBitrate?: number
  readonly maxFramerate?: number
  readonly scaleResolutionDownBy?: number
  readonly degradationPreference?: RTCDegradationPreference
  readonly contentHint?: string
  readonly layers?: readonly Layer[]
}

export interface TrackOptions {
  readonly deviceId?: string
  readonly profile?: Profile
  readonly capture?: AudioCapture & { readonly width?: number; readonly height?: number; readonly frameRate?: number }
  readonly encoding?: AudioEncoding & VideoEncoding
  readonly simulcast?: boolean
  readonly timeoutMs?: number
  readonly width?: number
  readonly height?: number
  readonly frameRate?: number
}

export interface LocalEvents extends Record<string, unknown[]> {
  ended: [{ reason: EndReason }]
  silence: []
  published: []
  publishFailed: [Fault]
  state: [LocalState]
}

const PRESET: Record<'telephone' | 'speech' | 'music', number> = { telephone: 12000, speech: 24000, music: 48000 }
const H264_FMTP = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'

/** 로컬 트랙 하나 — 발행 상태기 하나(트랙마다) · Source(장치 트랙 · owner) · Encoder(sender · source · gate) · 변경 락 */
export class LocalCore {
  st: PUB.St = PUB.initial()
  readonly events = new Emitter<LocalEvents>()
  readonly kind: 'audio' | 'video'
  source: Source
  owner: Owner
  duplex: 'full' | 'half'
  track: MediaStreamTrack
  private deviceTrack: MediaStreamTrack | null = null
  sfuId: string | null = null
  roomId: string | null = null
  slot: SendSlot | null = null
  trackId: string | null = null
  muted = false
  simulcast: boolean
  ended = false
  cold = false
  opts: TrackOptions
  private gate = false
  private chain: Promise<unknown> = Promise.resolve()
  private waiter: { resolve: () => void; reject: (f: Fault) => void } | null = null
  private retried3008 = false
  private silenceChecked = false
  private lastFault: Fault | null = null
  private coldTimer: Timer

  constructor(readonly core: Core, kind: 'audio' | 'video', source: Source, track: MediaStreamTrack, owner: Owner, opts: TrackOptions) {
    this.kind = kind
    this.source = source
    this.track = track
    this.owner = owner
    this.opts = opts
    this.duplex = 'full'
    this.simulcast = kind === 'video' && source === 'camera' && opts.simulcast === true
    this.coldTimer = new Timer(core.cfg.wakeDetectMs)
    this.watchTrack(track)
  }

  get server(): string | null { return this.st.ps === 'IDLE' && !this.slot ? null : this.sfuId }

  get state(): LocalState {
    if (this.ended) return 'idle'
    switch (this.st.ps) {
      case 'IDLE': return 'acquired'
      case 'STAGED': return 'staged'
      case 'REGISTERED': return 'registered'
      case 'SENDING': return 'sending'
    }
  }

  get mediaStreamTrack(): MediaStreamTrack { return this.track }

  get profile(): Profile { return this.opts.profile ?? (this.duplex === 'half' ? 'ptt' : 'conference') }

  /** 변경 락 — 겹치면 줄 선다(SDK:RULE-API-ASYNC 트랙 변경 락) */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  private watchTrack(t: MediaStreamTrack): void {
    t.addEventListener('ended', () => { if (t === this.track && this.owner === 'sdk' && !this.ended && !this.cold) void this.core.media.deviceLost(this) })
  }

  // ── 발행 상태기 ──────────────────────────────────────────────────────

  pubStep(entry: string, step: PUB.Step | null, cause: string): void {
    if (!step) { this.core.impossible('PUB', this.key, this.st.ps, entry); return }
    const prev = this.st
    const plan = PBn.plan(step)
    this.st = plan.state
    this.core.record('PUB', this.key, prev.ps, this.st.ps, plan.label, cause)
    if (plan.label === 'PUB.C.IDLE.on' || plan.label === 'PUB.C.any.reregister') this.acquireSlot()
    for (const tx of plan.send) this.pubSend(tx)
    for (const a of plan.actions) {
      if (a === 'transceiver.inactive' && this.slot) { this.core.linkFor(this.sfuId)?.peer?.deactivate(this.slot); this.slot = null; this.core.linkFor(this.sfuId)?.renego() }
    }
    for (const sm of plan.seams) {
      const link = this.core.linkFor(this.sfuId)
      if (sm.fx === 'sdp.rebuild') link?.renego()
      else if (sm.fx === 'floor.reg_half') for (const r of this.core.roomsOn(this.sfuId)) r.floor.registerHalf()
      else if (sm.fx === 'link.pub_lost') link?.pubLost()
    }
    this.gateFollow()
    for (const f of step.fx) {
      const e = PBn.effect(f).event
      if (e === 'published') { this.events.emit('published'); this.settle(null) }
      else if (e === 'publishFailed') {
        const fault = this.lastFault ?? negotiationFault('PUBLISH')
        this.lastFault = null
        this.releaseSlot()
        this.events.emit('publishFailed', fault)
        this.settle(fault)
      } else if (e === 'ended') { this.releaseSlot(); this.finish('revoked', false) }
    }
    if (plan.label === 'PUB.C.REGISTERED.attach_ok_half') this.settle(null)
    if (prev.ps !== this.st.ps) this.events.emit('state', this.state)
    if (this.st.ps === 'REGISTERED' && prev.ps === 'STAGED' && plan.label.startsWith('PUB.C.STAGED.pub_ok')) void this.attach()
  }

  get key(): string { return this.trackId ?? `${this.kind}:${this.source}` }

  private settle(f: Fault | null): void {
    const w = this.waiter
    this.waiter = null
    if (!w) return
    if (f) w.reject(f); else w.resolve()
  }

  /** 트랜시버 확보 — 같은 kind 의 쉬는 자리를 먼저 되쓴다 */
  acquireSlot(): void {
    const link = this.core.linkFor(this.sfuId)
    const peer = link?.peer
    if (!peer || this.slot) return
    const room = this.core.rooms.get(this.roomId ?? '')
    const codec = this.kind === 'audio' ? room?.store.mediaCodecs.audio ?? 'opus' : room?.store.mediaCodecs.video ?? 'H264'
    const encs: Encoding[] = this.simulcast ? this.layers().map((l) => ({ ...l })) : []
    const roomCodec = codec.toLowerCase() === 'h264' ? { name: codec, fmtp: H264_FMTP } : { name: codec }
    this.slot = peer.acquireSlot(this.kind, this.simulcast, encs, roomCodec, this.opusLine())
  }

  wantsSlot(): boolean { return this.st.ps === 'STAGED' && this.slot === null }

  private layers(): readonly Layer[] {
    const ls = this.opts.encoding?.layers ?? this.core.cfg.simulcastLayers
    return ls
  }

  /** opus answer fmtp — 방 고정값 하나 · 트랙별 dtx · fec · stereo 는 wire 에 닿지 않는다(로그 — SDK:RULE-SRC-PROFILE 증상) */
  private opusLine(): string {
    const e = this.opts.encoding ?? {}
    if (this.kind === 'audio' && (e.dtx !== undefined || e.fec !== undefined || e.stereo !== undefined)) this.core.log.info('opus dtx/fec/stereo 는 answer 고정값(minptime=10;useinbandfec=1)이 정한다 — 무시한다', { track: this.key })
    return this.core.opusLine
  }

  private releaseSlot(): void {
    if (this.slot) this.core.linkFor(this.sfuId)?.peer?.releaseSlot(this.slot)
    this.slot = null
  }

  peerClosed(): void { this.slot = null; this.gate = false }

  private pubSend(tx: PUB.Tx): void {
    const room = this.roomId ?? ''
    if (tx.action === 'add') {
      const link = this.core.linkFor(this.sfuId)
      const info = this.slot && link?.peer ? link.peer.sendInfo(this.slot) : null
      if (!info) {
        this.lastFault = negotiationFault('NO_SDP')
        this.pubStep('pubRes', PUB.pubRes(this.st, { action: 'add', code: 1003, part: 'fail' }), 'PUBLISH_TRACKS.local')
        return
      }
      const t: Record<string, unknown> = { ...info.track, duplex: this.duplex, simulcast: this.simulcast }
      if (this.kind === 'video') t['source'] = this.source === 'screen' ? 'screen' : 'camera'
      const body = { action: 'add', room_id: room, tracks: [t as unknown as PublishTrack], ...info.ext }
      this.core.sig.request('PUBLISH_TRACKS', body).then((r) => this.pubReply(r.ok, r.body, 'add'), () => undefined)
    } else {
      if (!this.trackId) return
      this.core.sig.request('PUBLISH_TRACKS', { action: 'remove', room_id: room, track_ids: [this.trackId] }).then((r) => this.pubReply(r.ok, r.body, 'remove'), () => undefined)
    }
  }

  private pubReply(ok: boolean, body: unknown, action: 'add' | 'remove'): void {
    if (ok && action === 'add') {
      const b = body as { tracks?: { mid: string; track_id: string }[] }
      const mine = b.tracks?.find((x) => x.mid === this.slot?.mid) ?? b.tracks?.[0]
      if (mine) this.trackId = mine.track_id
    }
    let code = 0
    if (!ok) {
      const f = fromFailure(body)
      code = f.code
      this.lastFault = f
      if (f.code === 2006) {
        const denied = (f.details ?? {})['denied']
        const room = this.core.rooms.get(this.roomId ?? '')
        if (room && Array.isArray(denied)) {
          const p = { ...room.store.permission }
          if (denied.includes('publish_audio')) p.publishAudio = false
          if (denied.includes('publish_video')) p.publishVideo = false
          if (denied.includes('publish_screen')) p.publishScreen = false
          room.store.permission = p
          room.events.emit('permission', { userId: this.core.userId ?? '', permission: p, mine: true })
        }
      }
      if (f.code === 3008 && !this.retried3008 && this.slot) {
        this.retried3008 = true
        const link = this.core.linkFor(this.sfuId)
        link?.peer?.deactivate(this.slot)
        this.slot = null
        this.st = { ...this.st, ps: 'IDLE', nego: false }
        this.core.record('PUB', this.key, 'STAGED', 'IDLE', 'SDK.ssrc_collision_retry', 'PUBLISH_TRACKS.3008')
        this.pubStep('on', PUB.on(this.st), '3008')
        return
      }
    }
    this.pubStep('pubRes', PUB.pubRes(this.st, { action, code, part: ok ? 'res' : 'fail' }), ok ? `PUBLISH_TRACKS.${action}` : `PUBLISH_TRACKS.${code}`)
  }

  /** RTP 시작 — Encoder 가 sender 에 트랙을 얹은 결과(연:PUB.C.REGISTERED) */
  private async attach(): Promise<void> {
    const sender = this.slot?.transceiver?.sender
    if (!sender) { this.pubStep('attach', PUB.attach(this.st, false), 'encoder'); return }
    try {
      await this.applyEncoding(sender)
      if (!this.st.half) { await sender.replaceTrack(this.track); this.gate = true }
      this.pubStep('attach', PUB.attach(this.st, true), 'encoder')
      if (!this.st.half) this.checkSilence()
    } catch (e) {
      this.lastFault = negotiationFault('ATTACH', e)
      this.pubStep('attach', PUB.attach(this.st, false), 'encoder')
    }
  }

  /** 값만 — 비트레이트 상한 · 프레임 · 레이어 active(setParameters · SDP 밖) · 서버 max_bitrate_bps 가 덮는다 */
  private async applyEncoding(sender: RTCRtpSender): Promise<void> {
    const p = sender.getParameters()
    if (!p.encodings || !p.encodings.length) return
    const sc = this.core.linkFor(this.sfuId)?.sc
    const cap = sc?.max_bitrate_bps
    const e = this.opts.encoding ?? {}
    if (this.kind === 'audio') {
      const preset = e.preset ?? (this.profile === 'ptt' ? 'speech' : 'music')
      p.encodings[0]!.maxBitrate = e.maxBitrate ?? PRESET[preset]
    } else if (this.simulcast) {
      const ls = this.layers()
      for (const enc of p.encodings) {
        const l = ls.find((x) => x.rid === enc.rid)
        if (!l) continue
        if (l.maxBitrate !== undefined) enc.maxBitrate = l.maxBitrate
        if (l.maxFramerate !== undefined) enc.maxFramerate = l.maxFramerate
        if (l.scaleResolutionDownBy !== undefined) enc.scaleResolutionDownBy = l.scaleResolutionDownBy
      }
    } else if (this.source === 'screen') {
      const s = this.core.cfg.screenShare
      p.encodings[0]!.maxBitrate = e.maxBitrate ?? s.maxBitrate ?? 1500000
      const fr = e.maxFramerate ?? s.maxFramerate
      if (fr !== undefined) p.encodings[0]!.maxFramerate = fr
      const dp = e.degradationPreference ?? s.degradationPreference
      if (dp) (p as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference = dp
    } else {
      if (e.maxBitrate !== undefined) p.encodings[0]!.maxBitrate = e.maxBitrate
      if (e.maxFramerate !== undefined) p.encodings[0]!.maxFramerate = e.maxFramerate
    }
    if (cap) for (const enc of p.encodings) if (enc.maxBitrate === undefined || enc.maxBitrate > cap) enc.maxBitrate = cap
    try { await sender.setParameters(p) } catch (err) { this.core.log.warn('setParameters 실패', { err: String(err) }) }
  }

  /** 게이트 — 발행 상태가 SENDING 일 때만 sender 에 source 를 얹는다(SDK:IMPL-SRC-BLOCKS 셋째 축) */
  private gateFollow(): void {
    const want = this.st.ps === 'SENDING'
    if (want === this.gate) return
    const sender = this.slot?.transceiver?.sender
    this.gate = want
    if (!sender) return
    if (want && this.cold) {
      void this.warm().then(() => { if (this.gate) void sender.replaceTrack(this.track) })
      return
    }
    void sender.replaceTrack(want ? this.track : null).catch((e) => this.core.log.warn('replaceTrack 실패', { err: String(e) }))
    if (want && this.st.half) {
      for (const r of this.core.roomsOn(this.sfuId)) if (r.floor.st.cs === 'PERM') r.floor.rtpTx()
      this.checkSilence()
    }
  }

  get gateOpen(): boolean { return this.gate }

  // ── 이음매가 부르는 입구 ─────────────────────────────────────────────

  nego(ok: boolean): void { if (this.st.ps === 'STAGED') this.pubStep('nego', PUB.nego(this.st, ok), ok ? 'nego.ok' : 'nego.fail') }
  revoked(): void { this.pubStep('revoked', PUB.revoked(this.st, {}), 'TRACK_EVENT.remove') }
  floorOpen(): void { this.pubStep('floorOpen', PUB.floorOpen(this.st), 'mic.open'); this.coldTimer.stop() }
  floorClose(): void { this.pubStep('floorClose', PUB.floorClose(this.st), 'mic.close'); this.armCold() }
  dropServer(): void { this.pubStep('dropServer', PUB.dropServer(this.st), 'link'); this.slot = null }
  roomGone(): void { this.pubStep('roomGone', PUB.roomGone(this.st), 'room') }
  resumeCheck(listed: boolean): void { this.pubStep('resumeCheck', PUB.resumeCheck(this.st, listed), 'RESUME') }

  /** 재구축의 다시 발행 — 비트가 막는 것은 다시 발행하지 않는다(SDK:RULE-ROOM-PERMISSION-BITS 자동 발행을 멈춘다) */
  reregister(): void {
    if (this.ended) return
    const room = this.core.rooms.get(this.roomId ?? '')
    if (room && !this.allowed(room)) { this.pubStep('off', PUB.off(this.st), 'permission'); return }
    this.slot = null
    this.pubStep('reregister', PUB.reregister(this.st), 'rebuild')
  }

  allowed(room: RoomCore): boolean {
    const p = room.permission
    if (this.kind === 'audio') return p.publishAudio
    return this.source === 'screen' ? p.publishScreen : p.publishVideo
  }

  /** 발행 — 획득한 트랙을 넘긴다 · resolve 때 owner 가 sdk 로 바뀐다(external 은 그대로) */
  publish(room: RoomCore, duplex: 'full' | 'half'): Promise<void> {
    return this.locked(async () => {
      if (this.ended) throw closedFault('ENDED')
      if (!this.allowed(room)) throw stateFault('STATE_NO_PERMISSION', { denied: [this.kind === 'audio' ? 'publish_audio' : this.source === 'screen' ? 'publish_screen' : 'publish_video'] })
      if (this.st.ps !== 'IDLE') return
      this.duplex = duplex
      this.sfuId = room.sfuId
      this.roomId = room.id
      this.st = { ...this.st, half: duplex === 'half', sfu: this.core.epochs.id(room.sfuId ?? ''), room: this.core.epochs.id(`room:${room.id}`) }
      this.core.media.register(this)
      if (this.kind === 'audio' && this.source !== 'external') this.applyCapture()
      const p = new Promise<void>((resolve, reject) => { this.waiter = { resolve, reject } })
      this.pubStep('on', PUB.on(this.st), 'app')
      await p
      if (this.owner === 'app') this.owner = 'sdk'
      if (duplex === 'half') this.armCold()
    })
  }

  private applyCapture(): void {
    const c = this.opts.capture
    if (c && this.owner !== 'external') void this.track.applyConstraints?.({ ...c } as MediaTrackConstraints).catch(() => undefined)
  }

  /** 끔 — 반이중이 허가 중이면 먼저 놓고 · 게이트 닫기 → remove → sender 에서 뗀다 → Source 정지(SDK:RULE-MOD-TEARDOWN track.stop) */
  stop(reason: EndReason = 'stopped'): Promise<void> {
    return this.locked(async () => {
      if (this.ended) return
      if (this.duplex === 'half') for (const r of this.core.roomsOn(this.sfuId)) if (r.floor.st.cs === 'PERM') await r.floor.release()
      if (this.st.ps !== 'IDLE') this.pubStep('off', PUB.off(this.st), 'app')
      const sender = this.slot?.transceiver?.sender
      if (sender) { try { await sender.replaceTrack(null) } catch { /* 닫혔다 */ } }
      this.gate = false
      this.releaseSlot()
      this.finish(reason, true)
    })
  }

  private finish(reason: EndReason, stopSource: boolean): void {
    if (this.ended) return
    this.ended = true
    this.coldTimer.stop()
    if (stopSource) { this.track.stop(); this.deviceTrack?.stop() }
    this.core.media.unregister(this)
    this.events.emit('state', 'idle')
    this.events.emit('ended', { reason })
    for (const r of this.core.roomsOn(this.sfuId)) r.floor.surface()
  }

  // ── 트랙 설정(연:PUB.op.TRACK_SET) ───────────────────────────────────

  setMuted(m: boolean): Promise<void> {
    return this.locked(async () => {
      if (this.duplex === 'half') throw stateFault('STATE_HALF_DUPLEX_NO_MUTE')
      if (!this.trackId || !this.roomId) { this.muted = m; this.track.enabled = !m; return }
      const r = await this.core.sig.request('TRACK_SET', { room_id: this.roomId, track_id: this.trackId, muted: m })
      if (!r.ok) throw fromFailure(r.body)
      this.muted = m
      this.track.enabled = !m
    })
  }

  /** duplex 전환 — 응답 뒤에만 바꾼다 · 재발행 · 재협상 없음(SDK:RULE-PUB-DUPLEX-SWITCH) */
  setDuplex(d: 'full' | 'half'): Promise<void> {
    return this.locked(async () => {
      if (d === this.duplex) return
      const base = this.core.speakingRoom
      if (!base) throw stateFault('STATE_NO_SPEAKING_ROOM')
      if (!this.trackId) throw stateFault('STATE_NOT_PUBLISHED')
      const r = await this.core.sig.request('TRACK_SET', { room_id: base, track_id: this.trackId, duplex: d })
      if (!r.ok) throw fromFailure(r.body)
      const prev = this.st
      this.duplex = d
      this.muted = false
      this.track.enabled = true
      if (d === 'half') {
        this.st = { ...this.st, half: true, ps: this.st.ps === 'SENDING' ? 'REGISTERED' : this.st.ps }
        this.core.record('PUB', this.key, prev.ps, this.st.ps, 'SDK.duplex_half', 'TRACK_SET.res')
        this.gateFollow()
        for (const rm of this.core.roomsOn(this.sfuId)) rm.floor.registerHalf()
        this.armCold()
      } else {
        this.st = { ...this.st, half: false, ps: this.st.ps === 'REGISTERED' ? 'SENDING' : this.st.ps }
        this.core.record('PUB', this.key, prev.ps, this.st.ps, 'SDK.duplex_full', 'TRACK_SET.res')
        this.coldTimer.stop()
        if (this.cold) await this.warm()
        this.gateFollow()
      }
      const sender = this.slot?.transceiver?.sender
      if (sender) await this.applyEncoding(sender)
      this.events.emit('state', this.state)
      for (const rm of this.core.roomsOn(this.sfuId)) rm.floor.surface()
    })
  }

  setEncoding(e: VideoEncoding & AudioEncoding): Promise<void> {
    return this.locked(async () => {
      this.opts = { ...this.opts, encoding: { ...(this.opts.encoding ?? {}), ...e } }
      const sender = this.slot?.transceiver?.sender
      if (sender) await this.applyEncoding(sender)
    })
  }

  /** 소스 교체 — Encoder.source 갱신 · 게이트가 열려 있을 때만 sender 에 얹는다(SSRC · 발행 · 발언권 보존) */
  replaceSource(t: MediaStreamTrack | null): Promise<void> {
    return this.locked(async () => {
      if (t) {
        if (this.owner === 'sdk' && !this.deviceTrack) this.deviceTrack = this.track
        this.track = t
        this.owner = 'external'
      } else {
        if (!this.deviceTrack) return
        this.track = this.deviceTrack
        this.deviceTrack = null
        this.owner = 'sdk'
      }
      const sender = this.slot?.transceiver?.sender
      if (sender && this.gate) await sender.replaceTrack(this.track)
    })
  }

  /** 장치 전환 — replaceTrack 이라 SSRC 보존 · cold 면 저장 제약만 바꾼다 */
  switchTo(deviceId: string | null): Promise<void> {
    return this.locked(async () => {
      if (this.owner !== 'sdk' || this.ended) return
      this.opts = { ...this.opts, ...(deviceId ? { deviceId } : {}) }
      if (this.cold) return
      const next = await this.acquireAgain(deviceId ?? undefined)
      const old = this.track
      this.track = next
      this.watchTrack(next)
      const sender = this.slot?.transceiver?.sender
      if (sender && this.gate) await sender.replaceTrack(next)
      old.stop()
    })
  }

  private acquireAgain(deviceId?: string): Promise<MediaStreamTrack> {
    const kind: DeviceKind = this.kind
    return capture({ kind, screen: this.source === 'screen', deviceId: deviceId ?? this.opts.deviceId, constraints: this.core.media.constraintsFor(this.kind, this.source, this.profile, this.opts), timeoutMs: this.opts.timeoutMs ?? this.core.cfg.deviceAcquireTimeoutMs })
  }

  // ── 마이크 전원(SDK:RULE-FLR-MIC-POWER) ──────────────────────────────

  private armCold(): void {
    if (this.duplex !== 'half' || this.kind !== 'audio' || this.owner !== 'sdk' || this.ended) return
    this.coldTimer.start(this.core.media.coldAfter, () => this.goCold())
  }

  keepWarm(ms: number): void {
    if (this.duplex !== 'half') return
    this.coldTimer.start(ms > 0 ? ms : this.core.cfg.micColdAfterMs, () => this.goCold())
  }

  private goCold(): void {
    if (this.st.ps === 'SENDING' || this.owner !== 'sdk' || this.ended || this.cold) return
    this.cold = true
    this.track.stop()
    this.core.record('PUB', this.key, this.st.ps, this.st.ps, 'SDK.cold', 'mic_power')
    for (const r of this.core.roomsOn(this.sfuId)) r.floor.surface()
  }

  /** 데우기 — 저장 제약으로 다시 획득 · source 만 보관(게이트가 열려 있을 때만 sender) */
  warm(): Promise<void> {
    if (!this.cold) return Promise.resolve()
    return this.acquireAgain().then((t) => {
      this.track = t
      this.cold = false
      this.watchTrack(t)
      this.core.record('PUB', this.key, this.st.ps, this.st.ps, 'SDK.warm', 'mic_power')
      const sender = this.slot?.transceiver?.sender
      if (sender && this.gate) void sender.replaceTrack(t)
      this.armCold()
    })
  }

  /** 무음 감지 — 그 창 동안 media-source totalAudioEnergy 가 늘지 않았다(SDK:IMPL-PUB-API silence) */
  private checkSilence(): void {
    if (this.kind !== 'audio' || this.silenceChecked || this.owner === 'external') return
    this.silenceChecked = true
    const sender = this.slot?.transceiver?.sender
    if (!sender) return
    void (async () => {
      const a = Probe.audioEnergy(await sender.getStats())
      await sleep(this.core.cfg.silenceWindowMs)
      const b = Probe.audioEnergy(await sender.getStats())
      if (a !== null && b !== null && b <= a && !this.ended) this.events.emit('silence')
    })()
  }

  /** 통보 없이 로컬만 내린다 — 세션 끝 · 백오프 소진 */
  dispose(stopSource: boolean): void {
    this.gate = false
    this.slot = null
    if (stopSource) this.finish('stopped', true)
    else { this.st = PUB.initial(); this.coldTimer.stop(); this.core.media.unregister(this) }
  }

  getStats(): Promise<RTCStatsReport> {
    const s = this.slot?.transceiver?.sender
    return s ? s.getStats() : Promise.resolve(new Map() as unknown as RTCStatsReport)
  }
}

/** 재생 — 방 오디오 요소 · autoplay 정책 · 출력 장치(SDK:IMPL-SRC-BLOCKS Playback) */
export class Playback {
  allowed = true
  sink: string | null = null
  private readonly els = new Set<HTMLAudioElement>()

  constructor(private readonly core: Core) {
    const doc = documentTarget()
    if (doc) doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible' && !this.allowed) void this.start() })
  }

  add(el: HTMLAudioElement): void {
    this.els.add(el)
    if (this.sink && canSetSink()) void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.sink).catch(() => undefined)
  }

  remove(el: HTMLAudioElement): void { this.els.delete(el); try { el.pause() } catch { /* 없다 */ } }

  play(el: HTMLAudioElement): void {
    void el.play().then(() => this.mark(true), (e: unknown) => { if (e && typeof e === 'object' && (e as { name?: string }).name === 'NotAllowedError') this.mark(false) })
  }

  private mark(ok: boolean): void {
    if (ok === this.allowed) return
    this.allowed = ok
    this.core.events.emit('audioPlayback', ok)
  }

  /** 앱이 사용자 제스처 안에서 부른다 */
  async start(): Promise<void> {
    let ok = true
    for (const el of this.els) { try { await el.play() } catch { ok = false } }
    this.mark(ok)
  }

  async output(deviceId: string | null): Promise<void> {
    this.sink = deviceId
    if (!canSetSink()) { this.core.log.warn('setSinkId 가 없다 — audioOutput 은 동작하지 않는다'); return }
    for (const el of this.els) await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId ?? '')
  }
}

/** 로컬 트랙 목록 · 획득 · 장치 정책 · 진단 수집 */
export class MediaRegistry {
  readonly tracks = new Set<LocalCore>()
  readonly playback: Playback
  readonly preferred: Partial<Record<'audioinput' | 'audiooutput' | 'videoinput', string>> = {}
  coldAfter: number
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private prevNet = new Map<string, Probe.NetSample>()
  readonly deviceEvents = new Emitter<{ change: [{ added: MediaDeviceInfo[]; removed: MediaDeviceInfo[]; list: MediaDeviceInfo[] }] }>()
  private lastDevices: MediaDeviceInfo[] = []

  constructor(private readonly core: Core) {
    this.playback = new Playback(core)
    this.coldAfter = core.cfg.micColdAfterMs
    const md = deviceChanges()
    if (md) md.addEventListener('devicechange', () => void this.devicesChanged())
  }

  /** getStats 주기는 세션이 active 인 동안만 돈다 */
  sessionActive(on: boolean): void {
    if (on && this.statsTimer === null && this.core.cfg.statsIntervalMs > 0) this.statsTimer = setInterval(() => void this.stats(), this.core.cfg.statsIntervalMs)
    if (!on && this.statsTimer !== null) { clearInterval(this.statsTimer); this.statsTimer = null }
  }

  register(t: LocalCore): void { this.tracks.add(t) }
  unregister(t: LocalCore): void { this.tracks.delete(t) }

  on(sfuId: string | null): LocalCore[] { return [...this.tracks].filter((t) => t.sfuId !== null && t.sfuId === sfuId) }
  inRoom(roomId: string): LocalCore[] { return [...this.tracks].filter((t) => t.roomId === roomId) }
  byTrackId(id: string): LocalCore | undefined { return [...this.tracks].find((t) => t.trackId === id) }
  ownsTrack(id: string): boolean { return this.byTrackId(id) !== undefined }
  anyPublished(): boolean { return [...this.tracks].some((t) => t.st.ps !== 'IDLE') }

  hasHalfMic(sfuId: string | null): boolean { return this.on(sfuId).some((t) => t.kind === 'audio' && t.duplex === 'half' && t.st.ps !== 'IDLE') }
  halfMic(sfuId: string | null): LocalCore | undefined { return this.on(sfuId).find((t) => t.kind === 'audio' && t.duplex === 'half' && !t.ended) }
  halfMicCold(sfuId: string | null): boolean { return this.halfMic(sfuId)?.cold ?? false }

  /** press 의 첫 단계 — 이 서버에 반이중 마이크가 없으면 발행한다(기준 방 = 그 방) */
  async ensureHalfMic(room: RoomCore, o: TrackOptions = {}): Promise<LocalCore> {
    const have = this.halfMic(room.sfuId)
    if (have && have.st.ps !== 'IDLE') return have
    if (!room.permission.publishAudio) throw stateFault('STATE_NO_PERMISSION', { denied: ['publish_audio'] })
    const t = have ?? (await this.acquireOne('audio', 'microphone', { ...o, profile: o.profile ?? 'ptt' }, 'sdk'))
    try { await t.publish(room, 'half') } catch (e) { if (!have) await t.stop(); throw e }
    return t
  }

  warmHalf(room: RoomCore): Promise<void> { return this.halfMic(room.sfuId)?.warm() ?? Promise.resolve() }

  floorOpen(room: RoomCore): void { for (const t of this.on(room.sfuId)) if (t.duplex === 'half') t.floorOpen() }
  floorClose(room: RoomCore): void { for (const t of this.on(room.sfuId)) if (t.duplex === 'half') t.floorClose() }

  reregisterAll(sfuId: string | null): void {
    for (const t of [...this.tracks]) if (sfuId === null || t.sfuId === sfuId) t.reregister()
  }

  resumeCheck(pubs: readonly Publication[]): void {
    for (const t of [...this.tracks]) t.resumeCheck(t.trackId !== null && pubs.some((p) => p.track_id === t.trackId))
  }

  permissionChanged(_room: RoomCore): void {}

  /** 획득 — kind 마다 getUserMedia · 프로필 제약 */
  constraintsFor(kind: 'audio' | 'video', source: Source, profile: Profile, o: TrackOptions): MediaTrackConstraints {
    if (kind === 'audio') {
      const base: MediaTrackConstraints = profile === 'ptt'
        ? { autoGainControl: true, noiseSuppression: true, echoCancellation: true, channelCount: 1 }
        : { autoGainControl: true, noiseSuppression: true, echoCancellation: true }
      const c = { ...(o.capture ?? {}) } as Record<string, unknown>
      delete c['deviceId']
      return { ...base, ...(c as MediaTrackConstraints) }
    }
    if (source === 'screen') return { frameRate: o.frameRate ?? this.core.cfg.screenShare.maxFramerate ?? 15 }
    const cam = this.core.cfg.cameraCapture
    const c: MediaTrackConstraints = {}
    const w = o.width ?? o.capture?.width ?? cam.width
    const h = o.height ?? o.capture?.height ?? cam.height
    const f = o.frameRate ?? o.capture?.frameRate ?? cam.frameRate
    if (w) c.width = { ideal: w }
    if (h) c.height = { ideal: h }
    if (f) c.frameRate = { ideal: f }
    return c
  }

  async acquireOne(kind: 'audio' | 'video', source: Source, o: TrackOptions, owner: Owner): Promise<LocalCore> {
    const profile = o.profile ?? 'conference'
    const deviceId = o.deviceId ?? o.capture?.deviceId ?? (kind === 'audio' ? this.preferred.audioinput : this.preferred.videoinput)
    const track = await capture({ kind, screen: source === 'screen', deviceId, constraints: this.constraintsFor(kind, source, profile, o), timeoutMs: o.timeoutMs ?? this.core.cfg.deviceAcquireTimeoutMs })
    if (source === 'screen') {
      const hint = o.encoding?.contentHint ?? this.core.cfg.screenShare.contentHint
      if (hint) track.contentHint = hint
    }
    return new LocalCore(this.core, kind, source, track, owner, deviceId ? { ...o, deviceId } : o)
  }

  /** 전부 아니면 전무 — 하나가 실패하면 획득한 것은 정지하고 그 kind 로 reject */
  async acquire(req: { microphone?: TrackOptions | boolean; camera?: TrackOptions | boolean; screen?: TrackOptions | boolean }): Promise<LocalCore[]> {
    const out: LocalCore[] = []
    const items: ['audio' | 'video', Source, TrackOptions | boolean | undefined][] = [['audio', 'microphone', req.microphone], ['video', 'camera', req.camera], ['video', 'screen', req.screen]]
    try {
      for (const [k, s, o] of items) {
        if (!o) continue
        out.push(await this.acquireOne(k, s, typeof o === 'object' ? o : {}, 'app'))
      }
    } catch (e) {
      for (const t of out) t.track.stop()
      throw e
    }
    return out
  }

  /** 장치 상실 — 대체가 있으면 정책이 살리고 · 없으면 ended{device_lost}(SDK:RULE-SRC-DEVICES device_lost 뒤) */
  async deviceLost(t: LocalCore): Promise<void> {
    const list = await enumerate()
    const kind = t.kind === 'audio' ? 'audioinput' : 'videoinput'
    if (t.source !== 'screen' && list.some((d) => d.kind === kind)) {
      try { await t.switchTo(null); return } catch { /* 대체 실패 — 아래 */ }
    }
    await t.stop('device_lost')
  }

  private async devicesChanged(): Promise<void> {
    const list = await enumerate()
    const key = (d: MediaDeviceInfo): string => `${d.kind}:${d.deviceId}`
    const before = new Set(this.lastDevices.map(key))
    const after = new Set(list.map(key))
    const added = list.filter((d) => !before.has(key(d)))
    const removed = this.lastDevices.filter((d) => !after.has(key(d)))
    this.lastDevices = list
    for (const t of [...this.tracks]) {
      if (t.owner !== 'sdk' || t.source === 'screen' || t.ended) continue
      const kind = t.kind === 'audio' ? 'audioinput' : 'videoinput'
      const pref = this.preferred[kind]
      const settings = t.track.getSettings?.() ?? {}
      const gone = settings.deviceId !== undefined && !list.some((d) => d.kind === kind && d.deviceId === settings.deviceId)
      if (gone || (!pref && added.some((d) => d.kind === kind))) {
        if (!list.some((d) => d.kind === kind)) { await t.stop('device_lost'); continue }
        const target = pref && list.some((d) => d.deviceId === pref) ? pref : null
        try { await t.switchTo(target) } catch { /* 다음 사건에 다시 */ }
      }
    }
    this.deviceEvents.emit('change', { added, removed, list })
  }

  async devices(kind?: MediaDeviceKind, requestPermissions = false): Promise<MediaDeviceInfo[]> {
    if (requestPermissions) {
      try {
        const t = await capture({ kind: kind === 'videoinput' ? 'video' : 'audio', timeoutMs: this.core.cfg.deviceAcquireTimeoutMs })
        t.stop()
      } catch { /* 권한이 없다 — 목록은 그대로 */ }
    }
    const list = await enumerate()
    this.lastDevices = list
    return kind ? list.filter((d) => d.kind === kind) : list
  }

  async permissions(): Promise<{ microphone: PermState; camera: PermState }> {
    return { microphone: await permission('microphone'), camera: await permission('camera') }
  }

  /** probe — TASK{request} 를 ACK 한 뒤 조립해 report 로 보낸다 · 모르는 값은 null 로 채우지 않는다 */
  async probeTask(reqId: number): Promise<void> {
    const result = await this.probe()
    this.core.events.emit('probe', result)
    this.core.sig.request('TASK', { phase: 'report', req_id: reqId, type: 'probe', result }).catch(() => undefined)
  }

  async probe(): Promise<ProbeResult> {
    const r: { -readonly [K in keyof ProbeResult]: ProbeResult[K] } = {}
    try {
      const reports: RTCStatsReport[] = []
      for (const l of this.core.links.values()) if (l.peer) reports.push(...(await l.peer.stats()))
      const pub = Probe.outbound(reports)
      const sub = Probe.inbound(reports)
      if (pub.length) r.pub_tracks = pub
      if (sub.length) r.sub_tracks = sub
      r.env = describe()
      r.devices = (await enumerate()).map((d) => ({ kind: d.kind, label: d.label, groupId: d.groupId }))
      r.permissions = await this.permissions()
      r.state = {
        session: this.core.sessionState,
        rooms: [...this.core.rooms.values()].map((x) => ({ room_id: x.id, state: x.state, floor: x.floor.phase, link: x.link?.state ?? null })),
        links: [...this.core.links.values()].map((l) => l.info()),
        pub_room: this.core.speakingRoom,
      }
      if (reports.length) r.network = Probe.network(reports)
    } catch (e) {
      r.error = String(e)
    }
    return r
  }

  /** getStats 주기 — diagnostics.stats · session.quality(여러 서버면 최악값) */
  private async stats(): Promise<void> {
    if (this.core.ses.cs !== 'ACTIVE') return
    let q: Probe.Quality = 'excellent'
    const out: Record<string, unknown> = {}
    for (const l of this.core.links.values()) {
      if (!l.peer) continue
      const reports = await l.peer.stats()
      const cur = Probe.network(reports)
      q = Probe.worst(q, Probe.grade(this.prevNet.get(l.server) ?? null, cur, l.state === 'up' || l.state === 'connecting', this.core.cfg.quality))
      this.prevNet.set(l.server, cur)
      out[l.server] = { pub: Probe.outbound(reports), sub: Probe.inbound(reports), network: cur }
    }
    this.core.events.emit('stats', out)
    if (q !== this.core.quality) { this.core.quality = q; this.core.surface() }
  }

  /** client.close() — 통보는 LEAVE 하나(이미 나갔다) · 로컬만 내린다 · 앱 소유 획득 트랙은 남긴다(SDK:RULE-MOD-TEARDOWN) */
  closeForApp(): void {
    if (this.statsTimer !== null) { clearInterval(this.statsTimer); this.statsTimer = null }
    for (const t of [...this.tracks]) t.dispose(t.owner !== 'app')
  }
}

