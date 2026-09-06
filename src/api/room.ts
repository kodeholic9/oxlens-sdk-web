// author: kodeholic (powered by Claude)
// SDK§4 — 방 핸들. 서버가 뺐으면 closed 이고 client.rooms 에서 빠진다.
import { TrackEntry } from '../domain/store.js'
import { PeerLink } from '../internal/transport/link.js'
import { Bus } from './emitter.js'
import { NotImplementedError } from './not-implemented.js'
import { RemoteTrackHandle } from './remote-track.js'
import { Participant, Ptt, RemoteTrack, Room, RoomAudio, RoomEvents, RoomState } from './types.js'

export interface RoomHost {
  leave(roomId: string): Promise<void>
  sendMessage(roomId: string, content: string): Promise<{ msgId: string }>
  /** 연§6-3 `SUBSCRIBE_LAYER` — 여러 대상을 한 번에 보낼 수 있다(부분 갱신). */
  subscribeLayer(roomId: string, targets: readonly LayerTarget[]): Promise<void>
}

/** 연§6-3 — wire 그대로. 생략한 필드는 ★안 바꾼다(부분 갱신). */
export interface LayerTarget {
  readonly track_id: string
  readonly spatial?: number
  readonly temporal?: number
  readonly paused?: boolean
  readonly priority?: number
}

export class RoomHandle extends Bus<RoomEvents> implements Room {
  state: RoomState = 'joining'
  participants: readonly Participant[] = []
  private readonly byTrackId = new Map<string, RemoteTrackHandle>()
  private muted = false
  private volume = 1

  constructor(
    readonly id: string,
    readonly mode: 'listen' | 'talk',
    readonly server: string,
    private readonly host: RoomHost,
  ) {
    super()
  }

  /** 장착 가능한 것만 — 받을 수 없는 트랙은 trackUnreachable 로 따로 간다(연§4-1). */
  get tracks(): readonly RemoteTrack[] { return [...this.byTrackId.values()] }

  get audio(): RoomAudio {
    const self = this
    return {
      get muted() { return self.muted },
      get volume() { return self.volume },
      setMuted(v: boolean) { self.muted = v },
      setVolume(v: number) { self.volume = Math.min(1, Math.max(0, v)) },
    }
  }

  private pttHandle: Ptt | null = null

  get ptt(): Ptt {
    if (this.pttHandle === null) throw new NotImplementedError(`room(${this.id}).ptt`)
    return this.pttHandle
  }

  attachPtt(handle: Ptt): void { this.pttHandle = handle }

  leave(): Promise<void> { return this.host.leave(this.id) }

  /** 연§6-5 — 보낸 사람에게는 에코가 없다. 자기 것은 응답으로 안다. */
  sendMessage(content: string): Promise<{ msgId: string }> {
    return this.host.sendMessage(this.id, content)
  }

  /** 같은 track_id 가 다시 오면 핸들은 그대로 두고 안쪽만 갈아 끼운다. 이벤트는 처음 한 번이다. */
  adopt(entry: TrackEntry, media: MediaStreamTrack, link: PeerLink): { track: RemoteTrackHandle; fresh: boolean } {
    const known = this.byTrackId.get(entry.track_id)
    if (known) { known.update(entry); return { track: known, fresh: false } }
    const handle = new RemoteTrackHandle(entry, media, link, this.host)
    this.byTrackId.set(entry.track_id, handle)
    this.emit('track', handle)
    return { track: handle, fresh: true }
  }

  refresh(entry: TrackEntry): void { this.byTrackId.get(entry.track_id)?.update(entry) }

  drop(trackId: string): void {
    const handle = this.byTrackId.get(trackId)
    if (!handle) return
    this.byTrackId.delete(trackId)
    handle.emit('ended')
  }

  setParticipants(list: readonly Participant[]): void {
    this.participants = list
    this.emit('participants', list)
  }
}
