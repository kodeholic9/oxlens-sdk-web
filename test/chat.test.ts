// author: kodeholic (powered by Claude)
// SDK:IMPL-CHAT-API · SDK:IMPL-CHAT-CATCHUP — 채팅(client.chat) 1층. 전송(msgId · 재시도 · 끝내 실패) · 꺼진 배포(3014) · 따라잡기 기준(K-sym-IMPL-CHAT-CATCHUP-*)을 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트(test/_rig).
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick } from './_ws.js'
import { up, enter, note, mem, vers, FAIL, BIND_OK, type Rig } from './_rig.js'
import { live } from './_pub.js'
import { Op, type ChatMessage } from '../src/internal/wire/ws.js'
import { OxLensError } from '../src/index.js'

/** 단언이 깨져도 클라이언트를 닫는다(test/_pub 의 afterEach) */
async function rig(): Promise<Rig> { const r = await up(); live.push(r); return r }

const msg = (space: string, id: string, t: number, user = 'u2'): ChatMessage => ({ space_id: space, msg_id: `${user}/${id}`, user_id: user, t, content: id })

/** 같은 세션으로 이어받는다 — 끊긴 뒤 새 소켓 · BIND · RESUME 성공 */
async function resume(r: Rig): Promise<void> {
  const old = r.ws
  old.close()
  for (let i = 0; i < 400 && FakeWS.made.at(-1) === old; i++) await tick(10)
  const ws = FakeWS.made.at(-1)!
  ws.open(); await tick()
  ws.reply(Op.BIND, BIND_OK); await tick()
  ws.reply(Op.RESUME, { snapshot: { r1: { participants: [mem('u1')], me: mem('u1'), tracks: [], version: vers(1) } }, publications: [], mline_tables: [] })
  await tick()
  r.ws = ws
}

async function until(f: () => boolean): Promise<void> { for (let i = 0; i < 50 && !f(); i++) await tick(1) }

const UUID4 = /^u1\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ══ 전송 — msgId · 재시도 · 끝내 실패(SDK:IMPL-CHAT-API) ═══════════════════════════════════════════

test('SDK:IMPL-CHAT-API send — msgId 가 없으면 SDK 가 <userId>/<UUID v4> 로 짓는다 · 보낼 때마다 다르다 · 방 입장 없이 · resolve 는 서버가 매긴 t 를 담은 메시지', async () => {
  const r = await rig()
  const p = r.c.chat.send('c1', '들리나')
  await tick()
  const b = r.ws.last(Op.MESSAGE).body as { space_id: string; msg_id: string; content: string }
  assert.match(b.msg_id, UUID4, 'SDK:IMPL-CHAT-API — msgId = <userId>/<UUID v4>')
  assert.deepEqual([b.space_id, b.content], ['c1', '들리나'])
  r.ws.reply(Op.MESSAGE, { t: 1700 })
  assert.deepEqual(await p, { spaceId: 'c1', msgId: b.msg_id, userId: 'u1', t: 1700, content: '들리나' }, 'SDK:IMPL-CHAT-API — resolve 값은 t 를 담은 메시지')
  const q = r.c.chat.send('c1', '또')
  await tick()
  const b2 = r.ws.last(Op.MESSAGE).body as { msg_id: string }
  assert.notEqual(b2.msg_id, b.msg_id, 'SDK:IMPL-CHAT-API — 보낼 때마다 새 msgId')
  r.ws.reply(Op.MESSAGE, { t: 1701 }); await q
  const z = r.c.chat.send('c1', '다시', { msgId: 'u1/given' })
  await tick()
  assert.equal((r.ws.last(Op.MESSAGE).body as { msg_id: string }).msg_id, 'u1/given', 'SDK:IMPL-CHAT-API — 앱이 준 msgId 그대로')
  r.ws.reply(Op.MESSAGE, { t: 1702 }); await z
  assert.equal(r.ws.requests(Op.ROOM_JOIN).length, 0, '방 입장 없이 쓴다')
})

test('SDK:IMPL-CHAT-API send — 영구 아닌 실패는 사다리 칸(300 · 1200 · 2700ms)으로 같은 msgId 를 다시 보낸다 · 다 한 뒤엔 details.msgId 를 실어 reject', async () => {
  const r = await rig()
  const flush = async (): Promise<void> => { for (let k = 0; k < 8; k++) await new Promise<void>((res) => setImmediate(res)) }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p = r.c.chat.send('c1', 'x').then(() => null, (e: unknown) => e)
    await flush()
    const id = (r.ws.last(Op.MESSAGE).body as { msg_id: string }).msg_id
    for (const want of [300, 1200, 2700]) {
      const n = r.ws.requests(Op.MESSAGE).length
      r.ws.reply(Op.MESSAGE, FAIL(5003, 'INTERNAL_ERROR'), false)
      await flush()
      mock.timers.tick(want - 1); await flush()
      assert.equal(r.ws.requests(Op.MESSAGE).length, n, `SDK:IMPL-CHAT-API — 재시도는 ${want}ms 전에 안 나간다`)
      mock.timers.tick(1); await flush()
      assert.equal(r.ws.requests(Op.MESSAGE).length, n + 1, `SDK:IMPL-CHAT-API — 재시도는 ${want}ms 에 나간다`)
    }
    assert.deepEqual(new Set(r.ws.requests(Op.MESSAGE).map((f) => (f.body as { msg_id: string }).msg_id)), new Set([id]), 'SDK:IMPL-CHAT-API — 다시 보낼 때 같은 msgId')
    r.ws.reply(Op.MESSAGE, FAIL(5003, 'INTERNAL_ERROR'), false)
    await flush()
    const e = await p
    assert.ok(e instanceof OxLensError && e.code === 5003 && e.details?.['msgId'] === id, 'SDK:IMPL-CHAT-API — 끝내 실패하면 details.msgId 를 실어 reject')
    assert.equal(r.ws.requests(Op.MESSAGE).length, 4, '처음 + 재시도 3')
  } finally { mock.timers.reset() }
})

test('SDK:IMPL-CHAT-API send — 재시도 뒤 성공이면 처음 msgId 로 resolve · permanent(3015) · 1xxx 는 다시 안 보내고 details.msgId 를 실어 reject', async () => {
  const r = await rig()
  const p = r.c.chat.send('c1', 'x')
  await tick()
  const id = (r.ws.last(Op.MESSAGE).body as { msg_id: string }).msg_id
  r.ws.reply(Op.MESSAGE, FAIL(5003, 'INTERNAL_ERROR'), false)
  await tick(320)
  assert.equal(r.ws.requests(Op.MESSAGE).length, 2)
  r.ws.reply(Op.MESSAGE, { t: 9 })
  assert.deepEqual([(await p).msgId, (await p).t], [id, 9], 'SDK:IMPL-CHAT-API — 같은 msgId 로 다시 보내 성공')
  for (const [code, name] of [[3015, 'MSG_ID_CONFLICT'], [1002, 'INVALID_PAYLOAD']] as const) {
    const n = r.ws.requests(Op.MESSAGE).length
    const q = r.c.chat.send('c1', 'y', { msgId: 'u1/fixed' }).then(() => null, (e: unknown) => e)
    await tick()
    r.ws.reply(Op.MESSAGE, { code, name, permanent: code === 3015 }, false)
    await tick(400)
    const e = await q
    assert.ok(e instanceof OxLensError && e.code === code && e.details?.['msgId'] === 'u1/fixed', `SDK:IMPL-CHAT-API — ${code} → details.msgId 를 실어 reject`)
    assert.equal(r.ws.requests(Op.MESSAGE).length, n + 1, `SDK:IMPL-CHAT-API — ${code} 는 다시 안 보낸다`)
  }
})

// ══ 꺼진 배포(연:RULE-CHAT-DISABLED) ═══════════════════════════════════════════════════════════

test('SDK:IMPL-CHAT-API enabled — 처음엔 true · 채팅 op 가 3014 로 오면 false · 그 뒤 채팅 API 는 보내지 않고 같은 오류로 reject · 다시 붙어도 따라잡기 0', async () => {
  const r = await rig()
  await enter(r, 'r1')
  assert.equal(r.c.chat.enabled, true, '처음엔 true')
  FakeWS.auto.delete(Op.SPACE_LIST)
  try {
    const p = r.c.chat.spaces().then(() => null, (e: unknown) => e)
    await tick()
    r.ws.reply(Op.SPACE_LIST, { code: 3014, name: 'CHAT_DISABLED', permanent: true }, false)
    const e = await p
    assert.ok(e instanceof OxLensError && e.code === 3014, '3014 reject')
    assert.equal(r.c.chat.enabled, false, 'SDK:IMPL-CHAT-API — 3014 뒤 enabled false')
    const sent = r.ws.sent.length
    const e2 = await r.c.chat.history('c1').then(() => null, (x: unknown) => x)
    const e3 = await r.c.chat.send('c1', 'x', { msgId: 'u1/k' }).then(() => null, (x: unknown) => x)
    assert.ok(e2 === e, 'SDK:IMPL-CHAT-API — 그 뒤 채팅 API 는 같은 오류로 reject')
    assert.ok(e3 instanceof OxLensError && e3.code === 3014 && e3.details?.['msgId'] === 'u1/k', 'send 는 같은 코드에 msgId 를 싣는다')
    assert.equal(r.ws.sent.length, sent, 'SDK:IMPL-CHAT-API — 꺼진 뒤 채팅 op wire 0')
    await resume(r)
    await tick(5)
    assert.deepEqual([r.ws.requests(Op.SPACE_LIST).length, r.ws.requests(Op.SPACE_HISTORY).length], [0, 0], '꺼진 뒤엔 다시 붙어도 따라잡기 0')
  } finally { FakeWS.auto.set(Op.SPACE_LIST, { spaces: [] }) }
})

test('SDK:IMPL-CHAT-API view — 응답의 read 로 보관본을 고치고 spaces 1 · 첫 접속은 따라잡기 0(놓친 것은 다시 붙은 뒤만)', async () => {
  FakeWS.auto.set(Op.SPACE_LIST, { spaces: [{ space_id: 'c1', total: 9, read: 2 }] })
  try {
    const r = await rig()
    await tick(5)
    assert.equal(r.ws.requests(Op.SPACE_LIST).length, 0, '첫 BIND 뒤 따라잡기 0')
    await r.c.chat.spaces()
    const sp: number[] = []
    r.c.chat.on('spaces', (l) => { if (l[0]) sp.push(l[0].unread) })
    const v = r.c.chat.view('c1')
    await tick()
    assert.deepEqual(r.ws.last(Op.SPACE_VIEW).body, { space_id: 'c1' })
    r.ws.reply(Op.SPACE_VIEW, { read: 9 })
    await v
    assert.deepEqual([r.c.chat.spaceList.get('c1'), sp], [{ spaceId: 'c1', total: 9, read: 9, unread: 0 }, [0]], 'SDK:IMPL-CHAT-API — view() 가 read 를 고친다 · spaces 1')
  } finally { FakeWS.auto.set(Op.SPACE_LIST, { spaces: [] }) }
})

// ══ 따라잡기 기준 · msg_id 거르기(SDK:IMPL-CHAT-CATCHUP) ═══════════════════════════════════════

test('K-sym-IMPL-CHAT-CATCHUP-1 — 서버 둘: 103 이 102 보다 먼저 닿은 뒤 끊김 · RESUME → 따라잡기 after 는 마지막 서버 읽기의 끝 t(100 · 받은 103 아님) · 102 는 catchup · 103 두 번 0', async () => {
  const r = await rig()
  await enter(r, 'r1')
  const ev: string[] = []
  r.c.chat.on('messages', (_, ms, src) => { for (const m of ms) ev.push(`${src}:${m.t}`) })
  r.c.chat.focus('S')
  const h = r.c.chat.history('S')
  await tick()
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'a', 100)], more: false })
  await h
  await note(r, Op.MESSAGE, msg('S', 'd', 103, 'D'))
  await resume(r)
  await until(() => r.ws.requests(Op.SPACE_HISTORY).length > 0)
  assert.deepEqual(r.ws.last(Op.SPACE_HISTORY).body, { space_id: 'S', after: 100 }, 'K-sym-IMPL-CHAT-CATCHUP-1 — after = 마지막 서버 읽기 응답의 끝 t(100) · 받은 103 아님')
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'b', 101), msg('S', 'c', 102, 'C'), msg('S', 'd', 103, 'D')], more: false })
  await tick(); await tick()
  await note(r, Op.MESSAGE, msg('S', 'd', 103, 'D'))
  assert.deepEqual(ev, ['history:100', 'live:103', 'catchup:101', 'catchup:102'], 'K-sym-IMPL-CHAT-CATCHUP-1 — 102 가 catchup 으로 온다 · 103 두 번 0')
  assert.equal(r.c.chat.core.basis.get('S'), 103, '응답 끝 t 로 기준을 올린다')
})

test('K-sym-IMPL-CHAT-CATCHUP-1 — more 가 참이면 끝 t 로 이어 부른다 · 기준이 없으면 최근 쪽 하나 · before 쪽은 기준을 안 바꾼다', async () => {
  const r = await rig()
  await enter(r, 'r1')
  r.c.chat.focus('S')
  const b = r.c.chat.history('S', { before: 50 })
  await tick()
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'o', 40), msg('S', 'p', 49)], more: true })
  await b
  assert.equal(r.c.chat.core.basis.has('S'), false, 'K-sym-IMPL-CHAT-CATCHUP-1 — before 쪽은 기준을 안 바꾼다')
  await resume(r)
  await until(() => r.ws.requests(Op.SPACE_HISTORY).length > 0)
  assert.deepEqual(r.ws.last(Op.SPACE_HISTORY).body, { space_id: 'S' }, '기준이 없으면 최근 쪽')
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'x', 200)], more: true })
  await tick(5)
  assert.equal(r.ws.requests(Op.SPACE_HISTORY).length, 1, '기준이 없으면 최근 쪽 하나(이어 부르기 0)')
  await resume(r)
  await until(() => r.ws.requests(Op.SPACE_HISTORY).length > 0)
  assert.deepEqual(r.ws.last(Op.SPACE_HISTORY).body, { space_id: 'S', after: 200 })
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'y', 201), msg('S', 'z', 202)], more: true })
  await until(() => r.ws.requests(Op.SPACE_HISTORY).length > 1)
  assert.deepEqual(r.ws.last(Op.SPACE_HISTORY).body, { space_id: 'S', after: 202 }, 'K-sym-IMPL-CHAT-CATCHUP-1 — more 면 받은 끝 t 로 이어 부른다')
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'w', 203)], more: false })
  await tick(5)
  assert.equal(r.ws.requests(Op.SPACE_HISTORY).length, 2, 'more 가 거짓이면 멈춘다')
})

test('K-sym-IMPL-CHAT-CATCHUP-2 — 오래 켠 클라: 실시간 메시지 다수 뒤 history() → 집합에서 t ≤ basis 인 것이 지워진다 · 집합 크기 = 마지막 읽기 뒤 실시간 몫', async () => {
  const r = await rig()
  for (let t = 101; t <= 150; t++) r.ws.notify(Op.MESSAGE, msg('S', `m${t}`, t))
  await tick(); await tick()
  const set = r.c.chat.core.seen.get('S')!
  assert.equal(set.size, 50, '실시간으로 받은 50')
  const h = r.c.chat.history('S')
  await tick()
  r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('S', 'm139', 139), msg('S', 'm140', 140)], more: true })
  await h
  assert.equal(r.c.chat.core.basis.get('S'), 140)
  assert.deepEqual([set.size, [...set.values()].every((t) => t > 140)], [10, true], 'K-sym-IMPL-CHAT-CATCHUP-2 — t ≤ basis 지움 · 남은 것 = 마지막 읽기 뒤 실시간 몫(141~150)')
})
