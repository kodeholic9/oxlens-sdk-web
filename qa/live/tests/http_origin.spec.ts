// author: kodeholic (powered by Claude)
// 연§5-1 — /rooms 는 브라우저 클라가 부르는 자리다. 페이지 origin 이 hub 와 다를 때
// ★CORS 가 없으면 preflight 에서 막힌다 — 파이썬 봇도 1층도 원리적으로 못 보는 축이다.
import { test } from '@playwright/test'
import { BASE } from '../fixtures/env.js'
import { Scope, expect } from '../fixtures/scope.js'

const S = new Scope('http_origin')

test.afterEach(async () => { await S.teardown() })

test('HTTP-01 다른 origin 의 페이지가 방 목록을 읽는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const p = await S.open(ctx, { userId: S.user('U01') })

  const page = await p.page.evaluate(() => (window as { location: Location }).location.origin)
  expect(page, '페이지와 hub 가 같은 origin 이면 이 시험이 공허하다').not.toBe(new URL(BASE).origin)

  const res = await p.call<{ status: number; count: number | null }>('httpRooms')
  expect(res.status, '★막히면 fetch 가 던져 여기 오지도 못한다').toBe(200)
  expect(res.count).not.toBeNull()
})
