// author: kodeholic (powered by Claude)
// 연§7-5 — 방 상태기. 방은 여럿이라도 ★연결은 미디어 서버마다 하나다(연§4-2).
// 방을 sfu_id 로 묶는 것이 그 단위를 만드는 유일한 수단이다 — 주소는 프로세스를 못 가린다.
import { Clock, systemClock } from '../platform/clock.js'
import { PeerFactory } from '../platform/webrtc.js'
import { RequestFailed, Signaling } from '../internal/signaling.js'
import { Seat } from '../internal/sdp/build.js'
import { ServerConfig } from '../internal/sdp/config.js'
import { OpusFmtpPrefs, PeerLink } from '../internal/transport/link.js'
import { Op } from '../internal/wire.js'
import { request } from './request.js'
import { TrackEntry, TrackStore, Version } from './store.js'

export type RoomState = 'none' | 'joining' | 'joined' | 'leaving'

export interface JoinResponse {
  readonly room_id: string
  readonly participants: readonly { user_id: string; role?: number; select?: boolean }[]
  readonly affiliation: { readonly sub_rooms: readonly string[]; readonly pub_room: string | null }
  readonly server_config: ServerConfig
  readonly tracks: readonly TrackEntry[]
  readonly version: Version
}

export interface JoinOptions {
  readonly select?: boolean
  readonly role?: number
}

/** 연§7-5-3 — 이 넷은 사건별 절차가 있다. 다시 보내도 같으니 곧바로 앱에 알린다. */
const JOIN_SETTLED: readonly number[] = [3001, 4001, 4004, 4005]
/** 연§7-5-5 — 서버에 없는 방은 성공과 같이 다룬다. */
const LEAVE_SETTLED: readonly number[] = [3001, 3002]

export class RoomError extends Error {
  override readonly name = 'RoomError'
  constructor(readonly code: number, readonly failureName: string, why: string) {
    super(why)
  }
}

/** 서버 하나 — 그 위의 방들과 전송로 하나와 보관본 하나. */
export interface Server {
  readonly sfuId: string
  readonly cfg: ServerConfig
  readonly link: PeerLink
  readonly store: TrackStore
  readonly rooms: Set<string>
  /** 연§9-10-3 2-0 — 확정본 신고는 그 연결에 한 번이다. */
  reported?: boolean
}

export interface RoomsOptions {
  readonly peers: PeerFactory
  readonly clock?: Clock
  readonly pcMode?: '1pc' | '2pc'
  /** 정책서 §4-1 `opusFmtpDefault` — 클라가 조립하는 answer 의 opus 선호(연§9-4 예외). */
  readonly opusFmtpDefault?: OpusFmtpPrefs
}

export class Rooms {
  private readonly servers = new Map<string, Server>()
  private readonly state = new Map<string, RoomState>()
  private readonly homeOf = new Map<string, string>()
  private readonly clock: Clock
  /** 연§4-3 — 발행 방은 전역에서 하나다. 서버는 자기 것만 알아 클라가 지킨다. */
  private pubRoom: { room: string; sfuId: string } | null = null

  constructor(private readonly sig: () => Signaling, private readonly opts: RoomsOptions) {
    this.clock = opts.clock ?? systemClock
  }

  stateOf(roomId: string): RoomState { return this.state.get(roomId) ?? 'none' }
  serverOf(roomId: string): Server | undefined {
    const id = this.homeOf.get(roomId)
    return id === undefined ? undefined : this.servers.get(id)
  }

  /** 연§7-3-2 4 — 미디어가 살아 있는 방만 신고한다. 확인 못 한 것은 신고하지 않는다. */
  liveRooms(): readonly string[] {
    return [...this.homeOf]
      .filter(([room, id]) => this.state.get(room) === 'joined' && (this.servers.get(id)?.link.alive() ?? false))
      .map(([room]) => room)
  }

  /** SDK§11-2-1 — 서버마다 품질을 매기는 쪽이 훑는다. */
  allServers(): readonly Server[] { return [...this.servers.values()] }

  /** 연§7-5-7 — 미디어가 죽은 서버들. 방아쇠는 ICE failed 와 media_lost 둘이다. */
  deadServers(now = this.clock.now()): readonly string[] {
    return [...this.servers.values()].filter((s) => s.link.dead(now)).map((s) => s.sfuId)
  }

  /** SDK§7-1 — `AFFILIATION`·JOIN·LEAVE 응답의 `pub_room` 변화가 이 값 하나로 드러난다. */
  get speakingRoom(): string | null { return this.pubRoom?.room ?? null }
  get joined(): readonly string[] { return [...this.state].filter(([, s]) => s === 'joined').map(([r]) => r) }

  /** 연§7-5-1 · §7-5-2 — 발행 방 이동은 옛 서버 pub_deselect 가 먼저다. */
  async join(roomId: string, opts: JoinOptions = {}): Promise<JoinResponse> {
    if (this.state.get(roomId) === 'joined') return Promise.reject(new RoomError(0, 'ALREADY_JOINED', `${roomId} 에 이미 있다`))
    const select = opts.select ?? true
    // 연§7-5-1 2 — 발행 방이 다른 서버에 있으면 그 서버에 pub_deselect 가 먼저다.
    // ★들어갈 방이 어느 서버인지는 응답이 와야 아므로(연§4-2), 아는 같은 서버가 아니면 보낸다.
    // 왕복 하나를 치르고 "발행 방은 전역에서 하나"를 지킨다 — 서버는 자기 것만 안다.
    const sameServer = this.homeOf.get(roomId) === this.pubRoom?.sfuId
    if (select && this.pubRoom !== null && this.pubRoom.room !== roomId && !sameServer) {
      await this.deselectElsewhere(this.pubRoom.sfuId)
    }

    this.state.set(roomId, 'joining')
    const body: Record<string, unknown> = { room_id: roomId, select }
    if (opts.role !== undefined) body.role = opts.role

    let res: JoinResponse
    try {
      res = await request(this.sig(), this.clock, Op.RoomJoin, body, JOIN_SETTLED) as unknown as JoinResponse
    } catch (e) {
      this.state.set(roomId, 'none')
      throw asRoomError(e)
    }

    // 연§6-2 — 서버가 조용히 다른 모드로 돌리는 경로는 없다.
    const want = this.opts.pcMode ?? '2pc'
    if (res.server_config.pc_mode !== want) {
      this.state.set(roomId, 'none')
      throw new RoomError(0, 'PC_MODE_MISMATCH',
        `세션은 ${want} 인데 ${res.server_config.sfu_id} 가 ${res.server_config.pc_mode} 로 답했다`)
    }

    const server = await this.attach(res.server_config)
    server.rooms.add(roomId)
    // 연§9-10-3 2-0 — `1pc` 은 확정본을 ★신고하고 응답을 기다린다. 신고 전에 조립하면
    // 서버가 보내는 PT·확장 번호와 내 SDP 가 어긋나 ★패킷은 오는데 트랙에 안 실린다.
    await this.reportTransport(server, roomId)
    this.homeOf.set(roomId, server.sfuId)
    server.store.apply('join', roomId, res.version, { kind: 'snapshot', tracks: res.tracks })
    if (select) this.pubRoom = { room: roomId, sfuId: server.sfuId }

    await this.renegotiate(server)
    this.state.set(roomId, 'joined')
    return res
  }

  /** 연§7-5-4·§7-5-5 — 통보가 먼저다. 로컬을 먼저 닫으면 서버는 20초 회수로만 안다. */
  async leave(roomId: string): Promise<void> {
    const server = this.serverOf(roomId)
    if (!server || this.state.get(roomId) === 'none') return
    this.state.set(roomId, 'leaving')
    let trouble: unknown
    try {
      await request(this.sig(), this.clock, Op.RoomLeave, { room_id: roomId }, LEAVE_SETTLED)
    } catch (e) {
      // 연§7-5-5 — 서버에 없는 방(3001·3002)은 성공과 같이 다룬다. 붙들 이유가 없다.
      const code = e instanceof RequestFailed ? e.failure.code : 0
      if (code !== 3001 && code !== 3002) trouble = e
    }
    // 방은 어느 쪽이든 내린다 — 서버 회수가 뒤를 맡는다.
    await this.detach(server, roomId)
    if (trouble !== undefined) throw asRoomError(trouble)
  }

  /** 연§7-5-7 — 그 서버 미디어가 죽었다. 다른 서버의 방은 건드리지 않는다. */
  async rebuildServer(sfuId: string): Promise<readonly string[]> {
    const server = this.servers.get(sfuId)
    if (!server) return []
    const rooms = [...server.rooms]
    for (const room of rooms) {
      this.state.set(room, 'none')
      this.homeOf.delete(room)
      server.store.dropRoom(room)
    }
    if (this.pubRoom?.sfuId === sfuId) this.pubRoom = null
    server.link.close()
    this.servers.delete(sfuId)
    return rooms
  }

  closeAll(): void {
    for (const s of this.servers.values()) s.link.close()
    this.servers.clear()
    this.state.clear()
    this.homeOf.clear()
    this.pubRoom = null
  }

  /**
   * 연§6-7 통지가 보관본에 닿는 유일한 문. 갭이면 부르는 쪽이 재동기한다.
   * ★`noop` — 받아들였는데 보관본이 안 바뀌었다. 연§4-6 배달 불변식이 시키는 **빈 델타**가 그것이다
   * (`seq` 를 올린 사건이 나에게는 바꿀 것이 없을 때 번호만 받는다). 재조립을 걸면 안 붙는다.
   */
  applyEvent(roomId: string, version: Version, delta: Parameters<TrackStore['apply']>[3]): 'ok' | 'noop' | 'stale' | 'resync' {
    const server = this.serverOf(roomId)
    if (!server) return 'stale'
    const verdict = server.store.apply('event', roomId, version, delta)
    if (!verdict.accepted) return verdict.why === 'stale' ? 'stale' : 'resync'
    return verdict.added.length + verdict.removed.length + verdict.unreachable.length === 0 && !verdict.reset ? 'noop' : 'ok'
  }

  /** 연§9-8 — 받을 것이 바뀌면 그 서버 하나만 다시 협상한다. */
  async renegotiate(server: Server): Promise<void> {
    const seats = server.store.seats() as readonly Seat[]
    await server.link.negotiateSubscribe(seats)
    // 연§7-5-2 5 · §6-3 — 협상이 성공해야 보낸다. 빠뜨리면 수신 영상이 영구히 검다.
    for (const room of server.rooms) {
      if (this.state.get(room) === 'none') continue
      await request(this.sig(), this.clock, Op.Ready, { room_id: room, type: 'tracks' })
    }
  }

  /** 연§6-3 `READY{type:"transport"}` — `1pc` 전용이고 그 연결에 한 번이다(정§7-4). */
  private async reportTransport(server: Server, roomId: string): Promise<void> {
    if (server.cfg.pc_mode !== '1pc' || server.reported === true) return
    const report = server.link.transportReport()
    await request(this.sig(), this.clock, Op.Ready, {
      room_id: roomId, type: 'transport', extmap: report.extmap, codecs: report.codecs,
    })
    server.reported = true
  }

  private async attach(cfg: ServerConfig): Promise<Server> {
    const known = this.servers.get(cfg.sfu_id)
    // 연§6-2 — 자격이 보관값과 다르면 그 서버 연결을 새로 세운다.
    if (known && known.cfg.ice.publish_ufrag === cfg.ice.publish_ufrag) return known
    known?.link.close()

    const link = new PeerLink(cfg, {
      peers: this.opts.peers,
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
      ...(this.opts.opusFmtpDefault ? { opusFmtpDefault: this.opts.opusFmtpDefault } : {}),
    })
    await link.open()
    const server: Server = { sfuId: cfg.sfu_id, cfg, link, store: known?.store ?? new TrackStore(), rooms: known?.rooms ?? new Set() }
    this.servers.set(cfg.sfu_id, server)
    return server
  }

  /** 연§7-5-5 — 그 서버에 남은 방이 없으면 연결을 닫는다. m-line 은 없애지 않는다. */
  private async detach(server: Server, roomId: string): Promise<void> {
    server.rooms.delete(roomId)
    server.store.dropRoom(roomId)
    this.state.set(roomId, 'none')
    this.homeOf.delete(roomId)
    if (this.pubRoom?.room === roomId) this.pubRoom = null

    if (server.rooms.size === 0) {
      server.link.close()
      this.servers.delete(server.sfuId)
      return
    }
    await this.renegotiate(server)
  }

  private async deselectElsewhere(sfuId: string): Promise<void> {
    if (!this.servers.has(sfuId)) return
    await request(this.sig(), this.clock, Op.Affiliation, { pub_deselect: true })
    this.pubRoom = null
  }
}

function asRoomError(e: unknown): Error {
  if (e instanceof RequestFailed) {
    return new RoomError(e.failure.code, e.failure.name, e.message)
  }
  return e as Error
}
