// author: kodeholic (powered by Claude)
// 재발 시험 — SDK 종합 검토(context 202611/20261102d) 보고 표의 손 결합 결함을 고친 뒤 다시 나지 않는지 잰다(평시 손 수리 + 재발 시험).
// 원천(연동규격서 · SDK 정의서)이 정한 문장 쪽은 영역 시험이 단위 ID 로 잰다 — 여기는 그 원천 문장을 손 결합이 어겼던 자리만.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tick, FakeWS } from './_ws.js'
import { SA, up, linkOf, drain, enter, joinBody, joinFrame, note, vers, httpMock, getRoom, FAIL } from './_rig.js'
import { pubUp } from './_pub.js'
import { Op } from '../src/internal/wire/ws.js'
import { OxLensError } from '../src/index.js'

test('재발 20261102d-5 — 협상 대기(staged) 중 close() 면 기다리던 enable* 는 closed 로 reject(영영 pending 아님 · SDK:IMPL-PUB-API 효과 표 app.publish_failed)', async () => {
  const x = await pubUp()
  const p = x.r.c.media.enableMicrophone().then(() => 'resolved', (e: unknown) => e)
  await tick()
  assert.equal(x.r.c.media.tracks[0]?.state, 'staged')
  await x.r.c.close()
  const e = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 200))])
  assert.ok(e instanceof OxLensError && e.category === 'closed', `재발 5 — closed 로 reject(받은 것: ${String(e)})`)
})

test('재발 20261102d-7 — 재구축이 내려 다시 들어갈 방(rs NONE · rejoin)에 같은 방 join() 은 그 핸들을 돌려준다(새 RoomCore 0 · SDK:RULE-API-HANDLES)', async () => {
  const r = await up()
  const h = await enter(r, 'r1')
  const core = r.core.rooms.get('r1')!
  core.st = { ...core.st, rs: 'NONE', rejoin: true }
  const joins = r.ws.requests(Op.ROOM_JOIN).length
  const p = r.c.join('r1')
  await tick()
  assert.deepEqual([r.core.rooms.get('r1') === core, r.ws.requests(Op.ROOM_JOIN).length], [true, joins], '재발 7 — 옛 RoomCore 그대로 · 새 입장 요청 0')
  core.st = { ...core.st, rs: 'JOINED', rejoin: false }
  core.joinPending = true
  core.finishJoin()
  assert.equal(await p, h, '재발 7 — 같은 Room 핸들')
  await r.c.close()
})

test('재발 20261102d-16 — 첫 협상이 실패하면 join() 은 그 방을 나가고 negotiation 으로 reject(SDK:IMPL-ROOM-API 효과 표 app.joined)', async () => {
  const r = await up()
  const p = r.c.join('r1').then(() => 'resolved', (e: unknown) => e)
  await tick()
  linkOf(r, SA)
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1'))
  await tick()
  await drain(r, SA, false)
  const e = await p
  assert.ok(e instanceof OxLensError && e.category === 'negotiation', `재발 16 — negotiation 으로 reject(받은 것: ${String(e)})`)
  assert.equal(r.ws.requests(Op.ROOM_LEAVE).filter((f) => (f.body as { room_id: string }).room_id === 'r1').length, 1, '재발 16 — 서버가 받아들인 입장을 나간다(명단에 남지 않게)')
  await r.c.close()
})

test('재발 20261102d-19 — 재동기 HTTP 401 이면 되풀이하지 않는다 · tokenRequired 하나 · setToken() 뒤 다시 받는다(연:RULE-TRN-HTTP-AUTH-TWO)', async () => {
  let deny = true
  const http = httpMock(() => (deny ? { status: 401, body: { code: 2003, name: 'TOKEN_EXPIRED', permanent: false } } : { status: 200, body: getRoom('r1', 9) }))
  try {
    const r = await up()
    await enter(r, 'r1', { seq: 1 })
    const asked: unknown[] = []
    r.c.on('tokenRequired', (x) => asked.push(x))
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u2', select: false, participant_type: 0, version: vers(5) })
    await tick(400)
    assert.deepEqual([http.calls.length, asked.length], [1, 1], '재발 19 — 401 하나에 재동기 1 · tokenRequired 1(되풀이 0)')
    deny = false
    r.c.setToken('tok-2')
    for (let i = 0; i < 20 && r.core.rooms.get('r1')!.st.rsync; i++) await tick()
    assert.deepEqual([http.calls.length, r.core.rooms.get('r1')!.st.rsync, r.core.rooms.get('r1')!.st.cseq], [2, false, 9], '재발 19 — 새 토큰 뒤 다시 받아 반영')
    await r.c.close()
  } finally { http.restore() }
})

test('재발 20261102d-22 — 재구축 끝(rebuilt)이 지운 협상 큐는 떠 있던 협상이 끝난 뒤 한 번 더 돈다(새 연결은 지금 보관본으로 — 연:LINK.C.REBUILD.rebuilt)', async () => {
  const r = await up()
  await enter(r, 'r1')
  const link = linkOf(r, SA)
  link.fact({ t: 'sctp', state: 'closed' })
  await tick()
  for (let i = 0; i < 50 && r.ws.requests(Op.ROOM_JOIN).length < 2; i++) await tick()
  const peer = (() => { linkOf(r, SA); return r.peers.get('sfu-a')! })()
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1'))
  await tick(); await tick()
  assert.equal(link.st.nego, true, '다시 들어간 방의 협상이 떠 있다')
  link.renego()
  assert.equal(link.st.dirty, true, '그 사이 온 재협상은 큐에')
  const built = peer.assembled
  const p = peer as unknown as { ice: string; dcOpen: boolean }
  p.ice = 'connected'; p.dcOpen = true
  link.fact({ t: 'ice', state: 'connected' })
  assert.deepEqual([link.st.ls, link.st.nego, link.st.dirty], ['OK', false, false], 'rebuilt 가 큐를 지웠다(위 상태기)')
  peer.settle(true); await tick(); await tick()
  assert.equal(peer.assembled, built + 1, '재발 22 — 떠 있던 협상이 끝난 뒤 지운 큐 몫의 협상 하나')
  await r.c.close()
})

test('재발 20261102d-25 — 전역 리스너(pagehide · visibilitychange · devicechange)는 close() 에 뗀다 · connect() 에 다시 단다(닫힌 클라이언트를 붙잡지 않는다)', async () => {
  const g = globalThis as Record<string, unknown>
  const saved = { window: g['window'], document: g['document'] }
  const count = new Map<string, number>()
  const target = (): EventTarget => ({
    addEventListener: (n: string) => { count.set(n, (count.get(n) ?? 0) + 1) },
    removeEventListener: (n: string) => { count.set(n, (count.get(n) ?? 0) - 1) },
    dispatchEvent: () => true,
  }) as unknown as EventTarget
  g['window'] = target()
  g['document'] = Object.assign(target(), { visibilityState: 'visible' })
  try {
    const r = await up()
    assert.deepEqual([count.get('pagehide'), count.get('visibilitychange')], [1, 1], '접속 동안 하나씩')
    await r.c.close()
    assert.deepEqual([count.get('pagehide'), count.get('visibilitychange')], [0, 0], '재발 25 — close() 뒤 0')
  } finally { g['window'] = saved.window; g['document'] = saved.document }
})

test('재발 20261102d-26 · 28 — 닫힌 방의 ptt.enable() 은 closed(CLOSED) · 세션이 끝나면 health 는 offline', async () => {
  const r = await up()
  const h = await enter(r, 'r1')
  const l = h.leave(); await tick()
  r.ws.answer(r.ws.last(Op.ROOM_LEAVE), {}); await l
  const e = await h.ptt.enable().then(() => null, (x: unknown) => x)
  assert.ok(e instanceof OxLensError && e.category === 'closed' && e.name === 'CLOSED', `재발 26 — closed · CLOSED(받은 것: ${String(e)})`)
  assert.equal(r.c.health, 'ok')
  await r.c.close()
  assert.equal(r.c.health, 'offline', '재발 28 — DISCONNECTED 면 offline(SDK:IMPL-SES-API client.health)')
})

test('SD-EVENT-TOKEN-REQUIRED③ — 재개 창을 넘긴 재접속(open_late)이 2003 을 받으면 tokenRequired 하나 · closed 0(closed 는 백오프 소진에서만)', async () => {
  const r = await up()
  await enter(r, 'r1')
  const labels: string[] = []
  const tokens: unknown[] = []
  const closed: unknown[] = []
  r.c.diagnostics.on('transition', (t) => { if (t.layer === 'SES') labels.push(t.label) })
  r.c.on('tokenRequired', (x) => tokens.push(x))
  r.c.on('closed', (x) => closed.push(x))
  r.core.ses = { ...r.core.ses, winMs: 1 }
  const made = FakeWS.made.length
  r.ws.close()
  for (let i = 0; i < 300 && FakeWS.made.length === made; i++) await tick(10)
  await tick(5)
  const ws2 = FakeWS.made.at(-1)!
  ws2.open(); await tick()
  ws2.reply(Op.BIND, FAIL(2003, 'TOKEN_EXPIRED'), false); await tick()
  assert.ok(labels.includes('SES.C.RESUMING.open_late') && labels.includes('SES.C.RESUMING.bind_2003'), `창을 넘긴 재접속 — open_late → bind_2003: ${labels.join(' · ')}`)
  assert.deepEqual([tokens, closed.length], [[{ cause: 'expired' }], 0], 'SD-EVENT-TOKEN-REQUIRED③ — 이 이벤트 하나 · closed 0')
  await r.c.close()
})
