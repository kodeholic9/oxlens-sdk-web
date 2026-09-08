// author: kodeholic (powered by Claude)
// ★연§9-10 규칙 2(무중단 불변)의 관측형 — 시험 항목서 `C-sym-9-10-1`.
// `1pc` 은 SDP 가 한 벌이라 어느 사건이든 전체를 다시 낸다. 그래서 ★이번 사건과 무관한
// 트랙이 그 창에서 멎는지를 본다. 두 스냅샷 차분으로는 창 안의 끊김을 못 보므로 촘촘히 훑는다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { stalls, TrackStat, watch } from '../fixtures/delta.js'

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
