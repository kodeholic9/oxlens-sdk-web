// author: kodeholic (powered by Claude)
// ★3층의 몫 — 실 인코더가 낸 프레임이 실 디코더에 닿아 픽셀이 되는가.
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('conf_video')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

interface Stat { id: string; kind: string; readyState: string; videoWidth?: number; currentTime?: number }

async function videoOf(p: Participant): Promise<Stat | undefined> {
  const stats = await p.call<Stat[]>('trackStats')
  return stats.find((s) => s.kind === 'video')
}

test('CONF-VIDEO-01 상대 영상이 디코딩되어 픽셀이 된다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')

  const b = await S.open(ctx, { userId: S.user('U02') })
  await b.call('join', ROOM, 'talk')
  await b.call('enableCamera')

  await expect.poll(() => videoOf(a).then((v) => v?.videoWidth ?? 0), {
    message: '★패킷이 오는 것과 디코딩되는 것은 다르다 — 폭이 0 이면 검은 화면이다',
    timeout: 20_000,
  }).toBeGreaterThan(0)

  const first = await videoOf(a)
  await new Promise((r) => setTimeout(r, 2_500))
  const second = await videoOf(a)
  expect(second!.currentTime!, '재생 시각이 흐른다 — 첫 프레임만 오고 멎으면 여기서 잡힌다')
    .toBeGreaterThan(first!.currentTime!)
})
