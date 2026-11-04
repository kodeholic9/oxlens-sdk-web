// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-ROOM-API · SDK:RULE-ROOM-PERMISSION-BITS · SDK:RULE-ROOM-RESYNC · SDK:RULE-MOD-EVENT-ORDER · SDK:RULE-MOD-AREA-MIRROR domain/room · model: claude-opus-5-5
import * as ROOM from '../gen/room_client.js'
import * as RB from '../gen/room_binding.js'
import type { RoomJoinRes, MemberInfo, TrackEntry, MediaCodecs, GetRoomRes, RoomSnapshot, Version } from '../../internal/wire/ws.js'
import type { Reply } from '../../internal/ses/signaling.js'
import { Emitter } from '../../platform/emitter.js'
import { Fault, fromFailure, closedFault, negotiationFault } from '../../platform/fault.js'
import { Timer, sleep, nextTick } from '../../platform/clock.js'
import type { Core } from '../ses/core.js'
import { FloorCore } from '../flr/core.js'
import { LinkCore } from '../link/core.js'
import { RoomTracks } from '../trk/tracks.js'
import type { RemoteCore, RemoteInfo } from '../trk/remote.js'
import { RoomStore, ALL_TRUE, type Participant, type Permission, type PermissionChange } from './store.js'

/** 방 통지의 종류 — 입구 delta 가 받는 wire(위 CDelta from.wire) */
type DeltaKind = Parameters<typeof ROOM.delta>[1]['t']

export interface JoinOptions {
  readonly mode?: 'listen' | 'talk'
  readonly role?: number
}

export type RoomState = 'joining' | 'joined' | 'leaving' | 'closed'

export interface RoomEvents extends Record<string, unknown[]> {
  joined: []
  joinFailed: [Fault]
  left: []
  forced: [{ cause: string }]
  participants: [Participant[]]
  permission: [PermissionChange]
  resync: []
  message: [{ userId: string; content: string }]
  error: [Fault]
  track: [RemoteCore]
  trackUnreachable: [RemoteInfo]
  state: [RoomState]
}

/** 입구 표의 입구 — 위 결합(room_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof RB.ENTRY
type Args<K extends Entry> = (typeof RB.ENTRY)[K] extends (s: ROOM.St, ...a: infer A) => unknown ? A : never

/** 사건이 실어 온 보관본 — 위가 받아들이면(이음매 trk.snapshot) 명단 · 트랙 목록을 통째로 갈아 끼운다 */
interface Carried {
  readonly participants: readonly MemberInfo[]
  readonly me: MemberInfo | undefined
  readonly tracks: readonly TrackEntry[]
  /** 입장 응답만 싣는다(연:RULE-ROOM-MEDIA-CODECS) */
  readonly mediaCodecs?: MediaCodecs
}

/** 재시도 사다리 둘째~넷째 칸(연:RULE-ERR-CLIENT-FAIL-DEFAULT 4) */
const RETRY = [300, 1200, 2700]
const NO_RETRY = new Set([3001, 4001, 4004, 4005])
/** 첫 협상이 끝내 안 오면 이만큼 뒤 resolve 한다(협상 실패는 room.error 로 따로 온다) */
const JOIN_SETTLE_MS = 10_000

/**
 * 방 하나 — 위가 지은 방 클라 상태기 하나(방마다).
 * 절차는 위가 정한다 — 여기는 입구 표(어느 SDK 사건이 어느 입구를) · 효과 표(위 효과를 어느 표면으로) · 이음매 집행만.
 * 받는 트랙(트랙 · 구독 상태기)은 domain/trk 의 RoomTracks 가 들고, 위 이음매대로 직접 부른다.
 * TRK 는 세션 영역을 부르지 않는다(may_use) — 받는 쪽이 세션에서 쓰는 것(신원 · 기록 · 요청 · 클라이언트 track)은 방이 내준다.
 * FLR 도 같다 — 발언권이 쓰는 DC 송신 · 연결 단계 · 슬롯 트랙 · 기록은 방이 내준다.
 */
export class RoomCore {
  st: ROOM.St = ROOM.initial()
  readonly store = new RoomStore()
  readonly trk: RoomTracks
  readonly events = new Emitter<RoomEvents>()
  readonly floor: FloorCore
  readonly mode: 'listen' | 'talk'
  readonly role: number
  sfuId: string | null = null
  closed = false
  rebuilding = false
  /** 입장은 됐고 그 입장이 부른 첫 협상을 기다린다 — 초기 트랙이 장착 가능해야 join() 이 resolve 한다(SDK:RULE-API-ASYNC 재진입 금지) */
  joinPending = false
  /** 이 입장이 select:true 로 나갔다 — 입장이 곁들여 발언 방을 정한다(SDK:IMPL-AFF-SPEAKING-ROOM 입구 joinSelect) */
  joinSel = false
  private joinWaiter: { resolve: (r: RoomCore) => void; reject: (f: Fault) => void } | null = null
  private leaveWaiter: (() => void) | null = null
  /** 지금 넣는 입장 응답 — 이음매(link.table · room.sub_rooms · aff.implicit)가 읽는다 */
  private lastJoin: RoomJoinRes | null = null
  private carried: Carried | null = null
  /** 이번 걸음에서 위가 보관본을 받아들였다(이음매 trk.snapshot) */
  private adopted = false
  /** 지금 넣는 통지 — 효과 app.members(명단 · 권한) · 이음매 trk.delta(트랙)가 그 내용을 반영한다 */
  private notice: { op: string; body: Record<string, unknown> } | null = null
  private lastFault: Fault | null = null
  private forcedCause = 'missing'
  private reqEpoch = 0
  private syncEpoch = 0
  private retries = 0
  /** 4009 의 retry_after_ms 하한 — 위 상태 retry 가 선 동안만 돈다 */
  private readonly retryTimer: Timer
  private retryAfterMs = 1000
  /** 첫 협상 기다림의 상한(JOIN_SETTLE_MS) */
  private readonly settleTimer: Timer
  /** 앱에 마지막으로 낸 room.state — 같은 값은 다시 내지 않는다 */
  private shown: RoomState = 'joining'

  constructor(readonly core: Core, readonly id: string, opts: JoinOptions) {
    this.mode = opts.mode ?? 'listen'
    this.role = opts.role ?? 255
    this.floor = new FloorCore(this, core.media, core.rooms.aff, core.cfg, core.log)
    this.trk = new RoomTracks(this, core.media, core.rooms.playback, core.cfg, core.log)
    this.retryTimer = new Timer(core.cfg.wakeDetectMs)
    this.settleTimer = new Timer(core.cfg.wakeDetectMs)
  }

  get state(): RoomState {
    if (this.closed) return 'closed'
    if (this.st.rs === 'JOINED') return 'joined'
    if (this.st.rs === 'LEAVING') return 'leaving'
    return 'joining'
  }

  get link(): LinkCore | undefined { return this.core.linkFor(this.sfuId) }

  get permission(): Permission { return this.store.permission ?? ALL_TRUE }

  // ── 받는 트랙(TRK)이 방을 지나 쓰는 것 ─────────────────────────────────

  /** 내 user_id — 내 개인 트랙은 받을 트랙이 아니다 */
  get selfId(): string | null { return this.core.userId }

  record(layer: string, key: string, from: string, to: string, label: string, cause: string): void { this.core.record(layer, key, from, to, label, cause) }
  impossible(layer: string, key: string, from: string, entry: string): void { this.core.impossible(layer, key, from, entry) }

  /** 발행 거절 2006 이 실어 온 막힌 비트 — 통지보다 거절이 먼저 닿은 창을 메운다(SDK:RULE-PUB-DENIED · 재시도 없음) */
  denied(bits: readonly string[]): void {
    const p = { ...this.store.permission }
    if (bits.includes('publish_audio')) p.publishAudio = false
    if (bits.includes('publish_video')) p.publishVideo = false
    if (bits.includes('publish_screen')) p.publishScreen = false
    this.store.permission = p
    this.events.emit('permission', { userId: this.core.userId ?? '', permission: p, mine: true })
    this.floor.surface()
  }

  /** 이 방의 구독 요청 — READY · SUBSCRIBE_LAYER */
  request(op: 'READY' | 'SUBSCRIBE_LAYER', body: Record<string, unknown>): Promise<Reply> { return this.core.sig.request(op, body) }

  /** 장착 가능한 받는 트랙 — room.track 과 client.track(SDK:IMPL-TRK-RECEIVE) */
  announce(r: RemoteCore): void {
    this.events.emit('track', r)
    this.core.events.emit('track', this, r)
  }

  /** 받는 트랙 목록이 바뀌었다 — 슬롯 화자 표면(발언권)이 다시 잰다 */
  tracksChanged(): void { this.floor.speakerTracks() }

  /** 그 방 슬롯 오디오가 닿았다(첫 디코딩 프레임) — 발언권 입구 rtpRx */
  voiceArrived(): void { this.floor.rtpRx() }

  // ── 발언권(FLR)이 방을 지나 쓰는 것 — 발언권은 세션 · 연결 · 트랙 영역을 부르지 않는다(may_use) ─────

  /** 세션이 끝났다 — press() 의 reject(closed) */
  get sessionClosed(): boolean { return this.core.ses.cs === 'DISCONNECTED' }

  /** 그 서버로 가는 발언권 길 — DC 가 열렸나 · 처음 세우는 중(transport) · 연결 복구 중(recovering) */
  floorPath(): 'open' | 'transport' | 'recovering' {
    const link = this.link
    if (!link || link.state !== 'up') return link && link.everUp ? 'recovering' : 'transport'
    return link.peer?.dcOpen ? 'open' : 'transport'
  }

  /** 발언권 메시지를 그 서버 DC 로 — 못 보내면 false(위 타이머가 다시 보낸다) */
  sendFloor(bytes: Uint8Array): boolean { return this.link?.peer?.sendDc(bytes) ?? false }

  /** 화자의 슬롯 트랙 — 줄이 선 무전 슬롯(연:RULE-FLR-SLOT-SPEAKER) */
  slotTrackIds(): string[] { return [...this.trk.remotes.values()].filter((r) => r.type === 'slot' && r.row !== null).map((r) => r.id) }

  /** 효과 media.render(playback.render) — 받은 슬롯 오디오를 그 방 room.audio 로 */
  renderVoice(): void { for (const r of this.trk.remotes.values()) if (r.type === 'slot') r.applyPlayback() }

  joined(): Promise<RoomCore> {
    if (this.st.rs === 'JOINED') return Promise.resolve(this)
    return new Promise((resolve, reject) => {
      const prev = this.joinWaiter
      this.joinWaiter = { resolve: (r) => { prev?.resolve(r); resolve(r) }, reject: (f) => { prev?.reject(f); reject(f) } }
    })
  }

  /** client.join() — 그 서버 연결이 up 이 된 뒤(RoomTable.join 이 기다린다) 입구 join */
  start(): Promise<RoomCore> {
    const p = this.joined()
    this.enter('join', 'app', [])
    return p
  }

  leave(): Promise<void> {
    if (this.closed || this.st.rs === 'NONE') { this.finishClose(); return Promise.resolve() }
    const p = new Promise<void>((resolve) => { const prev = this.leaveWaiter; this.leaveWaiter = () => { prev?.(); resolve() } })
    this.joinPending = false
    this.enter('leave', 'app', [])
    return p
  }

  // ── 입구 표 — 위 결합 ENTRY 를 지나 한 걸음 ─────────────────────────────

  /** 입구 하나 — 위가 안 받으면(null) 받지 않는 사건으로 적는다 · quiet 면 사건이 없던 것으로 둔다 · 받았는지를 돌려준다 */
  enter<K extends Entry>(name: K, cause: string, args: Args<K>, quiet = false): boolean {
    const f = RB.ENTRY[name] as unknown as (s: ROOM.St, ...a: Args<K>) => ROOM.Step | null
    const step = f(this.st, ...args)
    if (!step) {
      if (!quiet) this.core.impossible('ROOM', this.id, this.st.rs, name)
      return false
    }
    this.step(step, cause)
    return true
  }

  /** 한 걸음의 집행 — plan() 이 돌려준 목록대로(동작 · 보낼 것 · 이음매 · 이벤트) 직접 한다 */
  private step(step: ROOM.Step, cause: string): void {
    const prev = this.st
    const plan = RB.plan(step)
    this.st = plan.state
    this.core.record('ROOM', this.id, prev.rs, this.st.rs, plan.label, cause)
    for (const a of plan.actions) {
      if (a === 'resync.abandon') this.syncEpoch++
      else if (a === 'request.abandon') this.reqEpoch++
    }
    for (const tx of plan.send) this.send(tx)
    for (const sm of plan.seams) this.seam(sm.fx, plan.label)
    for (const e of plan.events) this.emit(e)
    // 4009 하한 — 위 상태 retry 가 선 동안만 잰다(나가면 멈춘다)
    if (this.st.retry && !prev.retry) this.retryTimer.start(this.retryAfterMs, () => this.enter('retryDue', 'clock', []))
    if (!this.st.retry) this.retryTimer.stop()
    if (this.leaveWaiter && this.st.rs === 'NONE' && !this.st.rejoin && !this.closed) {
      const w = this.leaveWaiter; this.leaveWaiter = null
      this.finishClose()
      w()
      this.events.emit('left')
    }
    this.showState()
  }

  private showState(): void {
    const s = this.state
    if (s === this.shown) return
    this.shown = s
    this.events.emit('state', s)
  }

  // ── 보낼 것 · 받은 응답 ───────────────────────────────────────────────

  private send(tx: ROOM.Tx): void {
    if (tx.ws === 'ROOM_JOIN') void this.sendJoin()
    else if (tx.ws === 'ROOM_LEAVE') {
      const ep = this.reqEpoch
      this.core.sig.request('ROOM_LEAVE', { room_id: this.id }).then((r) => {
        if (ep !== this.reqEpoch) return
        this.leaveReply(r)
      }, () => { if (ep === this.reqEpoch) this.enter('leaveRes', 'ROOM_LEAVE.closed', [{ part: 'fail' }]) })
    } else if (tx.ws === 'GET_ROOM') void this.resync()
  }

  /** 1pc 면 입장마다 새 연결로 번호표를 만든다(연:RULE-ROOM-JOIN-START 3) */
  private async sendJoin(): Promise<void> {
    const ep = this.reqEpoch
    const pcm = this.core.ses.pcm
    const body: Record<string, unknown> = { room_id: this.id, role: this.role, select: false }
    let fresh: LinkCore | null = null
    if (pcm === '1pc') {
      fresh = LinkCore.candidate(this.core)
      try {
        const tags = await fresh.peer!.first1pc()
        body['codecs'] = tags.codecs
        body['extmap'] = tags.extmap
      } catch (e) {
        fresh.peer?.close()
        this.lastFault = negotiationFault('OFFER', e)
        this.enter('joinRes', 'ROOM_JOIN.offer_fail', [{ code: 1002, part: 'fail', server_config: { pc_mode: pcm, sfu_id: 0 }, version: { epoch: 0, seq: 0 } }, pcm])
        return
      }
    }
    // select:true 는 발언 방이 없고 전환이 안 떠 있을 때만 — 소속 상태기가 정한다(연:RULE-ROOM-JOIN-START 2 · 입구 joinSelect)
    // ★재구축의 다시 들어감은 앱의 join() 이 아니다 — select:false 로 들어가고 발언 방은 위가 되찾는다(연:AFF.C.any.implicit_back · SDK:IMPL-AFF-SPEAKING-ROOM 입구 down)
    this.joinSel = this.rebuilding ? false : this.core.rooms.aff.joinSelect(this.id, this.mode === 'talk')
    body['select'] = this.joinSel
    let r: Reply
    try { r = await this.core.sig.request('ROOM_JOIN', body) } catch {
      fresh?.peer?.close()
      return
    }
    if (ep !== this.reqEpoch) { fresh?.peer?.close(); return }
    await this.joinReply(r, fresh)
  }

  private async joinReply(r: Reply, fresh: LinkCore | null): Promise<void> {
    const pcm = this.core.ses.pcm
    if (!r.ok) {
      fresh?.peer?.close()
      const f = fromFailure(r.body)
      this.lastFault = f
      if (!f.permanent && !NO_RETRY.has(f.code) && f.code !== 4009 && f.code >= 2000 && this.retries < RETRY.length) {
        const wait = RETRY[this.retries++]!
        await sleep(wait)
        if (this.st.rs === 'JOINING' && !this.st.quit) { void this.sendJoin(); return }
      }
      if (f.code === 4009) this.retryAfterMs = Math.max(0, Number((f.details ?? {})['retry_after_ms'] ?? 1000))
      this.enter('joinRes', `ROOM_JOIN.${f.code}`, [{ code: f.code, part: 'fail', server_config: { pc_mode: pcm, sfu_id: 0 }, version: { epoch: 0, seq: 0 } }, pcm])
      return
    }
    const b = r.body as RoomJoinRes
    this.retries = 0
    const sc = b.server_config
    const m = { code: 0, part: 'res' as const, server_config: { pc_mode: sc.pc_mode, sfu_id: this.core.epochs.id(sc.sfu_id) }, version: { epoch: this.core.epochs.id(b.version.epoch), seq: b.version.seq } }
    if (sc.pc_mode !== pcm) this.lastFault = negotiationFault('PC_MODE')
    // 이 응답으로 들어가는가는 위 코드가 정한다(미리 보기 — 상태를 바꾸지 않는다) · 들어가면 그 서버 연결부터 세운다(이음매 link.table · sdp.rebuild 가 그 연결을 쓴다)
    if (ROOM.joinRes(this.st, m, pcm)?.s.rs === 'JOINED') {
      this.sfuId = sc.sfu_id
      await LinkCore.adopt(this.core, sc, fresh)
    } else fresh?.peer?.close()
    this.lastJoin = b
    this.carried = { participants: b.participants, me: b.me, tracks: b.tracks, mediaCodecs: b.media_codecs ?? {} }
    this.enter('joinRes', 'ROOM_JOIN.res', [m, pcm])
    this.lastJoin = null
    this.carried = null
    this.takeAdopted()
  }

  private leaveReply(r: Reply): void {
    if (!r.ok) {
      const f = fromFailure(r.body)
      if (f.code !== 3001 && f.code !== 3002) this.events.emit('error', f)
    }
    this.enter('leaveRes', r.ok ? 'ROOM_LEAVE.res' : 'ROOM_LEAVE.fail', [{ part: r.ok ? 'res' : 'fail' }])
  }

  /**
   * 재동기 — HTTP(세션 헤더) · 실패는 사다리 칸 간격으로 다시(던지는 개수 · 간격은 구현 몫 — SDK:RULE-ROOM-RESYNC).
   * ★HTTP 401(auth)이면 되풀이하지 않는다 — tokenRequired 는 한 번 났다 · 앱의 setToken() 뒤에 다시 받는다(연:RULE-TRN-HTTP-AUTH-TWO).
   */
  private async resync(): Promise<void> {
    const ep = this.syncEpoch
    for (let i = 0; ; i++) {
      try {
        const res = (await this.core.http('GET', `/rooms/${encodeURIComponent(this.id)}?tracks=1`)) as GetRoomRes
        if (ep !== this.syncEpoch || this.closed) return
        this.snapshotRes(res)
        return
      } catch (e) {
        if (ep !== this.syncEpoch || this.closed) return
        const f = e instanceof Fault ? e : new Fault({ code: 5003, name: 'RESYNC_FAILED', cause: e })
        if (f.category === 'auth') {
          try { await this.core.untilToken() } catch { return }
          if (ep !== this.syncEpoch || this.closed) return
          i = -1
          continue
        }
        if (i === 2) this.events.emit('error', f)
        await sleep(RETRY[Math.min(i, RETRY.length - 1)]!)
        if (ep !== this.syncEpoch || this.closed) return
      }
    }
  }

  /** 재동기 응답 — 입구 snapshot · 받아들였으면 명단 · resync */
  private snapshotRes(res: GetRoomRes): void {
    this.carried = { participants: res.participants, me: res.me, tracks: res.tracks ?? [] }
    this.enter('snapshot', 'GET_ROOM.res', [{ version: { epoch: this.core.epochs.id(res.version.epoch), seq: res.version.seq } }])
    this.carried = null
    if (!this.takeAdopted()) return
    this.events.emit('resync')
    if (this.floor.st.cs === 'QUEUED') this.floor.queuePosition()
  }

  // ── 통지 · 위 이음매가 부르는 입구 ─────────────────────────────────────

  /** 통지 — ACK 은 시그널링이 이미 했다 · 견주기는 위 방 상태기 한 곳(입구 delta · SDK:IMPL-MOD-TABLE domain/store 단일 진입) */
  delta(op: string, body: Record<string, unknown>): void {
    const v = body['version'] as Version | undefined
    const bare = op === 'PARTICIPANT_STATE' && v === undefined
    const m = { t: op as DeltaKind, version: { epoch: v ? this.core.epochs.id(v.epoch) : this.st.cepoch, seq: v?.seq ?? 0 } }
    this.notice = { op, body }
    this.enter('delta', op, [m, bare])
    this.notice = null
  }

  roomEvent(body: Record<string, unknown>): void {
    const type = body['type'] === 'affiliation' ? 'affiliation' : 'sync_required'
    if (type === 'affiliation') this.forcedCause = String(body['cause'] ?? 'kick')
    this.enter('roomEvent', `ROOM_EVENT.${type}`, [{ type }])
  }

  rejoin(): void {
    this.rebuilding = true
    this.enter('rejoin', 'rebuild', [])
  }

  downAll(): void {
    this.enter('downAll', 'rebuild', [])
    this.rebuilding = this.st.rejoin
  }

  closeAll(): void {
    this.enter('closeAll', 'session', [])
    this.finishClose()
  }

  /** 이어받기 응답의 그 방 몫 — 들어가 있지 않은 방이면 사건이 없던 것이다 */
  resumeSnap(s: RoomSnapshot | null): void {
    if (!s) this.forcedCause = 'missing'
    this.carried = s ? { participants: s.participants, me: s.me, tracks: s.tracks } : null
    this.enter('resumeSnap', 'RESUME.snapshot', [s !== null, s?.version.seq ?? 0, s ? this.core.epochs.id(s.version.epoch) : 0], true)
    this.carried = null
    this.takeAdopted()
  }

  private takeAdopted(): boolean {
    const a = this.adopted
    this.adopted = false
    return a
  }

  // ── 이음매 — 받는 곳은 위가 정했다 ───────────────────────────────────

  private seam(fx: ROOM.SeamFx, label: string): void {
    const core = this.core
    const link = this.link
    switch (fx) {
      case 'trk.snapshot': {
        const c = this.carried
        if (c) {
          this.store.reset(c.participants, c.me)
          if (c.mediaCodecs) this.store.mediaCodecs = c.mediaCodecs
          this.adopted = true
        }
        this.trk.snapshot(c ? c.tracks : null, label)
        break
      }
      case 'trk.delta': if (this.notice) this.trk.delta(this.notice.op, this.notice.body); break
      case 'store.drop': this.trk.storeDrop(label); break
      case 'ready.tracks': this.trk.sub.enter('ready', label, []); break
      case 'sub.drop': this.trk.sub.enter('dropRoom', label, []); break
      case 'link.table': {
        const t = this.lastJoin?.mline_table
        if (t && link) link.tableCarried(t)
        else link?.flushPendingTable()
        break
      }
      case 'link.server_ice': link?.serverIce(); break
      case 'sdp.rebuild': link?.renego(); break
      case 'link.room_left': {
        const last = core.roomsOn(this.sfuId).every((r) => r === this || r.st.rs === 'NONE')
        link?.roomLeft(last)
        break
      }
      case 'link.epoch_changed': link?.epochChanged(); break
      case 'room.sub_rooms': {
        const listed = this.lastJoin?.affiliation.sub_rooms ?? []
        for (const other of core.roomsOn(this.sfuId)) if (other !== this) other.enter('subRooms', 'ROOM_JOIN.sub_rooms', [listed.includes(other.id)])
        break
      }
      case 'aff.leave': core.rooms.aff.left(this.id, label); break
      case 'aff.down': core.rooms.aff.down(this.id, label); break
      case 'aff.implicit': core.rooms.aff.implicit(this.id, this.joinSel, this.lastJoin?.affiliation, this.sfuId, label); break
      case 'aff.join_failed': core.rooms.aff.joinFailed(this.id, this.lastFault, label); break
      case 'floor.join': this.floor.join(); break
      case 'floor.leave': this.floor.leave(); break
      case 'pub.room_gone': for (const l of core.media.inRoom(this.id)) l.roomGone(false); break
      case 'pub.room_left': for (const l of core.media.inRoom(this.id)) l.roomGone(true); break
    }
  }

  // ── 효과 표 — 낼 표면은 결합(effect)이 정한다 · 덧붙임만 여기 ─────────

  private emit(e: RB.RoomEvent): void {
    switch (e) {
      case 'joined': {
        // 재구축이 끝났다 — recovering · health 는 세션 표면이 한 곳에서 다시 잰다
        if (this.rebuilding) { this.rebuilding = false; this.core.surface() }
        this.joinPending = true
        this.settleTimer.start(JOIN_SETTLE_MS, () => this.finishJoin())
        this.events.emit('joined')
        this.emitParticipants()
        return
      }
      case 'joinFailed': {
        const f = this.lastFault ?? new Fault({ code: 5003, name: 'INTERNAL_ERROR' })
        const w = this.joinWaiter; this.joinWaiter = null
        if (this.rebuilding) this.events.emit('error', f)
        w?.reject(f)
        this.events.emit('joinFailed', f)
        // 연결 모드가 달라 들어간 채 실패했으면(LEAVING) 퇴장 응답 뒤에 닫힌다
        if (this.st.rs === 'NONE') this.finishClose()
        return
      }
      case 'left': {
        const w = this.leaveWaiter; this.leaveWaiter = null
        const jw = this.joinWaiter; this.joinWaiter = null
        jw?.reject(closedFault('LEFT'))
        this.finishClose()
        w?.()
        this.events.emit('left')
        return
      }
      case 'participants': {
        // 위가 반영하라고 한 통지 — 명단 · 권한(투명 참가자의 version 없는 내 권한 통지도 · 연:DEV-ROOM-HIDDEN-SELF-PSTATE)
        const n = this.notice
        const changes = n ? this.store.apply(n.op, n.body, this.core.userId) : []
        this.emitParticipants()
        for (const c of changes) {
          this.events.emit('permission', c)
        }
        if (changes.length) this.floor.surface()
        return
      }
      case 'forced': {
        this.finishClose()
        this.events.emit('forced', { cause: this.forcedCause })
        return
      }
      default: {
        const missing: never = e
        throw new Error(`효과 표에 없는 이벤트: ${String(missing)}`)
      }
    }
  }

  /**
   * 그 입장의 첫 협상이 끝났다 — join() resolve · 초기 track 이벤트는 다음 tick.
   * ★협상이 실패했으면(fault) 기다리던 join() 은 그 방을 나가고 negotiation 으로 reject 한다 — 서버는 이미 받아들였다(SDK:IMPL-ROOM-API 효과 표 app.joined).
   * 재구축의 다시 들어감처럼 기다리는 join() 이 없으면 방은 그대로 둔다(그 실패는 room.error 다).
   */
  finishJoin(fault: Fault | null = null): void {
    if (!this.joinPending) return
    this.joinPending = false
    this.settleTimer.stop()
    const w = this.joinWaiter; this.joinWaiter = null
    if (fault && w && this.st.rs === 'JOINED') {
      w.reject(fault)
      void this.leave()
      return
    }
    if (fault && this.st.rs === 'JOINED') this.events.emit('error', fault)
    if (this.st.rs === 'JOINED') w?.resolve(this)
    void nextTick().then(() => this.trk.syncRemotes())
  }

  private finishClose(): void {
    if (this.closed) return
    this.closed = true
    // 닫힌 방의 join() 을 남기지 않는다 — 세션 끝(closeAll) · 재구축 중 닫힘(SDK:RULE-API-ASYNC)
    const jw = this.joinWaiter; this.joinWaiter = null
    jw?.reject(closedFault('CLOSED'))
    this.retryTimer.stop()
    this.settleTimer.stop()
    this.trk.endAll()
    this.floor.dispose()
    this.core.rooms.drop(this)
    this.showState()
  }

  private emitParticipants(): void {
    this.events.emit('participants', [...this.store.members.values()])
  }
}
