// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-TRK-RECEIVE RemoteTrack · attach · adaptiveStream · room.audio · SDK:IMPL-SRC-BLOCKS Playback · model: claude-opus-5-5
import type { TrackEntry, MlineEntry } from '../internal/wire/ws.js'
import { Emitter } from '../platform/emitter.js'
import { documentTarget } from '../platform/env.js'
import { setPlayoutDelay } from '../platform/webrtc.js'
import { bugFault } from '../platform/fault.js'
import type { Core } from './session.js'
import type { RoomCore } from './rooms.js'

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

/** adaptiveStream — 보이는 트랙 200 · 안 보이는 트랙 1(SDK:IMPL-TRK-RECEIVE) */
const PRIO_VISIBLE = 200
const PRIO_HIDDEN = 1
/** 작은 타일 문턱 — 물리 픽셀 폭 480 미만이면 가장 낮은 공간 단(정책:sdk.adaptiveStream) */
const SMALL_TILE = 480

/** 받는 트랙 하나 — 위 트랙 층 항목 + 배정표 줄 + 수신 트랜시버 */
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
  private audioEl: HTMLAudioElement | null = null
  private readonly attached = new Set<HTMLMediaElement>()
  private observers: { io: IntersectionObserver | null; ro: ResizeObserver | null } = { io: null, ro: null }
  private settle: ReturnType<typeof setTimeout> | null = null
  private visible = new Map<HTMLMediaElement, { visible: boolean; width: number }>()
  private lastLayer = ''

  constructor(readonly core: Core, readonly room: RoomCore, entry: TrackEntry) {
    this.entry = entry
  }

  get id(): string { return this.entry.track_id }
  get kind(): 'audio' | 'video' { return this.entry.kind }
  get type(): 'individual' | 'slot' { return this.entry.type }
  get userId(): string | undefined { return this.entry.user_id }
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

  /** 같은 track_id 의 항목 교체 — 같은 핸들의 active */
  update(t: TrackEntry): void {
    const wasActive = this.active
    this.entry = t
    if (wasActive !== this.active) this.events.emit('active', { active: this.active, mediaStreamTrack: this.mediaStreamTrack })
  }

  setMuted(m: boolean): void { this.events.emit('muted', m) }

  /** 줄 · 수신 트랜시버를 잇는다 — 장착 가능한 순간에 track 이벤트(SDK:IMPL-TRK-RECEIVE) */
  bind(row: MlineEntry | null, receiver: RTCRtpReceiver | null): void {
    if (this.ended) return
    const prevTrack = this.mediaStreamTrack
    this.row = row
    this.receiver = row ? receiver : null
    const now = this.mediaStreamTrack
    if (!row) {
      if (!this.unreachable && this.active) {
        this.unreachable = true
        this.room.events.emit('trackUnreachable', this.info())
      }
      return
    }
    this.unreachable = false
    if (!now) return
    if (prevTrack !== now && this.announced) {
      for (const el of this.attached) el.srcObject = new MediaStream([now])
      this.events.emit('active', { active: this.active, mediaStreamTrack: now })
    }
    this.watchReceiving(now)
    this.applyPlayback()
    if (!this.announced) {
      this.announced = true
      this.room.events.emit('track', this)
      this.core.events.emit('track', this.room, this)
    }
  }

  private watched: MediaStreamTrack | null = null

  /** 첫 디코딩 프레임(로컬 관측 · wire 아님) — 수신 트랙 unmute · requestVideoFrameCallback */
  private watchReceiving(t: MediaStreamTrack): void {
    if (this.watched === t) return
    this.watched = t
    this.receiving = false
    const fire = (): void => { if (!this.receiving && this.watched === t) { this.receiving = true; this.events.emit('receiving') } }
    if (!t.muted) setTimeout(fire, 0)
    t.addEventListener('unmute', fire, { once: true })
  }

  /** 오디오는 SDK 가 재생한다 — 방 audio · 트랙 volume · 출력 장치(SDK:IMPL-TRK-RECEIVE room.audio) */
  applyPlayback(): void {
    if (this.kind !== 'audio') return
    const t = this.mediaStreamTrack
    const doc = documentTarget()
    if (!t || !doc || this.ended) return
    if (!this.audioEl) {
      const el = doc.createElement('audio')
      el.autoplay = true
      el.setAttribute('data-oxlens-room', this.room.id)
      el.setAttribute('data-oxlens-track', this.id)
      this.audioEl = el
      this.core.media.playback.add(el)
    }
    const el = this.audioEl
    const cur = el.srcObject as MediaStream | null
    if (!cur || cur.getAudioTracks()[0] !== t) el.srcObject = new MediaStream([t])
    const a = this.room.audio
    el.muted = a.muted
    el.volume = Math.max(0, Math.min(1, a.volume * this.volume))
    this.core.media.playback.play(el)
  }

  setVolume(v: number): void { this.volume = Math.max(0, Math.min(1, v)); this.applyPlayback() }

  setLayer(v: { spatial?: number; temporal?: number; paused?: boolean; priority?: number }): Promise<void> {
    return this.room.setLayer(this.id, v)
  }

  setReceive(o: { playoutDelayMs: number | null }): boolean {
    if (!this.receiver) return false
    const ok = setPlayoutDelay(this.receiver, o.playoutDelayMs)
    if (!ok) this.core.log.warn('수신 지연 손잡이가 없다 — 무시한다', { track: this.id })
    return ok
  }

  getStats(): Promise<RTCStatsReport> {
    return this.receiver ? this.receiver.getStats() : Promise.resolve(new Map() as unknown as RTCStatsReport)
  }

  /** 영상 장착 — adaptiveStream 이면 가시성 · 크기로 setLayer 를 대신 한다(audio 는 bug — SDK 가 재생한다) */
  attach(el: HTMLMediaElement): void {
    if (this.kind === 'audio') throw bugFault('ATTACH_AUDIO')
    const t = this.mediaStreamTrack
    if (t) el.srcObject = new MediaStream([t])
    el.autoplay = true
    ;(el as HTMLVideoElement).playsInline = true
    el.muted = true
    this.attached.add(el)
    if (this.core.cfg.adaptiveStream) this.observe(el)
    void el.play?.().catch(() => undefined)
  }

  detach(el?: HTMLMediaElement): void {
    const list = el ? [el] : [...this.attached]
    for (const e of list) {
      this.attached.delete(e)
      this.visible.delete(e)
      this.observers.io?.unobserve(e)
      this.observers.ro?.unobserve(e)
      if (e.srcObject) e.srcObject = null
    }
    if (this.core.cfg.adaptiveStream) this.adapt()
  }

  private observe(el: HTMLMediaElement): void {
    if (typeof IntersectionObserver !== 'undefined') {
      if (!this.observers.io) this.observers.io = new IntersectionObserver((es) => { for (const e of es) this.seen(e.target as HTMLMediaElement, { visible: e.isIntersecting }) })
      this.observers.io.observe(el)
    }
    if (typeof ResizeObserver !== 'undefined') {
      if (!this.observers.ro) this.observers.ro = new ResizeObserver((es) => { for (const e of es) this.seen(e.target as HTMLMediaElement, { width: e.contentRect.width }) })
      this.observers.ro.observe(el)
    }
    this.visible.set(el, { visible: true, width: el.clientWidth || 640 })
    this.adapt()
  }

  private seen(el: HTMLMediaElement, v: { visible?: boolean; width?: number }): void {
    const cur = this.visible.get(el) ?? { visible: true, width: 640 }
    this.visible.set(el, { visible: v.visible ?? cur.visible, width: v.width ?? cur.width })
    this.adapt()
  }

  /** 바뀜은 adaptiveStreamSettleMs 동안 묶어 setLayer 를 한 번 낸다 */
  private adapt(): void {
    if (this.settle !== null) clearTimeout(this.settle)
    this.settle = setTimeout(() => {
      this.settle = null
      const doc = documentTarget()
      const hiddenDoc = doc ? doc.visibilityState === 'hidden' : false
      let any = false
      let maxW = 0
      for (const v of this.visible.values()) if (v.visible) { any = true; maxW = Math.max(maxW, v.width) }
      const seen = any && !hiddenDoc
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      const L = /^L(\d+)/.exec(this.scalability ?? '')
      const top = L ? Math.max(0, Number(L[1]) - 1) : undefined
      const v: { spatial?: number; paused: boolean; priority: number } = { paused: !seen, priority: seen ? PRIO_VISIBLE : PRIO_HIDDEN }
      if (top !== undefined) v.spatial = maxW * dpr < SMALL_TILE ? 0 : top
      const key = JSON.stringify(v)
      if (key === this.lastLayer) return
      this.lastLayer = key
      void this.setLayer(v)
    }, this.core.cfg.adaptiveStreamSettleMs)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.settle !== null) clearTimeout(this.settle)
    this.observers.io?.disconnect()
    this.observers.ro?.disconnect()
    for (const el of this.attached) if (el.srcObject) el.srcObject = null
    this.attached.clear()
    if (this.audioEl) { this.core.media.playback.remove(this.audioEl); this.audioEl.srcObject = null; this.audioEl = null }
    this.events.emit('ended')
  }
}
