// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-TRK-RECEIVE RemoteTrack · attach · adaptiveStream · room.audio · 연:RULE-SUB-LAYER-PROC · SDK:IMPL-SRC-BLOCKS Playback · SDK:RULE-MOD-TEST-SEAM · SDK:RULE-MOD-AREA-MIRROR domain/trk · model: claude-opus-5-5
import type { TrackEntry, MlineEntry } from '../../internal/wire/ws.js'
import { Emitter } from '../../platform/emitter.js'
import { documentTarget, pixelRatio, intersectionObserver, resizeObserver } from '../../platform/env.js'
import { setPlayoutDelay, streamOf } from '../../platform/webrtc.js'
import { Timer, nextTick } from '../../platform/clock.js'
import { bugFault } from '../../platform/fault.js'
import type { RoomCore } from '../room/core.js'
import type { RoomTracks } from './tracks.js'
import type { LayerTarget } from './sub.js'

/** 받는 트랙의 정체만 — trackUnreachable 의 페이로드(핸들이 아니다) */
export interface RemoteInfo {
  readonly id: string
  readonly type: 'individual' | 'slot'
  readonly kind: 'audio' | 'video'
  readonly userId?: string
  readonly scalability?: string
}

export interface RemoteEvents extends Record<string, unknown[]> {
  ended: []
  active: [{ active: boolean; mediaStreamTrack: MediaStreamTrack | null }]
  muted: [boolean]
  receiving: []
}

export interface LayerAsk { spatial?: number; temporal?: number; paused?: boolean; priority?: number }

/** adaptiveStream — 보이는 트랙 200 · 안 보이는 트랙 1(SDK:IMPL-TRK-RECEIVE) */
const PRIO_VISIBLE = 200
const PRIO_HIDDEN = 1
/** 작은 타일 문턱 — 물리 픽셀 폭 480 미만이면 가장 낮은 공간 단(정책:sdk.adaptiveStream) */
const SMALL_TILE = 480

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(v)))

/** 받을 레이어 상한 — scalability(L{공간}T{시간}) 밖의 값은 보내지 않는다 · 없으면 레이어 칸은 싣지 않는다 · priority 1~255(연:RULE-SUB-LAYER-PROC) */
export function layerTarget(trackId: string, scalability: string | undefined, v: LayerAsk): LayerTarget {
  const m = /^L(\d+)T(\d+)/.exec(scalability ?? '')
  const o: { track_id: string; spatial?: number; temporal?: number; paused?: boolean; priority?: number } = { track_id: trackId }
  if (m && v.spatial !== undefined) o.spatial = clamp(v.spatial, 0, Number(m[1]) - 1)
  if (m && v.temporal !== undefined) o.temporal = clamp(v.temporal, 0, Number(m[2]) - 1)
  if (v.paused !== undefined) o.paused = v.paused
  if (v.priority !== undefined) o.priority = clamp(v.priority, 1, 255)
  return o
}

/** 받는 트랙 하나 — 트랙 층 항목 + 배정표 줄 + 수신 트랜시버 · 방(트랙 목록)이 소유한다 */
export class RemoteCore {
  readonly events = new Emitter<RemoteEvents>()
  entry: TrackEntry
  row: MlineEntry | null = null
  receiver: RTCRtpReceiver | null = null
  receiving = false
  volume = 1
  ended = false
  private announced = false
  private unreachable = false
  /** 복귀했는데 장착할 트랙이 아직 없다 — 줄이 오면(bind) active 를 낸다 */
  private owed = false
  private watched: MediaStreamTrack | null = null
  private audioEl: HTMLAudioElement | null = null
  private readonly attached = new Set<HTMLMediaElement>()
  private io: IntersectionObserver | null = null
  private ro: ResizeObserver | null = null
  private readonly seenAt = new Map<HTMLMediaElement, { visible: boolean; width: number }>()
  private readonly settle: Timer
  private lastLayer = ''
  private docWatched = false
  private readonly docSeen = (): void => this.adapt()

  constructor(readonly trk: RoomTracks, entry: TrackEntry) {
    this.entry = entry
    this.settle = new Timer(trk.cfg.wakeDetectMs)
  }

  get room(): RoomCore { return this.trk.room }
  get id(): string { return this.entry.track_id }
  get kind(): 'audio' | 'video' { return this.entry.kind }
  /** 트랙 층 type 그대로 — track_id 를 파싱하지 않고 userId 로 추론하지 않는다 */
  get type(): 'individual' | 'slot' { return this.entry.type }
  get userId(): string | undefined { return this.entry.type === 'individual' ? this.entry.user_id : undefined }
  get active(): boolean { return this.entry.active !== false }
  get muted(): boolean | undefined { return this.entry.type === 'individual' ? this.entry.muted ?? false : undefined }
  get scalability(): string | undefined { return this.entry.scalability }
  get mediaStreamTrack(): MediaStreamTrack | null { return this.receiver?.track ?? null }

  info(): RemoteInfo {
    const o: { id: string; type: 'individual' | 'slot'; kind: 'audio' | 'video'; userId?: string; scalability?: string } = { id: this.id, type: this.type, kind: this.kind }
    if (this.userId !== undefined) o.userId = this.userId
    if (this.scalability !== undefined) o.scalability = this.scalability
    return o
  }

  /** 같은 track_id 의 항목 교체 — 같은 핸들의 active(쉼은 바로 · 복귀는 장착할 트랙이 있을 때) */
  update(t: TrackEntry): void {
    const was = this.active
    this.entry = t
    if (was === this.active || !this.announced) return
    if (this.active && !this.mediaStreamTrack) { this.owed = true; return }
    this.owed = false
    this.events.emit('active', { active: this.active, mediaStreamTrack: this.mediaStreamTrack })
  }

  /** 트랙 상태 통지의 muted(효과 app.track_state) */
  setMuted(m: boolean): void {
    this.entry = { ...this.entry, muted: m }
    this.events.emit('muted', m)
  }

  /** 줄 · 수신 트랜시버를 잇는다 — 장착 가능한 순간에 track(SDK:IMPL-TRK-RECEIVE) · 줄이 없으면 trackUnreachable 한 번 */
  bind(row: MlineEntry | null, receiver: RTCRtpReceiver | null): void {
    if (this.ended) return
    const prev = this.mediaStreamTrack
    const lost = this.row !== null && !row
    this.row = row
    this.receiver = row ? receiver : null
    if (!row) {
      if (!this.unreachable && this.active) {
        this.unreachable = true
        // 받던 트랙이 줄을 잃었다 — 핸들 수명 끝(SDK §10 정체성 표) · 서버가 줄을 다시 주면 새 핸들로 온다 · 쉬는 트랙은 같은 핸들
        if (lost && this.announced) this.end()
        this.room.events.emit('trackUnreachable', this.info())
      }
      return
    }
    this.unreachable = false
    const now = this.mediaStreamTrack
    if (!now) return
    if (this.announced && (prev !== now || this.owed)) {
      this.owed = false
      for (const el of this.attached) el.srcObject = streamOf(now)
      this.events.emit('active', { active: this.active, mediaStreamTrack: now })
    }
    this.watchReceiving(now)
    this.applyPlayback()
    if (!this.announced && !this.room.joinPending) {
      this.announced = true
      this.room.announce(this)
    }
  }

  /** 첫 디코딩 프레임(로컬 관측 · wire 아님) — 수신 트랙 unmute */
  private watchReceiving(t: MediaStreamTrack): void {
    if (this.watched === t) return
    this.watched = t
    this.receiving = false
    const fire = (): void => {
      if (this.receiving || this.watched !== t || this.ended) return
      this.receiving = true
      this.events.emit('receiving')
      // 그 방 무전 슬롯 오디오가 닿았다 — 방을 지나 발언권 입구 rtpRx(SDK:IMPL-FLR-BUTTON 입구 표)
      if (this.kind === 'audio' && this.type === 'slot') this.room.voiceArrived()
    }
    if (!t.muted) void nextTick().then(fire)
    t.addEventListener('unmute', fire, { once: true })
  }

  /** 오디오는 SDK 가 재생한다 — 방 audio · 트랙 volume · 출력 장치(SDK:IMPL-TRK-RECEIVE room.audio) */
  applyPlayback(): void {
    if (this.kind !== 'audio') return
    const t = this.mediaStreamTrack
    const doc = documentTarget()
    if (!t || !doc || this.ended) return
    const playback = this.trk.playback
    if (!this.audioEl) {
      const el = doc.createElement('audio')
      el.autoplay = true
      el.setAttribute('data-oxlens-room', this.room.id)
      el.setAttribute('data-oxlens-track', this.id)
      this.audioEl = el
      playback.add(el)
    }
    const el = this.audioEl
    const cur = el.srcObject as MediaStream | null
    if (!cur || cur.getAudioTracks()[0] !== t) el.srcObject = streamOf(t)
    const a = this.trk.audio
    el.muted = a.muted
    el.volume = Math.max(0, Math.min(1, a.volume * this.volume))
    playback.play(el)
  }

  setVolume(v: number): void { this.volume = Math.max(0, Math.min(1, v)); this.applyPlayback() }

  /** 받을 레이어 상한 — 범위는 scalability 로 자른다 · 입구 layer 는 구독이 넣는다 */
  setLayer(v: LayerAsk): Promise<void> {
    return this.trk.sub.setLayer(layerTarget(this.id, this.scalability, v))
  }

  setReceive(o: { playoutDelayMs: number | null }): boolean {
    if (!this.receiver) return false
    const ok = setPlayoutDelay(this.receiver, o.playoutDelayMs)
    if (!ok) this.trk.log.warn('수신 지연 손잡이가 없다 — 무시한다', { track: this.id })
    return ok
  }

  getStats(): Promise<RTCStatsReport> {
    return this.receiver ? this.receiver.getStats() : Promise.resolve(new Map() as unknown as RTCStatsReport)
  }

  /** 영상 장착 — adaptiveStream 이면 가시성 · 크기로 setLayer 를 대신 한다(audio 는 bug — SDK 가 재생한다) */
  attach(el: HTMLMediaElement): void {
    if (this.kind === 'audio') throw bugFault('ATTACH_AUDIO')
    const t = this.mediaStreamTrack
    if (t) el.srcObject = streamOf(t)
    el.autoplay = true
    ;(el as HTMLVideoElement).playsInline = true
    el.muted = true
    this.attached.add(el)
    if (this.trk.cfg.adaptiveStream) this.observe(el)
    void el.play?.().catch(() => undefined)
  }

  detach(el?: HTMLMediaElement): void {
    const list = el ? [el] : [...this.attached]
    for (const e of list) {
      this.attached.delete(e)
      this.seenAt.delete(e)
      this.io?.unobserve(e)
      this.ro?.unobserve(e)
      if (e.srcObject) e.srcObject = null
    }
    if (this.trk.cfg.adaptiveStream) this.adapt()
  }

  /** 가시성은 IntersectionObserver · 문서 visibilitychange, 크기는 ResizeObserver(SDK:IMPL-TRK-RECEIVE attach) */
  private observe(el: HTMLMediaElement): void {
    if (!this.io) this.io = intersectionObserver((es) => { for (const e of es) this.seen(e.target as HTMLMediaElement, { visible: e.isIntersecting }) })
    if (!this.ro) this.ro = resizeObserver((es) => { for (const e of es) this.seen(e.target as HTMLMediaElement, { width: e.contentRect.width }) })
    this.io?.observe(el)
    this.ro?.observe(el)
    const doc = documentTarget()
    if (doc && !this.docWatched) { this.docWatched = true; doc.addEventListener('visibilitychange', this.docSeen) }
    this.seenAt.set(el, { visible: true, width: el.clientWidth || 640 })
    this.adapt()
  }

  private seen(el: HTMLMediaElement, v: { visible?: boolean; width?: number }): void {
    const cur = this.seenAt.get(el) ?? { visible: true, width: 640 }
    this.seenAt.set(el, { visible: v.visible ?? cur.visible, width: v.width ?? cur.width })
    this.adapt()
  }

  /** 바뀜은 adaptiveStreamSettleMs 동안 묶어 setLayer 를 한 번 낸다 · 같은 값은 다시 내지 않는다 */
  private adapt(): void {
    this.settle.start(this.trk.cfg.adaptiveStreamSettleMs, () => {
      if (this.ended) return
      const doc = documentTarget()
      const hiddenDoc = doc ? doc.visibilityState === 'hidden' : false
      let any = false
      let maxW = 0
      for (const v of this.seenAt.values()) if (v.visible) { any = true; maxW = Math.max(maxW, v.width) }
      const shown = any && !hiddenDoc
      const L = /^L(\d+)/.exec(this.scalability ?? '')
      const v: LayerAsk = { paused: !shown, priority: shown ? PRIO_VISIBLE : PRIO_HIDDEN }
      if (L) v.spatial = maxW * pixelRatio() < SMALL_TILE ? 0 : Number(L[1]) - 1
      const key = JSON.stringify(v)
      if (key === this.lastLayer) return
      this.lastLayer = key
      this.setLayer(v).catch(() => undefined)
    })
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.receiver = null
    this.settle.stop()
    this.io?.disconnect()
    this.ro?.disconnect()
    if (this.docWatched) documentTarget()?.removeEventListener('visibilitychange', this.docSeen)
    for (const el of this.attached) if (el.srcObject) el.srcObject = null
    this.attached.clear()
    if (this.audioEl) { this.trk.playback.remove(this.audioEl); this.audioEl.srcObject = null; this.audioEl = null }
    this.events.emit('ended')
  }
}
