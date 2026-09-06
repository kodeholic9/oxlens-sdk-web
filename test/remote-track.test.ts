import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteTrackHandle } from '../src/api/remote-track.js'
import { LayerTarget, RoomHost } from '../src/api/room.js'
import { TrackEntry } from '../src/domain/store.js'

interface Sent { roomId: string; targets: readonly LayerTarget[] }

function hostOf(sent: Sent[]): RoomHost {
  return {
    leave: async () => {},
    sendMessage: async () => ({ msgId: 'm' }),
    subscribeLayer: async (roomId, targets) => { sent.push({ roomId, targets }) },
  }
}

function entryOf(over: Record<string, unknown> = {}): TrackEntry {
  return {
    room_id: 'r1', track_id: 't-u2-cam', kind: 'video', user_id: 'u2',
    ssrc: 1, mid: '0', scalability: 'L2T3', ...over,
  } as unknown as TrackEntry
}

function stand(over: Record<string, unknown> = {}): { track: RemoteTrackHandle; sent: Sent[] } {
  const sent: Sent[] = []
  const link = { receiverOf: () => null } as never
  return { track: new RemoteTrackHandle(entryOf(over), {} as MediaStreamTrack, link, hostOf(sent)), sent }
}

test('setLayer 는 생략한 필드를 안 싣는다 — 연§6-3 부분 갱신', async () => {
  const { track, sent } = stand()
  await track.setLayer({ spatial: 1 })
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].targets[0], { track_id: 't-u2-cam', spatial: 1 })
})

test('setLayer 의 paused 는 레이어 값이 아니라 별개 축이라 spatial 0 과 함께 실린다', async () => {
  const { track, sent } = stand()
  await track.setLayer({ paused: false, spatial: 0 })
  assert.deepEqual(sent[0].targets[0], { track_id: 't-u2-cam', spatial: 0, paused: false })
})

test('setLayer 는 scalability 밖의 값을 보내지 않는다 — 찍어 보내는 클라가 되지 않는다', async () => {
  const { track, sent } = stand()
  await track.setLayer({ spatial: 9, temporal: 9 })
  assert.deepEqual(sent[0].targets[0], { track_id: 't-u2-cam', spatial: 1, temporal: 2 })
})

test('scalability 가 없으면 단이 하나다 — 상한 0', async () => {
  const { track, sent } = stand({ scalability: undefined })
  await track.setLayer({ spatial: 3 })
  assert.deepEqual(sent[0].targets[0], { track_id: 't-u2-cam', spatial: 0 })
})

test('priority 는 1~255 로 자른다', async () => {
  const { track, sent } = stand()
  await track.setLayer({ priority: 0 })
  assert.equal(sent[0].targets[0].priority, 1)
  await track.setLayer({ priority: 999 })
  assert.equal(sent[1].targets[0].priority, 255)
})

test('대상은 track_id 다 — user_id 를 싣지 않는다', async () => {
  const { track, sent } = stand()
  await track.setLayer({ spatial: 0 })
  assert.equal(sent[0].targets[0].track_id, 't-u2-cam')
  assert.equal((sent[0].targets[0] as unknown as Record<string, unknown>).user_id, undefined)
})

test('setReceive 는 표준 손잡이가 있으면 ms 그대로 쓰고 서버로 보내지 않는다', async () => {
  const sent: Sent[] = []
  const receiver: { jitterBufferTarget?: number | null } = { jitterBufferTarget: null }
  const link = { receiverOf: () => receiver } as never
  const entry = entryOf({ kind: 'audio', track_id: 't', scalability: undefined })
  const track = new RemoteTrackHandle(entry, {} as MediaStreamTrack, link, hostOf(sent))
  await track.setReceive({ playoutDelayMs: 120 })
  assert.equal(receiver.jitterBufferTarget, 120)
  assert.equal(sent.length, 0)
})

test('표준이 없으면 비표준 손잡이를 초 단위로 쓴다', async () => {
  const hint: { playoutDelayHint?: number | null } = { playoutDelayHint: null }
  const link = { receiverOf: () => hint } as never
  const entry = entryOf({ kind: 'audio', track_id: 't', scalability: undefined })
  const track = new RemoteTrackHandle(entry, {} as MediaStreamTrack, link, hostOf([]))
  await track.setReceive({ playoutDelayMs: 200 })
  assert.equal(hint.playoutDelayHint, 0.2)
})

test('둘 다 없는 브라우저에서는 무시한다 — 앱 실패로 만들지 않는다', async () => {
  const link = { receiverOf: () => ({}) } as never
  const entry = entryOf({ kind: 'audio', track_id: 't', scalability: undefined })
  const track = new RemoteTrackHandle(entry, {} as MediaStreamTrack, link, hostOf([]))
  await track.setReceive({ playoutDelayMs: 200 })
})
