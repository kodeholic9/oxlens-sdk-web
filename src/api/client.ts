// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-API-HANDLES OxLensClient · SDK:IMPL-SES-API · SDK:IMPL-AFF-SPEAKING-ROOM · SDK:IMPL-PUB-API media · SDK:RULE-SRC-DEVICES · SDK:RULE-DIAG-EVENTS · model: claude-opus-5-5
import { Core, type SessionInfo, type SessionState, type Health, type Quality, type Transition } from '../domain/session.js'
import type { ClientOptions } from '../domain/defaults.js'
import type { LinkInfo } from '../domain/links.js'
import type { Participant } from '../domain/store.js'
import type { RoomCore } from '../domain/rooms.js'
import type { RemoteCore } from '../domain/remote.js'
import { LocalCore, type TrackOptions } from '../domain/media-registry.js'
import type { RoomSummary, GetRoomRes } from '../internal/wire/ws.js'
import type { PermState } from '../platform/env.js'
import type { Level, LogEntry } from '../platform/log.js'
import { stateFault } from '../platform/fault.js'
import { OxLensError, toError, wrap } from './errors.js'
import { Room, LocalTrack, RemoteTrack, roomOf, remoteOf, localOf, speakingRoomCore } from './handles.js'

type Fn<A extends unknown[]> = (...a: A) => void
type Off = () => void

/** 접속 · 세션 — 상태 넷 · 신원 · 재접속 · 파생값(SDK:IMPL-SES-API) */
export class Session {
  constructor(private readonly core: Core) {}
  get state(): SessionState { return this.core.sessionState }
  get recovering(): boolean { return this.core.recovering }
  get reason(): { code: number; name: string } | null { return this.core.reason }
  get userId(): string | null { return this.core.userId }
  get pcMode(): '1pc' | '2pc' | null { return this.core.info().pcMode }
  get quality(): Quality { return this.core.quality }
}

export interface RoomPreview {
  readonly roomId: string
  readonly name: string
  readonly capacity: number
  readonly userCount: number
  readonly participants: Participant[]
  readonly mediaCodecs: { audio?: string; video?: string }
  readonly version: { epoch: string; seq: number }
}

export interface RoomInfo {
  readonly roomId: string
  readonly name: string
  readonly capacity: number
  readonly userCount: number
  readonly createdAt: number
  readonly rec: boolean
}

/** 장치 — 목록 · 핫플러그 · 선택 정책(SDK:RULE-SRC-DEVICES) */
export class Devices {
  constructor(private readonly core: Core) {}
  get preferred(): Readonly<Partial<Record<'audioinput' | 'audiooutput' | 'videoinput', string>>> { return this.core.media.preferred }
  list(o: { kind?: MediaDeviceKind; requestPermissions?: boolean } = {}): Promise<MediaDeviceInfo[]> { return wrap(this.core.media.devices(o.kind, o.requestPermissions ?? false)) }
  on(name: 'change', fn: Fn<[{ added: MediaDeviceInfo[]; removed: MediaDeviceInfo[]; list: MediaDeviceInfo[] }]>): Off { return this.core.media.deviceEvents.on(name, fn) }
  off(name: 'change'): void { this.core.media.deviceEvents.off(name) }
}

/** 수신 오디오 재생 허용(autoplay 정책) */
export class AudioPlayback {
  constructor(private readonly core: Core) {}
  get playbackAllowed(): boolean { return this.core.media.playback.allowed }
}

/** 로컬 발행 · 장치 · 재생 — client.media */
export class Media {
  readonly devices: Devices
  readonly audio: AudioPlayback
  constructor(private readonly core: Core) {
    this.devices = new Devices(core)
    this.audio = new AudioPlayback(core)
  }

  get tracks(): LocalTrack[] { return [...this.core.media.tracks].map(localOf) }

  /** 획득만 — 접속 · 방 · 발언 방이 없어도 된다 · 전부 아니면 전무 · owner 'app' */
  async acquire(req: { microphone?: TrackOptions | boolean; camera?: TrackOptions | boolean; screen?: TrackOptions | boolean }): Promise<LocalTrack[]> {
    return (await wrap(this.core.media.acquire(req))).map(localOf)
  }

  /** 발행 — LocalTrack 이면 owner 가 resolve 때 sdk · MediaStreamTrack 이면 예외 경로(external · 전이중) */
  async publish(t: LocalTrack | MediaStreamTrack, opts: { source?: 'camera' | 'screen'; encoding?: TrackOptions['encoding'] } = {}): Promise<LocalTrack> {
    await wrap(this.core.untilActive())
    const room = speakingRoomCore(this.core)
    if (t instanceof LocalTrack) {
      await wrap(t.core.publish(room, 'full'))
      return t
    }
    const kind = t.kind === 'audio' ? 'audio' : 'video'
    const src = kind === 'video' && opts.source === 'screen' ? 'screen' : kind === 'video' ? 'camera' : 'external'
    const o: TrackOptions = opts.encoding ? { encoding: opts.encoding } : {}
    const c = new LocalCore(this.core, kind, src, t, 'external', o)
    await wrap(c.publish(room, 'full'))
    return localOf(c)
  }

  private async enable(kind: 'audio' | 'video', source: 'microphone' | 'camera' | 'screen', o: TrackOptions): Promise<LocalTrack> {
    await wrap(this.core.untilActive())
    const room = speakingRoomCore(this.core)
    const bit = kind === 'audio' ? room.permission.publishAudio : source === 'screen' ? room.permission.publishScreen : room.permission.publishVideo
    if (!bit) throw toError(stateFault('STATE_NO_PERMISSION', { denied: [kind === 'audio' ? 'publish_audio' : source === 'screen' ? 'publish_screen' : 'publish_video'] }))
    const c = await wrap(this.core.media.acquireOne(kind, source, o, 'sdk'))
    try { await wrap(c.publish(room, 'full')) } catch (e) { c.track.stop(); throw e }
    return localOf(c)
  }

  enableMicrophone(o: TrackOptions = {}): Promise<LocalTrack> { return this.enable('audio', 'microphone', o) }
  enableCamera(o: TrackOptions = {}): Promise<LocalTrack> { return this.enable('video', 'camera', o) }
  enableScreen(o: TrackOptions = {}): Promise<LocalTrack> { return this.enable('video', 'screen', { ...o, simulcast: false }) }

  /** 산 트랙에 즉시 적용 — owner:'sdk' 만 · id 를 주면 명시 선택 · null 이면 자동 */
  async switchDevice(kind: 'audioinput' | 'videoinput' | 'audiooutput', deviceId: string | null): Promise<void> {
    const pref = this.core.media.preferred
    if (deviceId) pref[kind] = deviceId
    else delete pref[kind]
    if (kind === 'audiooutput') { await wrap(this.core.media.playback.output(deviceId)); return }
    const want = kind === 'audioinput' ? 'audio' : 'video'
    for (const t of [...this.core.media.tracks]) if (t.kind === want && t.owner === 'sdk' && t.source !== 'screen') await wrap(t.switchTo(deviceId))
  }

  audioOutput(deviceId: string | null): Promise<void> { return this.switchDevice('audiooutput', deviceId) }
  permissions(): Promise<{ microphone: PermState; camera: PermState }> { return this.core.media.permissions() }
  startAudio(): Promise<void> { return this.core.media.playback.start() }
}

/** 진단 — log · probe · stats · transition */
export class Diagnostics {
  constructor(private readonly core: Core) {}
  probe(): Promise<unknown> { return this.core.media.probe() }
  setLogLevel(l: Level): void { this.core.book.setLevel(l) }
  logs(): readonly LogEntry[] { return this.core.book.entries() }
  on(name: 'log', fn: Fn<[LogEntry]>): Off
  on(name: 'probe' | 'stats', fn: Fn<[unknown]>): Off
  on(name: 'transition', fn: Fn<[Transition]>): Off
  on(name: string, fn: Fn<never[]>): Off {
    if (name === 'log') return this.core.book.events.on('log', fn as never)
    return this.core.events.on(name, fn as never)
  }
}

/** 클라이언트 객체 — createClient() 가 유일한 생성 경로 · 세션 · 방 · 발행을 소유한다 */
export class OxLensClient {
  readonly session: Session
  readonly media: Media
  readonly diagnostics: Diagnostics
  /** @internal */
  readonly core: Core

  /** @internal */
  constructor(opts: ClientOptions) {
    this.core = new Core(opts)
    this.session = new Session(this.core)
    this.media = new Media(this.core)
    this.diagnostics = new Diagnostics(this.core)
  }

  get rooms(): Map<string, Room> {
    const m = new Map<string, Room>()
    for (const [id, r] of this.core.rooms) if (!r.closed) m.set(id, roomOf(r))
    return m
  }

  get speakingRoom(): Room | null {
    const id = this.core.speakingRoom
    const r = id ? this.core.rooms.get(id) : undefined
    return r ? roomOf(r) : null
  }

  get health(): Health { return this.core.health }

  connect(): Promise<void> { return wrap(this.core.connect()) }
  close(): Promise<void> { return wrap(this.core.close()) }
  setToken(token: string): void { this.core.setToken(token) }

  async join(roomId: string, opts: { mode?: 'listen' | 'talk'; role?: number } = {}): Promise<Room> {
    return roomOf(await wrap(this.core.join(roomId, opts)))
  }

  setSpeakingRoom(roomId: string | null): Promise<void> { return wrap(this.core.setSpeakingRoom(roomId)) }

  /** 입장 전 미리보기 — 401 은 auth reject + tokenRequired */
  async preview(roomId: string): Promise<RoomPreview> {
    const b = (await wrap(this.core.http('GET', `/rooms/${encodeURIComponent(roomId)}`, undefined, true))) as GetRoomRes
    return {
      roomId: b.room_id, name: b.name, capacity: b.capacity, userCount: b.user_count,
      participants: b.participants.map((m) => ({ userId: m.user_id, role: m.role ?? 255, mode: m.select ? 'talk' : 'listen', participantType: (['user', 'recorder', 'bot'] as const)[m.participant_type] ?? 'user', ...(m.metadata !== undefined ? { metadata: m.metadata } : {}) })),
      mediaCodecs: b.media_codecs, version: b.version,
    }
  }

  /** 방 목록 — 표면은 사용자 어휘(camelCase · SDK:RULE-API-LAYERS) */
  async listRooms(): Promise<RoomInfo[]> {
    const b = (await wrap(this.core.http('GET', '/rooms'))) as { rooms: RoomSummary[] }
    return b.rooms.map((r) => ({ roomId: r.room_id, name: r.name, capacity: r.capacity, userCount: r.user_count, createdAt: r.created_at, rec: r.rec }))
  }

  on(name: 'session', fn: Fn<[SessionInfo]>): Off
  on(name: 'tokenRequired', fn: Fn<[{ cause: 'expired' }]>): Off
  on(name: 'closed', fn: Fn<[{ code: number; name: string; retryable: boolean }]>): Off
  on(name: 'rebuilt', fn: Fn<[]>): Off
  on(name: 'link', fn: Fn<[LinkInfo]>): Off
  on(name: 'speakingRoom', fn: Fn<[Room | null]>): Off
  on(name: 'speakingRoomFailed', fn: Fn<[OxLensError]>): Off
  on(name: 'track', fn: Fn<[Room, RemoteTrack]>): Off
  on(name: 'audioPlayback', fn: Fn<[boolean]>): Off
  on(name: string, fn: Fn<never[]>): Off {
    const f = fn as unknown as Fn<unknown[]>
    return this.core.events.on(name, ((...a: unknown[]) => {
      if (name === 'track') f(roomOf(a[0] as RoomCore), remoteOf(a[1] as RemoteCore))
      else if (name === 'speakingRoom') { const id = a[0] as string | null; const r = id ? this.core.rooms.get(id) : undefined; f(r ? roomOf(r) : null) }
      else if (name === 'speakingRoomFailed') f(toError(a[0]))
      else f(...a)
    }) as never)
  }

  once(name: string, fn: Fn<never[]>): Off {
    const off = this.on(name as 'rebuilt', ((...a: never[]) => { off(); (fn as Fn<never[]>)(...a) }) as Fn<[]>)
    return off
  }

  off(name: string): void { this.core.events.off(name) }
}

export function createClient(opts: ClientOptions): OxLensClient {
  return new OxLensClient(opts)
}
