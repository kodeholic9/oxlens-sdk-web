// author: kodeholic (powered by Claude)
// SDK:IMPL-CHAT-API · SDK:IMPL-CHAT-CATCHUP — 채팅(client.chat) 1층. 전송(msgId · 재시도 · 끝내 실패) · 꺼진 배포(3014) · 따라잡기 기준(K-sym-IMPL-CHAT-CATCHUP-*)을 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트(test/_rig).
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick } from './_ws.js'
import { encodeFrame } from '../src/internal/ses/signaling.js'
import { up, enter, note, mem, vers, FAIL, BIND_OK, type Rig } from './_rig.js'
import { live } from './_pub.js'
import { Op, type ChatMessage } from '../src/internal/wire/ws.js'
import { OxLensError } from '../src/index.js'
import { sha256Hex } from '../src/platform/sha256.js'

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

/** msgId 꼴 — SHA-256('u1') 앞 4 byte · unix ms 6 byte · 난수 8 byte = 소문자 hex 36 자(연:RULE-CHAT-MSG-ID) */
const HEX36 = /^[0-9a-f]{36}$/

// ══ 전송 — msgId · 재시도 · 끝내 실패(SDK:IMPL-CHAT-API) ═══════════════════════════════════════════

test('SDK:IMPL-CHAT-API send — msgId 가 없으면 SDK 가 hex 36 자(사용자 해시 · 시각 · 난수)로 짓는다 · 보낼 때마다 다르다 · 방 입장 없이 · resolve 는 서버가 매긴 t 를 담은 메시지', async () => {
  const r = await rig()
  const p = r.c.chat.send('c1', '들리나')
  await tick()
  const b = r.ws.last(Op.MESSAGE).body as { space_id: string; msg_id: string; content: string }
  assert.match(b.msg_id, HEX36, 'SDK:IMPL-CHAT-API — msgId = 소문자 hex 36 자')
  assert.equal(b.msg_id.slice(0, 8), sha256Hex('u1').slice(0, 8), 'SDK:IMPL-CHAT-API — 앞 8 자 = SHA-256(userId) 앞 4 byte')
  const ms = parseInt(b.msg_id.slice(8, 20), 16)
  assert.ok(Math.abs(ms - Date.now()) < 60_000, 'SDK:IMPL-CHAT-API — 가운데 12 자 = 지은 시각(unix ms)')
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

test('SDK:IMPL-CHAT-API 내가 보낸 것 — 보관본 한 건 늘고 읽은 것으로(unread 0) · 다시 가져오기가 내 글을 또 내지 않는다 · view 의 read 가 로컬 total 보다 커도 unread 는 음수가 아니다', async () => {
  FakeWS.auto.set(Op.SPACE_LIST, { spaces: [{ space_id: 'c1', total: 4, read: 4 }] })
  try {
    const r = await rig()
    await tick(5)
    await r.c.chat.spaces()
    const ev: string[] = []
    r.c.chat.on('messages', (_, ms, src) => { for (const m of ms) ev.push(`${src}:${m.msgId}`) })
    const s = r.c.chat.send('c1', 'mine', { msgId: 'u1/own-1' })
    await tick()
    r.ws.reply(Op.MESSAGE, { t: 105 })
    await s
    assert.deepEqual(r.c.chat.spaceList.get('c1'), { spaceId: 'c1', total: 5, read: 5, unread: 0, lastT: 105 }, '내 글은 안 읽은 수에 안 든다(서버도 보낸 사람 read 를 올린다)')
    const h = r.c.chat.history('c1', { after: 100 })
    await tick()
    r.ws.reply(Op.SPACE_HISTORY, { messages: [msg('c1', 'x', 104), { space_id: 'c1', msg_id: 'u1/own-1', user_id: 'u1', t: 105, content: 'mine' }], more: false })
    await h
    assert.deepEqual(ev, ['history:u2/x'], '내가 보낸 msg_id 는 다시 가져오기가 또 내지 않는다')
    const v = r.c.chat.view('c1')
    await tick()
    r.ws.reply(Op.SPACE_VIEW, { read: 7 })
    await v
    const e = r.c.chat.spaceList.get('c1')
    assert.deepEqual([e?.total, e?.read, e?.unread], [7, 7, 0], 'view 의 read 가 로컬 total 보다 크면 total 을 올린다 — unread 는 음수가 아니다')
  } finally { FakeWS.auto.set(Op.SPACE_LIST, { spaces: [] }) }
})

// ══ 따라잡기 받기 · msg_id 거르기(SDK:IMPL-CHAT-CATCHUP) ═══════════════════════════════════════

test('SDK:IMPL-CHAT-API catchup — 앱이 부른다 · spaceId · t 를 넣고 빼면 그대로 실린다 · 다시 붙어도 SDK 는 스스로 부르지 않는다', async () => {
  const r = await rig()
  const a = r.c.chat.catchup({ spaceId: 'S', t: 1700 })
  await tick()
  assert.deepEqual(r.ws.last(Op.CATCHUP).body, { space_id: 'S', t: 1700 }, '연:RULE-CHAT-CATCHUP — 칸 둘 그대로')
  r.ws.reply(Op.CATCHUP, {}); await a
  const b = r.c.chat.catchup()
  await tick()
  assert.deepEqual(r.ws.last(Op.CATCHUP).body, {}, '인자 없음 — 공간 경계 없이 · 미전송 기록만')
  r.ws.reply(Op.CATCHUP, {}); await b
  await enter(r, 'r1')
  await resume(r)
  await tick(5)
  assert.equal(r.ws.requests(Op.CATCHUP).length + r.ws.requests(Op.SPACE_HISTORY).length + r.ws.requests(Op.SPACE_LIST).length, 0, 'SDK:IMPL-CHAT-CATCHUP — 다시 붙은 뒤 SDK 가 스스로 따라잡지 않는다')
})

test('K-sym-IMPL-CHAT-CATCHUP-1 — 공간 둘이 섞인 MESSAGES 묶음 → ACK 먼저 · 공간마다 따로 catchup · (t, msgId) 오름차순 · 이미 낸 msg_id 0', async () => {
  const r = await rig()
  const ev: string[] = []
  r.c.chat.on('messages', (sp, ms, src) => ev.push(`${src}:${sp}:${ms.map((m) => m.msgId).join(',')}`))
  await note(r, Op.MESSAGE, msg('S', 'a', 100))
  const pid = 9001
  r.ws.deliver(encodeFrame('request', Op.MESSAGES, pid, { messages: [msg('S', 'a', 100), msg('S', 'c', 102), msg('S', 'b', 102), msg('T', 'z', 105)] }))
  await tick()
  const acks = r.ws.frames().filter((f) => f.op === Op.MESSAGES && f.pid === pid && f.kind === 'ok')
  assert.equal(acks.length, 1, 'K-sym-IMPL-CHAT-CATCHUP-1 — 묶음 ACK 하나(연:RULE-TRN-NOTIFY-ACK-STEPS)')
  assert.deepEqual(ev, ['live:S:u2/a', 'catchup:S:u2/b,u2/c', 'catchup:T:u2/z'], 'K-sym-IMPL-CHAT-CATCHUP-1 — 공간마다 따로 · (t, msgId) 차례 · 이미 낸 a 는 0')
})

test('K-sym-IMPL-CHAT-CATCHUP-2 — 오래 켠 클라: 실시간 1,200 개 → 집합은 1,000 개 · 버린 것은 가장 오래된 것부터', async () => {
  const r = await rig()
  for (let t = 1; t <= 1200; t++) r.ws.notify(Op.MESSAGE, msg('S', `m${t}`, t))
  await until(() => (r.c.chat.core.seen.get('S')?.size ?? 0) >= 1000 && r.c.chat.core.seen.get('S')!.has('u2/m1200'))
  const set = r.c.chat.core.seen.get('S')!
  assert.deepEqual([set.size, set.has('u2/m200'), set.has('u2/m201'), set.has('u2/m1200')], [1000, false, true, true], 'K-sym-IMPL-CHAT-CATCHUP-2 — 1,000 개 · 가장 오래된 200 을 버림')
})

// ══ 접기 — 고침 · 반응 · 지움(SDK:IMPL-CHAT-FOLD) ═══════════════════════════════════════════════════

const rel = (space: string, id: string, t: number, kind: 'edit' | 'react' | 'delete', ref: string, more: Partial<ChatMessage> = {}, user = 'u2'): ChatMessage =>
  ({ space_id: space, msg_id: `${user}/${id}`, user_id: user, t, content: '', kind, ref, ...more })

test('K-sym-IMPL-CHAT-FOLD-1 — 고침(200) · 고침(300) · 지움(400)을 400 → 200 → 300 차례로 받아도 지워진 글 · 고침 둘만 거꾸로면 t=300 본문', async () => {
  const r = await rig()
  const ups: string[] = []
  r.c.chat.on('updates', (_sp, ms) => ups.push(ms.map((m) => `${m.msgId}:${m.deleted ? 'X' : m.content}`).join(',')))
  await note(r, Op.MESSAGE, msg('S', 'p', 100))
  await note(r, Op.MESSAGE, rel('S', 'd', 400, 'delete', 'u2/p'))
  await note(r, Op.MESSAGE, rel('S', 'e1', 200, 'edit', 'u2/p', { content: 'v200' }))
  await note(r, Op.MESSAGE, rel('S', 'e2', 300, 'edit', 'u2/p', { content: 'v300' }))
  assert.deepEqual(ups, ['u2/p:X', 'u2/p:X', 'u2/p:X'], 'K-sym-IMPL-CHAT-FOLD-1①② — 지움은 끝 · 늦게 온 고침이 되살리지 않는다')
  await note(r, Op.MESSAGE, msg('S', 'q', 110))
  ups.length = 0
  await note(r, Op.MESSAGE, rel('S', 'f2', 300, 'edit', 'u2/q', { content: 'v300' }))
  await note(r, Op.MESSAGE, rel('S', 'f1', 200, 'edit', 'u2/q', { content: 'v200' }))
  assert.deepEqual(ups, ['u2/q:v300', 'u2/q:v300'], 'K-sym-IMPL-CHAT-FOLD-1③ — (t, msgId) 최대 고침')
})

test('K-sym-IMPL-CHAT-FOLD-2 — 원본보다 고침 · 반응이 먼저 와도 원본을 낼 때 붙어 있다 · 관계 메시지는 messages 로 따로 안 나온다 · total 은 글만', async () => {
  const r = await rig()
  const got: { msgId: string; content: string; edited?: boolean; reactions?: Readonly<Record<string, readonly string[]>> }[] = []
  r.c.chat.on('messages', (_sp, ms) => got.push(...ms))
  FakeWS.auto.set(Op.SPACE_LIST, { spaces: [{ space_id: 'S', total: 0, read: 0 }] })
  try { await r.c.chat.spaces() } finally { FakeWS.auto.set(Op.SPACE_LIST, { spaces: [] }) }
  await note(r, Op.MESSAGE, rel('S', 'e', 200, 'edit', 'u2/p', { content: '고침' }))
  await note(r, Op.MESSAGE, rel('S', 'r1', 210, 'react', 'u2/p', { keys: ['+1'] }, 'u3'))
  await note(r, Op.MESSAGE, rel('S', 'r2', 220, 'react', 'u2/p', { keys: ['+1', 'ok'] }, 'u4'))
  assert.equal(got.length, 0, '관계 메시지는 messages 로 안 나온다')
  await note(r, Op.MESSAGE, msg('S', 'p', 100))
  const p = got.find((m) => m.msgId === 'u2/p')!
  assert.deepEqual([p.content, p.edited, p.reactions], ['고침', true, { '+1': ['u3', 'u4'], ok: ['u4'] }], 'K-sym-IMPL-CHAT-FOLD-2 — 먼저 온 관계가 붙는다')
  assert.equal(r.c.chat.spaceList.get('S')?.total, 1, '연:RULE-CHAT-UNREAD — 글만 센다')
})

test('SDK:IMPL-CHAT-FOLD 모르는 종류 — content 가 있으면 글로 · 없으면 버린다 · 내가 보낸 고침 · 반응 · 지움은 성공 때 updates', async () => {
  const r = await rig()
  const seen: string[] = []
  const ups: string[] = []
  r.c.chat.on('messages', (_sp, ms) => seen.push(...ms.map((m) => `${m.msgId}:${m.kind ?? ''}`)))
  r.c.chat.on('updates', (_sp, ms) => ups.push(...ms.map((m) => `${m.content}|${m.edited ? 'E' : ''}${m.deleted ? 'X' : ''}|${JSON.stringify(m.reactions ?? {})}`)))
  await note(r, Op.MESSAGE, { ...msg('S', 'n1', 100), kind: 'poll' as never, content: '투표: 점심?' })
  await note(r, Op.MESSAGE, { ...msg('S', 'n2', 101), kind: 'typing' as never, content: '' })
  assert.deepEqual(seen, ['u2/n1:poll'], '연:RULE-CHAT-UNKNOWN-KIND')
  const s = r.c.chat.send('S', '원본')
  await tick(); r.ws.reply(Op.MESSAGE, { t: 500 })
  const mine = await s
  const e = r.c.chat.edit('S', mine.msgId, '고친 원본')
  await tick()
  const eb = r.ws.last(Op.MESSAGE).body as { kind: string; ref: string; content: string }
  assert.deepEqual([eb.kind, eb.ref, eb.content], ['edit', mine.msgId, '고친 원본'], 'SDK:IMPL-CHAT-API edit — 늘 원본을 가리킨다')
  r.ws.reply(Op.MESSAGE, { t: 501 }); await e
  const k = r.c.chat.react('S', mine.msgId, ['+1'])
  await tick(); r.ws.reply(Op.MESSAGE, { t: 502 }); await k
  const d = r.c.chat.delete('S', mine.msgId)
  await tick()
  assert.equal((r.ws.last(Op.MESSAGE).body as { kind: string }).kind, 'delete')
  r.ws.reply(Op.MESSAGE, { t: 503 }); await d
  assert.deepEqual(ups, ['고친 원본|E|{}', '고친 원본|E|{"+1":["u1"]}', '|X|{}'], 'SDK:IMPL-CHAT-FOLD — 내 것도 접어 updates')
})

test('SDK:IMPL-CHAT-API send — 요청 몸이 131,072 byte 를 넘으면 보내지 않고 INVALID_PAYLOAD 로 reject(연:RULE-CHAT-CONTENT)', async () => {
  const r = await rig()
  const n = r.ws.requests(Op.MESSAGE).length
  const e = await r.c.chat.send('S', 'x', { ext: { blob: 'a'.repeat(140_000) } }).then(() => null, (x: unknown) => x)
  assert.ok(e instanceof OxLensError && e.code === 1002, 'INVALID_PAYLOAD')
  assert.equal(r.ws.requests(Op.MESSAGE).length, n, '보내지 않는다')
})

test('SDK:IMPL-CHAT-FOLD 상한 — 원본을 모르는 관계 1,200 개가 몰려도 이미 낸 글의 접기 상태는 남는다(상한은 모르는 원본에만)', async () => {
  const r = await rig()
  const ups: string[] = []
  r.c.chat.on('updates', (_sp, ms) => ups.push(...ms.map((m) => `${m.content}|${m.edited ? 'E' : ''}|${JSON.stringify(m.reactions ?? {})}`)))
  await note(r, Op.MESSAGE, msg('S', 'p', 100))
  await note(r, Op.MESSAGE, rel('S', 'e', 110, 'edit', 'u2/p', { content: '고침' }))
  r.ws.deliver(encodeFrame('request', Op.MESSAGES, 9100, { messages: Array.from({ length: 1200 }, (_, i) => rel('S', `x${i}`, 120 + i, 'react', `u2/old${i}`, { keys: ['+1'] })) }))
  await tick()
  await note(r, Op.MESSAGE, rel('S', 'r', 2000, 'react', 'u2/p', { keys: ['ok'] }, 'u3'))
  assert.equal(ups.at(-1), '고침|E|{"ok":["u3"]}', 'SDK:IMPL-CHAT-FOLD — 낸 글의 고침이 밀려나지 않는다')
})

test('SDK:IMPL-CHAT-FOLD history — 쪽의 relations 를 먼저 접어 글에 붙여 낸다 · 돌려준 쪽도 접힌 글', async () => {
  const r = await rig()
  const got: { msgId: string; content: string; deleted?: boolean; edited?: boolean; reactions?: Readonly<Record<string, readonly string[]>> }[] = []
  r.c.chat.on('messages', (_sp, ms) => got.push(...ms))
  const h = r.c.chat.history('S')
  await tick()
  r.ws.reply(Op.SPACE_HISTORY, {
    messages: [msg('S', 'a', 100), msg('S', 'b', 101)],
    relations: [rel('S', 'e', 150, 'edit', 'u2/a', { content: 'a 고침' }), rel('S', 'r', 151, 'react', 'u2/a', { keys: ['+1'] }, 'u3'), rel('S', 'd', 152, 'delete', 'u2/b')],
    more: false,
  })
  const page = await h
  const view = (m: { msgId: string; content: string; deleted?: boolean; edited?: boolean; reactions?: Readonly<Record<string, readonly string[]>> }) => [m.msgId, m.content, !!m.edited, !!m.deleted, m.reactions ?? {}]
  const want = [['u2/a', 'a 고침', true, false, { '+1': ['u3'] }], ['u2/b', '', false, true, {}]]
  assert.deepEqual(got.map(view), want, '연:RULE-CHAT-HISTORY-PAGE — messages{history} 가 접힌 글')
  assert.deepEqual(page.messages.map(view), want, 'history() 가 돌려준 쪽도 접힌 글')
})
