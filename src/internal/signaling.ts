// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE internal/signaling · 연:TRN.frame.WS · 연:RULE-TRN-FLOW-CONTROL · 연:RULE-TRN-NOTIFY-ACK-STEPS · 연:RULE-LINK-RECOVERY-WS-FIRST · model: claude-opus-5-5
import { Op, Lane, type OpName, type LeaveBody } from './wire/ws.js'
import { openSocket, wsUrl } from '../platform/net.js'
import { closedFault, type Fault } from '../platform/fault.js'
import { Queue } from '../platform/queue.js'
import { now } from '../platform/clock.js'
import type { Logger } from '../platform/log.js'

const MAX_FRAME = 1_048_576
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
  pid: number
  sentAt: number
}

export interface SignalingOpts {
  readonly base: string
  /** 동시에 응답을 기다릴 수 있는 개수 — 1~10 · 기본 1(연:RULE-TRN-FLOW-CONTROL) */
  readonly window?: number
  /** 요청 하나의 시한 — 넘으면 소켓을 닫는다 · 재전송하지 않는다(연:RULE-SES-TIMERS-CONN T-req) */
  readonly reqTimeoutMs: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function frame(flags: number, op: number, pid: number, body: unknown): Uint8Array {
  const json = body === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(body))
  const out = new Uint8Array(8 + json.length)
  out[0] = 1
  out[1] = flags
  out[2] = (op >> 8) & 0xff
  out[3] = op & 0xff
  new DataView(out.buffer).setUint32(4, pid >>> 0)
  out.set(json, 8)
  return out
}

/**
 * WS 소켓 · pid 카운터 · 윈도우 · inflight 표 · ACK 응답(SDK:IMPL-MOD-TABLE).
 * 받은 통지는 ACK 을 먼저 보내고 통(inbox)에 넣는다 — 처리 결과를 따로 보내지 않는다.
 */
export class Signaling {
  readonly inbox = new Queue<Inbound>()
  private ws: WebSocket | null = null
  private gen = 0
  private pid = 0
  private readonly window: number
  private readonly waiting: Pending[] = []
  private readonly inflight = new Map<number, Pending>()
  private leave: LeaveBody | null = null
  private lastRx = 0
  private reqTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: SignalingOpts, private readonly log: Logger) {
    this.window = Math.min(10, Math.max(1, opts.window ?? 1))
  }

  get open(): boolean { return this.ws !== null && this.ws.readyState === 1 }
  get generation(): number { return this.gen }
  /** WS 생존 = 마지막으로 무엇이든 받은 뒤 흐른 시간 하나(연:RULE-LINK-RECOVERY-WS-FIRST) */
  get sinceRx(): number { return this.lastRx === 0 ? Infinity : now() - this.lastRx }

  /** 새 소켓을 연다 — 옛 소켓 핸들러는 떼고 보내다 만 프레임은 버린다(연:RULE-SES-RES-BACKOFF-END) */
  connect(): void {
    const old = this.ws
    this.detach(null)
    if (old) { try { old.close(1000) } catch { /* 이미 닫혔다 */ } }
    const g = ++this.gen
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
    if (this.reqTimer === null) this.reqTimer = setInterval(() => this.checkTimeouts(), 1000)
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
    this.detach(closedFault('CLOSED'))
    if (ws) { try { ws.close(1000) } catch { /* 이미 닫혔다 */ } }
  }

  /** 요청 — 성공 · 실패 응답 모두 resolve, 소켓이 끝나면 closed 로 reject */
  request(op: OpName, body: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const p: Pending = { op, lane: Lane[op], body, resolve, reject, pid: 0, sentAt: 0 }
      if (!this.open) { reject(closedFault('TRANSPORT')); return }
      if (op === 'HEARTBEAT') { this.transmit(p); return }
      this.waiting.push(p)
      this.pump()
    })
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
      await new Promise((r) => setTimeout(r, 50))
    }
    return this.lastRx >= since
  }

  private nextPid(): number {
    this.pid = (this.pid + 1) >>> 0
    return this.pid
  }

  private pump(): void {
    while (this.inflight.size < this.window && this.waiting.length) {
      let best = 0
      for (let i = 1; i < this.waiting.length; i++) if (this.waiting[i]!.lane < this.waiting[best]!.lane) best = i
      const [p] = this.waiting.splice(best, 1)
      this.transmit(p!)
    }
  }

  private transmit(p: Pending): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) { p.reject(closedFault('TRANSPORT')); return }
    p.pid = this.nextPid()
    p.sentAt = now()
    this.inflight.set(p.pid, p)
    this.log.debug(`→ ${p.op}`, { pid: p.pid, body: p.body })
    try { ws.send(frame(0, Op[p.op], p.pid, p.body)) } catch (e) { this.inflight.delete(p.pid); p.reject(closedFault('TRANSPORT')); this.log.warn('ws send 실패', { err: String(e) }) }
  }

  private sendRaw(flags: number, op: number, pid: number, body: unknown): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try { ws.send(frame(flags, op, pid, body)) } catch { /* 끊겼다 */ }
  }

  private receive(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) { this.log.warn('text 프레임을 받았다 — 버린다'); return }
    this.lastRx = now()
    const b = new Uint8Array(data)
    if (b.length < 8 || b.length > MAX_FRAME || b[0] !== 1 || (b[1]! & 3) === 3) { this.log.error('손상 프레임 — 끊는다'); this.close(); return }
    const flags = b[1]! & 3
    const opNum = (b[2]! << 8) | b[3]!
    const pid = new DataView(data).getUint32(4)
    let body: unknown = {}
    if (b.length > 8) {
      try { body = JSON.parse(dec.decode(b.subarray(8))) } catch { this.log.error('JSON 아닌 body — 끊는다'); this.close(); return }
    }
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
  }

  private checkTimeouts(): void {
    if (!this.ws) return
    const t = now()
    for (const p of this.inflight.values()) {
      if (t - p.sentAt > this.opts.reqTimeoutMs) {
        this.log.warn(`T-req 만료 — ${p.op} 응답이 없다 · 소켓을 닫는다`, { pid: p.pid })
        this.close()
        return
      }
    }
  }

  private dropped(): void {
    const g = this.gen
    const leave = this.leave
    this.detach(closedFault('TRANSPORT'))
    this.inbox.push({ t: 'close', gen: g, leave })
  }

  private detach(f: Fault | null): void {
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null }
    const fault = f ?? closedFault('TRANSPORT')
    for (const p of this.inflight.values()) p.reject(fault)
    for (const p of this.waiting) p.reject(fault)
    this.inflight.clear()
    this.waiting.length = 0
  }

  /** 소켓이 아예 끝났다 — 통을 닫는다 */
  dispose(): void {
    this.detach(closedFault('CLOSED'))
    if (this.reqTimer !== null) { clearInterval(this.reqTimer); this.reqTimer = null }
    this.inbox.end()
  }
}

