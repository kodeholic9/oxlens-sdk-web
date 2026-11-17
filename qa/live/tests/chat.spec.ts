// author: kodeholic (powered by Claude)
// 연:CHAT.op.MESSAGE · 정:IMPL-CHAT-FANOUT · SDK:IMPL-CHAT-API — 채팅은 공간의 것이고 ★방 입장과 무관하다.
// 신원은 서버가 세션에서 넣는다 · 보낸 세션에는 통지가 없다(자기 것은 응답으로 안다).
// (20261116 — 옛 방 문자 MESSAGE-01 · 02 를 공간 채팅으로 옮겼다 · context 202611/20261116c · 20261117 따라잡기 CHAT-03 — 202611/20261117c)
import { test } from '@playwright/test'
import { Scope, ensureSpace, expect } from '../fixtures/scope.js'

const S = new Scope('chat')
const SPACE = S.room('space')

test.afterEach(async () => { await S.teardown() })

interface Note { detail: { spaceId: string; source: string; msgs: { msgId: string; userId: string; t: number; content: string; kind?: string; target?: string }[] } }

test('CHAT-01 방에 안 들어가도 멤버에게 가고 보낸 사람에게는 안 돌아온다', { annotation: { type: 'spec', description: 'CP-OP-MESSAGE · SD-EVENT-MESSAGES' } }, async ({ browser }) => {
  const ctx = await browser.newContext()
  ensureSpace(SPACE, [S.user('U01'), S.user('U02')])
  const a = await S.open(ctx, { userId: S.user('U01') })
  const b = await S.open(ctx, { userId: S.user('U02') })
  const content = `들리나 ${Date.now()}`

  const res = await a.call<{ msgId: string; t: number; userId: string }>('chatSend', SPACE, content)
  expect(res.msgId, 'SDK 가 msgId 를 hex 36 자로 짓는다(연:RULE-CHAT-MSG-ID)').toMatch(/^[0-9a-f]{36}$/)
  expect(res.t, '서버가 매긴 t').toBeGreaterThan(0)

  await expect.poll(async () => {
    const notes = await b.call<Note[]>('events', 'chat')
    return notes.flatMap((n) => n.detail.msgs.map((m) => ({ src: n.detail.source, space: n.detail.spaceId, ...m }))).find((m) => m.content === content) ?? null
  }, { message: '★방 입장 없이 같은 공간 멤버에게 실시간으로 간다 · 신원은 서버가 세션에서 넣는다' })
    .toEqual({ src: 'live', space: SPACE, msgId: res.msgId, userId: S.user('U01'), t: res.t, content })

  const mine = (await a.call<Note[]>('events', 'chat')).flatMap((n) => n.detail.msgs).filter((m) => m.content === content)
  expect(mine, '★보낸 세션에는 통지가 없다').toHaveLength(0)

  const again = await a.call<{ t: number }>('chatSend', SPACE, content, res.msgId)
  expect(again.t, '같은 msgId · 같은 내용을 다시 보내면 처음 t').toBe(res.t)

  const page = await b.call<{ msgs: { msgId: string }[] }>('chatHistory', SPACE, { after: res.t - 1 })
  expect(page.msgs.filter((m) => m.msgId === res.msgId), '다시 가져오기에도 한 건').toHaveLength(1)
})

test('CHAT-02 멤버가 아닌 공간에는 못 보낸다', { annotation: { type: 'spec', description: 'CP-CODE-NOT-SPACE-MEMBER' } }, async ({ browser }) => {
  const ctx = await browser.newContext()
  const other = S.room('other')
  ensureSpace(other, [S.user('U01')])
  const p = await S.open(ctx, { userId: S.user('U03') })

  await expect(p.call('chatSend', other, 'x')).rejects.toThrow()
})

test('CHAT-03 접속하지 않던 멤버가 따라잡기를 부르면 못 받은 메시지와 자기 추가 메시지가 온다', { annotation: { type: 'spec', description: 'CP-OP-CATCHUP · CP-OP-MESSAGES · SD-EVENT-MESSAGES' } }, async ({ browser }) => {
  const ctx = await browser.newContext()
  const space = S.room('catchup')
  ensureSpace(space, [S.user('U04'), S.user('U05')])
  const a = await S.open(ctx, { userId: S.user('U04') })
  const content = `늦게 온 사람 ${Date.now()}`
  await a.call('chatSend', space, content)

  const b = await S.open(ctx, { userId: S.user('U05') })
  await b.call('chatCatchup', {})
  await expect.poll(async () => {
    const notes = await b.call<Note[]>('events', 'chat')
    const caught = notes.filter((n) => n.detail.source === 'catchup' && n.detail.spaceId === space).flatMap((n) => n.detail.msgs)
    return { post: caught.some((m) => m.content === content), added: caught.some((m) => m.kind === 'add' && m.target === S.user('U05')) }
  }, { message: '★CATCHUP{} 뒤 MESSAGES 로 못 받은 메시지 · 자기 추가 메시지(멤버 변경)' }).toEqual({ post: true, added: true })
})
