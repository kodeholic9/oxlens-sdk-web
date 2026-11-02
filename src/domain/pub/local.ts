// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-PUB-API · SDK:RULE-PUB-DUPLEX-SWITCH · SDK:RULE-PUB-DENIED · SDK:RULE-PUB-FMTP · SDK:RULE-SRC-PROFILE · SDK:IMPL-SRC-BLOCKS Source · Encoder · SDK:RULE-FLR-MIC-POWER · SDK:RULE-MOD-TEARDOWN · SDK:RULE-MOD-AREA-MIRROR domain/pub · model: claude-opus-5-5
import * as PUB from '../gen/publish_client.js'
import * as PBn from '../gen/pub_binding.js'
import type { PublishTrack } from '../../internal/wire/ws.js'
import type { SendSlot, Encoding } from '../../internal/link/transport.js'
import * as Probe from '../../internal/probe.js'
import { Emitter } from '../../platform/emitter.js'
import { Fault, fromFailure, stateFault, closedFault, negotiationFault } from '../../platform/fault.js'
import { capture } from '../../platform/env.js'
import { Timer, sleep } from '../../platform/clock.js'
import type { Layer } from '../defaults.js'
import type { LinkCore } from '../link/core.js'
import type { PubRoom } from '../aff/core.js'
import type { MediaRegistry } from './registry.js'

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

/** LocalTrack 이벤트 — state · owner 는 이벤트 없이 속성으로 읽는다(SDK:IMPL-API-EVENT-MAP LocalTrack.state) */
export interface LocalEvents extends Record<string, unknown[]> {
  ended: [{ reason: EndReason }]
  silence: []
  published: []
  publishFailed: [Fault]
}

/** 입구 표의 입구 — 위 결합(pub_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof PBn.ENTRY
type Args<K extends Entry> = (typeof PBn.ENTRY)[K] extends (s: PUB.St, ...a: infer A) => unknown ? A : never

const PRESET: Record<'telephone' | 'speech' | 'music', number> = { telephone: 12000, speech: 24000, music: 48000 }
const H264_FMTP = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'

/** 권한 비트 사상(연:RULE-ROOM-PERMISSION-MAP) — kind 가 아니라 source 로 가른다(카메라 · 화면은 둘 다 video) */
export function bitOf(kind: 'audio' | 'video', source: Source): 'publish_audio' | 'publish_video' | 'publish_screen' {
  return kind === 'audio' ? 'publish_audio' : source === 'screen' ? 'publish_screen' : 'publish_video'
}
function bitIn(r: PubRoom, kind: 'audio' | 'video', source: Source): boolean {
  const b = bitOf(kind, source)
  return b === 'publish_audio' ? r.bits.publishAudio : b === 'publish_screen' ? r.bits.publishScreen : r.bits.publishVideo
}

/**
 * 로컬 트랙 하나 — 위가 지은 발행 클라 상태기 하나(트랙마다) · Source(장치 트랙 · owner · 전원) · Encoder(sender · 게이트 · 인코딩) · 변경 락.
 * 절차는 위가 정한다 — 여기는 입구 표(어느 SDK 사건 · 어느 이음매가 어느 입구를) · 효과 표(위 효과를 무엇으로) · 이음매 집행 · wire 에 안 보이는 것(획득 · 소유권 · 처리기 · 장치)만.
 * 발행은 세션 · 방 · 트랙 영역을 부르지 않는다(may_use = AFF · FLR · LINK) — 요청 · 트랜시버는 그 서버의 연결(LINK)이, 방 사실 · 발언권은 소속(AFF)이, 기록은 원장(DIAG)이 내준다.
 */
export class LocalCore {
  st: PUB.St = PUB.initial()
  readonly events = new Emitter<LocalEvents>()
  readonly kind: 'audio' | 'video'
  source: Source
  owner: Owner
  duplex: 'full' | 'half' = 'full'
  track: MediaStreamTrack
  sfuId: string | null = null
  roomId: string | null = null
  slot: SendSlot | null = null
  trackId: string | null = null
  muted = false
  simulcast: boolean
  ended = false
  cold = false
  opts: TrackOptions
  /** 외부 소스가 걸린 동안 보관하는 자기 장치 트랙(replaceSource — cold 미적용) */
  private deviceTrack: MediaStreamTrack | null = null
  /** Encoder 게이트 — 열렸을 때만 sender 에 source 를 얹는다(SDK:IMPL-SRC-BLOCKS 셋째 축) */
  private gate = false
  private chain: Promise<unknown> = Promise.resolve()
  private waiter: { resolve: () => void; reject: (f: Fault) => void } | null = null
  private retried3008 = false
  /** 다음 트랜시버 확보는 새 트랜시버로(3008 재시도 한 번) */
  private freshSlot = false
  private silenceChecked = false
  /** 지금 넣는 사건이 실어 온 실패 — 위가 app.publish_failed 를 내면 이것으로 알린다 */
  private lastFault: Fault | null = null
  private readonly coldTimer: Timer

  constructor(readonly media: MediaRegistry, kind: 'audio' | 'video', source: Source, track: MediaStreamTrack, owner: Owner, opts: TrackOptions) {
    this.kind = kind
    this.source = source
    this.track = track
    this.owner = owner
    this.opts = opts
    this.simulcast = kind === 'video' && source === 'camera' && opts.simulcast === true
    this.coldTimer = new Timer(media.cfg.wakeDetectMs)
    this.watchTrack(track)
  }

  get key(): string { return this.trackId ?? `${this.kind}:${this.source}` }

  /** 발행된 서버 — 한 시점에 한 서버 · 발행 단을 다 내렸으면 null */
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

  get gateOpen(): boolean { return this.gate }

  /** 그 서버의 연결 — 요청 · 트랜시버 · 협상 */
  private get link(): LinkCore | undefined { return this.sfuId === null ? undefined : this.media.links.get(this.sfuId) }

  private get sender(): RTCRtpSender | null { return this.slot?.transceiver?.sender ?? null }

  /** 변경 락 — 겹치면 줄 선다(SDK:RULE-API-ASYNC 트랙 변경 락) */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** 지금 이 트랙의 비트가 발행을 허락하나 — 들어가 있지 않은 방이면 막지 않는다(2006 을 칠 서버가 없다) */
  allowedNow(): boolean {
    const r = this.roomId === null ? null : this.media.aff.pubRoom(this.roomId)
    return r === null || bitIn(r, this.kind, this.source)
  }

  private watchTrack(t: MediaStreamTrack): void {
    t.addEventListener('ended', () => { if (t === this.track && this.owner === 'sdk' && !this.ended && !this.cold) void this.media.deviceLost(this) })
  }

  // ── 입구 표 — 위 결합 ENTRY 를 지나 한 걸음 ─────────────────────────────

  /** 입구 하나 — 위가 안 받으면(null) 받지 않는 사건으로 적는다 · 받았는지를 돌려준다 */
  private enter<K extends Entry>(name: K, cause: string, args: Args<K>, fault: Fault | null = null): boolean {
    const f = PBn.ENTRY[name] as unknown as (s: PUB.St, ...a: Args<K>) => PUB.Step | null
    const step = f(this.st, ...args)
    if (!step) { this.media.book.impossible('PUB', this.key, this.st.ps, name); return false }
    this.lastFault = fault
    this.step(step, cause)
    this.lastFault = null
    return true
  }

  /** 한 걸음의 집행 — plan() 의 목록대로: 트랜시버 확보 → 동작(게이트 · inactive) → 이음매 → 이벤트 → 보낼 것(해체 순서 — 게이트 닫기가 remove 앞 · 보낼 것이 부르는 다음 걸음은 이 걸음 뒤) */
  private step(step: PUB.Step, cause: string): void {
    const prev = this.st
    const plan = PBn.plan(step)
    this.st = plan.state
    this.media.book.record('PUB', this.key, prev.ps, this.st.ps, plan.label, cause)
    // 위가 발행 협상을 세웠다(켬 · 다시 발행) — 협상 전에 트랜시버를 확보해 둔다(SDK:IMPL-SRC-BLOCKS 조립 형 staged)
    if (this.st.ps === 'STAGED' && this.st.nego && !prev.nego) this.acquireSlot()
    for (const a of plan.actions) this.action(a)
    for (const sm of plan.seams) this.seam(sm.fx)
    for (const e of plan.events) this.emit(e)
    // 발행 등록이 섰다 — Encoder 가 sender 에 트랙을 얹는다(입구 attach 의 사실)
    if (prev.ps === 'STAGED' && plan.state.ps === 'REGISTERED' && this.st === plan.state) void this.attach()
    for (const tx of plan.send) this.send(tx)
  }

  // ── 효과 표 — 동작 · 이벤트는 결합(effect)이 정한다 · 덧붙임만 여기 ─────

  private action(a: PBn.PubAction): void {
    switch (a) {
      case 'gate.open': this.openGate(); return
      case 'gate.close': this.closeGate(); return
      case 'transceiver.inactive': {
        const link = this.link
        if (this.slot) { link?.peer?.deactivate(this.slot); this.slot = null; link?.renego() }
        return
      }
      default: {
        const missing: never = a
        throw new Error(`효과 표에 없는 동작: ${String(missing)}`)
      }
    }
  }

  private emit(e: PBn.PubEvent): void {
    switch (e) {
      case 'published': this.events.emit('published'); this.settle(null); return
      case 'publishFailed': {
        let f = this.lastFault ?? negotiationFault('PUBLISH')
        // 1pc SSRC 충돌 — 그 트랜시버를 inactive 로 두고 새 트랜시버로 한 번 다시 켠다 · 두 번째면 negotiation 으로 앱에(SDK §8 LocalTrack.state)
        if (f.code === 3008 && !this.retried3008 && this.slot) {
          this.retried3008 = true
          this.freshSlot = true
          this.link?.peer?.deactivate(this.slot)
          this.slot = null
          this.enter('on', 'PUBLISH_TRACKS.3008', [])
          return
        }
        if (f.code === 3008) f = negotiationFault('SSRC_COLLISION', f)
        this.releaseSlot()
        this.events.emit('publishFailed', f)
        this.settle(f)
        return
      }
      case 'ended': this.finish('revoked', false); return
      default: {
        const missing: never = e
        throw new Error(`효과 표에 없는 이벤트: ${String(missing)}`)
      }
    }
  }

  /** 이음매 — 받는 곳은 위가 정했다(SEAMS · sameServer) */
  private seam(fx: PUB.SeamFx): void {
    switch (fx) {
      case 'sdp.rebuild': this.link?.renego(); return
      case 'link.pub_lost': this.link?.pubLost(); return
      case 'floor.reg_half': for (const f of this.media.aff.floorsOn(this.sfuId)) f.registerHalf(); return
      default: {
        const missing: never = fx
        throw new Error(`이음매 표에 없는 위 이음매: ${String(missing)}`)
      }
    }
  }

  private settle(f: Fault | null): void {
    const w = this.waiter
    this.waiter = null
    if (!w) return
    if (f) w.reject(f); else w.resolve()
  }

  // ── 보낼 것 · 받은 응답 ───────────────────────────────────────────────

  private send(tx: PUB.Tx): void {
    const link = this.link
    const room = this.roomId ?? ''
    if (tx.action === 'add') {
      const info = this.slot && link?.peer ? link.peer.sendInfo(this.slot) : null
      if (!link || !info) {
        this.enter('pubRes', 'PUBLISH_TRACKS.local', [{ action: 'add', code: 1003, part: 'fail' }], negotiationFault('NO_SDP'))
        return
      }
      const t: Record<string, unknown> = { ...info.track, duplex: this.duplex, simulcast: this.simulcast }
      if (this.kind === 'video') t['source'] = this.source === 'screen' ? 'screen' : 'camera'
      const body = { action: 'add', room_id: room, tracks: [t as unknown as PublishTrack], ...info.ext }
      link.request('PUBLISH_TRACKS', body).then((r) => this.reply(r.ok, r.body, 'add'), () => undefined)
    } else {
      if (!this.trackId || !link) return
      link.request('PUBLISH_TRACKS', { action: 'remove', room_id: room, track_ids: [this.trackId] }).then((r) => this.reply(r.ok, r.body, 'remove'), () => undefined)
    }
  }

  /** 발행 응답 — 입구 pubRes · 2006 이면 막힌 비트로 방 권한을 맞춘다(재시도 없음 — SDK:RULE-PUB-DENIED) */
  private reply(ok: boolean, body: unknown, action: 'add' | 'remove'): void {
    if (ok && action === 'add') {
      const b = body as { tracks?: { mid: string; track_id: string }[] }
      const mine = b.tracks?.find((x) => x.mid === this.slot?.mid) ?? b.tracks?.[0]
      if (mine) this.trackId = mine.track_id
    }
    if (ok) { this.enter('pubRes', `PUBLISH_TRACKS.${action}`, [{ action, code: 0, part: 'res' }]); return }
    const f = fromFailure(body)
    if (f.code === 2006 && this.roomId !== null) {
      const denied = (f.details ?? {})['denied']
      if (Array.isArray(denied)) this.media.aff.denied(this.roomId, denied.map(String))
    }
    this.enter('pubRes', `PUBLISH_TRACKS.${f.code}`, [{ action, code: f.code, part: 'fail' }], f)
  }

  // ── Encoder — sender · 게이트 · 인코딩 값 ──────────────────────────────

  /** 트랜시버 확보 — 같은 kind 의 쉬는 자리를 먼저 되쓴다 · 3008 재시도는 새 트랜시버 */
  acquireSlot(): void {
    const peer = this.link?.peer
    if (!peer || this.slot) return
    const r = this.roomId === null ? null : this.media.aff.pubRoom(this.roomId)
    const codec = this.kind === 'audio' ? r?.codecs.audio ?? 'opus' : r?.codecs.video ?? 'H264'
    const encs: Encoding[] = this.simulcast ? this.layers().map((l) => ({ ...l })) : []
    const roomCodec = codec.toLowerCase() === 'h264' ? { name: codec, fmtp: H264_FMTP } : { name: codec }
    this.slot = peer.acquireSlot(this.kind, this.simulcast, encs, roomCodec, this.opusLine(), this.freshSlot)
    this.freshSlot = false
  }

  /** 연결이 새로 섰다 — 협상을 기다리는 발행이면 트랜시버를 확보한다 */
  wantsSlot(): boolean { return this.st.ps === 'STAGED' && this.slot === null }

  /** 시뮬캐스트 레이어 — sendEncodings 는 낮은 품질부터(축소 큰 것 → 원본 · 같으면 비트레이트 낮은 것부터 — SDK:RULE-SRC-PROFILE · 연:RULE-LINK-SDP-PUB-MLINE) · 앱이 준 순서가 달라도 맞춘다 */
  private layers(): readonly Layer[] {
    const ls = this.opts.encoding?.layers ?? this.media.cfg.simulcastLayers
    return [...ls].sort((a, b) => (b.scaleResolutionDownBy ?? 1) - (a.scaleResolutionDownBy ?? 1) || (a.maxBitrate ?? 0) - (b.maxBitrate ?? 0))
  }

  /** opus answer fmtp — 방 고정값 하나 · 트랙별 dtx · fec · stereo 는 wire 에 닿지 않는다(로그 — SDK:RULE-SRC-PROFILE 증상) */
  private opusLine(): string {
    const e = this.opts.encoding ?? {}
    if (this.kind === 'audio' && (e.dtx !== undefined || e.fec !== undefined || e.stereo !== undefined)) this.media.log.info('opus dtx/fec/stereo 는 answer 고정값(minptime=10;useinbandfec=1)이 정한다 — 무시한다', { track: this.key })
    return this.media.opusLine
  }

  private releaseSlot(): void {
    if (this.slot) this.link?.peer?.releaseSlot(this.slot)
    this.slot = null
  }

  /** 연결이 닫혔다 — 그 연결의 트랜시버 · 게이트는 없다 */
  peerClosed(): void { this.slot = null; this.gate = false }

  /** RTP 시작 — Encoder 가 sender 에 트랙을 얹은 결과가 입구 attach(연:PUB.C.REGISTERED) · 반이중은 게이트를 닫아 둔 채 준비만 */
  private async attach(): Promise<void> {
    const sender = this.sender
    if (!sender) { this.enter('attach', 'encoder', [false], negotiationFault('ATTACH')); return }
    try {
      await this.applyEncoding(sender)
      if (!this.st.half) { await sender.replaceTrack(this.track); this.gate = true }
      this.enter('attach', 'encoder', [true])
      if (!this.st.half) this.checkSilence()
    } catch (e) {
      this.enter('attach', 'encoder', [false], negotiationFault('ATTACH', e))
    }
  }

  /** 값만 — 비트레이트 상한 · 프레임 · 레이어 값(setParameters · SDP 밖) · 서버 max_bitrate_bps 가 덮는다 */
  private async applyEncoding(sender: RTCRtpSender): Promise<void> {
    const p = sender.getParameters()
    if (!p.encodings || !p.encodings.length) return
    const cap = this.link?.sc?.max_bitrate_bps
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
      const s = this.media.cfg.screenShare
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
    try { await sender.setParameters(p) } catch (err) { this.media.log.warn('setParameters 실패', { err: String(err) }) }
  }

  /** 게이트 열기(효과 track.attach) — 보관한 source 를 sender 에 한 번 · cold 면 데우기 먼저 · 반이중이면 발언권에 RTP 송출 사실(연:FLR.C.PERM.rtp_tx) */
  private openGate(): void {
    if (this.gate) return
    this.gate = true
    const sender = this.sender
    if (!sender) return
    const on = (): void => {
      if (!this.gate) return
      void sender.replaceTrack(this.track).catch((e) => this.media.log.warn('replaceTrack 실패', { err: String(e) }))
      if (this.st.half) {
        for (const f of this.media.aff.floorsOn(this.sfuId)) if (f.st.cs === 'PERM') f.rtpTx()
        this.checkSilence()
      }
    }
    if (this.cold) void this.warm().then(on, () => undefined)
    else on()
  }

  /** 게이트 닫기(효과 track.detach) — 곧바로 replaceTrack(null) · source 는 보관(연:RULE-FLR-PROC-REVOKE 유예는 소리를 더 내는 창이 아니다) */
  private closeGate(): void {
    if (!this.gate) return
    this.gate = false
    const sender = this.sender
    if (sender) void sender.replaceTrack(null).catch((e) => this.media.log.warn('replaceTrack 실패', { err: String(e) }))
  }

  // ── 이음매가 부르는 입구(위 REACTS) ────────────────────────────────────

  /** LINK pub.nego_ok · pub.nego_fail — 협상을 기다리는 발행만 */
  nego(ok: boolean): void { if (this.st.ps === 'STAGED') this.enter('nego', ok ? 'nego.ok' : 'nego.fail', [ok], ok ? null : this.link?.negoFault ?? negotiationFault('APPLY')) }
  /** TRK pub.revoked — 트랙 목록에서 내 트랙이 빠졌다 */
  revoked(): void { this.enter('revoked', 'TRACK_EVENT.remove', [{}]) }
  /** FLR mic.open */
  floorOpen(): void { this.enter('floorOpen', 'mic.open', []); this.coldTimer.stop() }
  /** FLR mic.close */
  floorClose(): void { this.enter('floorClose', 'mic.close', []); this.armCold() }
  /** LINK pub.drop_server — 그 서버 연결이 닫혔다 */
  dropServer(): void { this.enter('dropServer', 'link', []); this.slot = null; this.gate = false }
  /** ROOM pub.room_gone — 발행한 방을 잃었다 */
  roomGone(): void { this.enter('roomGone', 'room', []) }
  /** SES pub.resume_check — 이어받기 응답의 발행 목록 대조 */
  resumeCheck(listed: boolean): void { this.enter('resumeCheck', 'RESUME', [listed]) }

  /** LINK pub.reregister_server · SES pub.reregister_all — 재구축의 다시 발행 · 비트가 막는 것은 다시 싣지 않고 끈다(SDK:RULE-ROOM-PERMISSION-BITS 자동 발행을 멈춘다) */
  reregister(): void {
    if (this.ended) return
    if (!this.allowedNow()) { this.enter('off', 'permission', []); return }
    this.slot = null
    this.enter('reregister', 'rebuild', [])
  }

  // ── 앱 조작 ──────────────────────────────────────────────────────────

  /** 발행 — 입구 on · 기준 방은 부르는 쪽이 고른다(enable* · publish = 발언 방 · ptt.enable = 그 방) · resolve 때 owner 가 sdk(external 은 그대로) */
  publish(roomId: string, duplex: 'full' | 'half'): Promise<void> {
    return this.locked(async () => {
      if (this.ended) throw closedFault()
      const room = this.media.aff.pubRoom(roomId)
      if (!room) throw stateFault('STATE_NOT_JOINED', { room: roomId })
      if (!bitIn(room, this.kind, this.source)) throw stateFault('STATE_NO_PERMISSION', { denied: [bitOf(this.kind, this.source)] })
      if (this.st.ps !== 'IDLE') return
      this.duplex = duplex
      this.sfuId = room.sfuId
      this.roomId = room.id
      // 개체 신원 — 이 트랙이 붙은 서버 · 방 · 반이중(위 모형의 자리 · SDK:RULE-MOD-BINDING-VALUES)
      this.st = { ...this.st, half: duplex === 'half', sfu: this.media.ids.id(`sfu:${room.sfuId ?? ''}`), room: this.media.ids.id(`room:${room.id}`) }
      this.media.register(this)
      if (this.kind === 'audio' && this.owner !== 'external') this.applyCapture()
      const p = new Promise<void>((resolve, reject) => { this.waiter = { resolve, reject } })
      this.enter('on', 'app', [])
      await p
      if (this.owner === 'app') this.owner = 'sdk'
      if (duplex === 'half') this.armCold()
    })
  }

  private applyCapture(): void {
    const c = this.opts.capture
    if (c) void this.track.applyConstraints?.({ ...c } as MediaTrackConstraints).catch(() => undefined)
  }

  /** 끔 — 반이중이 허가 중이면 먼저 놓고 · 입구 off(게이트 닫기 → remove) → sender 에서 뗀다 → Source 정지(SDK:RULE-MOD-TEARDOWN track.stop · 트랜시버는 그대로) */
  stop(reason: EndReason = 'stopped'): Promise<void> {
    return this.locked(async () => {
      if (this.ended) return
      if (this.duplex === 'half') for (const f of this.media.aff.floorsOn(this.sfuId)) if (f.st.cs === 'PERM') await f.release()
      if (this.st.ps !== 'IDLE') this.enter('off', 'app', [])
      const sender = this.sender
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
    this.media.unregister(this)
    this.events.emit('ended', { reason })
    for (const f of this.media.aff.floorsOn(this.sfuId)) f.surface()
  }

  // ── 트랙 설정(연:PUB.op.TRACK_SET) — 끝난 트랙(닫힌 핸들)의 조작은 closed · CLOSED(SDK:IMPL-ERR-TYPE) ──

  /** mute — 손잡이는 track.enabled(인코더는 돈다) · 반이중은 mute 가 없다(wire 전에 거절) · 발행 전이면 로컬만 */
  setMuted(m: boolean): Promise<void> {
    return this.locked(async () => {
      if (this.ended) throw closedFault()
      if (this.duplex === 'half') throw stateFault('STATE_HALF_DUPLEX_NO_MUTE')
      const link = this.link
      if (!this.trackId || !this.roomId || !link) { this.muted = m; this.track.enabled = !m; return }
      const r = await link.request('TRACK_SET', { room_id: this.roomId, track_id: this.trackId, muted: m })
      if (!r.ok) throw fromFailure(r.body)
      this.muted = m
      this.track.enabled = !m
    })
  }

  /**
   * duplex 전환 — 응답 뒤에만 바꾼다 · 재발행 · 재협상 없음(SDK:RULE-PUB-DUPLEX-SWITCH).
   * ★위 발행 상태기는 half 를 개체 신원으로 두고(모형에서 안 바뀐다) 전환 입구가 없다 — 표의 손잡이(게이트 · enabled · 프로필 · 전원 · 발언권 표면)를 SDK 가 밟고 기록을 남긴다.
   */
  setDuplex(d: 'full' | 'half'): Promise<void> {
    return this.locked(async () => {
      if (this.ended) throw closedFault()
      if (d === this.duplex) return
      const base = this.media.aff.speakingRoom
      if (!base) throw stateFault('STATE_NO_SPEAKING_ROOM')
      const link = this.link
      if (!this.trackId || !link) throw stateFault('STATE_NOT_PUBLISHED')
      const r = await link.request('TRACK_SET', { room_id: base, track_id: this.trackId, duplex: d })
      if (!r.ok) throw fromFailure(r.body)
      const prev = this.st
      this.duplex = d
      this.muted = false
      this.track.enabled = true
      if (d === 'half') {
        this.st = { ...this.st, half: true, ps: this.st.ps === 'SENDING' ? 'REGISTERED' : this.st.ps }
        this.media.book.record('PUB', this.key, prev.ps, this.st.ps, 'SDK.duplex_half', 'TRACK_SET.res')
        this.closeGate()
        for (const f of this.media.aff.floorsOn(this.sfuId)) f.registerHalf()
        this.armCold()
      } else {
        this.st = { ...this.st, half: false, ps: this.st.ps === 'REGISTERED' ? 'SENDING' : this.st.ps }
        this.media.book.record('PUB', this.key, prev.ps, this.st.ps, 'SDK.duplex_full', 'TRACK_SET.res')
        this.coldTimer.stop()
        if (this.cold) await this.warm()
        if (this.st.ps === 'SENDING') this.openGate()
      }
      const sender = this.sender
      if (sender) await this.applyEncoding(sender)
      for (const f of this.media.aff.floorsOn(this.sfuId)) f.surface()
    })
  }

  setEncoding(e: VideoEncoding & AudioEncoding): Promise<void> {
    return this.locked(async () => {
      if (this.ended) throw closedFault()
      this.opts = { ...this.opts, encoding: { ...(this.opts.encoding ?? {}), ...e } }
      const sender = this.sender
      if (sender) await this.applyEncoding(sender)
    })
  }

  // ── Source — 장치 트랙 · 소유권 · 교체 ───────────────────────────────

  /** 소스 교체 — Encoder.source 갱신 · 게이트가 열려 있을 때만 sender 에 얹는다(SSRC · 발행 · 발언권 보존) */
  replaceSource(t: MediaStreamTrack | null): Promise<void> {
    return this.locked(async () => {
      if (this.ended) throw closedFault()
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
      const sender = this.sender
      if (sender && this.gate) await sender.replaceTrack(this.track)
    })
  }

  /** 장치 전환 — sdk 소유만 · replaceTrack 이라 SSRC 보존 · null 이면 OS 기본(자동) · cold 면 저장 제약만 바꾼다 */
  switchTo(deviceId: string | null): Promise<void> {
    return this.locked(async () => {
      if (this.owner !== 'sdk' || this.ended) return
      const { deviceId: _was, ...rest } = this.opts
      this.opts = deviceId ? { ...rest, deviceId } : rest
      if (this.cold) return
      const next = await this.acquireAgain(deviceId ?? undefined)
      const old = this.track
      this.track = next
      this.watchTrack(next)
      const sender = this.sender
      if (sender && this.gate) await sender.replaceTrack(next)
      old.stop()
    })
  }

  private acquireAgain(deviceId?: string): Promise<MediaStreamTrack> {
    return capture({ kind: this.kind, screen: this.source === 'screen', deviceId: deviceId ?? this.opts.deviceId, constraints: this.media.constraintsFor(this.kind, this.source, this.profile, this.opts), timeoutMs: this.opts.timeoutMs ?? this.media.cfg.deviceAcquireTimeoutMs })
  }

  // ── 마이크 전원(SDK:RULE-FLR-MIC-POWER) — sdk 소유 반이중 마이크만 ─────────

  private armCold(): void {
    if (this.duplex !== 'half' || this.kind !== 'audio' || this.owner !== 'sdk' || this.ended) return
    this.coldTimer.start(this.media.coldAfter, () => this.goCold())
  }

  keepWarm(ms: number): void {
    if (this.duplex !== 'half') return
    this.coldTimer.start(ms > 0 ? ms : this.media.cfg.micColdAfterMs, () => this.goCold())
  }

  private goCold(): void {
    if (this.st.ps === 'SENDING' || this.owner !== 'sdk' || this.ended || this.cold) return
    this.cold = true
    this.track.stop()
    this.media.book.record('PUB', this.key, this.st.ps, this.st.ps, 'SDK.cold', 'mic_power')
    for (const f of this.media.aff.floorsOn(this.sfuId)) f.surface()
  }

  /** 데우기 — 저장 제약으로 다시 획득 · source 만 보관(게이트가 열려 있을 때만 sender) */
  warm(): Promise<void> {
    if (!this.cold) return Promise.resolve()
    return this.acquireAgain().then((t) => {
      this.track = t
      this.cold = false
      this.watchTrack(t)
      this.media.book.record('PUB', this.key, this.st.ps, this.st.ps, 'SDK.warm', 'mic_power')
      const sender = this.sender
      if (sender && this.gate) void sender.replaceTrack(t)
      this.armCold()
    })
  }

  /** 무음 감지 — 그 창 동안 media-source totalAudioEnergy 가 늘지 않았다(SDK:IMPL-PUB-API silence) · 앱 · 외부 소유는 대상 아님 */
  private checkSilence(): void {
    if (this.kind !== 'audio' || this.silenceChecked || this.owner === 'external') return
    const sender = this.sender
    if (!sender) return
    this.silenceChecked = true
    void (async () => {
      const a = Probe.audioEnergy(await sender.getStats())
      await sleep(this.media.cfg.silenceWindowMs)
      const b = Probe.audioEnergy(await sender.getStats())
      if (a !== null && b !== null && b <= a && !this.ended) this.events.emit('silence')
    })()
  }

  /** 통보 없이 로컬만 내린다 — 세션 끝 · 백오프 소진 */
  dispose(stopSource: boolean): void {
    this.gate = false
    this.slot = null
    if (stopSource) this.finish('stopped', true)
    else { this.st = PUB.initial(); this.coldTimer.stop(); this.media.unregister(this) }
  }

  getStats(): Promise<RTCStatsReport> {
    const s = this.sender
    return s ? s.getStats() : Promise.resolve(new Map() as unknown as RTCStatsReport)
  }
}
