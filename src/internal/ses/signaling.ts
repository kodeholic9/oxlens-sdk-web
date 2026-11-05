// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE internal/signaling(SES 의 연결 — internal/ses) · SDK:IMPL-SES-CLOCK · 연:TRN.frame.WS · 연:RULE-TRN-FLOW-CONTROL · 연:RULE-TRN-NOTIFY-ACK-STEPS · 연:RULE-TRN-REQ-LIFE · 연:RULE-LINK-RECOVERY-WS-FIRST · model: claude-opus-5-5
import { Op, Lane, type OpName, type LeaveBody } from '../wire/ws.js'
import { openSocket, wsUrl } from '../../platform/net.js'
import { closedFault, Fault } from '../../platform/fault.js'
import { Queue } from '../../platform/queue.js'
import { now, sleep, Every } from '../../platform/clock.js'
import type { Logger } from '../../platform/log.js'

const NAME_OF = new Map<number, OpName>(Object.entries(Op).map(([k, v]) => [v, k as OpName]))

export type Inbound =
  | { readonly t: 'open'; readonly gen: number }
  | { readonly t: 'close'; readonly gen: number; readonly leave: LeaveBody | null }
  | { readonly t: 'notify'; readonly gen: number; readonly op: OpName; readonly body: unknown }

export interface Reply {
  readonly ok: boolean
  readonly op: OpName
  readonly pid: number
  readonly body: unknown
}

interface Pending {
  readonly op: OpName
  readonly lane: number
  readonly body: unknown
  readonly resolve: (r: Reply) => void
  readonly reject: (f: Fault) => void
  /** 처음 보낼 때 매긴다 · 다시 보내도 그대로(연:RULE-TRN-REQ-LIFE 3 · 6) */
  pid: number
  /** 처음 보낸 시각 — 기한(T-req)은 여기서 센다 · 끊긴 동안에도 간다(연:RULE-TRN-REQ-LIFE 1 · 2) */
  sentAt: number
}

/** 소켓에 묶인 op — 세션이 서기 전에 가고 끊기면 버린다(대기표 밖) */
const SOCKET_OPS: ReadonlySet<OpName> = new Set<OpName>(['BIND', 'RESUME', 'HEARTBEAT'])

/** 기한을 넘겨 응답 없이 버린 요청의 reject 이름 — 낸 영역이 입구 reqExpired 로 상태를 맞춘다(연:RULE-TRN-REQ-ABANDON) */
export const REQ_EXPIRED = 'REQ_EXPIRED'
export const expired = (f: unknown): boolean => f instanceof Fault && f.name === REQ_EXPIRED

export interface SignalingOpts {
  readonly base: string
  /** 동시에 응답을 기다릴 수 있는 개수 — 1~10 · 기본 1(연:RULE-TRN-FLOW-CONTROL) */
  readonly window?: number
  /** 요청 하나의 기한 — 넘으면 그 요청만 버리고 소켓을 닫는다(연:RULE-SES-TIMERS-CONN T-req · 연:RULE-TRN-REQ-LIFE 5) */
  readonly reqTimeoutMs: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export type FrameKind = 'request' | 'ok' | 'fail'

export interface Frame {
  readonly kind: FrameKind
  /** flags bit2-7 — 예약 · 원본을 보존한다 */
  readonly reserved: number
  readonly op: number
  readonly pid: number
  readonly body: unknown
}

export class FrameError extends Error {}

export const MAX_FRAME = 1_048_576
const KIND_BITS: Record<FrameKind, number> = { request: 0, ok: 1, fail: 2 }

/** 8B 머리 + JSON — 빈 body 는 0바이트(연:TRN.frame.WS) */
export function encodeFrame(kind: FrameKind, op: number, pid: number, body?: unknown, reserved = 0): Uint8Array {
  const json = body === undefined || (body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body as object).length === 0) ? new Uint8Array(0) : enc.encode(JSON.stringify(body))
  if (8 + json.length > MAX_FRAME) throw new FrameError('프레임이 1,048,576 바이트를 넘는다')
  const out = new Uint8Array(8 + json.length)
  out[0] = 1
  out[1] = ((reserved & 0xfc) | KIND_BITS[kind]) & 0xff
  out[2] = (op >> 8) & 0xff
  out[3] = op & 0xff
  new DataView(out.buffer).setUint32(4, pid >>> 0)
  out.set(json, 8)
  return out
}

/** 8바이트 미만 · ver≠1 · flags 11 · 크기 초과 · JSON 아닌 body 는 FrameError — 끊는 사유다(연:RULE-TRN-CLOSE) */
export function decodeFrame(b: Uint8Array): Frame {
  if (b.length < 8) throw new FrameError('8바이트가 안 된다')
  if (b.length > MAX_FRAME) throw new FrameError('프레임이 너무 크다')
  if (b[0] !== 1) throw new FrameError('ver 가 1 이 아니다')
  const bits = b[1]! & 3
  if (bits === 3) throw new FrameError('flags 11 — 예약')
  const op = (b[2]! << 8) | b[3]!
  const pid = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4)
  let body: unknown = {}
  if (b.length > 8) {
    try { body = JSON.parse(dec.decode(b.subarray(8))) } catch { throw new FrameError('body 가 JSON 이 아니다') }
  }
  return { kind: bits === 0 ? 'request' : bits === 1 ? 'ok' : 'fail', reserved: b[1]! & 0xfc, op, pid, body }
}

function frame(flags: number, op: number, pid: number, body: unknown): Uint8Array {
  return encodeFrame(flags === 0 ? 'request' : flags === 1 ? 'ok' : 'fail', op, pid, body)
}

/**
 * WS 소켓 · pid 카운터 · 윈도우 · 대기표 · ACK 응답(SDK:IMPL-MOD-TABLE · SDK:IMPL-SES-CLOCK).
 * 받은 통지는 ACK 을 먼저 보내고 통(inbox)에 넣는다 — 처리 결과를 따로 보내지 않는다.
 * ★대기표는 소켓이 아니라 세션에 묶인다 — 끊겨도 기한 전이면 들고 있다가 같은 세션이 이어지면(sessionUp(true)) 처음 차례 · 처음 pid 로 다시 보내고, 새 세션이면 버린다(연:RULE-TRN-REQ-LIFE).
 */
export class Signaling {
  readonly inbox = new Queue<Inbound>()
  private ws: WebSocket | null = null
  private gen = 0
  private pid = 0
  private readonly window: number
  private readonly waiting: Pending[] = []
  private readonly inflight = new Map<number, Pending>()
  /** 보냈는데 응답 전에 소켓이 끊긴 요청 — pid 차례 */
  private held: Pending[] = []
  /** 이 소켓 위에 세션이 섰다 — 대기표의 요청이 나간다(BIND · RESUME 은 그 전에 간다) */
  private up = false
  private ended = false
  private leave: LeaveBody | null = null
  private lastRx = 0
  private readonly reqTimer = new Every()

  constructor(private readonly opts: SignalingOpts, private readonly log: Logger) {
    this.window = Math.min(10, Math.max(1, opts.window ?? 1))
  }

  get open(): boolean { return this.ws !== null && this.ws.readyState === 1 }
  get generation(): number { return this.gen }
  /** WS 생존 = 마지막으로 무엇이든 받은 뒤 흐른 시간 하나(연:RULE-LINK-RECOVERY-WS-FIRST) */
  get sinceRx(): number { return this.lastRx === 0 ? Infinity : now() - this.lastRx }

  /** 새 소켓을 연다 — 옛 소켓 핸들러는 떼고 소켓에 묶인 요청은 버린다 · 대기표는 남긴다(연:RULE-SES-RES-BACKOFF-END 2 · 연:RULE-TRN-REQ-LIFE 2) */
  connect(): void {
    const old = this.ws
    this.detach()
    if (old) { try { old.close(1000) } catch { /* 이미 닫혔다 */ } }
    const g = ++this.gen
    this.ended = false
    this.leave = null
    let ws: WebSocket
    try { ws = openSocket(wsUrl(this.opts.base)) } catch (e) {
      this.log.warn('ws open 실패', { err: String(e) })
      queueMicrotask(() => this.inbox.push({ t: 'close', gen: g, leave: null }))
      return
    }
    this.ws = ws
    ws.onopen = () => { if (g === this.gen) { this.lastRx = now(); this.inbox.push({ t: 'open', gen: g }) } }
    ws.onmessage = (ev) => { if (g === this.gen) this.receive(ev.data) }
    ws.onclose = () => { if (g === this.gen) this.dropped() }
    ws.onerror = () => undefined
  }

  /** LEAVE 없이 소켓을 닫는다 — 사유 없는 끊김으로 간다 */
  close(): void {
    if (!this.ws) return
    const ws = this.ws
    try { ws.close(1000) } catch { /* 이미 닫혔다 */ }
    this.dropped()
  }

  /** 세션 끝 — LEAVE 는 큐를 거치지 않고 곧바로 나가고 남은 큐는 버린다(연:RULE-SES-LEAVE-PROC) */
  sendLeave(): void {
    const ws = this.ws
    if (ws && ws.readyState === 1) {
      try { ws.send(frame(0, Op.LEAVE, this.nextPid(), undefined)) } catch { /* 보장 없음 */ }
    }
    this.detach()
    this.sessionEnd(closedFault('CLOSED'))
    this.ended = true
    if (ws) { try { ws.close(1000) } catch { /* 이미 닫혔다 */ } }
  }

  /**
   * 요청 — 성공 · 실패 응답 모두 resolve.
   * 소켓에 묶인 op(BIND · RESUME · HEARTBEAT)는 소켓이 끝나면 closed(TRANSPORT)로 reject ·
   * 그 밖은 세션이 끝나면 closed · 새 세션이면 closed(TRANSPORT) · 기한을 넘기면 closed(REQ_EXPIRED)로 reject.
   */
  request(op: OpName, body: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const p: Pending = { op, lane: Lane[op], body, resolve, reject, pid: 0, sentAt: 0 }
      if (this.ended) { reject(closedFault('CLOSED')); return }
      if (SOCKET_OPS.has(op) && !this.open) { reject(closedFault('TRANSPORT')); return }
      if (op === 'HEARTBEAT') { this.transmit(p); return }
      this.waiting.push(p)
      this.pump()
    })
  }

  /**
   * 세션이 섰다 — same = 같은 세션이 이어졌다(RESUME 성공): 끊긴 동안 들고 있던 요청을 처음 차례 · 처음 pid 로 다시 보내고 그 뒤에 새 요청(연:RULE-TRN-REQ-LIFE 3) ·
   * 새 세션이면 옛 세션의 요청은 버린다(연:RULE-TRN-REQ-LIFE 4 — 세션 재구축이 방 · 발행을 다시 세운다)
   */
  sessionUp(same: boolean): void {
    const held = this.held.sort((a, b) => a.pid - b.pid)
    this.held = []
    if (!same) {
      const f = closedFault('TRANSPORT')
      for (const p of held) p.reject(f)
      for (const p of this.waiting.splice(0)) p.reject(f)
    } else {
      for (const p of held) this.transmit(p)
    }
    this.up = true
    this.pump()
    this.watch()
  }

  /** 세션이 끝났다 — 대기표 전부 closed 로 reject · 다음 connect() 전까지 새 요청도 곧바로 closed(보내지 못한 요청은 기한이 없다 — 매달리지 않게) */
  sessionEnd(f: Fault): void {
    this.ended = true
    for (const p of this.held) p.reject(f)
    for (const p of this.waiting) p.reject(f)
    for (const p of this.inflight.values()) p.reject(f)
    this.held = []
    this.waiting.length = 0
    this.inflight.clear()
    this.up = false
    this.watch()
  }

  /** WS 점검 — HEARTBEAT 를 곧바로 보내고 시한 안에 무엇이든 받으면 산 것이다 */
  async probe(timeoutMs: number): Promise<boolean> {
    if (!this.open) return false
    const since = now()
    this.request('HEARTBEAT', undefined).catch(() => undefined)
    const until = since + timeoutMs
    while (now() < until) {
      if (this.lastRx >= since) return true
      if (!this.open) return false
      await sleep(50)
    }
    return this.lastRx >= since
  }

  private nextPid(): number {
    this.pid = (this.pid + 1) >>> 0
    return this.pid
  }

  private pump(): void {
    if (!this.open) return
    while (this.inflight.size < this.window) {
      let best = -1
      for (let i = 0; i < this.waiting.length; i++) {
        const w = this.waiting[i]!
        if (!this.up && !SOCKET_OPS.has(w.op)) continue
        if (best < 0 || w.lane < this.waiting[best]!.lane) best = i
      }
      if (best < 0) return
      const [p] = this.waiting.splice(best, 1)
      this.transmit(p!)
    }
  }

  private transmit(p: Pending): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) {
      if (SOCKET_OPS.has(p.op)) p.reject(closedFault('TRANSPORT'))
      else if (p.pid) this.held.push(p)
      else this.waiting.unshift(p)
      return
    }
    if (!p.pid) { p.pid = this.nextPid(); p.sentAt = now() }
    this.inflight.set(p.pid, p)
    this.watch()
    this.log.debug(`→ ${p.op}`, { pid: p.pid, body: p.body })
    try { ws.send(frame(0, Op[p.op], p.pid, p.body)) } catch (e) { this.log.warn('ws send 실패 — 끊김을 기다린다', { err: String(e) }) }
  }

  private sendRaw(flags: number, op: number, pid: number, body: unknown): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try { ws.send(frame(flags, op, pid, body)) } catch { /* 끊겼다 */ }
  }

  private receive(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) { this.log.warn('text 프레임을 받았다 — 버린다'); return }
    this.lastRx = now()
    let f: Frame
    try { f = decodeFrame(new Uint8Array(data)) } catch (e) { this.log.error(`손상 프레임 — 끊는다: ${String(e)}`); this.close(); return }
    const flags = KIND_BITS[f.kind]
    const opNum = f.op
    const pid = f.pid
    const body = f.body
    const op = NAME_OF.get(opNum)
    if (flags === 0) {
      if (!op) { this.sendRaw(1, opNum, pid, undefined); return }
      this.log.debug(`← ${op}`, { pid, body })
      if (op === 'LEAVE') { this.leave = body as LeaveBody; return }
      this.sendRaw(1, opNum, pid, undefined)
      if (op === 'HEARTBEAT') return
      this.inbox.push({ t: 'notify', gen: this.gen, op, body })
      return
    }
    const p = this.inflight.get(pid)
    if (!p || !op || p.op !== op) { this.log.debug('짝 없는 응답 — 버린다', { op, pid }); return }
    this.inflight.delete(pid)
    this.log.debug(`← ${op} ${flags === 1 ? 'ok' : 'fail'}`, { pid, body })
    p.resolve({ ok: flags === 1, op, pid, body })
    this.pump()
    this.watch()
  }

  /** 기한(T-req) — 넘긴 요청만 버리고(낸 영역이 상태를 맞춘다) 소켓을 닫는다 · 들고 있는 요청도 끊긴 동안 센다(연:RULE-TRN-REQ-LIFE 2 · 5) */
  private checkTimeouts(): void {
    const t = now()
    const over = (p: Pending): boolean => t - p.sentAt > this.opts.reqTimeoutMs
    let cut = false
    for (const p of [...this.inflight.values()]) {
      if (!over(p)) continue
      this.log.warn(`T-req 만료 — ${p.op} 응답이 없다 · 버리고 소켓을 닫는다`, { pid: p.pid })
      cut = true
      if (SOCKET_OPS.has(p.op)) continue
      this.inflight.delete(p.pid)
      p.reject(closedFault(REQ_EXPIRED))
    }
    for (const p of this.held.filter(over)) {
      this.log.warn(`T-req 만료 — 끊긴 동안 들고 있던 ${p.op} 를 버린다`, { pid: p.pid })
      this.held.splice(this.held.indexOf(p), 1)
      p.reject(closedFault(REQ_EXPIRED))
    }
    if (cut && this.ws) this.close()
    this.watch()
  }

  /** 기한 시계는 셀 요청(보낸 것 · 들고 있는 것)이 있을 때만 돈다 */
  private watch(): void {
    const any = this.inflight.size > 0 || this.held.length > 0
    if (any && !this.reqTimer.armed) this.reqTimer.start(1000, () => this.checkTimeouts())
    else if (!any && this.reqTimer.armed) this.reqTimer.stop()
  }

  private dropped(): void {
    const g = this.gen
    const leave = this.leave
    this.detach()
    this.inbox.push({ t: 'close', gen: g, leave })
  }

  /** 소켓을 뗀다 — 소켓에 묶인 요청은 버리고 보낸 요청은 대기표에 남긴다(연:RULE-TRN-REQ-LIFE 2) */
  private detach(): void {
    const ws = this.ws
    this.ws = null
    this.up = false
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null }
    const f = closedFault('TRANSPORT')
    for (const p of this.inflight.values()) {
      if (SOCKET_OPS.has(p.op)) p.reject(f)
      else this.held.push(p)
    }
    this.inflight.clear()
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (SOCKET_OPS.has(this.waiting[i]!.op)) this.waiting.splice(i, 1)[0]!.reject(f)
    }
    this.watch()
  }

  /** 소켓이 아예 끝났다 — 통을 닫는다 */
  dispose(): void {
    this.detach()
    this.sessionEnd(closedFault('CLOSED'))
    this.ended = true
    this.reqTimer.stop()
    this.inbox.end()
  }
}

