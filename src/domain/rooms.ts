// author: kodeholic (powered by Claude)
// 연§7-5 — 방 상태기. 방은 여럿이라도 ★연결은 미디어 서버마다 하나다(연§4-2).
// 방을 sfu_id 로 묶는 것이 그 단위를 만드는 유일한 수단이다 — 주소는 프로세스를 못 가린다.
import { Clock, systemClock } from '../platform/clock.js'
import { PeerFactory } from '../platform/webrtc.js'
import { RequestFailed, Signaling } from '../internal/signaling.js'
import { Seat } from '../internal/sdp/build.js'
import { ServerConfig } from '../internal/sdp/config.js'
import { OpusFmtpPrefs, PeerLink, TransportReport } from '../internal/transport/link.js'
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
  /**
   * 연§9-10-3 2 — ★**서버를 알기 전에 세운 연결**(`1pc`).
   *
   * 번호표를 `ROOM_JOIN` 요청에 실으려면 offer 가 먼저여야 하는데, 그때는 아직
   * `server_config` 가 없다. ★**번호표를 낸 바로 그 연결**을 응답 뒤에 붙인다 —
   * 다시 만들면 그 offer 의 PT·SSRC 와 어긋난다.
   */
  private seeded: PeerLink | null = null
  /**
   * ★**브라우저의 번호표** — 한 번 재면 그 뒤 입장은 그대로 쓴다(연§6-2).
   *
   * ★번호는 ★**브라우저가 정하는 것**이라 서버가 바뀌어도 같다. 입장마다 다시 재면
   * 그때마다 PC 를 새로 만들어 버리게 된다.
   */
  private table: TransportReport | null = null
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

    // ★★**연§9-10-3 2③ — `1pc` 은 번호표를 `ROOM_JOIN` **전**에 만든다.**
    //   ★한 BUNDLE 안에서 PT·확장 ID 는 코덱·URI 마다 하나여야 하고, 내 번호를 먼저
    //   알려야 서버가 받기 PT 를 겹치지 않게 배정한다(§4-2-1 ④).
    //   ★옛 `READY{transport}` 갈래는 확정본 **뒤에** 신고해 첫 배정을 되돌리는 재협상이
    //   필요했다 — 14차가 없앴다(그 갈래를 보내면 서버가 `1002` 로 거절한다).
    // ★★**번호표는 브라우저의 것이지 서버의 것이 아니다** — 한 번 재면 그 뒤 입장은
    //   그 값을 그대로 쓴다. ★안 그러면 ★**입장마다 PC 를 하나씩 새로 만들어** 버리고
    //   (§9-10-3 2 는 *"연결이 없으면 만든다"* 이다), 그 버려진 연결이 진단·계측의
    //   *"마지막 PC"* 를 가로챈다(실측 20260913 — 3층 `mlines` 가 빈 배열을 봤다).
    let seed: PeerLink | null = null
    if (this.opts.pcMode === '1pc') {
      if (this.table === null) {
        seed = await this.seedLink()
        this.table = await seed.seedOffer()
      }
      body.extmap = this.table.extmap
      body.codecs = this.table.codecs
    }

    let res: JoinResponse
    try {
      res = await request(this.sig(), this.clock, Op.RoomJoin, body, JOIN_SETTLED) as unknown as JoinResponse
    } catch (e) {
      this.state.set(roomId, 'none')
      // ★씨앗을 놓는다 — 안 놓으면 다음 입장이 옛 offer 를 들고 간다.
      seed?.close()
      this.seeded = null
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

  /**
   * 연§4-6-3 — ★**`version` 없는 `TRACK_EVENT{add}`** — 배정만 바뀌었다.
   * 견주기 밖이라 갭·stale 판정을 태우지 않는다.
   */
  applyAssign(roomId: string, tracks: readonly TrackEntry[]): 'ok' | 'noop' | 'stale' {
    const server = this.serverOf(roomId)
    if (!server) return 'stale'
    const verdict = server.store.applyAssign(roomId, tracks)
    if (!verdict.accepted) return 'stale'
    return verdict.added.length === 0 ? 'noop' : 'ok'
  }

  /** 연§9-8 — 받을 것이 바뀌면 그 서버 하나만 다시 협상한다. */
  async renegotiate(server: Server): Promise<void> {
    // ★캐스트를 두지 않는다 — 형이 어긋나면 그 자리에서 걸려야 한다(조립은 되돌릴 수 없다).
    const seats: readonly Seat[] = server.store.seats()
    await server.link.negotiateSubscribe(seats)
    // 연§7-5-2 5 · §6-3 — 협상이 성공해야 보낸다. 빠뜨리면 수신 영상이 영구히 검다.
    for (const room of server.rooms) {
      if (this.state.get(room) === 'none') continue
      await request(this.sig(), this.clock, Op.Ready, { room_id: room, type: 'tracks' })
    }
  }

  /** 연§9-10-3 2①② — 서버를 알기 전에 세우는 씨앗 연결(`1pc` 전용). */
  private async seedLink(): Promise<PeerLink> {
    if (this.seeded) return this.seeded
    const link = new PeerLink(null, {
      peers: this.opts.peers,
      pcMode: '1pc',
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
      ...(this.opts.opusFmtpDefault ? { opusFmtpDefault: this.opts.opusFmtpDefault } : {}),
    })
    this.seeded = link
    return link
  }

  private async attach(cfg: ServerConfig): Promise<Server> {
    const known = this.servers.get(cfg.sfu_id)
    // 연§6-2 — 자격이 보관값과 다르면 그 서버 연결을 새로 세운다.
    if (known && known.cfg.ice.publish_ufrag === cfg.ice.publish_ufrag) {
      // ★연§9-10-3 2④ — ★**이미 붙은 서버면 씨앗을 버린다.** 두 연결을 남기면
      //   같은 서버에 전송로가 둘이 되어 그 방 미디어가 어느 쪽으로 오는지 갈린다.
      this.seeded?.close()
      this.seeded = null
      return known
    }
    known?.link.close()

    // ★씨앗이 있으면 그것을 쓴다 — 번호표를 낸 바로 그 연결이어야 한다(다시 만들면 어긋난다).
    const seeded = this.seeded
    this.seeded = null
    const link = seeded ?? new PeerLink(cfg, {
      peers: this.opts.peers,
      pcMode: this.opts.pcMode ?? '2pc',
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
      ...(this.opts.opusFmtpDefault ? { opusFmtpDefault: this.opts.opusFmtpDefault } : {}),
    })
    if (seeded) {
      seeded.bind(cfg)
      // 연§9-10-3 2④ — ★**이 answer 가 첫 협상 확정본이다.**
      await seeded.seedAnswer()
    } else {
      await link.open()
    }
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
