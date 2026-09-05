// author: kodeholic (powered by Claude)
// 연§6-5 · 정§13 — 문자는 방 broadcast 이고 ★신원은 서버가 세션에서 넣는다.
// 보낸 사람에게는 에코가 없다 — 자기 것은 응답으로 안다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('message')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

interface Ev { detail: { userId: string; content: string } }

test('MSG-01 남에게 가고 나에게는 안 돌아온다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')
  const b = await S.open(ctx, { userId: S.user('U02') })
  await b.call('join', ROOM, 'listen')

  const res = await a.call<{ msgId: string }>('sendMessage', ROOM, '들리나')
  expect(res.msgId, '자기 것은 응답으로 안다').toBeTruthy()

  await expect.poll(() => b.call<Ev[]>('events', 'message').then((e) => e.at(-1)?.detail ?? null), {
    message: '★신원은 서버가 세션에서 넣는다 — 클라가 실은 값이 아니다',
  }).toEqual({ room: ROOM, userId: S.user('U01'), content: '들리나' })

  expect(await a.call<Ev[]>('events', 'message'), '★보낸 사람에게는 에코가 없다').toHaveLength(0)
})

test('MSG-02 안 들어간 방에는 못 보낸다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const other = S.room('other')
  await ensureRoom(other)
  const p = await S.open(ctx, { userId: S.user('U03') })
  await p.call('join', ROOM, 'talk')

  await expect(p.call('sendMessage', other, 'x')).rejects.toThrow()
})
