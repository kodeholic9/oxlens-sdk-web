// author: kodeholic (powered by Claude)
// ★갈래B — 정규 시험이 "0·부재"를 단언하는 칸은 시험이 깨져도 그대로 초록이다.
// 나머지를 정상으로 둔 채 딱 하나만 어겨, 그 단언이 무엇에 매여 있는지 못박는다.
import { test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../../fixtures/scope.js'

const S = new Scope('fault')

test.afterEach(async () => { await S.teardown() })

interface Track { id: string; slot: boolean; userId: string | null }
interface Room { id: string; tracks: Track[] }
const tracksOf = (p: Participant, room: string): Promise<Track[]> =>
  p.call<Room[]>('rooms').then((rs) => rs.find((r) => r.id === room)?.tracks ?? [])

test('FAULT-01 상대가 발행 안 하면 상대 트랙이 없다 — CONF 의 단언이 발행에 매여 있다', async ({ browser }) => {
  const ROOM = S.room('nopublish')
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('F01') })
  await a.call('join', ROOM, 'talk')
  const b = await S.open(ctx, { userId: S.user('F02') })
  await b.call('join', ROOM, 'talk')

  // ★딱 하나만 어긴다 — B 가 enableMic 을 부르지 않는다. 나머지는 정상 경로다.
  await new Promise((r) => setTimeout(r, 2_000))
  const mine = await tracksOf(a, ROOM)
  expect(mine.filter((t) => t.userId === S.user('F02')), '발행이 없으면 트랙도 없다').toHaveLength(0)

  // 대조군 — 같은 형상에서 발행하면 온다. 이것이 없으면 "그냥 안 붙는 시험" 과 구별이 안 된다.
  await b.call('enableMic')
  await expect.poll(() => tracksOf(a, ROOM).then((ts) => ts.filter((t) => t.userId === S.user('F02')).length))
    .toBeGreaterThan(0)
})

test('FAULT-02 다른 방이면 안 보인다 — "같은 방에서 본다" 가 방을 실제로 가른다', async ({ browser }) => {
  const A = S.room('splitA')
  const B = S.room('splitB')
  const ctx = await browser.newContext()
  await ensureRoom(A)
  await ensureRoom(B)

  const a = await S.open(ctx, { userId: S.user('F03') })
  await a.call('join', A, 'talk')
  const b = await S.open(ctx, { userId: S.user('F04') })
  await b.call('join', B, 'talk')
  await b.call('enableMic')

  await new Promise((r) => setTimeout(r, 2_000))
  expect(await tracksOf(a, A), '방을 안 가르면 남의 방 트랙이 섞인다').toHaveLength(1)
  expect((await tracksOf(a, A))[0]!.slot, '남는 것은 이 방 무전 슬롯뿐이다').toBe(true)
})

test('FAULT-03 floor 없이는 소리가 안 나간다 — PTT 게이트가 실제로 닫혀 있다', async ({ browser }) => {
  const ROOM = S.room('gate')
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const p = await S.open(ctx, { userId: S.user('F05') })
  await p.call('join', ROOM, 'talk')

  // ★딱 하나만 어긴다 — press 를 부르지 않고 반이중 마이크만 세운다.
  await p.call('press', ROOM)
  await p.call('release', ROOM)
  await expect.poll(() => p.call<{ phase: string }>('ptt', ROOM).then((s) => s.phase)).toBe('no_permission')

  const local = await p.call<{ state: string; duplex: string; packets: number | null }[]>('localTracks')
  const half = local.find((t) => t.duplex === 'half')
  expect(half, '반이중 마이크는 등록된 채 남는다').toBeDefined()
  expect(half!.state, '★허가가 없으면 sending 이 아니다 — 등록만 되어 있다').toBe('registered')
})
