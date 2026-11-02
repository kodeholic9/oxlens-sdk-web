// author: kodeholic (powered by Claude)
// SDK:IMPL-SES-API · SDK:IMPL-SES-EVENTS · SDK:IMPL-SES-CLOCK — 세션 영역 1층. 브라우저 없이 가짜 WebSocket 으로 위 세션 상태기의 집행을 잰다.
// ★입구는 위 결합(session_binding)의 ENTRY 를 지나는지 · 표면은 효과 표(effect)대로 나는지를 SES 단위(SD-ENTRY-SES-* · SD-EFFECT-SES-* · SD-API-* · SD-EVENT-*)마다 잰다.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFrame, encodeFrame } from '../src/internal/ses/signaling.js'
import { Op } from '../src/internal/wire/ws.js'
import { createClient, OxLensError, type OxLensClient, type ClientOptions, type SessionInfo, type LinkInfo } from '../src/index.js'
import * as SES from '../src/domain/gen/session_client.js'
import * as SB from '../src/domain/gen/session_binding.js'
import * as ROOM from '../src/domain/gen/room_client.js'
import * as LINK from '../src/domain/gen/link_client.js'
import { DEFAULTS } from '../src/domain/gen/sdk_defaults.js'
import { settle } from '../src/domain/defaults.js'
import { LinkCore } from '../src/domain/links.js'
import { RoomCore } from '../src/domain/room/core.js'
import type { Core } from '../src/domain/ses/core.js'
import * as FC from '../src/internal/wire/floor_codec.js'
import * as Mbcp from '../src/internal/mbcp.js'
import { SC } from './_fixtures.js'

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

test('연:SES.C.any.drop_final 2001(NOT_BOUND) — BIND 전 다른 op 로 끊기면 다시 붙지 않는다(대장 C-52 ②)', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
  const closed: { code: number; retryable: boolean }[] = []
  c.on('closed', (x) => closed.push(x))
  const p = c.connect()
  await tick(); FakeWS.made[0]!.open(); await tick()
  FakeWS.made[0]!.reply(Op.BIND, BIND_OK)
  await p
  FakeWS.made[0]!.deliver(encodeFrame('request', Op.LEAVE, 9, { code: 2001, name: 'NOT_BOUND' }))
  FakeWS.made[0]!.close()
  await tick(5)
  assert.equal(c.session.state, 'disconnected')
  assert.deepEqual(closed.map((x) => [x.code, x.retryable]), [[2001, false]])
  assert.equal(FakeWS.made.length, 1, '새 소켓을 열지 않는다')
})

test('연:SES.op.RESUME 실패 — 전이 원인은 받은 코드 그대로(SFU_ERROR 를 SESSION_NOT_FOUND 로 적지 않는다 · 대장 C-61 ②)', async () => {
  fresh()
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc' })
  const causes: string[] = []
  c.diagnostics.on('transition', (t) => { if (t.layer === 'SES') causes.push(`${t.label}|${t.cause}`) })
  const p = c.connect()
  await tick(); FakeWS.made[0]!.open(); await tick()
  FakeWS.made[0]!.reply(Op.BIND, BIND_OK)
  await p
  c.join('r1').catch(() => undefined)
  await tick()
  FakeWS.made[0]!.close()
  await tick(5)
  assert.equal(c.session.state, 'resuming', '들어가는 방이 있으면 이어받으러 간다')
  const ws = FakeWS.made[1]!
  ws.open(); await tick()
  assert.equal((ws.last(Op.BIND).body as Record<string, unknown>)['session_id'], 's-1')
  ws.reply(Op.BIND, BIND_OK)
  await tick()
  ws.reply(Op.RESUME, { code: 5002, name: 'SFU_ERROR', permanent: false }, false)
  await tick()
  assert.ok(causes.includes('SES.C.RESUMING.resume_2008|RESUME.5002'), causes.join(' · '))
  assert.ok(!causes.some((x) => x.endsWith('|RESUME.2008')))
  await c.close()
})

test('연:RULE-SES-BIND-PROC — WS 점검은 간격 뒤 보내는 순간에 세션 ACTIVE 를 다시 본다 · 안 보낸 점검은 세지 않는다(대장 C-52 ③)', async () => {
  const probes: number[] = []
  const core = {
    epochs: { id: () => 1 },
    cfg: { wakeDetectMs: 1000, iceRestartBackoffMs: [0, 40], wsProbeTimeoutMs: 10, unreachableAfter: 99 },
    ses: { cs: 'ACTIVE' },
    sig: { probe: () => { probes.push(1); return new Promise<boolean>(() => undefined) } },
    log: { warn: () => undefined, debug: () => undefined },
  }
  const Link = LinkCore as unknown as new (core: unknown, sc: null, peer: null) => LinkCore
  const link = new Link(core, null, null)
  link.st = { ...link.st, ls: 'CHECK' }
  const inner = link as unknown as { wsCheck(): void; attempt: number }
  inner.wsCheck()
  core.ses.cs = 'RESUMING'
  await tick(5)
  assert.equal(probes.length, 0, '세션이 ACTIVE 가 아닌 소켓에 HEARTBEAT 를 내면 NOT_BOUND 로 영구히 끊긴다')
  assert.equal(inner.attempt, 0)
  core.ses.cs = 'ACTIVE'
  link.sessionBack()
  await tick(5)
  assert.equal(probes.length, 1, '세션이 돌아오면 같은 칸(0ms)에서 다시 건다')
  assert.equal(inner.attempt, 1)
})

// ── SES 단위 — 입구 표 · 효과 표 · 표면 ──────────────────────────────────

const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)) }
const lastWs = (): FakeWS => FakeWS.made[FakeWS.made.length - 1]!
const requests = (ws: FakeWS, op: number): number => ws.frames().filter((f) => f.op === op && f.kind === 'request').length
const serverLeave = (ws: FakeWS, code: number, name: string): void => { ws.deliver(encodeFrame('request', Op.LEAVE, 9, { code, name })); ws.close() }
const real = (): Promise<void> => tick(3)

/** 위 결합 ENTRY 의 입구마다 불린 인자(상태 뒤) — SDK 사건이 결합 코드를 지났나를 잰다 */
function spyEntry(): { calls: Record<string, unknown[][]>; n(k: string): number; restore(): void } {
  const E = SB.ENTRY as unknown as Record<string, (...a: unknown[]) => unknown>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  for (const k of Object.keys(saved)) {
    calls[k] = []
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); return saved[k]!(...a) }
  }
  return { calls, n: (k) => calls[k]?.length ?? 0, restore: () => { Object.assign(E, saved) } }
}

interface Rig {
  c: OxLensClient
  core: Core
  labels: string[]
  sessions: SessionInfo[]
  closed: { code: number; name: string; retryable: boolean }[]
  tokens: { cause: string }[]
  rebuilt: number
}

function rig(o: Partial<ClientOptions> = {}): Rig {
  FakeWS.made.length = 0
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc', ...o })
  const r: Rig = { c, core: c.core, labels: [], sessions: [], closed: [], tokens: [], rebuilt: 0 }
  c.diagnostics.on('transition', (t) => { if (t.layer === 'SES') r.labels.push(t.label) })
  c.on('session', (s) => r.sessions.push(s))
  c.on('closed', (x) => r.closed.push(x))
  c.on('tokenRequired', (x) => r.tokens.push(x))
  c.on('rebuilt', () => { r.rebuilt += 1 })
  return r
}

/** 새 소켓(백오프 칸값 뒤에 열린다)을 열고 BIND 에 답한다 */
async function bind(body: unknown, ok = true, wait: () => Promise<void> = real): Promise<FakeWS> {
  await wait()
  for (let i = 0; i < 300 && wait === real && (!FakeWS.made.length || lastWs().readyState !== 0); i++) await tick(10)
  const ws = lastWs()
  ws.open()
  await wait()
  ws.reply(Op.BIND, body, ok)
  await wait()
  return ws
}

async function up(r: Rig, body: unknown = BIND_OK, wait: () => Promise<void> = real): Promise<FakeWS> {
  const p = r.c.connect()
  const ws = await bind(body, true, wait)
  await p
  return ws
}

const FAIL = (code: number, name: string): unknown => ({ code, name, permanent: false })

/** 상태만 가짜인 미디어 연결 — 세션 표면 · 이음매가 읽고 부르는 것만 */
function fakeLink(o: { everUp?: boolean; state?: string; blocked?: boolean; assoc?: boolean } = {}): LinkCore & { repaired: number } {
  const l = {
    st: { assoc: o.assoc ?? true, ice: 'OK' }, everUp: o.everUp ?? true, state: o.state ?? 'up', blocked: o.blocked ?? false, repaired: 0,
    sessionBack: () => undefined, closeForApp: () => undefined, closeAll: () => undefined, pendingTable: () => undefined,
    repair: () => { l.repaired += 1 },
  }
  return l as unknown as LinkCore & { repaired: number }
}

test('SD-ENTRY-SES-CONNECT · SD-API-SET-TOKEN — connect() 와 「재접속 중 토큰 요구 뒤 setToken()」 이 입구 connect 를 하나씩 넣고 새 토큰으로 재접속을 잇는다', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    const ws1 = await up(r)
    assert.equal(spy.n('connect'), 1, 'SD-ENTRY-SES-CONNECT — connect() 는 결합 ENTRY.connect 하나')
    ws1.close()
    await tick(5)
    await bind(FAIL(2003, 'TOKEN_EXPIRED'), false)
    assert.equal(r.c.session.state, 'disconnected')
    assert.equal(spy.n('connect'), 1, '토큰을 받기 전에는 다시 붙지 않는다')
    r.c.setToken('tok-2')
    assert.equal(spy.n('connect'), 2, 'SD-ENTRY-SES-CONNECT — 재접속 중 토큰 요구 뒤 setToken() 이면 SDK 가 ENTRY.connect 를 넣는다')
    const ws3 = await bind({ ...BIND_OK, session_id: 's-2' })
    assert.equal((ws3.last(Op.BIND).body as Record<string, unknown>)['token'], 'tok-2', 'SD-API-SET-TOKEN — 새 토큰을 실은 BIND')
    assert.equal(r.c.session.state, 'active', 'SD-API-SET-TOKEN — tokenRequired 뒤 setToken 으로 재접속이 이어졌다')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-NEW-TOKEN — setToken() 은 ENTRY.newToken 하나 · 위가 받는 때(토큰 요구 뒤)만 전이 · 그 밖은 다음 BIND 에 실릴 뿐', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    const ws = await up(r)
    r.c.setToken('tok-b')
    assert.equal(spy.n('newToken'), 1, 'SD-ENTRY-SES-NEW-TOKEN — setToken() 하나에 ENTRY.newToken 하나')
    assert.ok(!r.labels.includes('SES.C.DISCONNECTED.new_token'), 'ACTIVE 에서는 위가 받지 않는다(사건이 없던 것)')
    assert.equal(r.c.session.state, 'active')
    ws.close()
    await tick(5)
    lastWs().open(); await real()
    assert.equal((lastWs().last(Op.BIND).body as Record<string, unknown>)['token'], 'tok-b', '새 토큰은 다음 BIND 에 실린다')
    lastWs().reply(Op.BIND, FAIL(2003, 'TOKEN_EXPIRED'), false); await real()
    r.c.setToken('tok-c')
    assert.equal(spy.n('newToken'), 2, 'SD-ENTRY-SES-NEW-TOKEN')
    assert.ok(r.labels.includes('SES.C.DISCONNECTED.new_token'), 'SD-ENTRY-SES-NEW-TOKEN — 토큰 요구 뒤에는 위가 받는다')
    await real()
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-SOCK-OPEN · SD-ENTRY-SES-BIND-RES — 소켓 열림은 ENTRY.sockOpen 하나(BIND 를 낸다) · 접속 응답은 ENTRY.bindRes 하나(marked = 다시 들어갈 방 표시)', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    const p = r.c.connect()
    await real()
    const ws = lastWs()
    assert.equal(spy.n('sockOpen'), 0)
    ws.open(); await real()
    assert.equal(spy.n('sockOpen'), 1, 'SD-ENTRY-SES-SOCK-OPEN — WebSocket open 하나에 ENTRY.sockOpen 하나')
    assert.equal(requests(ws, Op.BIND), 1, 'SD-ENTRY-SES-SOCK-OPEN — 위가 낸 BIND')
    assert.equal(spy.n('bindRes'), 0)
    ws.reply(Op.BIND, BIND_OK); await p
    assert.equal(spy.n('bindRes'), 1, 'SD-ENTRY-SES-BIND-RES — 접속 응답 하나에 ENTRY.bindRes 하나')
    const [m, marked] = spy.calls['bindRes']![0]! as [Record<string, unknown>, boolean]
    assert.deepEqual([m['part'], m['session_id'], m['heartbeat_interval'], m['resume_window_ms'], m['pc_mode'], marked], ['res', r.core.sids.id('s-1'), 10_000, 60_000, '2pc', false], 'SD-ENTRY-SES-BIND-RES — 응답값 · 읽는 값 marked')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-DROP — WebSocket close 하나에 ENTRY.drop 하나 · c = 받은 LEAVE code(없으면 0) · carry = 방 · 발행 유무 · 사유별 갈림은 위가(회수 → 다시 붙음 · closed 0)', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    let ws = await up(r)
    ws.close(); await tick(5)
    assert.deepEqual(spy.calls['drop'], [[0, false]], 'SD-ENTRY-SES-DROP — 사유 없음 · 방 없음')
    assert.deepEqual(r.c.session.reason, { code: 0, name: 'TRANSPORT' }, 'SD-ENTRY-SES-DROP — LEAVE 없는 끊김의 사유')
    assert.equal(r.labels.at(-2), 'SES.C.any.drop')
    ws = await bind({ ...BIND_OK, session_id: 's-2' })
    r.c.join('r1').catch(() => undefined); await real()
    ws.close(); await tick(5)
    assert.deepEqual(spy.calls['drop']![1], [0, true], 'SD-ENTRY-SES-DROP — 들어가는 방이 있으면 carry')
    assert.equal(r.c.session.state, 'resuming')
    ws = await bind({ ...BIND_OK, session_id: 's-2' })
    ws.reply(Op.RESUME, { snapshot: {}, publications: [], mline_tables: [] }); await real()
    assert.equal(r.c.session.state, 'active')
    serverLeave(ws, 2009, 'SESSION_REVOKED'); await tick(5)
    assert.deepEqual(spy.calls['drop']![2], [2009, true], 'SD-ENTRY-SES-DROP — c = 받은 LEAVE code')
    assert.deepEqual(r.c.session.reason, { code: 2009, name: 'SESSION_REVOKED' }, 'SD-ENTRY-SES-DROP — session.reason 보관')
    assert.equal(r.c.session.state, 'connecting', 'SD-ENTRY-SES-DROP — 회수는 다시 붙는다(위가 가른다)')
    assert.equal(r.closed.length, 0, 'SD-ENTRY-SES-DROP — 회수에 closed 0')
    assert.equal(spy.n('drop'), 3, 'SD-ENTRY-SES-DROP — 끊김마다 하나')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-RESUME-RES · SD-EFFECT-SES-APP-RESUMED — 이어받기 응답은 ENTRY.resumeRes 하나 · dead = 연결 투영 · app.resumed 는 session{active} · recovering 거짓', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    let ws = await up(r)
    r.c.join('r1').catch(() => undefined); await real()
    const link = fakeLink()
    r.core.links.set('sfu-x', link)
    for (const dead of [false, true]) {
      link.st = { ...link.st, assoc: !dead } as LinkCore['st']
      ws.close(); await tick(5)
      assert.equal(r.c.session.recovering, true)
      ws = await bind(BIND_OK)
      assert.equal(spy.n('resumeRes'), dead ? 1 : 0)
      const before = r.sessions.length
      ws.reply(Op.RESUME, { snapshot: {}, publications: [], mline_tables: [] }); await real()
      assert.deepEqual(spy.calls['resumeRes']!.at(-1), [{ part: 'res' }, dead], 'SD-ENTRY-SES-RESUME-RES — 응답 하나에 ENTRY.resumeRes 하나 · dead = 연결 투영과 같다')
      assert.equal(r.labels.at(-1), dead ? 'SES.C.RESUMING.resume_ok_repair' : 'SES.C.RESUMING.resume_ok')
      assert.equal(SB.effect('app.resumed').event, 'session', 'SD-EFFECT-SES-APP-RESUMED — 결합이 낼 표면을 정한다')
      const fresh = r.sessions.slice(before)
      assert.deepEqual(fresh.map((s) => [s.state, s.recovering]), [['active', false]], 'SD-EFFECT-SES-APP-RESUMED — session{state:active} 하나 · recovering 거짓')
    }
    assert.equal(link.repaired, 1, 'SD-ENTRY-SES-RESUME-RES — 죽은 연결이면 위가 수리를 부른다(media.repair)')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-LATE — 끊긴 뒤 경과가 보관한 재개 창을 넘으면 ENTRY.late 하나 · 그 뒤 BIND 는 session_id 를 싣지 않는다', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    const ws = await up(r, { ...BIND_OK, resume_window_ms: 40 })
    r.c.join('r1').catch(() => undefined); await real()
    ws.close(); await tick(10)
    assert.equal(r.c.session.state, 'resuming')
    assert.equal(spy.n('late'), 0, '창 안')
    await tick(80)
    assert.equal(spy.n('late'), 1, 'SD-ENTRY-SES-LATE — 창을 넘자 ENTRY.late 하나')
    assert.ok(r.labels.includes('SES.C.RESUMING.window_passed'))
    lastWs().open(); await real()
    assert.equal((lastWs().last(Op.BIND).body as Record<string, unknown>)['session_id'], undefined, 'SD-ENTRY-SES-LATE — 창을 넘긴 재접속은 이어받지 않는다(open_late)')
    await r.c.close()
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-DISCONNECT · SD-API-CLOSE · SD-EFFECT-SES-APP-DISCONNECTED — close() 는 ENTRY.disconnect 하나 · LEAVE 1 · ROOM_LEAVE 0 · 응답 대기 0 · rooms 비움 · 다시 connect() · closed 0', async () => {
  const spy = spyEntry()
  try {
    const r = rig()
    const ws = await up(r)
    r.c.join('r1').catch(() => undefined); await real()
    assert.equal(r.c.rooms.size, 1)
    let done = false
    void r.c.close().then(() => { done = true })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(done, true, 'SD-API-CLOSE — 응답을 기다리지 않는다')
    assert.equal(spy.n('disconnect'), 1, 'SD-ENTRY-SES-DISCONNECT — close() 하나에 ENTRY.disconnect 하나')
    assert.equal(requests(ws, Op.LEAVE), 1, 'SD-API-CLOSE — LEAVE 하나')
    assert.equal(requests(ws, Op.ROOM_LEAVE), 0, 'SD-API-CLOSE — 방마다 나가지 않는다')
    assert.equal(r.c.rooms.size, 0, 'SD-API-CLOSE — rooms 비움')
    assert.equal(SB.effect('app.disconnected').event, 'session')
    assert.equal(r.sessions.at(-1)!.state, 'disconnected', 'SD-EFFECT-SES-APP-DISCONNECTED① — session{state:disconnected}')
    assert.equal(r.closed.length, 0, 'SD-EFFECT-SES-APP-DISCONNECTED① — 앱이 끊었으면 closed 0')
    await up(r, { ...BIND_OK, session_id: 's-new' })
    assert.equal(r.c.session.state, 'active', 'SD-API-CLOSE — 같은 객체로 다시 connect()')
    assert.equal(r.core.sessionId, 's-new', 'SD-API-CLOSE — 새 세션')
    serverLeave(lastWs(), 2010, 'DUPLICATE_SESSION'); await tick(5)
    assert.equal(r.sessions.at(-1)!.state, 'disconnected')
    assert.deepEqual(r.closed.map((x) => x.code), [2010], 'SD-EFFECT-SES-APP-DISCONNECTED② — 앱이 끊은 것이 아니면 closed 1 더')
  } finally { spy.restore() }
})

test('SD-ENTRY-SES-TOKEN-AGED — 토큰의 시간 경과는 넣지 않는다(ENTRY 에 없다 · ENTRY_ALL 거짓) · 접속 · 재접속 · 끊기 내내 token_expired 0', async () => {
  assert.equal(typeof SES.tokenAged, 'function', '위 상태기에는 입구가 있다')
  assert.equal(SB.ENTRY_ALL.tokenAged, false, 'SD-ENTRY-SES-TOKEN-AGED — 판정표: 넣지 않는다')
  assert.ok(!('tokenAged' in SB.ENTRY), 'SD-ENTRY-SES-TOKEN-AGED — 결합 ENTRY 에 없다')
  const r = rig()
  const ws = await up(r)
  r.c.setToken('t2')
  ws.close(); await tick(5)
  await bind({ ...BIND_OK, session_id: 's-2' })
  await r.c.close()
  assert.ok(!r.labels.includes('SES.C.any.token_expired'), 'SD-ENTRY-SES-TOKEN-AGED — 입구 tokenAged 0')
})

test('SD-ENTRY-SES-EXPIRE · SD-API-SESSION-REASON — 위가 건 타이머 만료만 ENTRY.expire 하나 · 걸지 않은 타이머 0 · 값 = 위 원장(시한 · 사다리 · 안정 관찰) · T-bind 만료는 BIND_TIMEOUT', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const spy = spyEntry()
  try {
    const r = rig({ recoveryStableMs: 1234 })
    const armed = (): string[] => [...r.core.clock.timers].filter(([, t]) => t.armed).map(([n]) => n)
    const p = r.c.connect()
    await flush(); lastWs().open(); await flush()
    assert.deepEqual(armed(), SES.armed(r.core.ses), 'SD-ENTRY-SES-EXPIRE — 도는 타이머 = 위 armed()')
    assert.deepEqual(armed(), ['TBind'], 'SD-ENTRY-SES-EXPIRE — BIND 응답 대기 중에는 T-bind 하나')
    mock.timers.tick(SES.TIMER_MS.TBind! - 1)
    assert.equal(spy.n('expire'), 0, 'SD-ENTRY-SES-EXPIRE — 값 = 위 원장(T-bind 직전 0)')
    assert.equal(r.core.clock.ms('Backoff'), SES.LADDER.waits[0], 'SD-ENTRY-SES-EXPIRE — 백오프 첫 칸 = 위 사다리')
    assert.equal(r.core.clock.ms('TStable'), SES.TIMER_MS.TStable, 'SD-ENTRY-SES-EXPIRE — 세션 층 안정 관찰은 위 원장(연결 층 손잡이 recoveryStableMs 가 아니다)')
    mock.timers.tick(1)
    assert.deepEqual(spy.calls['expire']![0], ['TBind'], 'SD-ENTRY-SES-EXPIRE — T-bind 만료에 ENTRY.expire 하나')
    assert.ok(r.labels.includes('SES.C.any.TBind'))
    assert.deepEqual(r.c.session.reason, { code: 0, name: 'BIND_TIMEOUT' }, 'SD-API-SESSION-REASON — T-bind 만료 = code:0 · BIND_TIMEOUT')
    assert.deepEqual(spy.calls['expire']![1], ['Backoff'], 'SD-ENTRY-SES-EXPIRE — 첫 칸(0ms) 백오프 만료에 ENTRY.expire 하나')
    assert.equal(spy.n('expire'), 2)
    assert.deepEqual(armed(), SES.armed(r.core.ses), 'SD-ENTRY-SES-EXPIRE — 걸지 않은 타이머 0(소켓 여는 중 — 아무것도 안 돈다)')
    await flush()
    lastWs().open(); await flush()
    lastWs().reply(Op.BIND, { ...BIND_OK, heartbeat_interval: 60_000 }); await flush()
    await p
    assert.deepEqual(armed().sort(), ['THb', 'TStable'], 'SD-ENTRY-SES-EXPIRE — 재시도 뒤 ACTIVE: 하트비트 · 안정 관찰')
    mock.timers.tick(SES.TIMER_MS.TStable!)
    assert.deepEqual(spy.calls['expire']![2], ['TStable'], 'SD-ENTRY-SES-EXPIRE — 안정 관찰 만료에 ENTRY.expire 하나')
    assert.equal(r.core.ses.tries, 0)
    assert.deepEqual(armed(), ['THb'])
    const ws = lastWs()
    mock.timers.tick(60_000 - SES.TIMER_MS.TStable!)
    assert.deepEqual(spy.calls['expire']![3], ['THb'], 'SD-ENTRY-SES-EXPIRE — 하트비트 주기 = 위 상태가 보관한 BIND 응답값')
    assert.equal(requests(ws, Op.HEARTBEAT), 1)
    assert.equal(spy.n('expire'), 4)
    await r.c.close()
  } finally { spy.restore(); mock.timers.reset() }
})

test('SD-EFFECT-SES-APP-CONNECTED — app.connected 는 session{state:active} 하나 · 기다리던 connect() resolve', async () => {
  const r = rig()
  assert.equal(SB.effect('app.connected').event, 'session', 'SD-EFFECT-SES-APP-CONNECTED — 결합이 낼 표면을 정한다')
  let resolved = false
  const p = r.c.connect().then(() => { resolved = true })
  await real(); lastWs().open(); await real()
  assert.equal(resolved, false)
  lastWs().reply(Op.BIND, BIND_OK)
  await p
  assert.equal(resolved, true, 'SD-EFFECT-SES-APP-CONNECTED — connect() resolve')
  assert.equal(r.sessions.filter((s) => s.state === 'active').length, 1, 'SD-EFFECT-SES-APP-CONNECTED — session{state:active} 하나')
  await r.c.close()
})

test('SD-EFFECT-SES-APP-NEED-TOKEN · SD-API-CONNECT — 재접속 중이면 tokenRequired 하나 · 최초 접속이면 이벤트 0 · connect() reject(auth)', async () => {
  assert.equal(SB.effect('app.need_token').event, 'tokenRequired')
  const a = rig()
  const p = a.c.connect()
  p.catch(() => undefined)
  await bind(FAIL(2003, 'TOKEN_EXPIRED'), false)
  await assert.rejects(p, (e: unknown) => e instanceof OxLensError && e.category === 'auth' && e.code === 2003, 'SD-API-CONNECT — 최초 2003 은 reject')
  assert.equal(a.tokens.length, 0, 'SD-EFFECT-SES-APP-NEED-TOKEN② — 최초 접속이면 이벤트 0 · connect() reject(auth)')
  const b = rig()
  const ws = await up(b)
  ws.close(); await tick(5)
  await bind(FAIL(2003, 'TOKEN_EXPIRED'), false)
  assert.deepEqual(b.tokens, [{ cause: 'expired' }], 'SD-EFFECT-SES-APP-NEED-TOKEN① — 재접속 중이면 tokenRequired 하나')
  await b.c.close()
})

test('SD-EFFECT-SES-APP-BUG — 재접속 중이면 closed{retryable:false} 하나 · 최초 접속이면 connect() reject(bug) 도', async () => {
  assert.equal(SB.effect('app.bug').event, 'closed')
  const a = rig()
  const p = a.c.connect()
  p.catch(() => undefined)
  await bind(FAIL(1002, 'INVALID_PAYLOAD'), false)
  await assert.rejects(p, (e: unknown) => e instanceof OxLensError && e.category === 'bug' && e.code === 1002, 'SD-EFFECT-SES-APP-BUG② — 최초면 connect() reject(bug)')
  assert.deepEqual(a.closed, [{ code: 1002, name: 'INVALID_PAYLOAD', retryable: false }], 'SD-EFFECT-SES-APP-BUG① — closed{retryable:false} 하나')
  const b = rig()
  const ws = await up(b)
  ws.close(); await tick(5)
  await bind(FAIL(1004, 'BAD_VERSION'), false)
  assert.deepEqual(b.closed, [{ code: 1004, name: 'BAD_VERSION', retryable: false }], 'SD-EFFECT-SES-APP-BUG① — 재접속 중 closed{retryable:false} 하나')
  assert.equal(b.c.session.state, 'disconnected')
  await tick(10)
  assert.equal(FakeWS.made.length, 2, '다시 붙지 않는다')
})

test('SD-EFFECT-SES-APP-REBUILT — 이어받기 실패 뒤 새 세션이면 rebuilt 하나 · 같은 방 핸들이 rebuilding → rebuilt(다시 입장)', async () => {
  assert.equal(SB.effect('app.rebuilt').event, 'rebuilt')
  const r = rig({ massJitterMs: 0 })
  let ws = await up(r)
  r.c.join('r1').catch(() => undefined); await real()
  const handle = r.c.rooms.get('r1')!
  const room = r.core.rooms.get('r1')!
  ws.close(); await tick(5)
  ws = await bind({ ...BIND_OK, session_id: 's-other' })
  assert.equal(r.labels.at(-1), 'SES.C.RESUMING.bind_new')
  assert.equal(r.rebuilt, 1, 'SD-EFFECT-SES-APP-REBUILT — rebuilt 하나')
  assert.equal(handle.rebuilding, true, 'SD-EFFECT-SES-APP-REBUILT — 방이 rebuilding')
  assert.equal(r.c.session.recovering, true, '세션 재구축 중 recovering')
  await tick(5)
  assert.equal(requests(ws, Op.ROOM_JOIN), 1, '같은 방에 다시 들어간다')
  assert.equal(r.core.rooms.get('r1'), room, '같은 핸들')
  room.enter('joinRes', 'ROOM_JOIN.res', [{ code: 0, part: 'res', server_config: { pc_mode: '2pc', sfu_id: 1 }, version: { epoch: 1, seq: 1 } }, '2pc'])
  assert.equal(handle.rebuilding, false, 'SD-EFFECT-SES-APP-REBUILT — 다시 입장하면 rebuilt')
  assert.equal(r.sessions.at(-1)!.recovering, false, '재구축이 끝나면 session 이벤트가 recovering 을 내린다')
  await r.c.close()
})

test('SD-API-CREATE-CLIENT — 안 준 칸은 정책서 §4-1 기본값(연결 복구 손잡이 여덟 포함) · 준 칸이 이긴다', () => {
  const c = createClient({ base: 'https://hub.example', token: 't' })
  const s = c.core.cfg
  const eight = ['wobblyGraceMs', 'iceRestartTimeoutMs', 'recoveryStableMs', 'wakeDetectMs', 'wsProbeTimeoutMs', 'massJitterMs', 'unreachableAfter'] as const
  const want: Record<string, unknown> = { ...DEFAULTS, recoveryStableMs: SES.TIMER_MS.TStable }
  for (const k of eight) assert.equal(s[k], want[k], `SD-API-CREATE-CLIENT — ${k}`)
  assert.deepEqual(s.iceRestartBackoffMs, SES.LADDER.waits, 'SD-API-CREATE-CLIENT — iceRestartBackoffMs = 위 사다리 칸값')
  assert.deepEqual([s.deviceAcquireTimeoutMs, s.statsIntervalMs, s.silenceWindowMs, s.adaptiveStreamSettleMs, s.micColdAfterMs, s.playoutDelayMs], [DEFAULTS.deviceAcquireTimeoutMs, DEFAULTS.statsIntervalMs, DEFAULTS.silenceWindowMs, DEFAULTS.adaptiveStreamSettleMs, DEFAULTS.micColdAfterMs, DEFAULTS.playoutDelayMs], 'SD-API-CREATE-CLIENT — 낱 손잡이')
  assert.deepEqual([s.dcReopen, s.opusFmtpDefault, s.simulcastLayers, s.cameraCapture, s.screenShare, s.quality], [DEFAULTS.dcReopen, DEFAULTS.opusFmtpDefault, DEFAULTS.simulcastLayers, DEFAULTS.cameraCapture, DEFAULTS.screenShare, DEFAULTS.quality], 'SD-API-CREATE-CLIENT — 묶음')
  assert.deepEqual([s.pcMode, s.disconnectOnPageLeave, s.adaptiveStream, s.clientVer], ['auto', true, true, 1], 'SD-API-CREATE-CLIENT — §14-1-1 · §10 기본')
  assert.deepEqual(s, settle({ base: 'https://hub.example', token: 't' }))
  const o = settle({ base: 'b', token: 't', wobblyGraceMs: 7, massJitterMs: 0, unreachableAfter: null })
  assert.deepEqual([o.wobblyGraceMs, o.massJitterMs, o.unreachableAfter], [7, 0, DEFAULTS.unreachableAfter], 'SD-API-CREATE-CLIENT — 준 칸이 이긴다 · null 은 기본값')
})

/** 끝날 때까지 — 새 소켓마다 open(답 있음/없음) · 망 실패(open 전 close) · 시계를 민다 */
async function exhaust(r: Rig, p: Promise<unknown>, each: (ws: FakeWS) => void): Promise<void> {
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  let seen = 0
  for (let i = 0; i < 40 && !settled; i++) {
    await flush()
    if (FakeWS.made.length > seen) { seen = FakeWS.made.length; each(lastWs()); await flush() }
    mock.timers.tick(10_000)
    await flush()
  }
  assert.equal(settled, true, '백오프가 끝나지 않았다')
  void r
}

test('SD-API-CONNECT — 최초 접속 실패 집합 다섯: auth(2002 · 2003) · bug(1002) · limit(4003 — 백오프 소진 뒤) · closed(T-bind 만료)', async () => {
  for (const [code, name, cat] of [[2003, 'TOKEN_EXPIRED', 'auth'], [2002, 'INVALID_TOKEN', 'auth'], [1002, 'INVALID_PAYLOAD', 'bug']] as const) {
    const r = rig()
    const p = r.c.connect()
    p.catch(() => undefined)
    await bind(FAIL(code, name), false)
    await assert.rejects(p, (e: unknown) => e instanceof OxLensError && e.category === cat && e.code === code, `SD-API-CONNECT — ${code} → ${cat}`)
    assert.equal(r.c.session.state, 'disconnected')
  }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const lim = rig()
    const p1 = lim.c.connect()
    p1.catch(() => undefined)
    await exhaust(lim, p1, (ws) => { ws.open(); queueMicrotask(() => ws.reply(Op.BIND, FAIL(4003, 'SESSION_LIMIT'), false)) })
    await assert.rejects(p1, (e: unknown) => e instanceof OxLensError && e.category === 'limit' && e.code === 4003, 'SD-API-CONNECT — 4003 → limit')
    assert.equal(lim.closed.length, 1)
    const tb = rig()
    const p2 = tb.c.connect()
    p2.catch(() => undefined)
    await exhaust(tb, p2, (ws) => { ws.open() })
    await assert.rejects(p2, (e: unknown) => e instanceof OxLensError && e.category === 'closed' && e.name === 'BIND_TIMEOUT', 'SD-API-CONNECT — T-bind 만료 → closed')
  } finally { mock.timers.reset() }
})

test('SD-API-SESSION-STATE — 상태 넷은 위 연결 상태 넷을 소문자로 그대로(연:RULE-SES-CONN-DIAGRAM 동형)', async () => {
  const r = rig()
  const conns: SES.Conn[] = ['DISCONNECTED', 'CONNECTING', 'ACTIVE', 'RESUMING']
  const saved = r.core.ses
  for (const cs of conns) {
    r.core.ses = { ...saved, cs }
    assert.equal(r.c.session.state, cs.toLowerCase(), `SD-API-SESSION-STATE — ${cs}`)
  }
  r.core.ses = saved
  const ws = await up(r)
  r.c.join('r1').catch(() => undefined); await real()
  ws.close(); await tick(5)
  await r.c.close()
  assert.deepEqual([...new Set(r.sessions.map((s) => s.state))].sort(), ['active', 'connecting', 'disconnected', 'resuming'], 'SD-API-SESSION-STATE — 흐름에서 넷이 다 보인다')
})

test('SD-API-SESSION-RECOVERING — resuming · 세션 재구축 중 참 · up 이 아닌 연결(첫 수립 중은 뺀다) 참 · 다 up 이면 거짓 · 파생값', async () => {
  const r = rig()
  await up(r)
  const a = fakeLink(); const b = fakeLink()
  r.core.links.set('a', a); r.core.links.set('b', b)
  assert.equal(r.c.session.recovering, false, 'SD-API-SESSION-RECOVERING④ — 다 up 이면 거짓')
  const saved = r.core.ses
  r.core.ses = { ...saved, cs: 'RESUMING' }
  assert.equal(r.c.session.recovering, true, 'SD-API-SESSION-RECOVERING① — resuming')
  r.core.ses = saved
  const room = new RoomCore(r.core, 'r9', {})
  r.core.rooms.set('r9', room)
  room.rebuilding = true
  assert.equal(r.c.session.recovering, true, 'SD-API-SESSION-RECOVERING① — 세션 재구축 중인 방')
  room.rebuilding = false
  for (const s of ['wobbly', 'restarting', 'rebuilding']) {
    Object.assign(b, { state: s })
    assert.equal(r.c.session.recovering, true, `SD-API-SESSION-RECOVERING② — 한 서버 연결만 ${s}`)
  }
  for (const s of ['connecting', 'restarting']) {
    Object.assign(b, { state: s, everUp: false })
    assert.equal(r.c.session.recovering, false, `SD-API-SESSION-RECOVERING③ — 한 번도 up 에 닿지 않은 서버의 ${s}`)
  }
  Object.assign(b, { state: 'up', everUp: true })
  assert.equal(r.c.session.recovering, false, 'SD-API-SESSION-RECOVERING④')
  assert.equal(r.core.info().recovering, r.c.session.recovering, 'SD-API-SESSION-RECOVERING — 따로 들지 않는다(표면 · 이벤트가 같은 계산)')
  r.core.rooms.delete('r9'); r.core.links.clear()
  await r.c.close()
})

test('SD-API-CLIENT-HEALTH — wobbly/restarting → degraded · rebuilding 또는 세션 층 복구 → recovering · WS 끊김 · path_unreachable → offline · 한 곳에서 계산 · 바뀌면 session', async () => {
  const r = rig()
  await up(r)
  const a = fakeLink(); const b = fakeLink()
  r.core.links.set('a', a); r.core.links.set('b', b)
  assert.equal(r.c.health, 'ok')
  for (const s of ['wobbly', 'restarting']) { Object.assign(b, { state: s }); assert.equal(r.c.health, 'degraded', `SD-API-CLIENT-HEALTH① — ${s}`) }
  Object.assign(b, { state: 'rebuilding' })
  assert.equal(r.c.health, 'recovering', 'SD-API-CLIENT-HEALTH② — rebuilding')
  Object.assign(b, { state: 'up' })
  const room = new RoomCore(r.core, 'r9', {})
  r.core.rooms.set('r9', room); room.rebuilding = true
  assert.equal(r.c.health, 'recovering', 'SD-API-CLIENT-HEALTH② — 세션 재구축 중')
  room.rebuilding = false; r.core.rooms.delete('r9')
  Object.assign(a, { blocked: true })
  assert.equal(r.c.health, 'offline', 'SD-API-CLIENT-HEALTH③ — path_unreachable')
  Object.assign(a, { blocked: false })
  const saved = r.core.ses
  for (const cs of ['RESUMING', 'CONNECTING'] as const) { r.core.ses = { ...saved, cs }; assert.equal(r.c.health, 'offline', `SD-API-CLIENT-HEALTH③ — WS 끊김(${cs})`) }
  r.core.ses = saved
  const n = r.sessions.length
  const info = (state: string): LinkInfo => ({ server: 'b', state: state as LinkInfo['state'], rung: 0, attempt: 0, cause: null, since: 1 })
  Object.assign(b, { state: 'wobbly' }); r.core.emitLink(info('wobbly'))
  assert.deepEqual(r.sessions.slice(n).map((s) => s.health), ['degraded'], 'SD-API-CLIENT-HEALTH④ — 바뀌면 session 이벤트')
  r.core.emitLink(info('wobbly'))
  assert.equal(r.sessions.length, n + 1, 'SD-API-CLIENT-HEALTH④ — 그대로면 0')
  Object.assign(b, { state: 'up' }); r.core.emitLink(info('up'))
  assert.deepEqual(r.sessions.slice(n).map((s) => s.health), ['degraded', 'ok'], 'SD-API-CLIENT-HEALTH④')
  assert.equal(r.c.health, r.sessions.at(-1)!.health, 'SD-API-CLIENT-HEALTH④ — 계산 지점 하나(표면 = 이벤트)')
  r.core.links.clear()
  await r.c.close()
})

test('SD-API-SESSION-REASON — LEAVE 의 code/name 보관 · LEAVE 없는 끊김 = code:0 + TRANSPORT · 접속 실패 = BIND_FAILED · 클라 주도 = 없음', async () => {
  const r = rig()
  let ws = await up(r)
  assert.equal(r.c.session.reason, null)
  ws.close(); await tick(5)
  assert.deepEqual(r.c.session.reason, { code: 0, name: 'TRANSPORT' }, 'SD-API-SESSION-REASON — LEAVE 없는 끊김')
  await bind(FAIL(5003, 'INTERNAL_ERROR'), false)
  assert.deepEqual(r.c.session.reason, { code: 0, name: 'BIND_FAILED' }, 'SD-API-SESSION-REASON — 접속 실패')
  await r.c.close()
  assert.equal(r.c.session.reason, null, 'SD-API-SESSION-REASON — 클라 주도 = 없음')
  ws = await up(r, { ...BIND_OK, session_id: 's-3' })
  serverLeave(ws, 4006, 'FLOW_TIMEOUT'); await tick(5)
  assert.deepEqual(r.c.session.reason, { code: 4006, name: 'FLOW_TIMEOUT' }, 'SD-API-SESSION-REASON — LEAVE 의 code/name')
})

test('SD-API-SESSION-USER-ID — BIND 응답의 user_id · pc_mode 에코를 그대로(2pc · 1pc)', async () => {
  for (const pc of ['2pc', '1pc'] as const) {
    const r = rig({ pcMode: pc })
    await up(r, { ...BIND_OK, user_id: `u-${pc}`, pc_mode: pc })
    assert.deepEqual([r.c.session.userId, r.c.session.pcMode], [`u-${pc}`, pc], `SD-API-SESSION-USER-ID — ${pc} 에코`)
    await r.c.close()
  }
})

test('SD-API-SESSION-QUALITY — getStats 로 4단 · 여러 서버면 최악값 · 문턱 = 정책서 · 바뀌면 session', async () => {
  const r = rig()
  await up(r)
  const th = DEFAULTS.quality
  const report = (rttMs: number): RTCStatsReport => new Map<string, unknown>([
    ['T', { type: 'transport', id: 'T', selectedCandidatePairId: 'P' }],
    ['P', { type: 'candidate-pair', id: 'P', state: 'succeeded', currentRoundTripTime: rttMs / 1000 }],
  ]) as unknown as RTCStatsReport
  const link = (server: string) => {
    const l = { server, state: 'up', rtt: 10, peer: { stats: async () => [report(l.rtt)] } }
    return l
  }
  const a = link('a'); const b = link('b')
  r.core.links.set('a', a as unknown as LinkCore); r.core.links.set('b', b as unknown as LinkCore)
  const stats = (): Promise<void> => (r.core.media as unknown as { stats(): Promise<void> }).stats()
  const seen: string[] = []
  r.c.on('session', (s) => seen.push(s.quality))
  b.rtt = th.excellent.rttMs - 1; await stats()
  assert.equal(r.c.session.quality, 'excellent', 'SD-API-SESSION-QUALITY — 문턱 = 정책서(excellent RTT 미만)')
  b.rtt = th.excellent.rttMs; await stats()
  assert.equal(r.c.session.quality, 'good', 'SD-API-SESSION-QUALITY — 한 서버만 나빠도 최악값')
  b.rtt = th.good.rttMs; await stats()
  assert.equal(r.c.session.quality, 'poor', 'SD-API-SESSION-QUALITY — good 문턱')
  b.state = 'rebuilding'; await stats()
  assert.equal(r.c.session.quality, 'lost', 'SD-API-SESSION-QUALITY — 죽음 판정')
  b.state = 'up'; b.rtt = 10; await stats()
  assert.deepEqual(seen, ['good', 'poor', 'lost', 'excellent'], 'SD-API-SESSION-QUALITY — 바뀔 때마다 session 하나')
  r.core.links.clear()
  await r.c.close()
})

test('SD-EVENT-SESSION — 상태 변화 하나에 session 이벤트 하나', async () => {
  const r = rig()
  const ws = await up(r)
  ws.close(); await tick(5)
  await bind({ ...BIND_OK, session_id: 's-2' })
  await r.c.close()
  assert.deepEqual(r.sessions.map((s) => s.state), ['connecting', 'active', 'connecting', 'active', 'disconnected'], 'SD-EVENT-SESSION — 변화마다 하나(소켓 열림 · BIND 송신은 변화가 아니다)')
})

test('SD-EVENT-TOKEN-REQUIRED — cause 는 expired 하나(BIND 2003 · HTTP 401) · 4004 로는 0', async () => {
  const r = rig()
  let ws = await up(r)
  const g = globalThis as unknown as { fetch: unknown }
  const savedFetch = g.fetch
  g.fetch = async () => ({ status: 401, text: async () => JSON.stringify(FAIL(2003, 'TOKEN_EXPIRED')) })
  try { await assert.rejects(r.c.listRooms()) } finally { g.fetch = savedFetch }
  r.c.join('r1').catch(() => undefined); await real()
  ws.reply(Op.ROOM_JOIN, FAIL(4004, 'LISTEN_LIMIT'), false); await real()
  assert.equal(r.tokens.length, 1, 'SD-EVENT-TOKEN-REQUIRED② — 4004 로는 발동 0(401 하나만)')
  ws.close(); await tick(5)
  ws = await bind(FAIL(2003, 'TOKEN_EXPIRED'), false)
  assert.deepEqual(r.tokens, [{ cause: 'expired' }, { cause: 'expired' }], 'SD-EVENT-TOKEN-REQUIRED① — cause 는 expired 하나')
  await r.c.close()
})

test('SD-EVENT-CLOSED — retryable 사상: 끝내는 LEAVE 사유 · 클라 버그 = false · 회수 · 서버 내려감 = closed 0 · 백오프 소진 = true', async () => {
  for (const [code, name] of [[1008, 'PROTOCOL_ERROR'], [2001, 'NOT_BOUND'], [4006, 'FLOW_TIMEOUT'], [4007, 'FLOW_OVERFLOW'], [2010, 'DUPLICATE_SESSION']] as const) {
    const r = rig()
    serverLeave(await up(r), code, name); await tick(5)
    assert.deepEqual(r.closed, [{ code, name, retryable: false }], `SD-EVENT-CLOSED — ${code} 는 retryable:false`)
  }
  for (const [code, name] of [[2009, 'SESSION_REVOKED'], [5004, 'SERVER_SHUTDOWN']] as const) {
    const r = rig()
    serverLeave(await up(r), code, name); await tick(5)
    assert.equal(r.closed.length, 0, `SD-EVENT-CLOSED — ${code} 는 다시 붙는다(closed 0)`)
    await r.c.close()
  }
  const bug = rig()
  const ws = await up(bug)
  ws.close(); await tick(5)
  await bind(FAIL(1002, 'INVALID_PAYLOAD'), false)
  assert.deepEqual(bug.closed.map((x) => x.retryable), [false], 'SD-EVENT-CLOSED — 클라 버그는 retryable:false')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const r = rig()
    const p = r.c.connect()
    await flush(); lastWs().open(); await flush(); lastWs().reply(Op.BIND, BIND_OK); await flush(); await p
    r.c.join('r1').catch(() => undefined); await flush()
    lastWs().close(); await flush()
    const gone = new Promise<void>((res) => r.c.once('closed', () => res()))
    await exhaust(r, gone, (w) => { w.close() })
    assert.deepEqual(r.closed.map((x) => [x.name, x.retryable]), [['TRANSPORT', true]], 'SD-EVENT-CLOSED — 백오프 소진은 retryable:true')
    assert.ok(r.labels.includes('SES.C.RESUMING.Backoff_exhaust'))
  } finally { mock.timers.reset() }
})

test('SD-EVENT-LINK — 서버 둘 중 하나가 흔들리면 그 서버 link 만 · 필드 다섯+server · 상태가 바뀔 때마다 하나', () => {
  const r = rig()
  const Link = LinkCore as unknown as new (core: Core, sc: typeof SC, peer: null) => LinkCore
  const a = new Link(r.core, { ...SC, sfu_id: 'sfu-a' }, null)
  const b = new Link(r.core, { ...SC, sfu_id: 'sfu-b' }, null)
  a.st = { ...a.st, everUp: true }; b.st = { ...b.st, everUp: true }
  r.core.links.set('sfu-a', a); r.core.links.set('sfu-b', b)
  const got: LinkInfo[] = []
  r.c.on('link', (i) => got.push(i))
  a.step('iceDisc', LINK.iceDisc(a.st, false), 'ice')
  assert.deepEqual(got.map((i) => [i.server, i.state]), [['sfu-a', 'wobbly']], 'SD-EVENT-LINK① — 흔들린 서버만 · 다른 서버 0')
  assert.deepEqual(Object.keys(got[0]!).sort(), ['attempt', 'cause', 'rung', 'server', 'since', 'state'], 'SD-EVENT-LINK② — state · rung · attempt · cause · since')
  a.step('iceDisc', LINK.iceDisc(a.st, true), 'ice')
  r.core.emitLink(a.info())
  assert.equal(got.length, 1, 'SD-EVENT-LINK③ — 상태가 그대로면 0')
  a.step('iceBack', LINK.iceBack(a.st), 'ice')
  assert.deepEqual(got.map((i) => [i.server, i.state]), [['sfu-a', 'wobbly'], ['sfu-a', 'up']], 'SD-EVENT-LINK③ — 바뀔 때마다 하나')
  assert.ok(!got.some((i) => i.server === 'sfu-b'), 'SD-EVENT-LINK① — 다른 서버 0')
  r.core.links.clear()
})

test('K-sym-IMPL-SES-EVENTS-1 — 재구축 중 press 는 대기한다(arming · recovering) · FLOOR_REQUEST 0 · DENY 0', async () => {
  const sent: number[] = []
  const link = { state: 'rebuilding', everUp: true, peer: { dcOpen: false, sendDc: (b: Uint8Array) => { sent.push(FC.decode(Mbcp.unwrap(b)!)!.type); return true } } }
  const core = {
    cfg: { wakeDetectMs: 1000 },
    ses: { cs: 'ACTIVE' },
    rooms: { aff: { speakingRoom: 'ch-1' } },
    record: () => undefined,
    impossible: () => undefined,
    linkFor: () => link,
    log: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    media: { hasHalfMic: () => true, halfMicCold: () => false, ensureHalfMic: async () => undefined, warmHalf: async () => undefined, floorClose: () => undefined, floorOpen: () => undefined },
  } as unknown as Core
  const room = new RoomCore(core, 'ch-1', {})
  room.st = { ...ROOM.initial(), rs: 'JOINED' }
  room.rebuilding = true
  let denied = 0
  room.floor.events.on('denied', () => { denied += 1 })
  await room.floor.press()
  await tick(120)
  const s = room.floor.snapshot()
  assert.deepEqual([s.arming, s.armingStage], [true, 'recovering'], 'K-sym-IMPL-SES-EVENTS-1 — 재구축 중 press 는 대기로 보인다')
  assert.equal(sent.length, 0, 'K-sym-IMPL-SES-EVENTS-1 — FLOOR_REQUEST 0')
  assert.equal(denied, 0, 'K-sym-IMPL-SES-EVENTS-1 — DENY 미수신 0(거절 없이 사라지지 않는다)')
  room.floor.dispose()
  await tick(60)
})

test('K-sym-IMPL-SES-EVENTS-2 — tokenRequired 를 받아 setToken 하면 재접속이 이어진다(안 받으면 재접속마다 멈춘다)', async () => {
  const stuck = rig()
  let ws = await up(stuck)
  ws.close(); await tick(5)
  await bind(FAIL(2003, 'TOKEN_EXPIRED'), false)
  await tick(20)
  assert.equal(stuck.c.session.state, 'disconnected', '주입 — 미처리면 멈춘다')
  assert.equal(FakeWS.made.length, 2)
  await stuck.c.close()
  const ok = rig()
  ok.c.on('tokenRequired', () => ok.c.setToken('fresh'))
  ws = await up(ok)
  ws.close(); await tick(5)
  await bind(FAIL(2003, 'TOKEN_EXPIRED'), false)
  await bind({ ...BIND_OK, session_id: 's-9' })
  assert.equal(ok.c.session.state, 'active', 'K-sym-IMPL-SES-EVENTS-2 — 정상: 재접속 지속')
  await ok.c.close()
})

