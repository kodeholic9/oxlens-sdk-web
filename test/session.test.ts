// author: kodeholic (powered by Claude)
// SDK:IMPL-SES-API · SDK:IMPL-SES-EVENTS — 세션 결선. 브라우저 없이 가짜 WebSocket 으로 위 세션 상태기의 집행을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFrame, encodeFrame } from '../src/internal/signaling.js'
import { Op } from '../src/internal/wire/ws.js'
import { createClient, OxLensError } from '../src/index.js'

class FakeWS {
  static made: FakeWS[] = []
  readyState = 0
  binaryType = 'blob'
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeWS.made.push(this) }
  send(b: Uint8Array): void { this.sent.push(b) }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.() }
  open(): void { this.readyState = 1; this.onopen?.() }
  deliver(b: Uint8Array): void { const c = b.slice(); this.onmessage?.({ data: c.buffer }) }
  frames(): ReturnType<typeof decodeFrame>[] { return this.sent.map(decodeFrame) }
  last(op: number): ReturnType<typeof decodeFrame> { const f = this.frames().filter((x) => x.op === op && x.kind === 'request'); return f[f.length - 1]! }
  reply(op: number, body: unknown, ok = true): void { const f = this.last(op); this.deliver(encodeFrame(ok ? 'ok' : 'fail', op, f.pid, body)) }
}

;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
const BIND_OK = { user_id: 'u1', server_ver: 1, heartbeat_interval: 10_000, session_id: 's-1', resume_window_ms: 60_000, pc_mode: '2pc' }

function fresh(): FakeWS { FakeWS.made.length = 0; return undefined as unknown as FakeWS }

test('연:SES.C.CONNECTING.open — 소켓이 열리면 BIND 부터 · 토큰은 body · pc_mode 를 싣는다', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example/media', token: 'tok', pcMode: '2pc' })
  const p = c.connect()
  await tick()
  const ws = FakeWS.made[0]!
  assert.equal(ws.url, 'wss://hub.example/media/ws')
  ws.open()
  await tick()
  const bind = ws.last(Op.BIND)
  assert.deepEqual(bind.body, { token: 'tok', client_ver: 1, pc_mode: '2pc' })
  ws.reply(Op.BIND, BIND_OK)
  await p
  assert.equal(c.session.state, 'active')
  assert.equal(c.session.userId, 'u1')
  assert.equal(c.session.pcMode, '2pc')
  await c.close()
  assert.ok(ws.frames().some((f) => f.op === Op.LEAVE), 'close() 는 LEAVE 하나를 넣는다')
})

test('연:RULE-TRN-NOTIFY-ACK-STEPS — 통지는 ACK 을 먼저(빈 body 01)', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
  const p = c.connect()
  await tick(); FakeWS.made[0]!.open(); await tick()
  const ws = FakeWS.made[0]!
  ws.reply(Op.BIND, BIND_OK)
  await p
  ws.deliver(encodeFrame('request', Op.LINK_EVENT, 77, { type: 'suspect', sfu_id: 'x', ufrag: 'u' }))
  await tick()
  const ack = ws.frames().find((f) => f.kind === 'ok' && f.pid === 77)
  assert.ok(ack, 'ACK 이 없다')
  assert.equal(ack.op, Op.LINK_EVENT)
  assert.equal(ws.sent.find((b) => decodeFrame(b).pid === 77 && decodeFrame(b).kind === 'ok')!.length, 8)
  await c.close()
})

test('SDK:IMPL-SES-API connect — 최초 접속의 토큰 요구(2003)는 reject(auth) · 이벤트가 아니다', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'old', pcMode: '2pc' })
  let asked = 0
  c.on('tokenRequired', () => { asked += 1 })
  const p = c.connect()
  await tick(); FakeWS.made[0]!.open(); await tick()
  FakeWS.made[0]!.reply(Op.BIND, { code: 2003, name: 'TOKEN_EXPIRED', permanent: false }, false)
  await assert.rejects(p, (e: unknown) => e instanceof OxLensError && e.category === 'auth' && e.code === 2003)
  assert.equal(asked, 0)
  assert.equal(c.session.state, 'disconnected')
})

test('연:SES.C.any.drop_carry 아님 — 방 · 발행이 없으면 끊김 뒤 CONNECTING 으로 다시 붙는다(백오프 첫 칸 0ms)', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
  const states: string[] = []
  c.on('session', (s) => states.push(s.state))
  const p = c.connect()
  await tick(); FakeWS.made[0]!.open(); await tick()
  FakeWS.made[0]!.reply(Op.BIND, BIND_OK)
  await p
  FakeWS.made[0]!.close()
  await tick(5)
  assert.equal(c.session.state, 'connecting')
  assert.equal(FakeWS.made.length, 2, '첫 칸 0ms 로 새 소켓을 연다')
  FakeWS.made[1]!.open(); await tick()
  assert.equal(FakeWS.made[1]!.last(Op.BIND).body && (FakeWS.made[1]!.last(Op.BIND).body as Record<string, unknown>)['session_id'], undefined, '이어받을 것이 없으면 session_id 를 싣지 않는다')
  FakeWS.made[1]!.reply(Op.BIND, { ...BIND_OK, session_id: 's-2' })
  await tick()
  assert.equal(c.session.state, 'active')
  assert.ok(states.includes('connecting') && states.includes('active'))
  await c.close()
})

test('연:SES.fact.LeaveReasons 2010 — 다시 붙지 않는다 · closed{retryable:false}', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
  const closed: { code: number; retryable: boolean }[] = []
  c.on('closed', (x) => closed.push(x))
  const p = c.connect()
  await tick(); FakeWS.made[0]!.open(); await tick()
  FakeWS.made[0]!.reply(Op.BIND, BIND_OK)
  await p
  FakeWS.made[0]!.deliver(encodeFrame('request', Op.LEAVE, 9, { code: 2010, name: 'DUPLICATE_SESSION' }))
  FakeWS.made[0]!.close()
  await tick(5)
  assert.equal(c.session.state, 'disconnected')
  assert.deepEqual(closed.map((x) => [x.code, x.retryable]), [[2010, false]])
  assert.equal(FakeWS.made.length, 1)
  assert.deepEqual(c.session.reason, { code: 2010, name: 'DUPLICATE_SESSION' })
})

test('SDK:RULE-API-ASYNC 연결 전 요청 — join 은 active 까지 기다린다 · 끊기면 closed 로 reject', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
  await assert.rejects(c.join('r1'), (e: unknown) => e instanceof OxLensError && e.category === 'closed')
})
