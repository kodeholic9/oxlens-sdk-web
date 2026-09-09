// author: kodeholic (powered by Claude)
// 연§4-1 · SDK§6-2 — 받는 트랙 하나. 정체는 track_id 이고 무전 슬롯은 user_id 가 없다.
import { TrackEntry } from '../domain/store.js'
import { PeerLink } from '../internal/transport/link.js'
import { MediaTrackLike } from '../platform/webrtc.js'
import { Bus } from './emitter.js'
import { NotImplementedError } from './not-implemented.js'
import { RoomHost } from './room.js'
import { LayerRequest, ReceiveOptions, RemoteTrack, RemoteTrackEvents, TrackKind } from './types.js'

/** 정책서 §4-1 `adaptiveStream` — 보이는 트랙 200 · 안 보이는 트랙 1 · 작은 타일 문턱(물리 픽셀). */
export const PRIORITY_VISIBLE = 200
export const PRIORITY_HIDDEN = 1
export const SMALL_TILE_PX = 480

interface Sight {
  visible: boolean
  widthPx: number
}

interface Observer {
  observe(target: Element): void
  disconnect(): void
}

interface Observers {
  ResizeObserver?: new (cb: () => void) => Observer
  IntersectionObserver?: new (cb: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) => Observer
  devicePixelRatio?: number
}

export class RemoteTrackHandle extends Bus<RemoteTrackEvents> implements RemoteTrack {
  volume = 1
  private attached = new Set<HTMLMediaElement>()
  private readonly sights = new Map<HTMLMediaElement, { sight: Sight; stop: () => void }>()
  private lastAuto: string | null = null

  constructor(
    private entry: TrackEntry,
    readonly mediaStreamTrack: MediaStreamTrack,
    private readonly link: PeerLink,
    private readonly host: RoomHost,
    private readonly adaptive = false,
  ) {
    super()
  }

  get id(): string { return this.entry.track_id }
  get roomId(): string { return this.entry.room_id }
  get kind(): TrackKind { return this.entry.kind }
  /** 연§11-7 5 — track_id 를 파싱하지 않는다. 슬롯은 user_id 부재로 안다. */
  get slot(): boolean { return this.entry.user_id === undefined }
  get active(): boolean { return this.entry.active !== false }
  get userId(): string { return this.entry.user_id as string }
  get scalability(): string { return this.entry.scalability as string }

  /** 보관본이 통째로 바뀌면 핸들은 그대로 두고 안쪽만 갈아 끼운다(같은 핸들 계약). */
  update(entry: TrackEntry): void {
    const wasActive = this.active
    this.entry = entry
    if (wasActive !== this.active) this.emit('active', this.active)
  }

  attach(element: HTMLMediaElement): HTMLMediaElement {
    if (this.kind !== 'video') throw new NotImplementedError('audio 트랙 장착 — 오디오는 SDK 가 낸다')
    const stream = new MediaStream([this.mediaStreamTrack])
    element.srcObject = stream
    element.autoplay = true
    // 모바일 사파리는 이것이 없으면 전체화면으로 뺏어 간다.
    ;(element as { playsInline?: boolean }).playsInline = true
    this.attached.add(element)
    if (this.adaptive) this.observe(element)
    return element
  }

  detach(element?: HTMLMediaElement): void {
    for (const el of element ? [element] : [...this.attached]) {
      el.srcObject = null
      this.attached.delete(el)
      this.sights.get(el)?.stop()
      this.sights.delete(el)
    }
    if (this.adaptive && this.lastAuto !== null) this.reassess()
  }

  /**
   * SDK§6-2 `adaptiveStream` — 엘리먼트 크기·가시성으로 `setLayer` 를 대신 한다. 안 보는 채널은 정지·
   * priority 1, 보는 채널은 priority 200, 작은 타일은 낮은 단. ★브라우저가 관찰자를 안 주면 자동은 없다.
   */
  private observe(el: HTMLMediaElement): void {
    const g = globalThis as Observers
    if (!g.ResizeObserver || !g.IntersectionObserver) return
    const sight: Sight = { visible: false, widthPx: this.widthOf(el) }
    const ro = new g.ResizeObserver(() => { sight.widthPx = this.widthOf(el); this.reassess() })
    const io = new g.IntersectionObserver((entries) => {
      sight.visible = entries.some((x) => x.isIntersecting)
      this.reassess()
    })
    ro.observe(el)
    io.observe(el)
    this.sights.set(el, { sight, stop: () => { ro.disconnect(); io.disconnect() } })
  }

  private widthOf(el: HTMLMediaElement): number {
    return (el.clientWidth || 0) * ((globalThis as Observers).devicePixelRatio ?? 1)
  }

  /** 같은 답이면 다시 보내지 않는다 — 관찰자는 자주 울린다. */
  private reassess(): void {
    const shown = [...this.sights.values()].map((s) => s.sight).filter((s) => s.visible)
    const [maxSpatial] = parseScalability(this.entry.scalability)
    const req: LayerRequest = shown.length === 0
      ? { paused: true, priority: PRIORITY_HIDDEN }
      : {
          paused: false,
          priority: PRIORITY_VISIBLE,
          spatial: Math.max(...shown.map((s) => s.widthPx)) < SMALL_TILE_PX ? 0 : maxSpatial,
        }
    const key = JSON.stringify(req)
    if (key === this.lastAuto) return
    this.lastAuto = key
    this.setLayer(req).catch((e: unknown) => { this.host.report(this.roomId, e) })
  }

  /**
   * 연§6-3 `SUBSCRIBE_LAYER` — 받을 단의 ★**상한**을 고른다. 지정이 아니다.
   *
   * ★생략한 필드는 안 바꾼다(부분 갱신) — `undefined` 는 싣지 않는다.
   * ★`paused` 는 레이어 값이 아니라 **별개 축**이다("안 받는다" 와 "낮은 화질로 받는다" 는 다르다).
   * ★`scalability`(연§4-1) 밖의 값은 보내지 않는다 — *"클라는 그 밖의 값을 보내지 않는다"* 가 계약이다.
   *   `"L2T1"` 이면 `spatial` 은 0~1, `temporal` 은 0~0 이다. 서버도 자르지만(거절은 안 한다),
   *   ★찍어 보내는 클라가 되지 않는 것이 이쪽 몫이다.
   * ★대상은 `track_id` 다 — 한 사람이 카메라와 화면공유를 둘 다 올리면 사람으로는 못 가른다.
   */
  async setLayer(req: LayerRequest): Promise<void> {
    const [maxSpatial, maxTemporal] = parseScalability(this.entry.scalability)
    const target = {
      track_id: this.id,
      ...(req.spatial !== undefined ? { spatial: clamp(req.spatial, maxSpatial) } : {}),
      ...(req.temporal !== undefined ? { temporal: clamp(req.temporal, maxTemporal) } : {}),
      ...(req.paused !== undefined ? { paused: req.paused } : {}),
      ...(req.priority !== undefined ? { priority: clamp(req.priority, 255, 1) } : {}),
    }
    await this.host.subscribeLayer(this.roomId, [target])
  }

  /**
   * SDK§6-3 수신 — ★**서버로 가지 않는다.** 재생 지연은 받는 쪽 jitter buffer 값이다.
   *
   * SDK§12(플랫폼) — 표준 `RTCRtpReceiver.jitterBufferTarget` 이 있으면 그것, 없으면
   * 비표준 `playoutDelayHint`, ★**둘 다 없으면 무시하고 로그**(던지지 않는다 — 브라우저가
   * 안 주는 것을 앱 실패로 만들지 않는다).
   */
  async setReceive(opts: ReceiveOptions): Promise<void> {
    if (opts.playoutDelayMs === undefined) return
    const receiver = this.link.receiverOf(this.mediaStreamTrack) as
      | { jitterBufferTarget?: number | null; playoutDelayHint?: number | null }
      | null
    if (!receiver) return
    if ('jitterBufferTarget' in receiver) {
      receiver.jitterBufferTarget = opts.playoutDelayMs
      return
    }
    if ('playoutDelayHint' in receiver) {
      receiver.playoutDelayHint = opts.playoutDelayMs / 1000
      return
    }
    console.warn('[oxlens] 이 브라우저는 수신 지연 손잡이가 없다 — setReceive 를 무시한다')
  }

  /** SDK§11-2 — 이 트랙의 수신 계수. 판정은 절대값이 아니라 두 스냅샷의 차분이다. */
  async getStats(): Promise<RTCStatsReport> {
    const rows = await this.link.statsFor(this.entry.ssrc, 'inbound')
    return rows as unknown as RTCStatsReport
  }
}

export function trackOf(media: MediaTrackLike): MediaStreamTrack {
  return media as unknown as MediaStreamTrack
}

/** 연§4-1 `scalability` — `"L{spatial}T{temporal}"`. 없으면 단이 하나다(상한 0). */
function parseScalability(value: string | undefined): [number, number] {
  const m = /^L(\d+)T(\d+)$/.exec(value ?? '')
  if (!m) return [0, 0]
  return [Math.max(0, Number(m[1]) - 1), Math.max(0, Number(m[2]) - 1)]
}

function clamp(value: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
