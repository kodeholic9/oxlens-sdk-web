// author: kodeholic (powered by Claude)
// 연§4-1 · SDK§6-2 — 받는 트랙 하나. 정체는 track_id 이고 무전 슬롯은 user_id 가 없다.
import { TrackEntry } from '../domain/store.js'
import { MediaTrackLike } from '../platform/webrtc.js'
import { Bus } from './emitter.js'
import { NotImplementedError } from './not-implemented.js'
import { LayerRequest, ReceiveOptions, RemoteTrack, RemoteTrackEvents, TrackKind } from './types.js'

export class RemoteTrackHandle extends Bus<RemoteTrackEvents> implements RemoteTrack {
  volume = 1
  private attached = new Set<HTMLMediaElement>()

  constructor(private entry: TrackEntry, readonly mediaStreamTrack: MediaStreamTrack) {
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
    return element
  }

  detach(element?: HTMLMediaElement): void {
    for (const el of element ? [element] : [...this.attached]) {
      el.srcObject = null
      this.attached.delete(el)
    }
  }

  setLayer(_req: LayerRequest): Promise<void> { return Promise.reject(new NotImplementedError('setLayer')) }
  setReceive(_opts: ReceiveOptions): Promise<void> { return Promise.reject(new NotImplementedError('setReceive')) }
  getStats(): Promise<RTCStatsReport> { return Promise.reject(new NotImplementedError('getStats')) }
}

export function trackOf(media: MediaTrackLike): MediaStreamTrack {
  return media as unknown as MediaStreamTrack
}
