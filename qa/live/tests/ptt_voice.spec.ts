// author: kodeholic (powered by Claude)
// 연§11 — 발언권은 DC 축이고 슬롯은 미디어 축이다. ★둘을 같이 봐야 "무전이 된다" 가 성립한다.
// DC 만 보면 허가는 나는데 소리가 안 가는 형상을 못 본다(미디어 계수기로도 안 잡힌다).
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { flowOf, TrackStat } from '../fixtures/delta.js'

const S = new Scope('ptt_voice')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

interface Ptt { phase: string; trusted: boolean; canRequest: boolean; remainingSec: number | null }
const ptt = (p: Participant): Promise<Ptt> => p.call<Ptt>('ptt', ROOM)
const slot = (t: TrackStat): boolean => t.id.startsWith('ptt-')
const speakerSeen = (p: Participant): Promise<string | null> =>
  p.call<{ detail: { userId: string | null } }[]>('events', 'speaker').then((e) => e.at(-1)?.detail.userId ?? null)

test('PTT-01 허가 동안만 슬롯이 흐른다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const speaker = await S.open(ctx, { userId: S.user('U01') })
  await speaker.call('join', ROOM, 'talk')
  const listener = await S.open(ctx, { userId: S.user('U02') })
  await listener.call('join', ROOM, 'listen')

  // ★조용할 때는 흐르지 않는다 — 이 칸이 없으면 "늘 흐르는 것" 과 구별이 안 된다.
  expect((await flowOf(listener, slot, 1_500))!.packets, '아무도 안 말하는데 흐르면 안 된다').toBe(0)

  await speaker.call('press', ROOM)
  await expect.poll(() => ptt(speaker).then((s) => s.phase), { message: '허가가 난다' })
    .toBe('has_permission')
  expect((await ptt(speaker)).remainingSec, '표의 기본값이 아니라 실려 온 값이다').not.toBeNull()

  const talking = await flowOf(listener, slot)
  expect(talking!.packets, '★허가만 나고 소리가 안 가는 형상이 있다 — 차분이 판정이다')
    .toBeGreaterThan(0)
  expect(talking!.bytes).toBeGreaterThan(0)

  await speaker.call('release', ROOM)
  await expect.poll(() => ptt(speaker).then((s) => s.phase)).toBe('no_permission')
  await new Promise((r) => setTimeout(r, 1_000))
  expect((await flowOf(listener, slot))!.packets, '놓았는데 계속 흐르면 게이트가 안 닫힌 것이다')
    .toBe(0)
})

test('PTT-02 청취자가 화자를 안다 — DC 축', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM2 = S.room('notice')
  await ensureRoom(ROOM2)
  const speaker = await S.open(ctx, { userId: S.user('U03') })
  await speaker.call('join', ROOM2, 'talk')
  const listener = await S.open(ctx, { userId: S.user('U04') })
  await listener.call('join', ROOM2, 'listen')

  await expect.poll(() => listener.call<Ptt>('ptt', ROOM2).then((s) => s.trusted), {
    message: '★청취 전용도 track-less 보내기 연결을 세운다 — 없으면 누가 말하는지 영영 안 뜬다',
  }).toBe(true)

  await speaker.call('press', ROOM2)
  await expect.poll(() => speakerSeen(listener), { message: '미디어 계수기로는 안 잡히는 축이다' })
    .toBe(S.user('U03'))

  await speaker.call('release', ROOM2)
  await expect.poll(() => speakerSeen(listener)).toBe(null)
})

test('PTT-03 무전 슬롯은 방으로 온다 — user_id 가 없다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM3 = S.room('slot')
  await ensureRoom(ROOM3)
  const p = await S.open(ctx, { userId: S.user('U05') })
  await p.call('join', ROOM3, 'talk')

  const rooms = await p.call<{ tracks: { id: string; slot: boolean; userId: string | null }[] }[]>('rooms')
  const found = rooms[0]!.tracks.find((t) => t.slot)
  expect(found, '입장 응답부터 audio 슬롯이 있다(opus 고정)').toBeDefined()
  expect(found!.userId, '★track_id 를 파싱하지 않는다 — 슬롯은 user_id 부재로 안다').toBeNull()
})
