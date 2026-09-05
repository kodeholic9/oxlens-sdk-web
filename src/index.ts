// OxLens SDK 진입점 — surface first. 표면은 api.ts, 안쪽은 아직 0줄(전부 throw).
export * from './api/types.js'
import type {
  ClientEvents, ClientOptions, Diagnostics, JoinOptions, Media, OxLensClient,
  Room, RoomPreview, RoomSummary, SessionInfo,
} from './api/types.js'

/** 표면이 먼저다 — 안쪽이 채워질 때까지 모든 진입이 이것을 던진다. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'
  constructor(what: string) { super(`not implemented: ${what}`) }
}

class ClientShell implements OxLensClient {
  readonly rooms: ReadonlyMap<string, Room> = new Map()
  readonly speakingRoom: Room | null = null
  constructor(private readonly opts: ClientOptions) {}
  get session(): SessionInfo {
    return { state: 'disconnected', recovering: false, userId: null, pcMode: null, quality: 'lost' }
  }
  get media(): Media { throw new NotImplementedError('media') }
  get diagnostics(): Diagnostics { throw new NotImplementedError('diagnostics') }
  connect(): Promise<void> { return Promise.reject(new NotImplementedError(`connect(${this.opts.base})`)) }
  setToken(_token: string): void { throw new NotImplementedError('setToken') }
  close(): Promise<void> { return Promise.reject(new NotImplementedError('close')) }
  join(roomId: string, _opts?: JoinOptions): Promise<Room> { return Promise.reject(new NotImplementedError(`join(${roomId})`)) }
  preview(roomId: string): Promise<RoomPreview> { return Promise.reject(new NotImplementedError(`preview(${roomId})`)) }
  listRooms(): Promise<ReadonlyArray<RoomSummary>> { return Promise.reject(new NotImplementedError('listRooms')) }
  setSpeakingRoom(roomId: string | null): Promise<void> { return Promise.reject(new NotImplementedError(`setSpeakingRoom(${roomId})`)) }
  on<K extends keyof ClientEvents>(_e: K, _fn: ClientEvents[K]): this { return this }
  off<K extends keyof ClientEvents>(_e: K, _fn: ClientEvents[K]): this { return this }
  once<K extends keyof ClientEvents>(_e: K, _fn: ClientEvents[K]): this { return this }
}

/** 유일한 생성 경로. 정의서 §2-1. */
export function createClient(opts: ClientOptions): OxLensClient {
  return new ClientShell(opts)
}
