import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MediaRegistry } from '../src/domain/media-registry.js'
import { FakeClock, FakeDevices } from './_fakes.js'
import { SendParameters } from '../src/platform/webrtc.js'

interface Sender {
  params: SendParameters
  applied: SendParameters[]
}

function stand(encodings: NonNullable<SendParameters['encodings']>): {
  r: MediaRegistry
  track: { transceiver: unknown }
  sender: Sender
} {
  const devices = new FakeDevices()
  const r = new MediaRegistry(() => ({}) as never, { devices, clock: new FakeClock() })
  const sender: Sender = { params: { encodings }, applied: [] }
  const track = {
    transceiver: {
      sender: {
        replaceTrack: async () => {},
        getParameters: (): SendParameters => sender.params,
        setParameters: async (p: SendParameters) => { sender.applied.push(p) },
      },
    },
  }
  return { r, track: track as never, sender }
}

test('maxBitrate 는 모든 단에 걸린다', async () => {
  const { r, track, sender } = stand([{ rid: 'l' }, { rid: 'h' }])
  await r.setEncoding(track as never, { maxBitrate: 300_000 })
  assert.deepEqual(sender.applied[0]!.encodings!.map((e) => e.maxBitrate), [300_000, 300_000])
})

test('layers 는 낮은 단부터 순서대로 얹힌다', async () => {
  const { r, track, sender } = stand([{ rid: 'l' }, { rid: 'h' }])
  await r.setEncoding(track as never, {
    layers: [{ maxBitrate: 100 }, { maxBitrate: 900, active: false }],
  })
  const got = sender.applied[0]!.encodings!
  assert.equal(got[0]!.maxBitrate, 100)
  assert.equal(got[1]!.maxBitrate, 900)
  assert.equal(got[1]!.active, false)
})

test('단이 하나뿐이면 있는 단에만 얹는다 — 구조는 못 바꾼다', async () => {
  const { r, track, sender } = stand([{ rid: 'l' }])
  await r.setEncoding(track as never, { layers: [{ maxBitrate: 100 }, { maxBitrate: 900 }] })
  const got = sender.applied[0]!.encodings!
  assert.equal(got.length, 1, '단을 늘리려면 stop → 재발행이다')
  assert.equal(got[0]!.maxBitrate, 100)
})

test('발행 전이면 조용히 넘긴다 — 얹을 자리가 없다', async () => {
  const { r } = stand([])
  await r.setEncoding({ transceiver: null } as never, { maxBitrate: 1 })
})

test('encodings 가 비어 있으면 setParameters 를 부르지 않는다', async () => {
  const { r, track, sender } = stand([])
  await r.setEncoding(track as never, { maxBitrate: 1 })
  assert.equal(sender.applied.length, 0)
})

test('degradationPreference 는 파라미터 쪽에 얹힌다', async () => {
  const { r, track, sender } = stand([{ rid: 'h' }])
  await r.setEncoding(track as never, { degradationPreference: 'maintain-framerate' })
  assert.equal(sender.applied[0]!.degradationPreference, 'maintain-framerate')
})

test('setParameters 가 없는 플랫폼이면 조용히 넘긴다', async () => {
  const devices = new FakeDevices()
  const r = new MediaRegistry(() => ({}) as never, { devices, clock: new FakeClock() })
  const track = { transceiver: { sender: { replaceTrack: async () => {} } } }
  await r.setEncoding(track as never, { maxBitrate: 1 })
})
