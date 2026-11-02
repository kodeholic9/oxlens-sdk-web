// author: kodeholic (powered by Claude)
// SDK:IMPL-ERR-TYPE · SDK:RULE-ERR-DEVICE · SDK:RULE-ERR-REJECT-OR-EVENT — 실패 표면(ERR — 가로지르는 것) 1층. 분류(category) · 장치 실패 이름 · blockedBy 판별을 단위(SD-CATEGORY-* · SD-NAME-* · SD-BLOCKED-BY-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트(test/_rig) · 가짜 navigator(이 파일 — 획득 실패를 시험이 고른다).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick } from './_ws.js'
import { SA, up, linkOf, enter, drain, joinBody, joinFrame, leaveFrame, FAIL, type Rig } from './_rig.js'
import { Op, Code } from '../src/internal/wire/ws.js'
import { createClient, OxLensError, type OxLensClient } from '../src/index.js'
import { LocalCore } from '../src/domain/pub/local.js'

// ══ 가짜 장치 — getUserMedia 가 던질 것 · 권한 상태를 시험이 고른다 ══════════════════════════════════

interface Dev { kind: string; stops: number; readyState: string; enabled: boolean; stop(): void; addEventListener(): void; removeEventListener(): void; getSettings(): object; applyConstraints(): Promise<void> }
function devTrack(kind: string): Dev {
  const t: Dev = { kind, stops: 0, readyState: 'live', enabled: true, stop() { t.stops++; t.readyState = 'ended' }, addEventListener: () => undefined, removeEventListener: () => undefined, getSettings: () => ({}), applyConstraints: () => Promise.resolve() }
  return t
}
const env = {
  /** 다음 획득이 던질 것(kind 별) · 없으면 성공 */
  fail: new Map<string, unknown>(),
  /** permissions.query 의 state · 'throw' 면 던진다 */
  perm: 'prompt' as string,
  /** 획득을 붙잡는다(프롬프트 방치) — 풀면 늦은 스트림이 온다 */
  hold: null as null | ((t: Dev) => void),
  holding: false,
  made: [] as Dev[],
  reset(): void { env.fail.clear(); env.perm = 'prompt'; env.hold = null; env.holding = false; env.made.length = 0 },
}
const stream = (t: Dev): unknown => ({ getAudioTracks: () => (t.kind === 'audio' ? [t] : []), getVideoTracks: () => (t.kind === 'video' ? [t] : []), getTracks: () => [t] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    enumerateDevices: async () => [],
    getUserMedia: async (c: MediaStreamConstraints) => {
      const kind = c.audio ? 'audio' : 'video'
      if (env.fail.has(kind)) { const e = env.fail.get(kind); env.fail.delete(kind); throw e }
      if (env.holding) return new Promise((res) => { env.hold = (t) => res(stream(t)) })
      const t = devTrack(kind)
      env.made.push(t)
      return stream(t)
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  },
  permissions: { query: async () => { if (env.perm === 'throw') throw new TypeError('bad name'); return { state: env.perm } } },
} })

/** 브라우저가 던지는 DOMException 꼴 */
const dom = (name: string, message = ''): Error => Object.assign(new Error(message), { name })

const clients: OxLensClient[] = []
const rigs: Rig[] = []
afterEach(async () => {
  env.reset()
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  for (const r of rigs.splice(0)) await r.c.close().catch(() => undefined)
})
function client(o: Record<string, unknown> = {}): OxLensClient { const c = createClient({ base: 'https://hub.example', token: 'tok', ...o }); clients.push(c); return c }
async function rig(o: Record<string, unknown> = {}): Promise<Rig> { const r = await up(o); rigs.push(r); return r }

/** 획득 하나를 깨고 받은 OxLensError */
async function acquireFail(kind: 'audio' | 'video', e: unknown, perm = 'prompt'): Promise<OxLensError> {
  env.fail.set(kind, e)
  env.perm = perm
  const x = await client().media.acquire(kind === 'audio' ? { microphone: true } : { camera: true }).then(() => null, (y: unknown) => y)
  assert.ok(x instanceof OxLensError, `획득 실패는 OxLensError 로 reject: ${String(x)}`)
  return x
}

const SIX = ['DEVICE_PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'DEVICE_IN_USE', 'DEVICE_OVERCONSTRAINED', 'DEVICE_TIMEOUT', 'DEVICE_OTHER']

// ══ 분류(category) — 앞자리가 무엇을 고쳐야 하나다 ═════════════════════════════════════════════════

test('SD-CATEGORY-ALL — 코드 앞자리 → category 사상 전량(코드 표 전부 · 표에 없는 코드도 앞자리로) · wire 코드는 그대로', async () => {
  const r = await rig()
  const h = await enter(r, 'r1')
  const LEAD: Record<string, string> = { '1': 'bug', '2': 'auth', '3': 'state', '4': 'limit', '5': 'server' }
  const codes = [...Object.values(Code).map((c) => c.code), 1999, 2999, 3999, 4999, 5999]
  for (const code of codes) {
    const p = h.sendMessage('x').then(() => null, (e: unknown) => e)
    await tick()
    r.ws.answer(r.ws.last(Op.MESSAGE), FAIL(code, `C${code}`), false)
    const e = await p
    assert.ok(e instanceof OxLensError && e.code === code, `${code} 그대로`)
    assert.equal(e.category, LEAD[String(code)[0]!], `SD-CATEGORY-ALL — ${code} → ${LEAD[String(code)[0]!]}`)
  }
})

test('SD-CATEGORY-BUG — 1xxx 는 재시도 0(permanent 가 거짓으로 와도) · bug 로 reject', async () => {
  const r = await rig()
  const p = r.c.join('r1').then(() => null, (e: unknown) => e)
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r1'), FAIL(1002, 'INVALID_PAYLOAD'), false)
  await tick(400)
  const e = await p
  assert.ok(e instanceof OxLensError && e.category === 'bug' && e.code === 1002, 'SD-CATEGORY-BUG — bug 로 reject')
  assert.equal(r.ws.requests(Op.ROOM_JOIN).length, 1, 'SD-CATEGORY-BUG — 재시도 0')
})

test('SD-CATEGORY-AUTH — 2xxx 는 auth · 재접속 중의 2003 은 tokenRequired 가 먼저 받는다(앱 reject 0 · 새 토큰으로 이어간다)', async () => {
  const r = await rig()
  const h = await enter(r, 'r1')
  const p = h.sendMessage('x').then(() => null, (e: unknown) => e)
  await tick()
  r.ws.answer(r.ws.last(Op.MESSAGE), FAIL(2006, 'NOT_AUTHORIZED'), false)
  const e = await p
  assert.ok(e instanceof OxLensError && e.category === 'auth', '2xxx → auth')
  const tokens: unknown[] = []
  const closed: unknown[] = []
  r.c.on('tokenRequired', (t) => tokens.push(t))
  r.c.on('closed', (x) => closed.push(x))
  r.ws.close(); await tick(5)
  const ws2 = FakeWS.made.at(-1)!
  ws2.open(); await tick()
  ws2.reply(Op.BIND, FAIL(2003, 'TOKEN_EXPIRED'), false); await tick(5)
  assert.deepEqual([tokens, closed], [[{ cause: 'expired' }], []], 'SD-CATEGORY-AUTH — 재접속 갈래의 2003 → tokenRequired(closed 0)')
  r.c.setToken('tok-2'); await tick(5)
  const ws3 = FakeWS.made.at(-1)!
  ws3.open(); await tick()
  assert.equal((ws3.last(Op.BIND).body as { token: string }).token, 'tok-2', 'SD-CATEGORY-AUTH — 새 토큰으로 재접속을 잇는다')
})

test('SD-CATEGORY-STATE — 3xxx 는 state(code 그대로) · wire 를 안 탄 상태 오류는 code 0 + STATE_* name', async () => {
  const r = await rig()
  const h = await enter(r, 'r1')
  const p = h.sendMessage('x').then(() => null, (e: unknown) => e)
  await tick()
  r.ws.answer(r.ws.last(Op.MESSAGE), FAIL(3002, 'NOT_IN_ROOM'), false)
  const e1 = await p
  assert.ok(e1 instanceof OxLensError && e1.category === 'state' && e1.code === 3002, '3xxx → state')
  const before = r.ws.sent.length
  const e2 = await r.c.media.enableMicrophone().then(() => null, (e: unknown) => e)
  assert.ok(e2 instanceof OxLensError && e2.category === 'state' && e2.code === 0 && e2.name === 'STATE_NO_SPEAKING_ROOM', 'SD-CATEGORY-STATE — STATE_* 는 code:0 + name')
  assert.equal(r.ws.sent.length, before, 'wire 를 타지 않는다')
})

test('SD-CATEGORY-LIMIT①② — 4005 는 재시도 0 · 4009 는 앱 reject 0 · retry_after_ms 이상 기다린 뒤 다시 · 횟수 제한 0 · join() pending(취소 = leave())', async () => {
  const r = await rig()
  const p = r.c.join('r1').then(() => null, (e: unknown) => e)
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r1'), FAIL(4005, 'MID_LIMIT'), false)
  await tick(400)
  const e = await p
  assert.ok(e instanceof OxLensError && e.category === 'limit' && e.code === 4005, 'SD-CATEGORY-LIMIT① — 4005 limit reject')
  assert.equal(r.ws.requests(Op.ROOM_JOIN).length, 1, 'SD-CATEGORY-LIMIT① — 4005 재시도 0')
  // 4009 — 여섯 번 연달아 과부하
  let settled: unknown = 'pending'
  const q = r.c.join('r2').then((x) => { settled = x }, (x: unknown) => { settled = x })
  await tick()
  const at: number[] = []
  for (let i = 0; i < 6; i++) {
    const n = r.ws.requests(Op.ROOM_JOIN).length
    r.ws.answer(joinFrame(r.ws, 'r2'), FAIL(4009, 'OVERLOADED', { retry_after_ms: 30 }), false)
    const t0 = performance.now()
    for (let k = 0; k < 100 && r.ws.requests(Op.ROOM_JOIN).length === n; k++) await tick(2)
    at.push(performance.now() - t0)
    assert.equal(r.ws.requests(Op.ROOM_JOIN).length, n + 1, `SD-CATEGORY-LIMIT② — ${i + 1} 번째 4009 뒤 다시 보낸다(횟수 제한 0)`)
  }
  assert.ok(at.every((ms) => ms >= 28), `SD-CATEGORY-LIMIT② — retry_after_ms(30) 이상 기다린 뒤: ${at.map((x) => x.toFixed(0)).join(',')}`)
  assert.equal(settled, 'pending', 'SD-CATEGORY-LIMIT② — 앱 reject 0 · join() pending')
  // 취소 = leave() — 떠 있는 입장 요청의 응답을 기다렸다가 나간다(연:DEV-ROOM-LEAVE-WHILE-JOINING)
  const l = r.c.rooms.get('r2')!.leave()
  await tick()
  r.ws.answer(joinFrame(r.ws, 'r2'), FAIL(4009, 'OVERLOADED', { retry_after_ms: 30 }), false)
  await tick(50)
  await l; await q
  const end = settled as unknown
  assert.ok(end instanceof OxLensError && end.category === 'closed', 'SD-CATEGORY-LIMIT② — 취소는 leave() — 기다리던 join() 이 closed 로 끝난다')
  assert.equal(r.c.rooms.has('r2'), false)
})

test('SD-CATEGORY-SERVER — 5xxx 는 기본 재시도 3회(300 · 1200 · 2700ms) 뒤에도 안 되면 server 로 reject', async () => {
  const r = await rig()
  let settled = false
  const p = r.c.join('r1').then(() => null, (e: unknown) => e).finally(() => { settled = true })
  await tick()
  const gaps: number[] = []
  for (let i = 0; i < 4; i++) {
    const n = r.ws.requests(Op.ROOM_JOIN).length
    r.ws.answer(joinFrame(r.ws, 'r1'), FAIL(5003, 'INTERNAL_ERROR'), false)
    if (i === 3) break
    const t0 = performance.now()
    for (let k = 0; k < 400 && r.ws.requests(Op.ROOM_JOIN).length === n; k++) await tick(10)
    gaps.push(performance.now() - t0)
    assert.equal(settled, false, `SD-CATEGORY-SERVER — ${i + 1} 번째 실패 뒤엔 reject 0(다시 보낸다)`)
  }
  const e = await p
  assert.equal(r.ws.requests(Op.ROOM_JOIN).length, 4, 'SD-CATEGORY-SERVER — 처음 + 재시도 3')
  assert.ok([300, 1200, 2700].every((want, i) => gaps[i]! >= want - 15 && gaps[i]! < want + 250), `SD-CATEGORY-SERVER — 간격 300 · 1200 · 2700: ${gaps.map((x) => x.toFixed(0)).join(',')}`)
  assert.ok(e instanceof OxLensError && e.category === 'server' && e.code === 5003, 'SD-CATEGORY-SERVER — 다 한 뒤 server reject')
})

test('SD-CATEGORY-NEGOTIATION — SDP 적용 실패 · pc_mode 불일치는 NEGOTIATION_<단계>(code 0 · negotiation) · 런타임 폴백 0(모드 그대로 · 다시 붙기 0)', async () => {
  const r = await rig()
  const binds = r.ws.requests(Op.BIND).length
  const p = r.c.join('r1').then(() => null, (e: unknown) => e)
  await tick()
  linkOf(r, SA)
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1', { sc: { ...SA, pc_mode: '1pc' } }))
  await tick()
  const lf = leaveFrame(r.ws, 'r1')
  if (lf) r.ws.answer(lf, {})
  await tick()
  const e1 = await p
  assert.ok(e1 instanceof OxLensError && e1.category === 'negotiation' && e1.code === 0 && e1.name === 'NEGOTIATION_PC_MODE', `SD-CATEGORY-NEGOTIATION — pc_mode 불일치 NEGOTIATION_PC_MODE: ${String((e1 as Error).name)}`)
  assert.deepEqual([r.c.session.pcMode, r.ws.requests(Op.BIND).length, FakeWS.made.length], ['2pc', binds, 1], 'SD-CATEGORY-NEGOTIATION — 런타임 폴백 0(1pc 로 갈아타지 않는다 · 세션 그대로)')
  // SDP 적용 실패 — 발행 협상이 깨진다
  await enter(r, 'r2', { mode: 'talk', pub: 'r2' })
  const q = r.c.media.enableMicrophone().then(() => null, (e: unknown) => e)
  await tick(); await drain(r, SA, false)
  const e2 = await q
  assert.ok(e2 instanceof OxLensError && e2.category === 'negotiation' && e2.code === 0 && /^NEGOTIATION_[A-Z_]+$/.test(e2.name), `SD-CATEGORY-NEGOTIATION — SDP 실패 NEGOTIATION_<단계>: ${String((e2 as Error).name)}`)
  assert.equal(r.c.session.pcMode, '2pc')
})

test('SD-CATEGORY-CLOSED — 닫힌 핸들에 API 는 closed · CLOSED(닫힌 방 · 끝난 트랙 · 닫힌 클라이언트) · wire 0', async () => {
  const r = await rig()
  const h = await enter(r, 'r1')
  const l = h.leave(); await tick(); r.ws.answer(leaveFrame(r.ws, 'r1'), {}); await l
  const sent = r.ws.sent.length
  const isClosed = (e: unknown): boolean => e instanceof OxLensError && e.category === 'closed' && e.name === 'CLOSED' && e.code === 0
  assert.ok(isClosed(await h.sendMessage('x').then(() => null, (e: unknown) => e)), 'SD-CATEGORY-CLOSED — 닫힌 방 sendMessage → CLOSED')
  assert.ok(isClosed(await h.ptt.press().then(() => null, (e: unknown) => e)), 'SD-CATEGORY-CLOSED — 닫힌 방 ptt.press → CLOSED')
  assert.equal(r.ws.sent.length, sent, 'SD-CATEGORY-CLOSED — 닫힌 방 핸들은 wire 0')
  const [t] = await r.c.media.acquire({ microphone: true })
  await t!.stop()
  for (const [what, call] of [['setMuted', () => t!.setMuted(true)], ['setDuplex', () => t!.setDuplex('half')], ['replaceSource', () => t!.replaceSource(null)], ['setEncoding', () => t!.setEncoding({})]] as const) {
    assert.ok(isClosed(await call().then(() => null, (e: unknown) => e)), `SD-CATEGORY-CLOSED — 끝난 트랙 ${what} → CLOSED`)
  }
  const lc = new LocalCore(r.core.media, 'audio', 'external', devTrack('audio') as unknown as MediaStreamTrack, 'external', {})
  await lc.stop()
  const pe = await lc.publish('r1', 'full').then(() => null, (e: unknown) => e)
  assert.ok(pe && (pe as { category?: string }).category === 'closed' && (pe as { name?: string }).name === 'CLOSED', 'SD-CATEGORY-CLOSED — 끝난 트랙 publish → CLOSED')
  await r.c.close()
  assert.ok(isClosed(await r.c.join('r9').then(() => null, (e: unknown) => e)), 'SD-CATEGORY-CLOSED — 닫힌 클라이언트 join → CLOSED')
  assert.ok(isClosed(await r.c.media.enableCamera().then(() => null, (e: unknown) => e)), 'SD-CATEGORY-CLOSED — 닫힌 클라이언트 enable* → CLOSED')
})

// ══ device — 이름 · kind · blockedBy · 시한(SDK:RULE-ERR-DEVICE) ══════════════════════════════════

test('SD-CATEGORY-DEVICE — getUserMedia 실패는 device 분류 · DEVICE_* name · details.kind · 권한 거부면 blockedBy', async () => {
  const e = await acquireFail('audio', dom('NotAllowedError', 'Permission denied'))
  assert.deepEqual([e.category, e.code, SIX.includes(e.name), e.details?.['kind'], e.details?.['blockedBy']], ['device', 0, true, 'audio', 'user'], 'SD-CATEGORY-DEVICE — device · DEVICE_* · kind · blockedBy')
  const e2 = await acquireFail('video', dom('NotReadableError'))
  assert.deepEqual([e2.category, e2.name, e2.details?.['kind']], ['device', 'DEVICE_IN_USE', 'video'], 'SD-CATEGORY-DEVICE — 다른 장치 실패도 device · DEVICE_*')
})

test('SD-NAME-DEVICE-PERMISSION-DENIED — NotAllowedError → DEVICE_PERMISSION_DENIED · blockedBy 실림 · kind 하나(여러 kind 획득이어도 실패한 그 kind)', async () => {
  const e = await acquireFail('video', dom('NotAllowedError', 'Permission dismissed'))
  assert.deepEqual([e.name, e.details?.['blockedBy'], e.details?.['kind']], ['DEVICE_PERMISSION_DENIED', 'dismissed', 'video'], 'SD-NAME-DEVICE-PERMISSION-DENIED — name · blockedBy · kind')
  env.fail.set('video', dom('NotAllowedError', 'Permission denied'))
  const x = await client().media.acquire({ microphone: true, camera: true }).then(() => null, (y: unknown) => y) as OxLensError
  assert.deepEqual([x.name, x.details?.['kind'], typeof x.details?.['kind']], ['DEVICE_PERMISSION_DENIED', 'video', 'string'], 'SD-NAME-DEVICE-PERMISSION-DENIED — kind 는 하나(실패한 kind)')
  assert.equal(env.made[0]!.stops, 1, '먼저 얻은 마이크는 멈춘다(전부 아니면 전무)')
})

test('SD-NAME-DEVICE-NOT-FOUND — NotFoundError → DEVICE_NOT_FOUND · 권한이 denied 면 브라우저가 NotAllowedError 로 덮어 PERMISSION_DENIED 로 온다', async () => {
  const e = await acquireFail('audio', dom('NotFoundError', 'Requested device not found'))
  assert.deepEqual([e.name, e.details?.['blockedBy']], ['DEVICE_NOT_FOUND', undefined], 'SD-NAME-DEVICE-NOT-FOUND — NotFoundError → DEVICE_NOT_FOUND')
  const d = await acquireFail('audio', dom('NotAllowedError', ''), 'denied')
  assert.deepEqual([d.name, d.details?.['blockedBy']], ['DEVICE_PERMISSION_DENIED', 'user'], 'SD-NAME-DEVICE-NOT-FOUND — denied 면 PERMISSION_DENIED 로 온다')
})

test('SD-NAME-DEVICE-IN-USE — NotReadableError → DEVICE_IN_USE · cause 보존', async () => {
  const raw = dom('NotReadableError', 'Could not start audio source')
  const e = await acquireFail('audio', raw)
  assert.deepEqual([e.name, e.cause === raw], ['DEVICE_IN_USE', true], 'SD-NAME-DEVICE-IN-USE — name · cause 보존')
})

test('SD-NAME-DEVICE-OVERCONSTRAINED — OverconstrainedError → DEVICE_OVERCONSTRAINED · details.constraint = 예외의 constraint', async () => {
  const raw = Object.assign(dom('OverconstrainedError'), { constraint: 'frameRate' })
  const e = await acquireFail('video', raw)
  assert.deepEqual([e.name, e.details?.['constraint'], e.cause === raw], ['DEVICE_OVERCONSTRAINED', 'frameRate', true], 'SD-NAME-DEVICE-OVERCONSTRAINED — name · details.constraint')
})

test('SD-NAME-DEVICE-TIMEOUT — 프롬프트 방치가 deviceAcquireTimeoutMs 를 넘으면 DEVICE_TIMEOUT reject · blockedBy 없음 · 늦게 온 스트림은 곧바로 stop', async () => {
  env.holding = true
  const c = client({ deviceAcquireTimeoutMs: 30 })
  const t0 = performance.now()
  const e = await c.media.acquire({ microphone: true }).then(() => null, (y: unknown) => y)
  assert.ok(e instanceof OxLensError && e.name === 'DEVICE_TIMEOUT' && e.category === 'device', 'SD-NAME-DEVICE-TIMEOUT — reject')
  assert.ok(performance.now() - t0 >= 28, '시한 뒤에')
  assert.equal(e.details?.['blockedBy'], undefined, 'SD-NAME-DEVICE-TIMEOUT — blockedBy 없음')
  const late = devTrack('audio')
  env.hold!(late); await tick()
  assert.deepEqual([late.stops, late.readyState], [1, 'ended'], 'SD-NAME-DEVICE-TIMEOUT — 늦은 스트림 stop(표시등 0)')
})

test('SD-NAME-DEVICE-OTHER — AbortError · SecurityError · TypeError · InvalidStateError · NotSupportedError → DEVICE_OTHER · cause 로 가른다', async () => {
  for (const n of ['AbortError', 'SecurityError', 'TypeError', 'InvalidStateError', 'NotSupportedError']) {
    const raw = n === 'TypeError' ? new TypeError('bad constraints') : dom(n)
    const e = await acquireFail('audio', raw)
    assert.deepEqual([e.name, e.cause === raw, (e.cause as Error).name], ['DEVICE_OTHER', true, n], `SD-NAME-DEVICE-OTHER — ${n} → DEVICE_OTHER · cause`)
  }
})

test('SD-NAME-ALL①② — 여섯 이름 밖으로 떨어지는 예외 0(모르는 예외는 DEVICE_OTHER) · 이름은 예외 name 으로만(메시지로 정하는 경로 0)', async () => {
  for (const raw of [dom('FooError'), 'string thrown', undefined, { message: 'Permission denied' }, new Error('NotAllowedError')]) {
    const e = await acquireFail('audio', raw)
    assert.ok(SIX.includes(e.name), `SD-NAME-ALL① — 여섯 안: ${e.name}`)
    assert.equal(e.name, 'DEVICE_OTHER', `SD-NAME-ALL① — 모르는 예외(${String((raw as { name?: string })?.name ?? raw)}) → DEVICE_OTHER`)
  }
  const a = await acquireFail('audio', dom('NotFoundError', 'Permission denied'))
  assert.equal(a.name, 'DEVICE_NOT_FOUND', 'SD-NAME-ALL② — 메시지가 권한 문구여도 name 이 정한다')
  const b = await acquireFail('audio', dom('WeirdError', 'NotReadableError'))
  assert.equal(b.name, 'DEVICE_OTHER', 'SD-NAME-ALL② — 메시지에 예외 이름이 있어도 name 이 정한다')
})

test('SD-BLOCKED-BY-USER — message "Permission denied" 또는 permissions.query denied → blockedBy user', async () => {
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'Permission denied'))).details?.['blockedBy'], 'user', 'SD-BLOCKED-BY-USER — 메시지 층')
  assert.equal((await acquireFail('video', dom('NotAllowedError', 'The request is not allowed'), 'denied')).details?.['blockedBy'], 'user', 'SD-BLOCKED-BY-USER — query denied 층')
})

test('SD-BLOCKED-BY-DISMISSED — message "Permission dismissed" → blockedBy dismissed', async () => {
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'Permission dismissed'))).details?.['blockedBy'], 'dismissed', 'SD-BLOCKED-BY-DISMISSED — dismissed')
})

test('SD-BLOCKED-BY-SYSTEM — message "Permission denied by system" → blockedBy system', async () => {
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'Permission denied by system'))).details?.['blockedBy'], 'system', 'SD-BLOCKED-BY-SYSTEM — system')
})

test('SD-BLOCKED-BY-UNKNOWN — 그 밖(Firefox 고정 메시지 · query prompt · query 가 던짐)은 unknown · 문자열이 바뀌어도 오판 0', async () => {
  const ff = 'The request is not allowed by the user agent or the platform in the current context.'
  assert.equal((await acquireFail('audio', dom('NotAllowedError', ff), 'prompt')).details?.['blockedBy'], 'unknown', 'SD-BLOCKED-BY-UNKNOWN — Firefox 고정 메시지 · query prompt')
  assert.equal((await acquireFail('audio', dom('NotAllowedError', ff), 'throw')).details?.['blockedBy'], 'unknown', 'SD-BLOCKED-BY-UNKNOWN — query 가 던진다')
  for (const changed of ['Permission denied.', 'permission denied', 'Permission was dismissed', 'Permission denied by the system']) {
    assert.equal((await acquireFail('audio', dom('NotAllowedError', changed), 'prompt')).details?.['blockedBy'], 'unknown', `SD-BLOCKED-BY-UNKNOWN — 바뀐 문자열 "${changed}" 은 오판 0(unknown)`)
  }
})

test('SD-BLOCKED-BY-ALL①②③ — blockedBy 는 PERMISSION_DENIED 에만 · 판별 순서 = 메시지 → permissions.query → unknown(역전 0) · 넷 밖의 값 0', async () => {
  for (const n of ['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError']) {
    const e = await acquireFail('audio', dom(n, 'Permission denied'), 'denied')
    assert.equal('blockedBy' in (e.details ?? {}), false, `SD-BLOCKED-BY-ALL① — ${e.name} 에 blockedBy 0`)
  }
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'Permission dismissed'), 'denied')).details?.['blockedBy'], 'dismissed', 'SD-BLOCKED-BY-ALL② — 메시지 층이 query 보다 먼저(denied 여도 dismissed)')
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'Permission denied by system'), 'denied')).details?.['blockedBy'], 'system', 'SD-BLOCKED-BY-ALL② — 메시지 층이 먼저(system)')
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'x'), 'denied')).details?.['blockedBy'], 'user', 'SD-BLOCKED-BY-ALL② — 메시지가 안 맞으면 query')
  assert.equal((await acquireFail('audio', dom('NotAllowedError', 'x'), 'granted')).details?.['blockedBy'], 'unknown', 'SD-BLOCKED-BY-ALL② — 둘 다 아니면 unknown')
  const values = new Set<unknown>()
  for (const [m, q] of [['Permission denied', 'prompt'], ['Permission dismissed', 'prompt'], ['Permission denied by system', 'prompt'], ['', 'denied'], ['', 'granted'], ['', 'prompt'], ['', 'throw'], ['zz', 'unknown-state']] as const) {
    values.add((await acquireFail('audio', dom('NotAllowedError', m), q)).details?.['blockedBy'])
  }
  assert.ok([...values].every((v) => ['user', 'dismissed', 'system', 'unknown'].includes(v as string)), `SD-BLOCKED-BY-ALL③ — 넷 밖의 값 0: ${[...values].join(',')}`)
})

