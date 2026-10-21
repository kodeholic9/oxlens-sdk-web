// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SES-API · SDK:IMPL-SES-EVENTS · SDK:IMPL-SES-CLOCK · SDK:IMPL-LINK-PROJECTION 출입구 하나 · SDK:IMPL-MOD-TABLE domain/session · model: claude-opus-5-5
import * as SES from './gen/session_client.js'
import * as SB from './gen/session_binding.js'
import * as AFF from './gen/aff_client.js'
import * as AB from './gen/aff_binding.js'
import type { ResumeRes, AffiliationRes, LeaveBody, MlineTable, RoomSnapshot, Publication } from '../internal/wire/ws.js'
import { Code } from '../internal/wire/ws.js'
import { Signaling, type Inbound, type Reply } from '../internal/signaling.js'
import { Emitter } from '../platform/emitter.js'
import { LogBook, type Logger } from '../platform/log.js'
import { Timer, now, wall } from '../platform/clock.js'
import { Fault, fromFailure, closedFault, stateFault } from '../platform/fault.js'
import { httpJson, httpUrl } from '../platform/net.js'
import { decide } from '../platform/capability.js'
import { pageTarget } from '../platform/env.js'
import { settle, opusFmtpLine, type ClientOptions, type Settings } from './defaults.js'
import { RoomCore, type JoinOptions } from './rooms.js'
import { LinkCore, type LinkInfo } from './links.js'
import { MediaRegistry } from './media-registry.js'
import type { LocalCore } from './media-registry.js'
import type { RemoteCore } from './remote.js'

export type SessionState = 'disconnected' | 'connecting' | 'active' | 'resuming'
export type Health = 'ok' | 'degraded' | 'recovering' | 'offline'
export type Quality = 'excellent' | 'good' | 'poor' | 'lost'

export interface SessionInfo {
  readonly state: SessionState
  readonly recovering: boolean
  readonly reason: { readonly code: number; readonly name: string } | null
  readonly userId: string | null
  readonly pcMode: '1pc' | '2pc' | null
  readonly health: Health
  readonly quality: Quality
}

/** 전이 기록 — 기록 없이 바뀌는 상태가 없다(SDK:IMPL-LINK-PROJECTION 출입구 하나) */
export interface Transition {
  readonly ts: number
  readonly layer: string
  readonly key: string
  readonly from: string
  readonly to: string
  readonly cause: string
  readonly label: string
  readonly rung?: number
  readonly attempt?: number
}

export interface CoreEvents extends Record<string, unknown[]> {
  session: [SessionInfo]
  tokenRequired: [{ cause: 'expired' }]
  closed: [{ code: number; name: string; retryable: boolean }]
  rebuilt: []
  link: [LinkInfo]
  speakingRoom: [string | null]
  speakingRoomFailed: [Fault]
  track: [RoomCore, RemoteCore]
  audioPlayback: [boolean]
  probe: [unknown]
  stats: [unknown]
  transition: [Transition]
}

/** session_id 같은 불투명 문자열을 상태기의 작은 수로 — 같은지만 본다 */
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

/**
 * 클라이언트 객체 하나의 접속 — 시그널링 · 세션 상태기 · 시계 · 백오프 · 토큰을 소유한다.
 * 방 · 연결 · 발행은 이 객체가 직접 소유하고 이음매(위가 정한 받는 곳)대로 직접 부른다.
 */
export class Core {
  readonly cfg: Settings
  readonly book = new LogBook()
  readonly log: Logger
  readonly events = new Emitter<CoreEvents>()
  readonly sig: Signaling
  readonly rooms = new Map<string, RoomCore>()
  readonly links = new Map<string, LinkCore>()
  readonly media: MediaRegistry
  readonly sids = new Interner()
  readonly epochs = new Interner()
  token: string
  ses: SES.St = SES.initial()
  aff: AFF.St = AFF.initial()
  userId: string | null = null
  sessionId: string | null = null
  reason: { code: number; name: string } | null = null
  quality: Quality = 'excellent'
  private readonly timers = new Map<SES.TimerName, Timer>()
  private lateTimer: Timer
  private droppedAt = 0
  private connectWaiters: Waiter[] = []
  private activeWaiters: Waiter[] = []
  private affWaiter: Waiter | null = null
  private affMove: { from: string | null; to: string | null } = { from: null, to: null }
  private appClosed = false
  private ignoreGen = -1
  private resumeBody: ResumeRes | null = null
  private lastInfo = ''
  private pumping = false

  constructor(opts: ClientOptions) {
    this.cfg = settle(opts)
    this.token = opts.token
    this.log = this.book.scope('session')
    this.sig = new Signaling({ base: this.cfg.base, reqTimeoutMs: SES.TIMER_MS.TReq ?? 30000 }, this.book.scope('signaling'))
    this.media = new MediaRegistry(this)
    for (const t of ['TBind', 'TReq', 'THb', 'Backoff', 'TStable'] as const) this.timers.set(t, new Timer(this.cfg.wakeDetectMs))
    this.lateTimer = new Timer(this.cfg.wakeDetectMs)
    if (this.cfg.disconnectOnPageLeave) {
      const w = pageTarget()
      if (w) w.addEventListener('pagehide', () => { if (this.ses.cs !== 'DISCONNECTED') this.close() })
    }
  }

  get opusLine(): string { return opusFmtpLine(this.cfg.opusFmtpDefault) }

  // ── 출입구 ────────────────────────────────────────────────────────────

  record(layer: string, key: string, from: string, to: string, label: string, cause: string, extra?: { rung?: number; attempt?: number }): void {
    const t: Transition = { ts: wall(), layer, key, from, to, cause, label, ...(extra ?? {}) }
    this.events.emit('transition', t)
    this.book.write(cause === 'impossible' ? 'warn' : 'debug', layer.toLowerCase(), `${key} ${from}→${to} ${label}`, cause === 'impossible' ? t : undefined)
  }

  /** 받지 않는 사건 — 조용히 무시하지 않는다(SDK:IMPL-LINK-PROJECTION 받지 않는 사건) */
  impossible(layer: string, key: string, from: string, entry: string): void {
    this.record(layer, key, from, from, entry, 'impossible')
  }

  // ── 세션 ──────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    if (this.ses.cs === 'ACTIVE') return Promise.resolve()
    this.appClosed = false
    const p = new Promise<void>((resolve, reject) => this.connectWaiters.push({ resolve, reject }))
    if (this.ses.cs === 'DISCONNECTED') {
      const pcAsk = decide(this.cfg.pcMode)
      const prev = this.ses
      this.ses = { ...this.ses, pcAsk, token: this.token ? (this.ses.token === 'NONE' ? 'NONE' : this.ses.token) : 'NONE' }
      if (prev.pcAsk !== pcAsk) this.record('SES', 'session', prev.cs, prev.cs, 'SDK.pc_ask', 'capability')
      this.startPump()
      this.sesStep('connect', SES.connect(this.ses), 'app')
    }
    return p
  }

  setToken(token: string): void {
    this.token = token
    const st = SES.newToken(this.ses)
    if (st) {
      this.sesStep('newToken', st, 'app')
      if (this.ses.cs === 'DISCONNECTED' && !this.appClosed) {
        this.startPump()
        this.sesStep('connect', SES.connect(this.ses), 'token')
      }
    }
  }

  close(): Promise<void> {
    this.appClosed = true
    for (const l of this.links.values()) l.closeForApp()
    const st = SES.disconnect(this.ses)
    if (st) this.sesStep('disconnect', st, 'app')
    this.media.closeForApp()
    for (const w of this.connectWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    for (const w of this.activeWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    return Promise.resolve()
  }

  /** 연결 전 요청은 기다린다(SDK:RULE-API-ASYNC 연결 전 요청) */
  untilActive(): Promise<void> {
    if (this.ses.cs === 'ACTIVE') return Promise.resolve()
    if (this.ses.cs === 'DISCONNECTED' && this.connectWaiters.length === 0) return Promise.reject(closedFault('CLOSED'))
    return new Promise((resolve, reject) => this.activeWaiters.push({ resolve, reject }))
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

  private inbound(e: Inbound): void {
    if (e.t === 'open') {
      if (e.gen !== this.sig.generation) return
      const st = SES.sockOpen(this.ses)
      if (st) this.sesStep('sockOpen', st, 'ws.open')
      else this.impossible('SES', 'session', this.ses.cs, 'sockOpen')
      return
    }
    if (e.t === 'close') {
      if (e.gen === this.ignoreGen) return
      const leave: LeaveBody | null = e.leave
      const c = leave ? leave.code : 0
      this.reason = leave ? { code: leave.code, name: leave.name } : { code: 0, name: 'TRANSPORT' }
      const carry = [...this.rooms.values()].some((r) => r.st.rs !== 'NONE') || this.media.anyPublished()
      this.sesStep('drop', SES.drop(this.ses, c, carry), 'ws.close')
      return
    }
    this.notify(e.op, e.body)
  }

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
        if (b['phase'] === 'request' && b['type'] === 'probe') void this.media.probeTask(Number(b['req_id'] ?? 0))
        return
      }
      default:
        this.log.debug(`모르는 통지 ${op} — ACK 만 했다`)
    }
  }

  /** 세션 상태기 한 걸음 — 집행은 plan() 의 목록대로 직접 한다 */
  sesStep(entry: string, step: SES.Step | null, cause: string): void {
    if (!step) { this.impossible('SES', 'session', this.ses.cs, entry); return }
    const prev = this.ses
    const plan = SB.plan(step)
    this.ses = plan.state
    this.record('SES', 'session', prev.cs, this.ses.cs, plan.label, cause, { attempt: this.ses.tries })
    this.sockFollow(prev)
    this.sesTimers(plan.timers)
    for (const tx of plan.send) this.sesSend(tx)
    for (const sm of plan.seams) this.sesSeam(sm.fx)
    for (const f of step.fx) this.sesEffect(f, plan.label)
    this.lateClock(prev, plan.label)
    if (this.ses.cs === 'ACTIVE' && prev.cs !== 'ACTIVE') {
      for (const w of this.activeWaiters.splice(0)) w.resolve()
      for (const l of this.links.values()) l.sessionBack()
    }
    if (this.ses.cs === 'DISCONNECTED' && prev.cs !== 'DISCONNECTED') {
      for (const w of this.activeWaiters.splice(0)) w.reject(closedFault('CLOSED'))
    }
    this.surface()
  }

  private sockFollow(prev: SES.St): void {
    if (this.ses.sock === 'OPENING' && prev.sock !== 'OPENING') this.sig.connect()
    if (this.ses.sock === 'CLOSED' && prev.sock !== 'CLOSED' && this.sig.open) {
      this.ignoreGen = this.sig.generation
      this.sig.close()
    }
  }

  private sesTimers(start: readonly SES.TimerName[]): void {
    const armed = SES.armed(this.ses)
    for (const [name, t] of this.timers) {
      if (!armed.includes(name)) { t.stop(); continue }
      if (start.includes(name) || !t.armed) t.start(this.sesTimerMs(name), (f) => this.sesExpire(name, f.woke))
    }
  }

  private sesTimerMs(name: SES.TimerName): number {
    if (name === 'THb') return this.ses.hbMs || SES.TIMER_MS.THb || 10000
    if (name === 'TStable') return this.cfg.recoveryStableMs
    if (name === 'Backoff') {
      const i = Math.min(this.ses.tries, SES.LADDER.waits.length - 1)
      const base = SES.LADDER.waits[i] ?? 7000
      const jitter = this.ses.tries >= SES.LADDER.jitterFrom - 1 ? Math.floor(Math.random() * SES.LADDER.jitterMs) : 0
      return base + jitter
    }
    return SES.TIMER_MS[name] ?? 10000
  }

  private sesExpire(name: SES.TimerName, woke: boolean): void {
    if (woke && name !== 'THb' && name !== 'Backoff') {
      this.record('SES', 'session', this.ses.cs, this.ses.cs, `SDK.wake.${name}`, 'wake')
      this.timers.get(name)?.start(this.sesTimerMs(name), (f) => this.sesExpire(name, f.woke))
      return
    }
    this.sesStep(`expire.${name}`, SES.expire(this.ses, name), woke ? 'wake' : 'timer')
  }

  /** 끊긴 시각부터의 경과가 재개 창을 넘으면 입구 late(SDK:IMPL-SES-CLOCK) — 숨은 탭에서도 돈다 */
  private lateClock(prev: SES.St, label: string): void {
    if (label === 'SES.C.any.drop_carry' && (prev.cs === 'ACTIVE' || prev.wait === 'RESUME')) this.droppedAt = now()
    if (this.ses.cs !== 'RESUMING' || this.ses.late) { this.lateTimer.stop(); return }
    if (this.lateTimer.armed) return
    const win = this.ses.winMs || 60000
    const left = Math.max(0, win - (now() - this.droppedAt))
    this.lateTimer.start(left, () => {
      if (now() - this.droppedAt < win) { this.lateClock(this.ses, ''); return }
      const st = SES.late(this.ses)
      if (st) this.sesStep('late', st, 'clock')
    })
  }

  private sesSend(tx: SES.Tx): void {
    if (tx.ws === 'BIND') {
      const body: Record<string, unknown> = { token: this.token, client_ver: this.cfg.clientVer, pc_mode: tx.pc_mode }
      if (tx.session_id !== undefined) { const s = this.sids.str(tx.session_id); if (s) body['session_id'] = s }
      this.sig.request('BIND', body).then((r) => this.bindReply(r), () => undefined)
    } else if (tx.ws === 'RESUME') {
      this.sig.request('RESUME', {}).then((r) => this.resumeReply(r), () => undefined)
    } else if (tx.ws === 'HEARTBEAT') {
      this.sig.request('HEARTBEAT', undefined).catch(() => undefined)
    } else if (tx.ws === 'LEAVE') {
      this.ignoreGen = this.sig.generation
      this.sig.sendLeave()
    }
  }

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
    if (r.ok) { this.userId = String(b['user_id'] ?? ''); this.sessionId = sid }
    else this.lastBindFault = fromFailure(r.body)
    const marked = [...this.rooms.values()].some((x) => x.st.rejoin)
    this.sesStep('bindRes', SES.bindRes(this.ses, m, marked), r.ok ? 'BIND.res' : `BIND.${code}`)
  }

  private lastBindFault: Fault | null = null

  private resumeReply(r: Reply): void {
    this.resumeBody = r.ok ? (r.body as ResumeRes) : null
    const dead = [...this.links.values()].some((l) => !l.st.assoc || l.st.ice !== 'OK')
    this.sesStep('resumeRes', SES.resumeRes(this.ses, { part: r.ok ? 'res' : 'fail' }, dead), r.ok ? 'RESUME.res' : 'RESUME.2008')
    this.resumeBody = null
  }

  private sesSeam(fx: SES.SeamFx): void {
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
    const delay = Math.floor(Math.random() * this.cfg.massJitterMs)
    setTimeout(() => { for (const r of marked) r.rejoin() }, delay)
  }

  private resumeSnapshots(): void {
    const body = this.resumeBody
    const snap: Record<string, RoomSnapshot> = body?.snapshot ?? {}
    for (const t of body?.mline_tables ?? []) this.links.get(t.sfu_id)?.pendingTable(t)
    for (const r of [...this.rooms.values()]) r.resumeSnap(snap[r.id] ?? null)
  }

  resumePublications(): readonly Publication[] { return this.resumeBody?.publications ?? [] }

  private sesEffect(f: SES.Fx, label: string): void {
    const e = SB.effect(f).event
    if (f === 'app.connected') {
      this.reason = null
      for (const w of this.connectWaiters.splice(0)) w.resolve()
    } else if (f === 'app.need_token') {
      const waiting = this.connectWaiters.splice(0)
      if (waiting.length) {
        const fault = this.lastBindFault ?? new Fault({ code: Code.TOKEN_EXPIRED.code, name: 'TOKEN_EXPIRED', permanent: false })
        for (const w of waiting) w.reject(fault)
      } else this.events.emit('tokenRequired', { cause: 'expired' })
    } else if (f === 'app.bug') {
      const fault = this.lastBindFault ?? new Fault({ code: 1002, name: 'INVALID_PAYLOAD' })
      for (const w of this.connectWaiters.splice(0)) w.reject(fault)
      this.events.emit('closed', { code: fault.code, name: fault.name, retryable: false })
    } else if (f === 'app.disconnected') {
      const final = label === 'SES.C.any.drop_final'
      const exhausted = label.endsWith('Backoff_exhaust')
      const fault = this.lastBindFault && (label === 'SES.C.CONNECTING.bind_2002') ? this.lastBindFault : closedFault(exhausted ? 'BACKOFF_EXHAUSTED' : 'CLOSED')
      for (const w of this.connectWaiters.splice(0)) w.reject(fault)
      if (!this.appClosed) {
        const r = this.reason ?? { code: 0, name: 'TRANSPORT' }
        this.events.emit('closed', { code: r.code, name: r.name, retryable: !final })
      }
    } else if (f === 'app.rebuilt') {
      this.events.emit('rebuilt')
    }
    if (e === 'session') this.surface(true)
  }

  // ── 소속(발언 방) ────────────────────────────────────────────────────

  get speakingRoom(): string | null { return this.aff.pub === 'NONE' ? null : this.aff.pub }

  /** 발언 방 고르기 — pub_select / pub_deselect 만(SDK:IMPL-AFF-SPEAKING-ROOM) */
  async setSpeakingRoom(roomId: string | null): Promise<void> {
    await this.untilActive()
    if (roomId === this.speakingRoom) return
    while (this.affWaiter) await new Promise<void>((r) => setTimeout(r, 20))
    if (roomId !== null) {
      const room = this.rooms.get(roomId)
      if (!room || room.st.rs !== 'JOINED') throw stateFault('STATE_NOT_JOINED', { room: roomId })
    }
    const p = new Promise<void>((resolve, reject) => { this.affWaiter = { resolve, reject } })
    const cur = this.speakingRoom
    if (roomId === null) {
      this.affMove = { from: cur, to: null }
      this.affStep('deselect', AFF.deselect(this.aff), 'app')
    } else {
      const same = cur === null || this.rooms.get(cur)?.sfuId === this.rooms.get(roomId)?.sfuId
      this.affMove = { from: cur, to: roomId }
      this.affStep('select', AFF.select(this.aff, roomId, same), 'app')
    }
    if (!this.affWaiter) return
    return p
  }

  affStep(entry: string, step: AFF.Step | null, cause: string): void {
    if (!step) {
      this.impossible('AFF', 'client', this.aff.wait, entry)
      const w = this.affWaiter; this.affWaiter = null; w?.resolve()
      return
    }
    const prev = this.aff
    const plan = AB.plan(step)
    this.aff = plan.state
    this.record('AFF', 'client', `${prev.wait}:${prev.pub}`, `${this.aff.wait}:${this.aff.pub}`, plan.label, cause)
    for (const tx of plan.send) this.affSend(tx)
    for (const sm of plan.seams) {
      if (sm.fx === 'floor.pub_away') {
        const from = prev.pub !== 'NONE' ? prev.pub : this.affMove.from
        if (from) this.rooms.get(from)?.floor.pubAway()
      } else if (sm.fx === 'floor.pub_select') {
        if (this.aff.pub !== 'NONE') this.rooms.get(this.aff.pub)?.floor.pubSelect()
      }
    }
    for (const f of step.fx) {
      if (f === 'app.affiliation') {
        this.events.emit('speakingRoom', this.speakingRoom)
        if (this.aff.wait === 'NONE') { const w = this.affWaiter; this.affWaiter = null; w?.resolve() }
      } else if (f === 'app.aff_failed') {
        const fault = this.affFault ?? new Fault({ code: 5003, name: 'INTERNAL_ERROR' })
        this.affFault = null
        this.events.emit('speakingRoomFailed', fault)
        const w = this.affWaiter; this.affWaiter = null; w?.reject(fault)
      }
    }
    if (this.aff.wait === 'NONE' && this.affWaiter && step.fx.length === 0) { const w = this.affWaiter; this.affWaiter = null; w.resolve() }
  }

  private affFault: Fault | null = null

  private affSend(tx: AFF.Tx): void {
    const body: Record<string, unknown> = {}
    if (tx.pub_select !== undefined) body['pub_select'] = tx.pub_select
    if (tx.pub_deselect !== undefined) body['pub_deselect'] = tx.pub_deselect
    const asked = tx.pub_select ?? tx.pub_deselect ?? ''
    const server = this.rooms.get(asked)?.sfuId ?? null
    this.sig.request('AFFILIATION', body).then((r) => this.affReply(r, server), () => {
      this.affFault = closedFault('TRANSPORT')
      this.affStep('res', AFF.res(this.aff, false, 'NONE', false, false), 'AFFILIATION.closed')
    })
  }

  private affReply(r: Reply, server: string | null): void {
    if (!r.ok) {
      this.affFault = fromFailure(r.body)
      this.affStep('res', AFF.res(this.aff, false, 'NONE', false, false), `AFFILIATION.${this.affFault.code}`)
      return
    }
    const b = r.body as AffiliationRes
    if (b.pub_room !== null && !b.sub_rooms.includes(b.pub_room)) {
      this.log.error('pub_room ⊄ sub_rooms 응답 — 반영하지 않는다(서버 결함)', { pub_room: b.pub_room, sub_rooms: b.sub_rooms })
      this.affFault = new Fault({ code: 5003, name: 'AFFILIATION_INCONSISTENT', category: 'server' })
      this.affStep('res', AFF.res(this.aff, false, 'NONE', false, false), 'AFFILIATION.bad')
      return
    }
    const onPub = this.aff.pub !== 'NONE' && this.rooms.get(this.aff.pub)?.sfuId === server
    const onWant = this.aff.want !== 'NONE' && this.rooms.get(this.aff.want)?.sfuId === server
    this.affStep('res', AFF.res(this.aff, true, b.pub_room ?? 'NONE', onPub, onWant), 'AFFILIATION.res')
  }

  // ── 방 ────────────────────────────────────────────────────────────────

  async join(roomId: string, opts: JoinOptions): Promise<RoomCore> {
    await this.untilActive()
    const live = this.rooms.get(roomId)
    if (live && live.st.rs !== 'NONE') return live.joined()
    const room = new RoomCore(this, roomId, opts)
    this.rooms.set(roomId, room)
    return room.start()
  }

  dropRoom(room: RoomCore): void {
    if (this.rooms.get(room.id) === room) this.rooms.delete(room.id)
  }

  linkFor(sfuId: string | null): LinkCore | undefined {
    return sfuId === null ? undefined : this.links.get(sfuId)
  }

  roomsOn(sfuId: string | null): RoomCore[] {
    return [...this.rooms.values()].filter((r) => r.sfuId !== null && r.sfuId === sfuId)
  }

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

  // ── 표면 ──────────────────────────────────────────────────────────────

  get sessionState(): SessionState {
    return this.ses.cs.toLowerCase() as SessionState
  }

  get recovering(): boolean {
    if (this.ses.cs === 'RESUMING') return true
    for (const l of this.links.values()) if (l.everUp && l.state !== 'up') return true
    return false
  }

  get health(): Health {
    if (this.ses.cs !== 'ACTIVE' && this.ses.cs !== 'DISCONNECTED') return 'offline'
    let h: Health = 'ok'
    for (const l of this.links.values()) {
      if (l.blocked) return 'offline'
      const s = l.state
      if (s === 'rebuilding') h = 'recovering'
      else if ((s === 'wobbly' || s === 'restarting') && h === 'ok') h = 'degraded'
    }
    return h
  }

  info(): SessionInfo {
    return { state: this.sessionState, recovering: this.recovering, reason: this.reason, userId: this.userId, pcMode: this.ses.cs === 'ACTIVE' || this.sessionId ? this.ses.pcm : null, health: this.health, quality: this.quality }
  }

  /** 상태 · recovering · reason · health · quality 가 바뀔 때마다 session 이벤트 */
  surface(force = false): void {
    const i = this.info()
    const key = JSON.stringify(i)
    if (!force && key === this.lastInfo) return
    this.lastInfo = key
    this.events.emit('session', i)
  }

  emitLink(info: LinkInfo): void {
    this.events.emit('link', info)
    this.surface()
  }

  localsOn(sfuId: string | null): LocalCore[] { return this.media.on(sfuId) }

  dispose(): void {
    this.sig.dispose()
    for (const t of this.timers.values()) t.stop()
    this.lateTimer.stop()
  }
}
