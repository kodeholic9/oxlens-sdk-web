// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-API-HANDLES · SDK:RULE-API-ASYNC · SDK:IMPL-ROOM-API · SDK:IMPL-FLR-BUTTON · SDK:IMPL-PUB-API · SDK:IMPL-TRK-RECEIVE · model: claude-opus-5-5
import type { RoomCore, RoomState } from '../domain/rooms.js'
import type { RemoteCore, RemoteInfo } from '../domain/remote.js'
import { LocalCore, type LocalState, type Owner, type EndReason, type TrackOptions, type VideoEncoding, type AudioEncoding } from '../domain/media-registry.js'
import type { FloorCore, PttState as CorePttState, PressSource } from '../domain/floor.js'
import type { Participant, Permission } from '../domain/store.js'
import type { LinkState } from '../domain/links.js'
import type { Core } from '../domain/session.js'
import { Fault, fromFailure, stateFault } from '../platform/fault.js'
import { OxLensError, toError, wrap } from './errors.js'

type Fn<A extends unknown[]> = (...a: A) => void
type Off = () => void

const ROOMS = new WeakMap<RoomCore, Room>()
const REMOTES = new WeakMap<RemoteCore, RemoteTrack>()
const LOCALS = new WeakMap<LocalCore, LocalTrack>()

export function roomOf(c: RoomCore): Room { let h = ROOMS.get(c); if (!h) { h = new Room(c); ROOMS.set(c, h) } return h }
export function remoteOf(c: RemoteCore): RemoteTrack { let h = REMOTES.get(c); if (!h) { h = new RemoteTrack(c); REMOTES.set(c, h) } return h }
export function localOf(c: LocalCore): LocalTrack { let h = LOCALS.get(c); if (!h) { h = new LocalTrack(c); LOCALS.set(c, h) } return h }

/** 앱 핸들러를 사건 주인에게 그대로 건넨다 — 실패 사실은 표면 오류형으로, 코어는 핸들로 바꿔서 */
function mapArg(a: unknown): unknown {
  if (a instanceof Fault) return toError(a)
  return a
}

export type PttState = Omit<CorePttState, 'lastError'> & { readonly lastError?: OxLensError }

function pttOut(s: CorePttState): PttState {
  if (!s.lastError) return s as PttState
  return { ...s, lastError: toError(s.lastError) }
}

/** 방 핸들 — room_id 로만 식별 · 닫히면 client.rooms 에서 빠진다 · 다시 join 하면 새 핸들 */
export class Room {
  readonly ptt: Ptt
  readonly audio: RoomAudio
  /** @internal */
  constructor(readonly core: RoomCore) {
    this.ptt = new Ptt(core.floor, core)
    this.audio = new RoomAudio(core)
  }

  get id(): string { return this.core.id }
  get state(): RoomState { return this.core.state }
  get mode(): 'listen' | 'talk' { return this.core.mode }
  get server(): string | null { return this.core.sfuId }
  get link(): LinkState { return this.core.link?.state ?? (this.core.state === 'closed' ? 'closed' : 'connecting') }
  get rebuilding(): boolean { return this.core.rebuilding || this.link === 'rebuilding' }
  get participants(): Participant[] { return [...this.core.store.members.values()] }
  get permission(): Permission { return this.core.permission }
  get tracks(): RemoteTrack[] { return [...this.core.remotes.values()].filter((r) => r.mediaStreamTrack !== null).map(remoteOf) }
  get mediaCodecs(): { audio?: string; video?: string } { return { ...this.core.store.mediaCodecs } }

  leave(): Promise<void> { return wrap(this.core.leave()) }

  async sendMessage(content: string): Promise<{ msgId: string }> {
    const r = await wrap(this.core.core.sig.request('MESSAGE', { room_id: this.id, content }))
    if (!r.ok) throw toError(fromFailure(r.body))
    return { msgId: String((r.body as { msg_id?: string }).msg_id ?? '') }
  }

  on(name: 'track', fn: Fn<[RemoteTrack]>): Off
  on(name: 'trackUnreachable', fn: Fn<[RemoteInfo]>): Off
  on(name: 'participants', fn: Fn<[Participant[]]>): Off
  on(name: 'permission', fn: Fn<[{ userId: string; permission: Permission; mine: boolean }]>): Off
  on(name: 'message', fn: Fn<[{ userId: string; content: string }]>): Off
  on(name: 'error' | 'joinFailed', fn: Fn<[OxLensError]>): Off
  on(name: 'forced', fn: Fn<[{ cause: string }]>): Off
  on(name: 'joined' | 'left' | 'resync', fn: Fn<[]>): Off
  on(name: 'state', fn: Fn<[RoomState]>): Off
  on(name: string, fn: Fn<never[]>): Off {
    const f = fn as unknown as Fn<unknown[]>
    return this.core.events.on(name, ((...a: unknown[]) => {
      if (name === 'track') f(remoteOf(a[0] as RemoteCore))
      else f(...a.map(mapArg))
    }) as never)
  }

  once(name: string, fn: Fn<never[]>): Off {
    const off = this.on(name as 'joined', ((...a: never[]) => { off(); (fn as Fn<never[]>)(...a) }) as Fn<[]>)
    return off
  }

  off(name: string): void { this.core.events.off(name) }
}

/** 방의 수신 오디오 — SDK 가 재생한다 */
export class RoomAudio {
  constructor(private readonly core: RoomCore) {}
  get muted(): boolean { return this.core.audio.muted }
  get volume(): number { return this.core.audio.volume }
  setMuted(m: boolean): void { this.core.setAudioMuted(m) }
  setVolume(v: number): void { this.core.setAudioVolume(v) }
}

/** 발언권 표면 — room.ptt */
export class Ptt {
  constructor(private readonly core: FloorCore, private readonly room: RoomCore) {}

  get state(): PttState { return pttOut(this.core.snapshot()) }
  get input(): 'hold' | 'toggle' { return this.core.input }
  set input(v: 'hold' | 'toggle') { this.core.input = v }
  get priority(): number { return this.core.priority }
  set priority(v: number) { this.core.priority = Math.max(0, Math.min(255, Math.floor(v))) }

  press(o?: { source?: PressSource }): Promise<void> { return wrap(this.core.press(o)) }
  release(): Promise<void> { return wrap(this.core.release()) }

  /** 반이중 마이크 미리 발행(미리 데우기) — 부르지 않아도 press 의 첫 단계가 한다 */
  async enable(o: TrackOptions & { track?: MediaStreamTrack } = {}): Promise<void> {
    const media = this.room.core.media
    await wrap(this.room.core.untilActive())
    if (o.track) {
      const t = new LocalCore(this.room.core, 'audio', 'external', o.track, 'external', { ...o, profile: o.profile ?? 'ptt' })
      await wrap(t.publish(this.room, 'half'))
      return
    }
    await wrap(media.ensureHalfMic(this.room, o))
  }

  /** 반이중 영상 — 이 방의 미디어 코덱으로 · 송출은 발언권 게이트를 따른다 */
  async enableVideo(o: TrackOptions & { track?: MediaStreamTrack } = {}): Promise<LocalTrack> {
    await wrap(this.room.core.untilActive())
    if (!this.room.permission.publishVideo) throw toError(stateFault('STATE_NO_PERMISSION', { denied: ['publish_video'] }))
    const media = this.room.core.media
    let t: LocalCore
    if (o.track) {
      t = new LocalCore(this.room.core, 'video', 'external', o.track, 'external', o)
    } else t = await wrap(media.acquireOne('video', 'camera', { ...o, simulcast: false }, 'sdk'))
    try { await wrap(t.publish(this.room, 'half')) } catch (e) { if (!o.track) t.track.stop(); throw e }
    return localOf(t)
  }

  /** cold 를 미룬다(정책:sdk.micColdAfterMs) */
  keepWarm(ms = 0): void { this.room.core.media.halfMic(this.room.sfuId)?.keepWarm(ms) }

  on(name: 'state' | 'granted' | 'denied' | 'revoked' | 'queued' | 'released', fn: Fn<[PttState]>): Off
  on(name: 'speaker', fn: Fn<[{ userId: string | null; trackIds: string[] }]>): Off
  on(name: string, fn: Fn<never[]>): Off {
    const f = fn as unknown as Fn<unknown[]>
    return this.core.events.on(name, ((...a: unknown[]) => f(...a.map((x) => (name === 'speaker' ? x : pttOut(x as CorePttState))))) as never)
  }

  off(name: string): void { this.core.events.off(name) }
}

/** 로컬 트랙 — 발행 단 · 소유권 · 게이트 */
export class LocalTrack {
  /** @internal */
  constructor(readonly core: LocalCore) {}

  get kind(): 'audio' | 'video' { return this.core.kind }
  get source(): string { return this.core.source }
  get state(): LocalState { return this.core.state }
  get owner(): Owner { return this.core.owner }
  get server(): string | null { return this.core.server }
  get duplex(): 'full' | 'half' { return this.core.duplex }
  get muted(): boolean { return this.core.muted }
  get trackId(): string | null { return this.core.trackId }
  get mediaStreamTrack(): MediaStreamTrack { return this.core.mediaStreamTrack }
  get simulcast(): boolean { return this.core.simulcast }

  stop(): Promise<void> { return wrap(this.core.stop()) }
  setMuted(m: boolean): Promise<void> { return wrap(this.core.setMuted(m)) }
  setDuplex(d: 'full' | 'half'): Promise<void> { return wrap(this.core.setDuplex(d)) }
  setEncoding(e: VideoEncoding & AudioEncoding): Promise<void> { return wrap(this.core.setEncoding(e)) }
  replaceSource(t: MediaStreamTrack | null): Promise<void> { return wrap(this.core.replaceSource(t)) }
  getStats(): Promise<RTCStatsReport> { return this.core.getStats() }

  on(name: 'ended', fn: Fn<[{ reason: EndReason }]>): Off
  on(name: 'silence' | 'published', fn: Fn<[]>): Off
  on(name: 'publishFailed', fn: Fn<[OxLensError]>): Off
  on(name: 'state', fn: Fn<[LocalState]>): Off
  on(name: string, fn: Fn<never[]>): Off {
    const f = fn as unknown as Fn<unknown[]>
    return this.core.events.on(name, ((...a: unknown[]) => f(...a.map(mapArg))) as never)
  }

  off(name: string): void { this.core.events.off(name) }
}

/** 받는 트랙 — 방으로 온다 */
export class RemoteTrack {
  /** @internal */
  constructor(readonly core: RemoteCore) {}

  get id(): string { return this.core.id }
  get type(): 'individual' | 'slot' { return this.core.type }
  get kind(): 'audio' | 'video' { return this.core.kind }
  get userId(): string | undefined { return this.core.userId }
  get roomId(): string { return this.core.room.id }
  get active(): boolean { return this.core.active }
  get muted(): boolean | undefined { return this.core.muted }
  get scalability(): string | undefined { return this.core.scalability }
  get receiving(): boolean { return this.core.receiving }
  get mediaStreamTrack(): MediaStreamTrack { return this.core.mediaStreamTrack as MediaStreamTrack }
  get volume(): number { return this.core.volume }
  set volume(v: number) { this.core.setVolume(v) }

  attach(el: HTMLMediaElement): void { try { this.core.attach(el) } catch (e) { throw toError(e) } }
  detach(el?: HTMLMediaElement): void { this.core.detach(el) }
  setLayer(v: { spatial?: number; temporal?: number; paused?: boolean; priority?: number }): Promise<void> { return wrap(this.core.setLayer(v)) }
  setReceive(o: { playoutDelayMs: number | null }): void { this.core.setReceive(o) }
  getStats(): Promise<RTCStatsReport> { return this.core.getStats() }

  on(name: 'ended' | 'receiving', fn: Fn<[]>): Off
  on(name: 'active', fn: Fn<[{ active: boolean; mediaStreamTrack: MediaStreamTrack | null }]>): Off
  on(name: 'muted', fn: Fn<[boolean]>): Off
  on(name: string, fn: Fn<never[]>): Off {
    return this.core.events.on(name, fn as never)
  }

  off(name: string): void { this.core.events.off(name) }
}

/** 발언 방 기준 — 발행에 쓰는 방 · 없으면 STATE_NO_SPEAKING_ROOM */
export function speakingRoomCore(core: Core): RoomCore {
  const id = core.speakingRoom
  const r = id ? core.rooms.get(id) : undefined
  if (!r) throw toError(stateFault('STATE_NO_SPEAKING_ROOM'))
  return r
}
