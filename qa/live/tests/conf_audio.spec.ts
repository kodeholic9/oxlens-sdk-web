// author: kodeholic (powered by Claude)
// ★3층의 몫 — 실 인코더가 낸 것이 실 디코더에 닿는가. 와이어로 결판나는 것은 2층이 본다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('conf_audio')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

test('CONF-AUDIO-01 두 사람이 같은 방에서 서로의 오디오를 받는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')

  const b = await S.open(ctx, { userId: S.user('U02') })
  await b.call('join', ROOM, 'talk')
  await b.call('enableMic')

  await expect.poll(async () => {
    const rooms = await a.call<{ tracks: { userId: string | null }[] }[]>('rooms')
    return rooms[0]?.tracks.filter((t) => t.userId === S.user('U02')).length ?? 0
  }, { message: 'U01 이 U02 의 트랙을 받는다' }).toBeGreaterThan(0)

  const stats = await a.call<{ readyState: string; muted: boolean }[]>('trackStats')
  expect(stats.length).toBeGreaterThan(0)
  expect(stats.every((s) => s.readyState === 'live')).toBe(true)
})
