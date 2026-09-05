// author: kodeholic (powered by Claude)
// 연§11 — 발언권은 DC 축이다. ★미디어 지표로는 안 잡히는 자리라 여기서 본다.
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('ptt_voice')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

interface Ptt { phase: string; trusted: boolean; canRequest: boolean; remainingSec: number | null }
const ptt = (p: Participant): Promise<Ptt> => p.call<Ptt>('ptt', ROOM)

test('PTT-01 누르면 허가가 나고 놓으면 방이 빈다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const speaker = await S.open(ctx, { userId: S.user('U01') })
  await speaker.call('join', ROOM, 'talk')

  const listener = await S.open(ctx, { userId: S.user('U02') })
  await listener.call('join', ROOM, 'listen')

  await expect.poll(() => ptt(speaker).then((s) => s.trusted), {
    message: 'DC 가 서야 발언권이 산다 — 청취 전용도 track-less 보내기 연결을 세운다',
  }).toBe(true)
  expect((await ptt(listener)).trusted, '청취 전용도 DC 를 갖는다').toBe(true)

  await speaker.call('press', ROOM)
  await expect.poll(() => ptt(speaker).then((s) => s.phase), { message: '허가가 난다' })
    .toBe('has_permission')
  expect((await ptt(speaker)).remainingSec, '표의 기본값이 아니라 실려 온 값이다').not.toBeNull()

  await expect.poll(
    () => listener.call<{ detail: { userId: string | null } }[]>('events', 'speaker')
      .then((e) => e.at(-1)?.detail.userId ?? null),
    { message: '★청취자가 화자를 안다 — 미디어 계수기로는 안 잡히는 축이다' },
  ).toBe(S.user('U01'))

  await speaker.call('release', ROOM)
  await expect.poll(() => ptt(speaker).then((s) => s.phase)).toBe('no_permission')
  await expect.poll(
    () => listener.call<{ detail: { userId: string | null } }[]>('events', 'speaker')
      .then((e) => e.at(-1)?.detail.userId ?? null),
  ).toBe(null)
})

test('PTT-02 무전 슬롯은 방으로 온다 — user_id 가 없다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const p = await S.open(ctx, { userId: S.user('U03') })
  await p.call('join', ROOM, 'talk')

  const rooms = await p.call<{ tracks: { id: string; slot: boolean; userId: string | null }[] }[]>('rooms')
  const slot = rooms[0]!.tracks.find((t) => t.slot)
  expect(slot, '입장 응답부터 audio 슬롯이 있다(opus 고정)').toBeDefined()
  expect(slot!.userId, '★track_id 를 파싱하지 않는다 — 슬롯은 user_id 부재로 안다').toBeNull()
})
