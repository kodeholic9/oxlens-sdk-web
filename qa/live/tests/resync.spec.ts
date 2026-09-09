// author: kodeholic (powered by Claude)
// 정§14-3 · 연§5-5 ② — 서버가 전달 정체를 감지해 알리고, SDK 가 그 방을 통짜로 다시 받는다.
// ★이 왕복은 서버·DC·HTTP 세 축을 한 번에 지난다 — 어느 한 층만으로는 못 태운다.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'

const S = new Scope('resync')

test.afterEach(async () => { await S.teardown() })

interface Ev { kind: string; detail: unknown }

test('RESYNC-01 흐르고 있으면 알리지 않는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM = S.room()
  await ensureRoom(ROOM)

  const talker = await S.open(ctx, { userId: S.user('U01') })
  await talker.call('join', ROOM, 'talk')
  const listener = await S.open(ctx, { userId: S.user('U02') })
  await listener.call('join', ROOM, 'listen')

  // 정상 발행을 두고 정체 창(5초)이 여러 번 지나기를 기다린다.
  await talker.call('enableMic')

  await expect.poll(
    () => listener.call<Ev[]>('events', 'resync').then((e) => e.length),
    { message: '정체가 없으면 알리지 않는다 — 이 칸이 없으면 늘 도는 것과 구별이 안 된다', timeout: 12_000 },
  ).toBe(0)
})

test('RESYNC-02 흐름이 멎으면 서버가 알리고 SDK 가 다시 받는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM = S.room('stall')
  await ensureRoom(ROOM)

  const listener = await S.open(ctx, { userId: S.user('U03') })
  await listener.call('join', ROOM, 'listen')

  const talker = await S.open(ctx, { userId: S.user('U04') })
  await talker.call('join', ROOM, 'talk')
  await talker.call('enableMic')

  // ★장치만 죽인다 — 등록·배관은 살아 있고 RTP 만 멎는다.
  // 깨끗한 퇴장은 정체가 아니다(배관이 같이 걷힌다). 서버가 보는 것은 이 형상이다.
  // ★이 자극은 브라우저를 탄다 — Chromium 은 `stop()` 에 RTP 가 즉시 멎지만
  //   Firefox 는 무음 RTP 를 계속 보낸다(실측 +321 패킷/6초). Firefox 에서 이 시험이
  //   빨간 것은 정체 감지가 아니라 ★자극이 안 먹은 것이다 — 서버는 옳게 동작한다.
  expect(await talker.call<number>('killSource')).toBeGreaterThan(0)

  await expect.poll(
    () => listener.call<Ev[]>('events', 'resync').then((e) => e.length),
    { message: '★서버가 알리고 SDK 가 다시 받는 왕복 — 서버·DC·HTTP 세 축을 한 번에 지난다', timeout: 25_000 },
  ).toBeGreaterThan(0)
})
