// author: kodeholic (powered by Claude)
// ★3층의 몫 — 실 인코더가 낸 것이 실 디코더에 닿는가.
// 판정은 트랙 존재가 아니라 ★차분이다. 붙은 채로 한 바이트도 안 오는 형상이 있다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { flowOf, TrackStat } from '../fixtures/delta.js'

const S = new Scope('conf_audio')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

test('CONF-AUDIO-01 상대 오디오가 실제로 흐른다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')

  const b = await S.open(ctx, { userId: S.user('U02') })
  await b.call('join', ROOM, 'talk')
  await b.call('enableMic')

  const mine = (t: TrackStat): boolean => t.kind === 'audio' && !t.id.startsWith('ptt-')
  await expect.poll(() => a.call<TrackStat[]>('trackStats').then((s) => s.filter(mine).length), {
    message: '상대 트랙이 붙는다',
  }).toBe(1)

  const flow = await flowOf(a, mine)
  expect(flow, '트랙이 사라지면 0 과 구별해야 한다').not.toBeNull()
  expect(flow!.packets, '★붙은 채로 한 바이트도 안 오는 형상이 있다 — 차분이 판정이다')
    .toBeGreaterThan(0)
  expect(flow!.bytes).toBeGreaterThan(0)
})

test('CONF-AUDIO-02 발행이 없으면 흐르지도 않는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM2 = S.room('silent')
  await ensureRoom(ROOM2)
  const a = await S.open(ctx, { userId: S.user('U03') })
  await a.call('join', ROOM2, 'talk')
  const b = await S.open(ctx, { userId: S.user('U04') })
  await b.call('join', ROOM2, 'talk')

  // 발행이 없으니 상대 트랙 자체가 없다 — 무전 슬롯만 남는다.
  await new Promise((r) => setTimeout(r, 1_500))
  const stats = await a.call<TrackStat[]>('trackStats')
  expect(stats.filter((t) => !t.id.startsWith('ptt-')), '발행 없이 트랙이 생기면 안 된다')
    .toHaveLength(0)
})
