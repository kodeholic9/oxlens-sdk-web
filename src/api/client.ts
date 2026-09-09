// author: kodeholic (powered by Claude)
// SDK§3·§4 — 표면과 안쪽을 잇는 자리. 통지는 여기 한 루프에서 보관본으로 흘러 앱 이벤트가 된다.
import { Directory } from '../domain/directory.js'
import { Playback } from '../domain/playback.js'
import { DiagnosticsHandle } from './diagnostics.js'
import { ResumeOutcome } from '../domain/session.js'
import { FloorRoom } from '../domain/floor.js'
import { MediaRegistry } from '../domain/media-registry.js'
import { grade, StatsMeter, STATS_INTERVAL_MS, worst } from '../domain/quality.js'
import { Rooms, Server } from '../domain/rooms.js'
import { Session } from '../domain/session.js'
import { TrackEntry, Version } from '../domain/store.js'
import { decode as decodeMbcp, SVC_MBCP, unframe } from '../internal/mbcp.js'
import { Notification, Signaling } from '../internal/signaling.js'
import { PeerLink } from '../internal/transport/link.js'
import { Op } from '../internal/wire.js'
import { Clock, systemClock } from '../platform/clock.js'
import { browserHttp, Http } from '../platform/http.js'
import { AudioOut, browserAudio, headlessAudio } from '../platform/audio.js'
import { Devices } from '../platform/media.js'
import { browserPage, PageLifecycle } from '../platform/page.js'
import { connectWebSocket, Socket } from '../platform/socket.js'
import { browserPeers, PeerFactory } from '../platform/webrtc.js'
import { Bus } from './emitter.js'
import { toOxLensError } from './errors.js'
import { MediaSurface } from './media.js'
import { NotImplementedError } from './not-implemented.js'
import { PttHandle, roomOf } from './ptt.js'
import { LayerTarget, RoomHandle } from './room.js'
import {
  ClientEvents, ClientOptions, ConnectionQuality, Diagnostics, JoinOptions, Media, OxLensClient,
  OxLensError, Participant, Room, RoomPreview, RoomSummary, SessionInfo,
} from './types.js'

/** 연§8-4 타이머들이 도는 눈금. 재전송 간격(0.5초)보다 촘촘해야 한다. */
const TICK_MS = 100

/** 앱이 갈아 끼울 수 있는 자리 — 1층이 브라우저 없이 이 결선을 잰다. */
export interface Wiring {
  readonly connect?: (url: string) => Promise<Socket>
  readonly peers?: PeerFactory
  readonly devices?: Devices
  readonly audioOut?: AudioOut
  readonly clock?: Clock
  readonly http?: Http
  readonly page?: PageLifecycle
}

const PT_NAMES = ['user', 'recorder', 'bot'] as const

/** 연§4-4 명단 원소 — 종류·신원은 서버가 토큰에서 채운 값이다(클라 선언이 아니다). */
function participantOf(p: {
  user_id: string; role?: number; select?: boolean; participant_type?: number; metadata?: unknown
}): Participant {
  return {
    userId: p.user_id,
    role: p.role ?? 255,
    mode: p.select === false ? 'listen' : 'talk',
    participantType: PT_NAMES[p.participant_type ?? 0] ?? 'user',
    ...(p.metadata === undefined ? {} : { metadata: p.metadata }),
  }
}

export class Client extends Bus<ClientEvents> implements OxLensClient {
  private readonly sess: Session
  private readonly roomsDomain: Rooms
  private readonly diag: DiagnosticsHandle
  private readonly playback: Playback
  private readonly devicePort: Devices
  private readonly registry: MediaRegistry
  private readonly surface: MediaSurface
  private readonly handles = new Map<string, RoomHandle>()
  private readonly ptts = new Map<string, PttHandle>()
  private readonly directory: Directory
  /** 연§5-5 — 여러 방을 다 받은 뒤 한 번 조립한다. 방마다 조립하면 왕복이 방 수만큼 난다. */
  private readonly desynced = new Set<string>()
  private resyncing = false
  private readonly pumping = new Set<string>()
  private ticking = false
  private readonly clock: Clock
  private userId: string | null = null
  private pcMode: '1pc' | '2pc' | null = null
  private lastClose: { code: number; name: string } | null = null
  private token: string
  /** SDK§11-2-1 — 서버마다 매긴 것의 최악값. `active` 밖에서는 `lost` 다. */
  private quality: ConnectionQuality = 'good'
  private readonly meters = new Map<string, StatsMeter>()
  private readonly statsInterval: number
  private metering = false
  private readonly adaptive: boolean

  constructor(opts: ClientOptions, wiring: Wiring = {}) {
    super()
    this.clock = wiring.clock ?? systemClock
    this.token = opts.token
    this.statsInterval = opts.statsIntervalMs ?? STATS_INTERVAL_MS
    this.adaptive = opts.adaptiveStream !== false
    const peers = wiring.peers ?? browserPeers
    const mode = opts.pcMode === '1pc' ? '1pc' : '2pc'
    this.roomsDomain = new Rooms(() => this.requireSignaling(), { peers, clock: this.clock, pcMode: mode })
    this.devicePort = wiring.devices ?? requireBrowserDevices()
    this.playback = new Playback(wiring.audioOut ?? defaultAudioOut())
    // SDK§12-1 — 허용이 바뀌면 앱에 알린다. ★주인이 훑는다(콜백을 넘기지 않는다).
    void this.drainPlayback()
    // SDK§11-1 — 조립 분담. ★모르는 값은 `null` 로 채우지 않고 **뺀다**(연§6-6).
    this.diag = new DiagnosticsHandle({
      publishing: () => this.registry.all,
      subscribed: () => this.subscribedTracks(),
      state: () => this.probeState(),
      devices: () => this.surface.devices.list().then((l) => l.map((d) => ({ ...d }))),
      permissions: () => this.surface.permissions().then((p) => ({ ...p })),
    })
    this.registry = new MediaRegistry(() => this.requireSignaling(), {
      devices: this.devicePort,
      clock: this.clock,
      ...(opts.deviceAcquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: opts.deviceAcquireTimeoutMs }),
    })
    this.surface = new MediaSurface(this.registry, { publishTarget: () => this.publishTarget() }, this.devicePort, this.playback)
    this.directory = new Directory(
      opts.base.replace(/\/$/, ''),
      { token: () => this.token, sessionId: () => this.sess.info?.session_id ?? null },
      wiring.http ?? browserHttp,
    )
    this.sess = new Session({
      url: wsUrl(opts.base),
      token: opts.token,
      pcMode: mode,
      ...(opts.clientVer === undefined ? {} : { clientVer: opts.clientVer }),
      connect: wiring.connect ?? connectWebSocket,
      live: { rooms: () => this.roomsDomain.liveRooms(), publish: () => this.registry.liveTracks() },
      clock: this.clock,
    })
    // SDK§12-1 — 페이지를 떠나면 close() 를 시도하되 보장하지 않는다. 못 보내면 서버의 두 시계가 회수한다.
    if (opts.disconnectOnPageLeave !== false) (wiring.page ?? browserPage).onLeave(() => { void this.close() })
  }

  get rooms(): ReadonlyMap<string, Room> { return this.handles }
  get media(): Media { return this.surface }
  get speakingRoom(): Room | null {
    const id = this.roomsDomain.speakingRoom
    return id === null ? null : this.handles.get(id) ?? null
  }
  get diagnostics(): Diagnostics { return this.diag }

  get session(): SessionInfo {
    return {
      state: this.sess.state,
      recovering: this.sess.recovering,
      userId: this.userId,
      pcMode: this.pcMode,
      quality: this.sess.state === 'active' ? this.quality : 'lost',
      ...(this.lastClose === null ? {} : { reason: this.lastClose }),
    }
  }

  async connect(): Promise<void> {
    try {
      const bind = await this.sess.connect()
      this.userId = bind.user_id
      this.pcMode = bind.pc_mode
    } catch (e) {
      throw toOxLensError(e)
    }
    void this.pumpNotifications()
    void this.pumpSession()
    void this.meter()
    this.emit('session', this.session)
  }

  setToken(token: string): void {
    this.token = token
    this.sess.setToken(token)
  }

  /** SDK§10-6 — 방마다 나가고 그 다음 전송로, 마지막이 소켓이다. */
  async close(): Promise<void> {
    for (const id of [...this.handles.keys()]) await this.leave(id).catch(() => {})
    this.ptts.clear()
    this.roomsDomain.closeAll()
    this.sess.close()
    this.handles.clear()
  }

  async join(roomId: string, opts: JoinOptions = {}): Promise<Room> {
    const mode = opts.mode ?? 'listen'
    let res
    try {
      res = await this.roomsDomain.join(roomId, {
        select: mode === 'talk',
        ...(opts.role === undefined ? {} : { role: opts.role }),
      })
    } catch (e) {
      throw toOxLensError(e)
    }
    const handle = new RoomHandle(roomId, mode, res.server_config.sfu_id, {
      leave: (id) => this.leave(id),
      sendMessage: (id, content) => this.sendMessage(id, content),
      subscribeLayer: (id, targets) => this.subscribeLayer(id, targets),
      setRoomAudio: (id, patch) => this.playback.setRoom(id, patch),
      report: (id, e) => this.handles.get(id)?.emit('error', toOxLensError(e)),
    }, this.adaptive)
    handle.state = 'joined'
    const ptt = new PttHandle(
      new FloorRoom(roomId, this.userId ?? '', 'hold'),
      this.registry,
      {
        target: (id) => this.targetOf(id),
        selectSpeaking: (id) => this.setSpeakingRoom(id),
        slotVideoCodec: (id) => this.slotVideoCodec(id),
        wrap: (inner) => this.surface.handleOf(inner),
      },
      this.clock,
    )
    this.ptts.set(roomId, ptt)
    handle.attachPtt(ptt)
    this.pumpFloor(roomId)
    this.startTicker()
    handle.setParticipants(res.participants.map(participantOf))
    this.handles.set(roomId, handle)
    // SDK§6-2 — 초기 트랙은 resolve 다음 tick 에 온다. 그 사이 await 를 두면 방 리스너는 놓친다.
    void Promise.resolve().then(() => { this.harvest(roomId) })
    return handle
  }

  async setSpeakingRoom(roomId: string | null): Promise<void> {
    if (roomId === null) {
      await this.requireSignaling().request(Op.Affiliation, { pub_deselect: true })
      return
    }
    await this.requireSignaling().request(Op.Affiliation, { pub_select: roomId })
  }

  /** 연§5-5 ① — 정원을 먹지 않고 명단에 오르지 않는다. 들어갈지 정하려고 보는 것이다. */
  async preview(roomId: string): Promise<RoomPreview> {
    try {
      const d = await this.directory.preview(roomId)
      return {
        ...summaryOf(d),
        version: d.version,
        participants: d.participants.map(participantOf),
      }
    } catch (e) {
      throw this.surfaced(e)
    }
  }

  async listRooms(): Promise<readonly RoomSummary[]> {
    try {
      return (await this.directory.list()).rooms.map(summaryOf)
    } catch (e) {
      throw this.surfaced(e)
    }
  }

  /** SDK§3-2 — HTTP 401(`2003`)은 `auth` reject 이면서 `tokenRequired` 다. 둘 중 하나만 내면 앱이 새 토큰을 못 낸다. */
  private surfaced(e: unknown): OxLensError {
    const err = toOxLensError(e)
    if (err.code === 2003) this.emit('tokenRequired', { cause: 'expired' })
    return err
  }

  /** SDK§10-6 — 게이트 닫기가 먼저다. 전송로를 놓은 뒤 sender 를 만지면 닫힌 연결에 손댄다. */
  /** 연§6-5 — 응답의 msg_id 로 내 것을 안다(에코가 오지 않는다). */
  private async sendMessage(roomId: string, content: string): Promise<{ msgId: string }> {
    try {
      const res = await this.requireSignaling().request(Op.Message, { room_id: roomId, content })
      return { msgId: String(res.msg_id) }
    } catch (e) {
      throw toOxLensError(e)
    }
  }

  /** 연§6-3 `SUBSCRIBE_LAYER` — 응답은 빈 body 다. 대상별 실패는 실패가 아니다(조용히 건너뛴다). */
  /**
   * 연§6-3 — ★"그 방의 무전 코덱" 은 슬롯 트랙이 알려준다. 보관본에서 읽는다.
   * ★없으면 `null` 이고, 그때는 첫 화자가 정하는 자리다(추론하지 않는다).
   */
  private slotVideoCodec(roomId: string): { codec: string; fmtp?: string } | null {
    const server = this.roomsDomain.serverOf(roomId)
    if (!server) return null
    for (const t of server.store.tracks(roomId)) {
      if (t.kind !== 'video' || t.duplex !== 'half' || t.codec === undefined) continue
      return { codec: t.codec, ...(t.fmtp === undefined ? {} : { fmtp: t.fmtp }) }
    }
    return null
  }

  /** SDK§11-1 — 보관본 + 그 서버의 전송로. 계수는 `PeerLink` 가 ssrc 로 골라 준다. */
  private subscribedTracks(): Array<{ entry: TrackEntry; link: PeerLink | null }> {
    const out: Array<{ entry: TrackEntry; link: PeerLink | null }> = []
    for (const [roomId] of this.handles) {
      const server = this.roomsDomain.serverOf(roomId)
      if (!server) continue
      for (const entry of server.store.tracks(roomId)) {
        out.push({ entry, link: server.link })
      }
    }
    return out
  }

  /** ★`state` 는 **항상** 있다 — 못 모은 칸이 없다는 뜻이 아니라, 이건 늘 아는 값이다. */
  private probeState(): Record<string, unknown> {
    return {
      session: { state: this.sess.state, userId: this.userId, pcMode: this.pcMode },
      rooms: [...this.handles.values()].map((r) => ({
        room_id: r.id, mode: r.mode, state: r.state, server: r.server,
        ptt: { phase: r.ptt.state.phase, mic: r.ptt.state.mic },
      })),
      speakingRoom: this.roomsDomain.speakingRoom,
    }
  }

  private async drainPlayback(): Promise<void> {
    for await (const allowed of this.playback.changes()) this.emit('audioPlayback', allowed)
  }

  private async subscribeLayer(roomId: string, targets: readonly LayerTarget[]): Promise<void> {
    try {
      await this.requireSignaling().request(Op.SubscribeLayer, { room_id: roomId, targets })
    } catch (e) {
      throw toOxLensError(e)
    }
  }

  private async leave(roomId: string): Promise<void> {
    const handle = this.handles.get(roomId)
    if (handle) handle.state = 'leaving'
    this.ptts.get(roomId)?.reset('left')
    this.ptts.delete(roomId)
    try {
      await this.roomsDomain.leave(roomId)
    } finally {
      if (handle) handle.state = 'closed'
      this.handles.delete(roomId)
    }
  }

  private publishTarget(): { link: PeerLink; roomId: string; sfuId: string } | null {
    const roomId = this.roomsDomain.speakingRoom
    return roomId === null ? null : this.targetOf(roomId)
  }

  private targetOf(roomId: string): { link: PeerLink; roomId: string; sfuId: string } | null {
    const server = this.roomsDomain.serverOf(roomId)
    return server === undefined ? null : { link: server.link, roomId, sfuId: server.sfuId }
  }

  /** 연§11 — 발언권 권위는 DC 단일이다. 방 가르기는 0x1D 가 한다. */
  private pumpFloor(roomId: string): void {
    const server = this.roomsDomain.serverOf(roomId)
    if (!server) return
    const sfuId = server.sfuId
    if (this.pumping.has(sfuId)) return
    const channel = server.link.channel
    if (!channel) return
    this.pumping.add(sfuId)
    void (async () => {
      for await (const raw of channel.messages()) {
        const wrapped = unframe(raw)
        // 연§11-6 — svc 0x02 는 확장이다. 보내지도 읽지도 않는다.
        if (!wrapped || wrapped.svc !== SVC_MBCP) continue
        const msg = decodeMbcp(wrapped.payload)
        if (!msg) continue
        const room = roomOf(msg)
        if (room === undefined) continue
        this.ptts.get(room)?.deliver(msg)
      }
      this.pumping.delete(sfuId)
      // 연§7-7-8 — DC 가 끊겼다. 그 서버 방의 표시를 믿을 수 없다.
      for (const [id, ptt] of this.ptts) if (this.handles.get(id)?.server === sfuId) ptt.setTrusted(false)
    })()
  }

  /** 연§8-4 — 재전송·T132·큐 폴링이 도는 유일한 시계다. */
  private startTicker(): void {
    if (this.ticking) return
    this.ticking = true
    void (async () => {
      while (this.ptts.size > 0) {
        await this.clock.sleep(TICK_MS)
        for (const ptt of this.ptts.values()) ptt.tick()
      }
      this.ticking = false
    })()
  }

  /** 연§7-0-2 — ACK 은 signaling 이 이미 보냈다. 여기는 내용만 다룬다. */
  private async pumpNotifications(): Promise<void> {
    const sig = this.sess.signaling
    if (!sig) return
    for await (const note of sig.notifications()) {
      try {
        this.route(note)
      } catch (e) {
        const roomId = String(note.body.room_id ?? '')
        this.handles.get(roomId)?.emit('error', toOxLensError(e))
      }
    }
  }

  /**
   * SDK§7-1 — ★**wire 통지 → 표면 사건**의 번역표가 사는 자리다. 그 절의 행마다 아래 분기가
   * 하나씩 대응한다(`PARTICIPANT_EVENT`·`TRACK_EVENT`·`TRACK_STATE`·`ROOM_EVENT`·`MESSAGE`).
   * ★여기서 이름을 바꾸면 앱이 듣던 사건이 소리 없이 사라진다 — 표면 어휘의 권위는 그 절이다.
   */
  private route(note: Notification): void {
    const roomId = String(note.body.room_id ?? '')
    const handle = this.handles.get(roomId)
    if (!handle) return
    const version = note.body.version as Version | undefined

    // ★연§4-6 — seq 는 입퇴장에도 오른다. 이 통지가 보관본 문을 안 지나면
    // 뒤따라오는 TRACK_EVENT 가 매번 갭으로 보여 트랙이 영영 안 붙는다.
    if (note.op === Op.ParticipantEvent && version) {
      const verdict = this.roomsDomain.applyEvent(roomId, version, { kind: 'add', tracks: [] })
      if (verdict === 'stale') return
      if (verdict === 'resync') { this.queueResync(roomId); return }
      const type = note.body.type as string
      const userId = String(note.body.user_id ?? '')
      if (type === 'joined') {
        const p = participantOf({
          user_id: userId, role: Number(note.body.role ?? 255), select: note.body.select !== false,
          participant_type: Number(note.body.participant_type ?? 0), metadata: note.body.metadata,
        })
        // ★같은 seq 를 두 번 봐도 명단이 겹치지 않는다 — 견주기가 중복을 걸러 주지 않는다(연§4-6 둘째 예외).
        handle.setParticipants([...handle.participants.filter((x) => x.userId !== userId), p])
        handle.emit('participantJoined', p)
      } else {
        handle.setParticipants(handle.participants.filter((p) => p.userId !== userId))
        handle.emit('participantLeft', { userId })
      }
      return
    }

    // 연§6-7 — TRACK_EVENT 의 갈래는 action 이다(type 이 아니다).
    if (note.op === Op.TrackEvent && version) {
      const action = note.body.action as string
      const tracks = (note.body.tracks ?? []) as TrackEntry[]
      const verdict = this.roomsDomain.applyEvent(roomId, version,
        action === 'remove' ? { kind: 'remove', tracks } : { kind: 'add', tracks })
      if (verdict === 'stale') return
      if (verdict === 'resync') { this.queueResync(roomId); return }
      // ★빈 델타 — 연§4-6 배달 불변식이 시키는 "번호만 받는 한 장"이다(내 트랙이라 바뀔 것이 없다).
      // 여기서 재조립을 걸면 발행할 때마다 붙어 있는 배관을 헛되이 흔든다.
      if (verdict === 'noop') return
      if (action === 'remove') {
        for (const t of tracks) { handle.drop(t.track_id); this.playback.remove(t.track_id) }
      }
      const server = this.roomsDomain.serverOf(roomId)
      if (server) void this.renegotiate(server, roomId)
      return
    }

    // 연§6-7 — TRACK_STATE 는 트랙 하나의 표시만 고친다. 배열이 아니다.
    if (note.op === Op.TrackState && version) {
      const server = this.roomsDomain.serverOf(roomId)
      const known = server?.store.tracks(roomId).find((t) => t.track_id === note.body.track_id)
      if (!known) return
      const patched: TrackEntry = {
        ...known,
        ...(note.body.active === undefined ? {} : { active: note.body.active as boolean }),
        ...(note.body.duplex === undefined ? {} : { duplex: note.body.duplex as 'full' | 'half' }),
      }
      if (!['ok', 'noop'].includes(this.roomsDomain.applyEvent(roomId, version, { kind: 'add', tracks: [patched] }))) return
      handle.refresh(patched)
      return
    }

    // 연§6-7 — 결말은 cause 가 아니라 목록이 정한다. sub_rooms 에 없으면 방이 닫힌 것이다.
    // 연§6-5 — 남이 보낸 문자. 신원은 서버가 세션에서 넣은 값이다.
    if (note.op === Op.Message) {
      handle.emit('message', { userId: String(note.body.user_id ?? ''), content: String(note.body.content ?? '') })
      return
    }

    if (note.op === Op.RoomEvent) {
      const type = note.body.type as string
      if (type === 'sync_required') { this.queueResync(roomId); return }
      if (type !== 'affiliation') return
      const affiliation = note.body.affiliation as { sub_rooms?: string[] } | undefined
      const cause = (note.body.cause ?? 'moderate') as string

      // 연§4-6 첫째 예외 — ★방을 내리는 결말에는 견주기를 걸지 않는다. 그 뒤에 올 통지가 없어
      // 되감길 것이 없고, 급사 통지(정§15-1)의 version 은 hub 가 마지막으로 통과시킨 값이라
      // 보관값과 같다 — 견주면 종결이 삼켜지고 방은 영영 안 닫힌다.
      // 방을 유지하는 갱신은 연§4-6 둘째 예외로 받는다 — 이 통지는 나에게만 오므로 서버가
      // seq 를 안 올렸다. 보관값과 같게 오고, 그것이 stale 이 아니라 에코다.
      if (affiliation?.sub_rooms?.includes(roomId) === true) {
        if (version && this.roomsDomain.applyEvent(roomId, version, { kind: 'add', tracks: [] }) === 'stale') return
        handle.emit('affiliation', { cause: 'moderate' })
        return
      }
      if (cause === 'media_lost') { void this.rebuild(handle.server); return }
      handle.state = 'closed'
      this.handles.delete(roomId)
      this.ptts.get(roomId)?.reset('left')
      this.ptts.delete(roomId)
      handle.emit('forced', { cause: cause === 'kick' ? 'kick' : cause === 'room_closed' ? 'room_closed' : 'moderate' })
    }
  }

  /** 연§9-8 — 받을 것이 바뀌면 그 서버를 다시 협상하고 새 트랙을 걷는다. */
  private async renegotiate(server: Server, roomId: string): Promise<void> {
    try {
      await this.roomsDomain.renegotiate(server)
      this.harvest(roomId)
    } catch (e) {
      this.handles.get(roomId)?.emit('error', toOxLensError(e))
    }
  }

  /**
   * SDK§10-3 — 갭을 봤거나 서버가 어긋남을 알렸다. 그 방을 통짜로 다시 받는다.
   * ★여러 방이면 다 반영한 뒤 한 번 조립한다 — 방마다 조립하면 중간 상태로 협상이 돈다.
   * ★낡은 응답은 버린다. 계약은 그 하나이고 개수·간격은 구현 몫이다.
   */
  private queueResync(roomId: string): void {
    this.desynced.add(roomId)
    if (this.resyncing) return
    this.resyncing = true
    void (async () => {
      const touched = new Map<string, Server>()
      // ★한 판이 도는 동안 더 어긋난 방이 생기면 같은 판에서 마저 받는다 — 조립은 그 뒤 한 번이다.
      while (this.desynced.size > 0) {
        const rooms = [...this.desynced]
        this.desynced.clear()
        for (const id of rooms) await this.refill(id, touched)
      }
      this.resyncing = false
      for (const [, server] of touched) {
        const first = [...server.rooms][0]
        if (first !== undefined) await this.renegotiate(server, first)
      }
    })()
  }

  private async refill(roomId: string, touched: Map<string, Server>): Promise<void> {
    const server = this.roomsDomain.serverOf(roomId)
    const handle = this.handles.get(roomId)
    if (!server || !handle) return
    try {
      const detail = await this.directory.resync(roomId)
      // ★낡은 응답은 버린다 — 계약은 그 하나이고 개수·간격은 구현 몫이다.
      const verdict = server.store.apply('http', roomId, detail.version, {
        kind: 'snapshot', tracks: detail.tracks ?? [],
      })
      if (verdict.accepted) touched.set(server.sfuId, server)
      handle.setParticipants(detail.participants.map(participantOf))
      handle.emit('resync')
    } catch (e) {
      handle.emit('error', this.surfaced(e))
    }
  }

  /** 연§7-5-7 — 그 서버 방만 다시 세운다. */
  private async rebuild(sfuId: string): Promise<void> {
    const again = await this.roomsDomain.rebuildServer(sfuId)
    for (const id of again) {
      const handle = this.handles.get(id)
      handle?.emit('rebuilding')
      try {
        await this.roomsDomain.join(id, { select: this.roomsDomain.speakingRoom === id })
        handle?.emit('rebuilt')
      } catch (e) {
        handle?.emit('error', toOxLensError(e))
      }
    }
  }

  /** 보관본과 실제 도착한 미디어를 맞춰 방에 건다. 장착은 멱등이다. */
  private harvest(roomId: string): void {
    const server = this.roomsDomain.serverOf(roomId)
    const handle = this.handles.get(roomId)
    if (!server || !handle) return
    for (const entry of server.store.tracks(roomId)) {
      const media = server.link.mediaFor(entry.mid!)
      if (!media) continue
      const { track, fresh } = handle.adopt(entry, media as unknown as MediaStreamTrack, server.link)
      // SDK§6-2 — ★수신 오디오는 SDK 가 낸다. 앱이 `<audio>` 를 열 개 열지 않게 하는 결정이라
      //   여기서 재생을 건다(video 는 앱이 `attach` 로 붙인다).
      if (fresh && entry.kind === 'audio') {
        void this.playback.add(entry.track_id, entry.room_id, media)
      }
      if (fresh) this.emit('track', handle, track)
    }
  }

  private async pumpSession(): Promise<void> {
    for await (const e of this.sess.listen()) {
      if (e.kind === 'caught_up') {
        this.catchUp(e.outcome)
        continue
      }
      if (e.kind === 'token_required') {
        this.emit('tokenRequired', { cause: 'expired' })
        continue
      }
      if (e.kind === 'closed') {
        this.lastClose = { code: e.info.code, name: e.info.reason }
        this.emit('closed', { code: e.info.code, name: e.info.reason, retryable: e.retryable })
      }
      this.emit('session', this.session)
    }
  }

  /**
   * 연§6-1 — 이어받은 방은 스냅샷으로 따라잡고, 놓친 방은 ROOM_JOIN 부터 다시 한다.
   * ★tracks 가 그대로면 미디어를 안 건드린다 — 이어 쓰는 것이 이 op 의 목적이다.
   */
  private catchUp(outcome: ResumeOutcome): void {
    for (const roomId of outcome.resumed) {
      const shot = outcome.snapshot[roomId] as
        | { participants?: { user_id: string; role?: number; select?: boolean }[]; tracks?: TrackEntry[]; version?: Version }
        | undefined
      const server = this.roomsDomain.serverOf(roomId)
      const handle = this.handles.get(roomId)
      if (!shot?.version || !server || !handle) continue
      // ★version 을 견준 뒤 덮어쓴다. epoch 가 갈리면 보관본을 통째로 버린다(연§4-6).
      const verdict = server.store.apply('resume', roomId, shot.version, {
        kind: 'snapshot', tracks: shot.tracks ?? [],
      })
      handle.setParticipants((shot.participants ?? []).map(participantOf))
      // 받을 것이 달라졌을 때만 다시 조립한다.
      if (verdict.accepted && (verdict.added.length > 0 || verdict.removed.length > 0)) {
        void this.renegotiate(server, roomId)
      }
    }
    for (const roomId of outcome.failed) {
      const handle = this.handles.get(roomId)
      handle?.emit('rebuilding')
      void this.roomsDomain.join(roomId, { select: this.roomsDomain.speakingRoom === roomId })
        .then(() => handle?.emit('rebuilt'))
        .catch((e: unknown) => handle?.emit('error', toOxLensError(e)))
    }
    // 서버가 모르는 트랙은 remove 를 보내지 않는다 — 서버에 없다(연§6-1).
    // SDK§7-1 — `RESUME.publish_failed`(연§6-1) → `LocalTrack.ended{reason:'server_lost'}`.
    // ★조용히 지우지 않는다 — 앱이 다시 `enable` 할 근거가 이 사건 하나다.
    for (const id of outcome.publish_failed) {
      const track = this.registry.all.find((t) => t.trackId === id)
      if (track) { track.trackId = null; track.server = null; track.state = 'acquired' }
    }
  }

  /**
   * SDK§11-2-1 — `statsIntervalMs` 마다 서버마다 getStats 로 4단을 매기고 최악값을 세션 값으로 낸다.
   * 바뀔 때만 `session` 이벤트. `diagnostics.stats` 는 듣는 쪽이 있을 때만 같은 스냅샷을 낸다(SDK§11-2).
   */
  private async meter(): Promise<void> {
    if (this.metering || this.statsInterval <= 0) return
    this.metering = true
    while (this.sessionUp()) {
      await this.clock.sleep(this.statsInterval)
      if (!this.sessionUp()) break
      await this.measure()
      if (this.diag.has('stats')) this.diag.emit('stats', await this.diag.probe())
    }
    this.metering = false
  }

  private sessionUp(): boolean { return this.sess.state !== 'disconnected' }

  private async measure(): Promise<void> {
    const grades: ConnectionQuality[] = []
    for (const server of this.roomsDomain.allServers()) {
      let meter = this.meters.get(server.sfuId)
      if (!meter) { meter = new StatsMeter(); this.meters.set(server.sfuId, meter) }
      const reports = await server.link.statsAll()
      grades.push(grade(meter.sample(reports), server.link.dead()))
    }
    const q = worst(grades)
    if (q === this.quality) return
    this.quality = q
    this.emit('session', this.session)
  }

  private requireSignaling(): Signaling {
    const sig = this.sess.signaling
    if (!sig) throw new NotImplementedError('연결이 아직 없다 — connect() 먼저')
    return sig
  }
}

function summaryOf(r: {
  room_id: string; name: string; capacity: number; user_count: number; created_at: number; rec: boolean
}): RoomSummary {
  return {
    roomId: r.room_id, name: r.name, capacity: r.capacity,
    userCount: r.user_count, createdAt: r.created_at, rec: r.rec,
  }
}

function wsUrl(base: string): string {
  return `${base.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`
}

function requireBrowserDevices(): Devices {
  return {
    capture: () => Promise.reject(new NotImplementedError('브라우저 밖에서는 장치를 못 잡는다')),
    enumerate: () => Promise.resolve([]),
    onChange: () => () => {},
    permission: () => Promise.resolve('unknown' as const),
  }
}

/** 브라우저 밖(시험·노드)에서는 소리를 낼 곳이 없다 — 조용히 도는 판을 준다. */
function defaultAudioOut(): AudioOut {
  return typeof document === 'undefined' ? headlessAudio : browserAudio
}
