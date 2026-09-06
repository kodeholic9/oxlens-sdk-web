import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'

interface AudioOut {
  count: number
  playing: number
  muted: number
  volumes: number[]
  allowed: boolean | null
}

const S = new Scope('audio_out')

async function audioTracks(page: { call<T>(fn: string, ...a: unknown[]): Promise<T> }): Promise<number> {
  const rooms = await page.call<Array<{ tracks: Array<{ kind: string }> }>>('rooms')
  return rooms.reduce((n, r) => n + r.tracks.filter((t) => t.kind === 'audio').length, 0)
}

test.afterEach(async () => { await S.teardown() })

test('AUDIO-OUT-01 수신 오디오는 SDK 가 낸다 — 앱이 붙이지 않아도 소리가 난다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM = S.room()
  await ensureRoom(ROOM)

  const listener = await S.open(ctx, { userId: S.user('U01') })
  await listener.call('join', ROOM, 'talk')

  const talker = await S.open(ctx, { userId: S.user('U02') })
  await talker.call('join', ROOM, 'talk')
  await talker.call('enableMic')

  await expect.poll(
    async () => {
      const want = await audioTracks(listener)
      const got = await listener.call<AudioOut>('audioOut')
      return want > 0 && got.playing === want
    },
    { message: '★패킷이 오는 것과 소리가 나는 것은 다르다 — 재생 요소가 그 계약이다', timeout: 15_000 },
  ).toBe(true)

  const out = await listener.call<AudioOut>('audioOut')
  expect(out.count, '트랙마다 요소 하나').toBe(await audioTracks(listener))
  expect(out.allowed, '막히지 않았으면 허용이다').toBe(true)
})

test('AUDIO-OUT-02 영상만 오는 방에는 오디오 요소를 만들지 않는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM = S.room('videoonly')
  await ensureRoom(ROOM)

  const listener = await S.open(ctx, { userId: S.user('U03') })
  await listener.call('join', ROOM, 'talk')
  const talker = await S.open(ctx, { userId: S.user('U04') })
  await talker.call('join', ROOM, 'talk')
  await talker.call('enableCamera')

  await expect.poll(
    () => listener.call<Array<{ tracks: unknown[] }>>('rooms').then((r) => r[0]?.tracks.length ?? 0),
    { message: '영상 트랙은 붙는다', timeout: 10_000 },
  ).toBeGreaterThan(0)

  const out = await listener.call<AudioOut>('audioOut')
  expect(out.count, '★영상에 오디오 요소를 만들면 그것이 곧 유령이다').toBe(await audioTracks(listener))
})

test('AUDIO-OUT-03 방 볼륨·뮤트가 재생에 실제로 걸린다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM = S.room('mix')
  await ensureRoom(ROOM)

  const listener = await S.open(ctx, { userId: S.user('U05') })
  await listener.call('join', ROOM, 'talk')
  const talker = await S.open(ctx, { userId: S.user('U06') })
  await talker.call('join', ROOM, 'talk')
  await talker.call('enableMic')

  await expect.poll(() => listener.call<AudioOut>('audioOut').then((a) => a.count)).toBeGreaterThan(0)
  const n = (await listener.call<AudioOut>('audioOut')).count

  await listener.call('roomAudio', ROOM, { volume: 0.25 })
  await expect.poll(
    () => listener.call<AudioOut>('audioOut').then((a) => a.volumes.filter((v) => v === 0.25).length),
  ).toBe(n)

  await listener.call('roomAudio', ROOM, { muted: true })
  await expect.poll(
    () => listener.call<AudioOut>('audioOut').then((a) => a.muted),
    { message: '값만 들고 재생에 안 걸면 화면은 음소거인데 소리가 난다' },
  ).toBe(n)
})

test('AUDIO-OUT-04 트랙이 사라지면 요소도 놓는다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const ROOM = S.room('drop')
  await ensureRoom(ROOM)

  const listener = await S.open(ctx, { userId: S.user('U07') })
  await listener.call('join', ROOM, 'talk')
  const talker = await S.open(ctx, { userId: S.user('U08') })
  await talker.call('join', ROOM, 'talk')
  await talker.call('enableMic')
  await expect.poll(() => listener.call<AudioOut>('audioOut').then((a) => a.count)).toBeGreaterThan(1)
  const before = (await listener.call<AudioOut>('audioOut')).count

  await talker.call('leave', ROOM)
  await expect.poll(
    () => listener.call<AudioOut>('audioOut').then((a) => a.count),
    { message: '★요소가 쌓이면 탭이 무거워지고 소리가 겹친다', timeout: 15_000 },
  ).toBeLessThan(before)
})
