// author: kodeholic (powered by Claude)
// 1층 가짜 WebSocket — 불러들이면 globalThis.WebSocket 을 갈아 끼운다(브라우저 없이 시그널링 프레임을 주고받는다).
import { decodeFrame, encodeFrame } from '../src/internal/ses/signaling.js'

export type Frame = ReturnType<typeof decodeFrame>

export class FakeWS {
  static made: FakeWS[] = []
  static pid = 9000
  /** 서버 몫을 대신하는 자동 응답 — 요청 op → 응답 body(창 1 이라 답 없는 요청이 뒤 요청을 막는다) */
  static auto = new Map<number, unknown>()
  readyState = 0
  binaryType = 'blob'
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeWS.made.push(this) }
  send(b: Uint8Array): void {
    this.sent.push(b)
    const f = decodeFrame(b)
    if (f.kind === 'request' && FakeWS.auto.has(f.op)) setTimeout(() => { if (this.readyState === 1) this.answer(f, FakeWS.auto.get(f.op)) }, 0)
  }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.() }
  open(): void { this.readyState = 1; this.onopen?.() }
  deliver(b: Uint8Array): void { const c = b.slice(); this.onmessage?.({ data: c.buffer }) }
  frames(): Frame[] { return this.sent.map(decodeFrame) }
  requests(op: number): Frame[] { return this.frames().filter((x) => x.op === op && x.kind === 'request') }
  last(op: number): Frame { const f = this.requests(op); return f[f.length - 1]! }
  reply(op: number, body: unknown, ok = true): void { this.answer(this.last(op), body, ok) }
  answer(f: Frame, body: unknown, ok = true): void { this.deliver(encodeFrame(ok ? 'ok' : 'fail', f.op, f.pid, body)) }
  /** 서버가 보내는 통지 — 받는 쪽이 ACK 한다 */
  notify(op: number, body: unknown): void { this.deliver(encodeFrame('request', op, ++FakeWS.pid, body)) }
}

;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
