// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SES-API · SDK:IMPL-SES-EVENTS · SDK:IMPL-SES-CLOCK · SDK:IMPL-LINK-PROJECTION 출입구 하나 · SDK:RULE-MOD-AREA-MIRROR domain/ses · 연:RULE-SES-FINGERPRINT · model: claude-opus-5-5
import * as SES from '../gen/session_client.js'
import * as SB from '../gen/session_binding.js'
import type { ResumeRes, LeaveBody, MlineTable, RoomSnapshot } from '../../internal/wire/ws.js'
import { Code } from '../../internal/wire/ws.js'
import { Signaling, type Inbound, type Reply } from '../../internal/ses/signaling.js'
import { Emitter } from '../../platform/emitter.js'
import { sessionFingerprint } from '../../platform/sha256.js'
import { LogBook, type Logger } from '../../platform/log.js'
import { Timer } from '../../platform/clock.js'
import { Fault, fromFailure, closedFault } from '../../platform/fault.js'
import { httpJson, httpUrl } from '../../platform/net.js'
import { decide } from '../../platform/capability.js'
import { pageTarget } from '../../platform/env.js'
import { settle, opusFmtpLine, type ClientOptions, type Settings } from '../defaults.js'
import { RoomTable } from '../room/table.js'
import type { RoomCore, RoomEvents } from '../room/core.js'
import type { LinkCore, LinkInfo } from '../link/core.js'
import { MediaRegistry } from '../pub/registry.js'
import type { LocalCore } from '../pub/local.js'
import { SesClock } from './clock.js'
import { Diag } from '../diag.js'

export type SessionState = 'disconnected' | 'connecting' | 'active' | 'resuming'
export type Health = 'ok' | 'degraded' | 'recovering' | 'offline'
export type Quality = 'excellent' | 'good' | 'poor' | 'lost'

export interface SessionInfo {
  readonly state: SessionState
  readonly recovering: boolean
  readonly reason: { readonly code: number; readonly name: string } | null
  readonly userId: string | null
  readonly pcMode: '1pc' | '2pc' | null
  readonly fingerprint: string | null
  readonly health: Health
  readonly quality: Quality
}

export type { Transition } from '../../platform/log.js'

export interface CoreEvents extends Record<string, unknown[]> {
  session: [SessionInfo]
  tokenRequired: [{ cause: 'expired' }]
  closed: [{ code: number; name: string; retryable: boolean }]
  rebuilt: []
  link: [LinkInfo]
  /** 받는 트랙 핸들은 방 이벤트가 든 그 형(SES 는 TRK 를 부르지 않는다 · tools/sdk_deps.json may_use) */
  track: [RoomCore, RoomEvents['track'][0]]
  probe: [unknown]
  stats: [unknown]
}

/** 입구 표의 입구 — 위 결합(session_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof SB.ENTRY
type Args<K extends Entry> = (typeof SB.ENTRY)[K] extends (s: SES.St, ...a: infer A) => unknown ? A : never

/** session_id 같은 불투명 문자열을 상태기의 작은 수로 — 같은지만 본다 · 0 은 내지 않는다(SDK:RULE-MOD-BINDING-VALUES) */
export class Interner {
  private readonly to = new Map<string, number>()
  private readonly from = new Map<number, string>()
  id(s: string): number {
    let n = this.to.get(s)
    if (n === undefined) { n = this.to.size + 1; this.to.set(s, n); this.from.set(n, s) }
    return n
  }
  str(n: number): string | undefined { return this.from.get(n) }
}

interface Waiter { resolve: () => void; reject: (f: Fault) => void }

const TRANSPORT = { code: 0, name: 'TRANSPORT' } as const

/**
 * 클라이언트 객체 하나의 접속 — 시그널링 · 세션 상태기 · 시계 · 토큰을 소유한다.
 * 절차는 위가 지은 세션 클라 상태기가 정한다 — 여기는 입구 표(어느 SDK 사건이 어느 입구를) · 효과 표(위 효과를 어느 표면으로) · 이음매 집행만.
 * 방 · 연결 · 발행은 이 객체가 직접 소유하고 이음매(위가 정한 받는 곳)대로 직접 부른다.
 */
export class Core {
  readonly cfg: Settings
  readonly book = new LogBook()
  readonly log: Logger
  readonly events = new Emitter<CoreEvents>()
  readonly sig: Signaling
  readonly rooms: RoomTable
  readonly links = new Map<string, LinkCore>()
  readonly media: MediaRegistry
  readonly diag: Diag
  readonly sids = new Interner()
  readonly epochs = new Interner()
  /** 방 입장 식별자 join_id(연:RULE-ROOM-JOIN-ID) — 방 상태기는 같은지만 본다 */
  readonly jids = new Interner()
  readonly clock: SesClock
  token: string
  ses: SES.St = SES.initial()
  userId: string | null = null
  sessionId: string | null = null
  fingerprint: string | null = null
  reason: { code: number; name: string } | null = null
  quality: Quality = 'excellent'
  /** 이번 접속 시도가 실패한 사실 — 기다리는 connect() 를 이것으로 reject 한다 */
  private failure: Fault | null = null
  private connectWaiters: Waiter[] = []
  private activeWaiters: Waiter[] = []
  /** 앱의 다음 setToken() 을 기다리는 것 — HTTP 401 로 멈춘 재동기(연:RULE-TRN-HTTP-AUTH-TWO) */
  private tokenWaiters: Waiter[] = []
  /** 재구축 칸 첫 ROOM_JOIN 의 분산 대기 — 세션이 소유한다 · close() 가 멈춘다(SDK:RULE-API-HANDLES 닫히면 아래 전부 닫힌다) */
  private jitter: Timer | null = null
  private readonly jitterRooms = new Set<RoomCore>()
  private appClosed = false
  /** 재접속 중 토큰 요구로 멈췄다 — 새 토큰이 오면 SDK 가 이어서 접속을 넣는다 */
  private resumeOnToken = false
  private ignoreGen = -1
  private resumeBody: ResumeRes | null = null
  private lastInfo = ''
  private readonly lastLink = new Map<string, string>()
  private pumping = false

  constructor(opts: ClientOptions) {
    this.cfg = settle(opts)
    this.token = opts.token
    this.log = this.book.scope('session')
    this.sig = new Signaling({ base: this.cfg.base, reqTimeoutMs: SES.TIMER_MS.TReq ?? 30000 }, this.book.scope('signaling'))
    this.rooms = new RoomTable(this)
    this.media = new MediaRegistry(this.cfg, this.book, this.links, this.rooms)
    this.diag = new Diag(this)
    this.clock = new SesClock(this, this.cfg.wakeDetectMs)
  }

  /** 클라이언트를 붙잡는 전역 리스너(pagehide · 재생 visibilitychange · 핫플러그 devicechange)는 connect() 에 달고 close() 에 뗀다 — 닫힌 클라이언트가 남지 않는다(SDK:RULE-API-HANDLES) */
  private readonly onPageHide = (): void => { if (this.ses.cs !== 'DISCONNECTED') void this.close() }
  private watchPage(on: boolean): void {
    const w = this.cfg.disconnectOnPageLeave ? pageTarget() : null
    if (on) w?.addEventListener('pagehide', this.onPageHide)
    else w?.removeEventListener('pagehide', this.onPageHide)
    this.rooms.playback.watch(on)
    this.media.watchDevices(on)
  }

  get opusLine(): string { return opusFmtpLine(this.cfg.opusFmtpDefault) }

  // ── 출입구 ────────────────────────────────────────────────────────────

  record(layer: string, key: string, from: string, to: string, label: string, cause: string, extra?: { rung?: number; attempt?: number }): void {
    this.book.record(layer, key, from, to, label, cause, extra)
  }

  /** 받지 않는 사건 — 조용히 무시하지 않는다(SDK:IMPL-LINK-PROJECTION 받지 않는 사건) */
  impossible(layer: string, key: string, from: string, entry: string): void {
    this.book.impossible(layer, key, from, entry)
  }

  // ── 앱 조작 셋(SDK:IMPL-SES-API) ──────────────────────────────────────

  connect(): Promise<void> {
    if (this.ses.cs === 'ACTIVE') return Promise.resolve()
    this.appClosed = false
    this.watchPage(true)
    const p = new Promise<void>((resolve, reject) => this.connectWaiters.push({ resolve, reject }))
    if (this.ses.cs === 'DISCONNECTED') {
      this.failure = null
      this.resumeOnToken = false
      // BIND 에 싣는 연결 모드 · 앱이 준 토큰의 유무 — 위 상태의 바깥 사실 칸(브라우저 능력 · 앱 입력)
      const pcAsk = decide(this.cfg.pcMode)
      const prev = this.ses
      this.ses = { ...this.ses, pcAsk, token: this.token ? (this.ses.token === 'NONE' ? 'NONE' : this.ses.token) : 'NONE' }
      if (prev.pcAsk !== pcAsk) this.record('SES', 'session', prev.cs, prev.cs, 'SDK.pc_ask', 'capability')
      this.startPump()
      this.enter('connect', 'app', [])
    }
    return p
  }

  /** 새 토큰 — 위가 받는 때(토큰 요구로 멈춘 뒤)만 입구 newToken · 그 밖은 다음 BIND 에 실릴 뿐이다 */
  setToken(token: string): void {
    this.token = token
    for (const w of this.tokenWaiters.splice(0)) w.resolve()
    if (!this.enter('newToken', 'app', [], true)) return
    if (this.resumeOnToken && this.ses.cs === 'DISCONNECTED' && !this.appClosed) {
      this.resumeOnToken = false
      this.startPump()
      this.enter('connect', 'token', [])
    }
  }

  /** 앱의 다음 setToken() — close() 면 closed 로 끝난다 */
  untilToken(): Promise<void> {
    if (this.appClosed) return Promise.reject(closedFault('CLOSED'))
    return new Promise((resolve, reject) => this.tokenWaiters.push({ resolve, reject }))
  }

  /** 끊기 — 입구 disconnect 하나(방마다 나가지 않는다) · 응답을 기다리지 않는다 · 클라 주도 종료라 사유는 없다 */
  close(): Promise<void> {
    this.appClosed = true
    this.resumeOnToken = false
    this.reason = null
    this.failure = null
    for (const l of this.links.values()) l.closeForApp()
    this.enter('disconnect', 'app', [], true)
    this.diag.stop()
    this.media.closeForApp()
    this.watchPage(false)
    this.jitter?.stop()
    this.jitterRooms.clear()
    for (const w of this.connectWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    for (const w of this.tokenWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    for (const w of this.activeWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    return Promise.resolve()
  }

  /** 연결 전 요청은 기다린다(SDK:RULE-API-ASYNC 연결 전 요청) */
  untilActive(): Promise<void> {
    if (this.ses.cs === 'ACTIVE') return Promise.resolve()
    if (this.ses.cs === 'DISCONNECTED' && this.connectWaiters.length === 0) return Promise.reject(closedFault('CLOSED'))
    return new Promise((resolve, reject) => this.activeWaiters.push({ resolve, reject }))
  }

  // ── 입구 표 — 위 결합 ENTRY 를 지나 한 걸음 ─────────────────────────────

  /** 입구 하나 — 위가 안 받으면(null) 받지 않는 사건으로 적는다 · quiet 면 사건이 없던 것으로 둔다 · 받았는지를 돌려준다 */
  enter<K extends Entry>(name: K, cause: string, args: Args<K>, quiet = false): boolean {
    const f = SB.ENTRY[name] as unknown as (s: SES.St, ...a: Args<K>) => SES.Step | null
    const step = f(this.ses, ...args)
    if (!step) {
      if (!quiet) this.impossible('SES', 'session', this.ses.cs, name)
      return false
    }
    this.step(name, step, cause)
    return true
  }

  /** 시계가 넣는 만료 — T-bind 만료는 끊긴 사유 · 접속 실패 사실이다(SDK:IMPL-SES-API session.reason) */
  expired(t: SES.TimerName, cause: string): void {
    if (t === 'TBind') { this.reason = { code: 0, name: 'BIND_TIMEOUT' }; this.failure = closedFault('BIND_TIMEOUT') }
    this.enter('expire', cause, [t])
  }

  /** 한 걸음의 집행 — plan() 이 돌려준 목록대로(보낼 것 · 소켓 · 타이머 · 이음매 · 효과) 직접 한다 */
  private step(entry: Entry, step: SES.Step, cause: string): void {
    const prev = this.ses
    const plan = SB.plan(step)
    this.ses = plan.state
    this.record('SES', 'session', prev.cs, this.ses.cs, plan.label, cause, { attempt: this.ses.tries })
    for (const tx of plan.send) this.send(tx)
    this.sockFollow(prev)
    // 대기표 — 같은 세션이 이어졌으면(app.resumed) 들고 있던 요청이 이음매가 낼 새 요청보다 먼저 · 새 세션이면 버린다 · 끝났으면 closed(연:RULE-TRN-REQ-LIFE 3 · 4)
    if (this.ses.cs === 'ACTIVE' && prev.cs !== 'ACTIVE') this.sig.sessionUp(step.fx.includes('app.resumed'))
    if (this.ses.cs === 'DISCONNECTED' && prev.cs !== 'DISCONNECTED') this.sig.sessionEnd(closedFault('CLOSED'))
    this.clock.follow(entry, prev, plan.timers)
    for (const sm of plan.seams) this.seam(sm.fx)
    for (const f of step.fx) this.effect(f, entry)
    if (this.ses.cs === 'ACTIVE' && prev.cs !== 'ACTIVE') {
      this.diag.sessionActive(true)
      for (const w of this.activeWaiters.splice(0)) w.resolve()
      for (const l of this.links.values()) l.sessionBack()
    }
    if (this.ses.cs === 'DISCONNECTED' && prev.cs !== 'DISCONNECTED') {
      this.diag.sessionActive(false)
      // 효과 없이 끝난 접속(2002 등)도 기다리던 connect() 를 남기지 않는다 — 그 실패 사실로 reject
      const fault = this.failure ?? closedFault(entry === 'expire' ? 'BACKOFF_EXHAUSTED' : 'CLOSED')
      for (const w of this.connectWaiters.splice(0)) w.reject(fault)
      for (const w of this.activeWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    }
    this.surface()
  }

  private startPump(): void {
    if (this.pumping) return
    this.pumping = true
    void this.pump()
  }

  private async pump(): Promise<void> {
    for (;;) {
      const e = await this.sig.inbox.next()
      if (!e) break
      try { this.inbound(e) } catch (err) { this.log.error('수신 처리 실패', { err: String(err), stack: err instanceof Error ? err.stack : undefined }) }
    }
    this.pumping = false
  }

  /** 소켓 열림 · 끊김(입구 sockOpen · drop) · 통지 */
  private inbound(e: Inbound): void {
    if (e.t === 'open') {
      if (e.gen !== this.sig.generation) return
      this.enter('sockOpen', 'ws.open', [])
      return
    }
    if (e.t === 'close') {
      if (e.gen === this.ignoreGen) return
      const leave: LeaveBody | null = e.leave
      this.reason = leave ? { code: leave.code, name: leave.name } : { ...TRANSPORT }
      this.failure = leave ? new Fault({ code: leave.code, name: leave.name }) : closedFault('TRANSPORT')
      const carry = [...this.rooms.values()].some((r) => r.st.rs !== 'NONE') || this.media.anyPublished()
      this.enter('drop', 'ws.close', [leave ? leave.code : 0, carry])
      return
    }
    this.notify(e.op, e.body)
  }

  /** 통지 — 받는 영역으로 가른다(이 영역의 입구가 아니다) */
  private notify(op: string, body: unknown): void {
    const b = (body ?? {}) as Record<string, unknown>
    switch (op) {
      case 'PARTICIPANT_EVENT':
      case 'PARTICIPANT_STATE':
      case 'TRACK_EVENT':
      case 'TRACK_STATE': {
        const r = this.rooms.get(String(b['room_id'] ?? ''))
        if (r) r.delta(op, b)
        return
      }
      case 'ROOM_EVENT': {
        const r = this.rooms.get(String(b['room_id'] ?? ''))
        if (r) r.roomEvent(b)
        return
      }
      case 'MLINE_EVENT': {
        const t = b['table'] as MlineTable | undefined
        if (!t) return
        this.links.get(t.sfu_id)?.mlineEvent(t)
        return
      }
      case 'LINK_EVENT': {
        this.links.get(String(b['sfu_id'] ?? ''))?.linkEvent(String(b['ufrag'] ?? ''))
        return
      }
      case 'MESSAGE': {
        const r = this.rooms.get(String(b['room_id'] ?? ''))
        if (r) r.events.emit('message', { userId: String(b['user_id'] ?? ''), content: String(b['content'] ?? '') })
        return
      }
      case 'TASK': {
        if (b['phase'] === 'request' && b['type'] === 'probe') void this.diag.probeTask(Number(b['req_id'] ?? 0))
        return
      }
      default:
        this.log.debug(`모르는 통지 ${op} — ACK 만 했다`)
    }
  }

  private sockFollow(prev: SES.St): void {
    if (this.ses.sock === 'OPENING' && prev.sock !== 'OPENING') this.sig.connect()
    // 닫힘 = 열린 소켓도 여는 중인 소켓도 닫는다(여는 중에 끊기면 그 소켓 · T-req 시계가 남는다)
    if (this.ses.sock === 'CLOSED' && prev.sock !== 'CLOSED') {
      this.ignoreGen = this.sig.generation
      this.sig.close()
    }
  }

  // ── 보낼 것 · 받은 응답 ───────────────────────────────────────────────

  private send(tx: SES.Tx): void {
    switch (tx.ws) {
      case 'BIND': {
        const body: Record<string, unknown> = { token: this.token, client_ver: this.cfg.clientVer, pc_mode: tx.pc_mode }
        if (tx.session_id !== undefined) { const s = this.sids.str(tx.session_id); if (s) body['session_id'] = s }
        this.sig.request('BIND', body).then((r) => this.bindReply(r), () => undefined)
        return
      }
      case 'RESUME': this.sig.request('RESUME', {}).then((r) => this.resumeReply(r), () => undefined); return
      case 'HEARTBEAT': this.sig.request('HEARTBEAT', undefined).catch(() => undefined); return
      case 'LEAVE': this.ignoreGen = this.sig.generation; this.sig.sendLeave(); return
    }
  }

  /** 접속 응답 — 입구 bindRes · 읽는 값 marked = 다시 들어갈 방 표시가 남은 방이 있다 */
  private bindReply(r: Reply): void {
    const b = (r.body ?? {}) as Record<string, unknown>
    const code = r.ok ? 0 : Number(b['code'] ?? 5003)
    const sid = r.ok ? String(b['session_id'] ?? '') : ''
    const m = {
      code, part: (r.ok ? 'res' : 'fail') as SES.Part,
      heartbeat_interval: Number(b['heartbeat_interval'] ?? 0),
      pc_mode: (b['pc_mode'] === '1pc' ? '1pc' : '2pc') as SES.PcMode,
      resume_window_ms: Number(b['resume_window_ms'] ?? 0),
      session_id: r.ok ? this.sids.id(sid) : 0,
    }
    if (r.ok) { this.userId = String(b['user_id'] ?? ''); this.sessionId = sid; this.fingerprint = sid ? sessionFingerprint(sid) : null }
    else { this.failure = fromFailure(r.body); this.reason = { code: 0, name: 'BIND_FAILED' } }
    const marked = [...this.rooms.values()].some((x) => x.st.rejoin)
    this.enter('bindRes', r.ok ? 'BIND.res' : `BIND.${code}`, [m, marked])
  }

  /** 이어받기 응답 — 입구 resumeRes · 읽는 값 dead = 연결 투영이 그 미디어 연결을 죽었다고 본다 */
  private resumeReply(r: Reply): void {
    this.resumeBody = r.ok ? (r.body as ResumeRes) : null
    const dead = [...this.links.values()].some((l) => !l.st.assoc || l.st.ice !== 'OK')
    this.enter('resumeRes', r.ok ? 'RESUME.res' : `RESUME.${fromFailure(r.body).code}`, [{ part: r.ok ? 'res' : 'fail' }, dead])
    this.resumeBody = null
  }

  // ── 이음매 — 받는 곳은 위가 정했다 ───────────────────────────────────

  private seam(fx: SES.SeamFx): void {
    switch (fx) {
      case 'floor.down_all': for (const r of this.rooms.values()) r.floor.down(); break
      case 'rooms.down_all': for (const r of [...this.rooms.values()]) r.downAll(); break
      case 'rooms.close_all': for (const r of [...this.rooms.values()]) r.closeAll(); break
      case 'media.close_all': for (const l of [...this.links.values()]) l.closeAll(); break
      case 'media.repair': for (const l of this.links.values()) l.repair(); break
      case 'rooms.rejoin': this.rejoinAll([...this.rooms.values()]); break
      case 'pub.reregister_all': this.media.reregisterAll(null); break
      case 'rooms.snapshot': this.resumeSnapshots(); break
      case 'pub.resume_check': this.media.resumeCheck(this.resumeBody?.publications ?? []); break
    }
  }

  /** 재구축 칸의 첫 ROOM_JOIN 은 0 ~ massJitterMs 균등 무작위로 늦춘다(연:RULE-SES-REBUILD-JITTER) */
  rejoinAll(rooms: RoomCore[]): void {
    const marked = rooms.filter((r) => r.st.rejoin)
    if (!marked.length) return
    for (const r of marked) this.jitterRooms.add(r)
    this.jitter ??= new Timer(this.cfg.wakeDetectMs)
    if (this.jitter.armed) return
    this.jitter.start(Math.floor(Math.random() * this.cfg.massJitterMs), () => {
      const due = [...this.jitterRooms]
      this.jitterRooms.clear()
      for (const r of due) if (this.rooms.get(r.id) === r) r.rejoin()
    })
  }

  private resumeSnapshots(): void {
    const body = this.resumeBody
    const snap: Record<string, RoomSnapshot> = body?.snapshot ?? {}
    for (const t of body?.mline_tables ?? []) this.links.get(t.sfu_id)?.pendingTable(t)
    for (const r of [...this.rooms.values()]) r.resumeSnap(snap[r.id] ?? null)
  }

  // ── 효과 표 — 낼 표면은 결합(effect)이 정한다 · 덧붙임만 여기 ─────────

  private effect(f: SES.Fx, entry: Entry): void {
    const event = SB.effect(f).event
    if (f === 'app.connected') {
      this.reason = null
      this.failure = null
      for (const w of this.connectWaiters.splice(0)) w.resolve()
    } else if (f === 'app.need_token' && this.connectWaiters.length) {
      // 최초 접속 — 이벤트 대신 기다리던 connect() 를 reject(auth)
      const fault = this.failure ?? new Fault({ code: Code.TOKEN_EXPIRED.code, name: 'TOKEN_EXPIRED', permanent: false })
      for (const w of this.connectWaiters.splice(0)) w.reject(fault)
      return
    } else if (f === 'app.need_token') {
      this.resumeOnToken = true
    } else if (f === 'app.disconnected' && entry === 'bindRes' && this.connectWaiters.length) {
      // 최초 접속의 BIND 거절(위조 · 손상 토큰) — 이벤트 대신 기다리던 connect() 를 reject(auth · SDK:IMPL-SES-EVENTS 효과 표 app.disconnected)
      const fault = this.failure ?? new Fault({ code: Code.TOKEN_INVALID.code, name: 'TOKEN_INVALID', permanent: true })
      for (const w of this.connectWaiters.splice(0)) w.reject(fault)
      return
    } else if (f === 'app.bug') {
      const fault = this.failure ?? new Fault({ code: 1002, name: 'INVALID_PAYLOAD' })
      for (const w of this.connectWaiters.splice(0)) w.reject(fault)
    }
    if (event) this.emit(event, entry)
    // 덧붙임 — 앱이 close() 로 끊은 것이 아니면 closed 도 낸다
    if (f === 'app.disconnected' && !this.appClosed) this.emit('closed', entry)
  }

  private emit(e: SB.SessionEvent, entry: Entry): void {
    switch (e) {
      case 'session': this.surface(true); return
      case 'tokenRequired': this.events.emit('tokenRequired', { cause: 'expired' }); return
      case 'rebuilt': this.events.emit('rebuilt'); return
      case 'closed': {
        // retryable — 백오프 소진(입구 expire)만 다시 부를 보람이 있다 · 끊김 사유(drop) · 클라 버그(bindRes)는 아니다
        const r = entry === 'bindRes' ? (this.failure ?? { code: 1002, name: 'INVALID_PAYLOAD' }) : (this.reason ?? TRANSPORT)
        this.events.emit('closed', { code: r.code, name: r.name, retryable: entry === 'expire' })
        return
      }
      default: {
        const missing: never = e
        throw new Error(`효과 표에 없는 이벤트: ${String(missing)}`)
      }
    }
  }

  // ── 방 · 연결 찾기 · HTTP ─────────────────────────────────────────────

  linkFor(sfuId: string | null): LinkCore | undefined {
    return sfuId === null ? undefined : this.links.get(sfuId)
  }

  roomsOn(sfuId: string | null): RoomCore[] {
    return [...this.rooms.values()].filter((r) => r.sfuId !== null && r.sfuId === sfuId)
  }

  localsOn(sfuId: string | null): LocalCore[] { return this.media.on(sfuId) }

  /** HTTP — 세션 헤더 갈래(연:RULE-TRN-HTTP-AUTH-TWO) · 401 이면 tokenRequired */
  async http(method: string, path: string, body?: unknown, bearer = false): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (bearer || !this.sessionId) headers['Authorization'] = `Bearer ${this.token}`
    else headers['X-OxLens-Session'] = this.sessionId
    const r = await httpJson(method, httpUrl(this.cfg.base, path), headers, body)
    if (r.status === 401) this.events.emit('tokenRequired', { cause: 'expired' })
    if (r.status >= 400) throw fromFailure(r.body)
    return r.body
  }

  // ── 표면 — 파생값은 여기 한 곳에서만 계산한다 ──────────────────────────

  get sessionState(): SessionState {
    return this.ses.cs.toLowerCase() as SessionState
  }

  /** resuming · 세션(또는 그 서버) 재구축 중인 방 · up 이 아닌 연결(그 서버 첫 수립 중은 뺀다) */
  get recovering(): boolean {
    if (this.ses.cs === 'RESUMING') return true
    for (const r of this.rooms.values()) if (r.rebuilding) return true
    for (const l of this.links.values()) if (l.everUp && l.state !== 'up') return true
    return false
  }

  get health(): Health {
    // 세션이 끝났거나(DISCONNECTED — 토큰 기다림 · close() 뒤 · 백오프 소진) 끊겨 다시 붙는 중이면 offline(SDK:IMPL-SES-API client.health)
    if (this.ses.cs !== 'ACTIVE') return 'offline'
    let h: Health = 'ok'
    for (const r of this.rooms.values()) if (r.rebuilding) h = 'recovering'
    for (const l of this.links.values()) {
      if (l.blocked) return 'offline'
      const s = l.state
      if (s === 'rebuilding') h = 'recovering'
      else if ((s === 'wobbly' || s === 'restarting') && h === 'ok') h = 'degraded'
    }
    return h
  }

  info(): SessionInfo {
    return { state: this.sessionState, recovering: this.recovering, reason: this.reason, userId: this.userId, pcMode: this.ses.cs === 'ACTIVE' || this.sessionId ? this.ses.pcm : null, fingerprint: this.fingerprint, health: this.health, quality: this.quality }
  }

  /** 상태 · recovering · reason · health · quality 가 바뀔 때마다 session 이벤트 */
  surface(force = false): void {
    const i = this.info()
    const key = JSON.stringify(i)
    if (!force && key === this.lastInfo) return
    this.lastInfo = key
    this.events.emit('session', i)
  }

  /** 서버마다 연결 상태 — 바뀔 때마다 link 이벤트(같은 값은 다시 내지 않는다) */
  emitLink(info: LinkInfo): void {
    const key = JSON.stringify(info)
    if (this.lastLink.get(info.server) !== key) {
      this.lastLink.set(info.server, key)
      this.events.emit('link', info)
    }
    this.surface()
  }

  dispose(): void {
    this.sig.dispose()
    this.clock.stop()
  }
}
