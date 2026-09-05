// author: kodeholic (powered by Claude)
// 연§5-1·§5-3·§5-5 — 브라우저 클라가 부르는 HTTP 세 자리. 페이지 origin 이 hub 와 다르면
// ★CORS 가 없으면 막힌다 — 파이썬 봇도 1층도 원리적으로 못 보는 축이다.
import { test } from '@playwright/test'
import { BASE } from '../fixtures/env.js'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('http_origin')

test.afterEach(async () => { await S.teardown() })

test('HTTP-01 다른 origin 의 페이지가 SDK 로 방 목록을 읽는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const room = S.room('list')
  await ensureRoom(room)
  const p = await S.open(ctx, { userId: S.user('U01') })

  const origin = await p.page.evaluate(() => window.location.origin)
  expect(origin, '페이지와 hub 가 같은 origin 이면 이 시험이 공허하다').not.toBe(new URL(BASE).origin)

  const rooms = await p.call<{ roomId: string }[]>('listRooms')
  expect(rooms.some((r) => r.roomId === room), '★막히면 fetch 가 던져 여기 오지도 못한다').toBe(true)
})

test('HTTP-02 미리보기는 방에 안 들어가고 본다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const room = S.room('peek')
  await ensureRoom(room)
  const inside = await S.open(ctx, { userId: S.user('U02') })
  await inside.call('join', room, 'talk')

  const outside = await S.open(ctx, { userId: S.user('U03') })
  const view = await outside.call<{ userCount: number; participants: string[]; version: unknown }>('preview', room)

  expect(view.participants, '누가 있는지가 보인다').toContain(S.user('U02'))
  expect(view.version, '★version 은 항상 온다 — 반영 전에 견주는 값이다').toBeTruthy()
  expect(await outside.call<unknown[]>('rooms'), '정원을 먹지 않고 명단에 오르지 않는다').toHaveLength(0)
})
