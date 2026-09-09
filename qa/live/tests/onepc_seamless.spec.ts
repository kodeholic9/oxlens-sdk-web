// author: kodeholic (powered by Claude)
// ★연§9-10 규칙 2(무중단 불변)의 관측형 — 시험 항목서 `C-sym-9-10-1`.
// `1pc` 은 SDP 가 한 벌이라 어느 사건이든 전체를 다시 낸다. 그래서 ★이번 사건과 무관한
// 트랙이 그 창에서 멎는지를 본다. 두 스냅샷 차분으로는 창 안의 끊김을 못 보므로 촘촘히 훑는다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { msOf, stalls, TrackStat, watch } from '../fixtures/delta.js'

const S = new Scope('onepc')
const ROOM = S.room()
const ROOM2 = S.room('second')

/** 남의 마이크 — 무전 슬롯(`ptt-`)이 아니라 개인 오디오다. */
const peerAudio = (t: TrackStat): boolean => t.kind === 'audio' && !t.id.startsWith('ptt-')

test.afterEach(async () => { await S.teardown() })

/** 사건 전에 그 트랙이 실제로 흐르고 있어야 "끊겼다" 를 말할 수 있다. */
async function flowing(p: { call<T>(fn: string, ...a: unknown[]): Promise<T> }): Promise<TrackStat> {
  await expect.poll(async () => (await p.call<TrackStat[]>('trackStats')).filter(peerAudio).length, {
    message: '상대 오디오가 붙는다',
  }).toBe(1)
  await expect.poll(async () => (await p.call<TrackStat[]>('trackStats')).find(peerAudio)?.packets ?? 0, {
    message: '붙은 것과 흐르는 것은 다르다',
  }).toBeGreaterThan(0)
  return (await p.call<TrackStat[]>('trackStats')).find(peerAudio)!
}

test('ONEPC-01 보내기 증설 중에도 듣던 소리가 안 끊긴다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const a = await S.open(ctx, { userId: S.user('U01'), pcMode: '1pc' })
  const b = await S.open(ctx, { userId: S.user('U02'), pcMode: '1pc' })
  // ★모드가 실제로 1pc 인지 먼저 못박는다 — 2pc 로 돌면 이 시험은 아무것도 안 잰다.
  for (const p of [a, b]) {
    expect((await p.call<{ pcMode: string | null }>('session')).pcMode, '이 시험은 1pc 것이다').toBe('1pc')
  }
  await a.call('join', ROOM, 'talk')
  await b.call('join', ROOM, 'talk')
  await b.call('enableMic')
  const before = await flowing(a)

  // 사건 — A 가 보낼 것을 늘린다(m-line 증설). 듣고 있던 B→A 오디오와는 무관한 축이다.
  const samples = await watch(a, peerAudio, {
    samples: 12, gapMs: 250, fireAt: 2, during: () => a.call('enableCamera'),
  })

  expect(stalls(samples), '재협상 창에서 계수가 멎은 표본이 있으면 그 자리가 끊김이다').toEqual([])
  const after = (await a.call<TrackStat[]>('trackStats')).find(peerAudio)!
  expect(after.id, '무관한 트랙의 신원이 바뀌면 배관이 새로 선 것이다').toBe(before.id)
})

test('ONEPC-02 받기 증설 중에도 듣던 소리가 안 끊긴다', async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  await ensureRoom(ROOM2)
  const a = await S.open(ctx, { userId: S.user('U03'), pcMode: '1pc' })
  const b = await S.open(ctx, { userId: S.user('U04'), pcMode: '1pc' })
  await a.call('join', ROOM, 'talk')
  await b.call('join', ROOM, 'talk')
  await b.call('enableMic')
  const before = await flowing(a)

  // 사건 — A 가 방을 하나 더 든다(받기 m-line 증설). 듣던 트랙과 무관하다.
  const samples = await watch(a, peerAudio, {
    samples: 12, gapMs: 250, fireAt: 2, during: () => a.call('join', ROOM2, 'listen'),
  })

  expect(stalls(samples), '방을 더 들었다고 듣던 소리가 멎으면 안 된다').toEqual([])
  const after = (await a.call<TrackStat[]>('trackStats')).find(peerAudio)!
  expect(after.id).toBe(before.id)
  expect(after.freezeCount ?? 0, '디코더가 얼어붙지 않는다').toBe(before.freezeCount ?? 0)
})

test('ONEPC-00 사건이 없으면 그냥 흐른다 — 기준선', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM0 = S.room('base')
  await ensureRoom(ROOM0)
  const a = await S.open(ctx, { userId: S.user('U05'), pcMode: '1pc' })
  const b = await S.open(ctx, { userId: S.user('U06'), pcMode: '1pc' })
  await a.call('join', ROOM0, 'talk')
  await b.call('join', ROOM0, 'talk')
  await b.call('enableMic')
  await flowing(a)

  // 아무 사건도 안 친다. 여기서 멎으면 끊김의 원인은 재협상이 아니다.
  const samples = await watch(a, peerAudio, {
    samples: 10, gapMs: 250, fireAt: 99, during: async () => undefined,
  })
  expect(stalls(samples), '사건 없이도 멎으면 1pc 전달 자체가 안 서는 것이다').toEqual([])
})

/** 그 창 동안 늘어난 값. 계수는 누적이라 차분만이 뜻을 갖는다. */
const grew = (a: TrackStat, b: TrackStat, k: keyof TrackStat): number =>
  ((b[k] as number | null) ?? 0) - ((a[k] as number | null) ?? 0)

/**
 * ★ONEPC-04 — 끊김의 **폭**을 잰다.
 *
 * ONEPC-01·02 는 패킷 계수가 멎는지를 250ms 창으로 훑는다. 그 눈금은 창보다 짧은 끊김을
 * 못 본다 — opus 20ms ptime 이면 250ms 에 12.5 패킷이라 ★40ms 가 비어도 계수는 늘어난다.
 * 오디오 은닉은 48kHz 샘플 단위라 480 샘플이 곧 10ms 다. 두 축은 서로를 대신하지 못한다:
 * 계수는 "온다" 를, 은닉은 "들린다" 를 말한다.
 *
 * ★이 눈금이 살아 있다는 증거 — 발행자 장치를 죽이면 2초 창에서 은닉이 1,900ms 로 오른다
 * (`resync.spec.ts` 의 `killSource` 와 같은 손잡이). 평시 바닥은 0~6ms 다.
 */
test('ONEPC-04 재협상 창에 들리는 끊김이 없다 — 폭으로 잰다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM4 = S.room('width')
  const ROOM4B = S.room('width2')
  await ensureRoom(ROOM4)
  await ensureRoom(ROOM4B)
  const a = await S.open(ctx, { userId: S.user('U07'), pcMode: '1pc' })
  const b = await S.open(ctx, { userId: S.user('U08'), pcMode: '1pc' })
  await a.call('join', ROOM4, 'talk')
  await b.call('join', ROOM4, 'talk')
  await b.call('enableMic')
  await flowing(a)

  const at = async (): Promise<TrackStat> =>
    (await a.call<TrackStat[]>('trackStats')).find(peerAudio)!

  /** 같은 길이의 창을 열고 그 안에서 사건을 친다. 사건이 없으면 그것이 기준선이다. */
  const window_ = async (during: () => Promise<unknown>): Promise<TrackStat[]> => {
    const before = await at()
    const fired = during()
    await a.page.waitForTimeout(2_000)
    await fired
    return [before, await at()]
  }

  const [q0, q1] = await window_(async () => undefined)
  const floor = grew(q0!, q1!, 'concealed')

  // ★화면공유는 연§9-10-3 2② 가 미리 세운 **둘째 video 자리**를 되쓴다 — m-line 이 늘지 않는다.
  // 늘면 규칙 2(무중단 불변)가 그 창에서 깨지고, 여기 은닉 폭으로 그것이 보인다.
  for (const [what, fire] of [
    ['보내기 증설', () => a.call('enableCamera')],
    ['화면공유 증설', () => a.call('enableScreen')],
    ['받기 증설', () => a.call('join', ROOM4B, 'listen')],
  ] as const) {
    const [s0, s1] = await window_(fire)
    const silent = grew(s0!, s1!, 'silentConcealed')
    const hidden = grew(s0!, s1!, 'concealed')
    expect(silent, `★${what} 창에서 무음으로 메운 자리 — 사람이 듣는 끊김이다(${msOf(silent)}ms)`).toBe(0)
    expect(hidden, `${what} 창 은닉 ${msOf(hidden)}ms · 기준선 ${msOf(floor)}ms — 10ms 를 넘으면 재협상이 소리를 끊은 것이다`)
      .toBeLessThanOrEqual(480)
  }

  // ★연§9-10-3 2② — 카메라와 화면공유가 **미리 세운 자리**를 되썼는지. 늘었으면 위 은닉 폭이
  // 우연히 작았을 뿐이고, 규칙 2 는 다음 형상에서 깨진다.
  const seats = await a.call<{ mid: string; kind: string; direction: string }[]>('mlines')
  const sending = seats.filter((t) => t.direction === 'sendonly' || t.direction === 'sendrecv')
  expect(sending.map((t) => t.kind).sort(), '보내는 것은 카메라 + 화면공유 둘이다').toEqual(['video', 'video'])
  expect(seats.filter((t) => t.kind === 'video' && Number.parseInt(t.mid, 10) < 32).length,
    '★보내기 video 자리는 2단계가 세운 둘 그대로다 — 늘면 무중단 불변이 다음 형상에서 깨진다').toBe(2)
})
