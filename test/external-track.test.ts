import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MediaRegistry } from '../src/domain/media-registry.js'
import { FakeClock, FakeDevices } from './_fakes.js'
import { MediaTrackLike } from '../src/platform/webrtc.js'

function appTrack(id: string): MediaTrackLike {
  const t = { id, kind: 'video', enabled: true, stopped: false, stop(): void { t.stopped = true } }
  return t as unknown as MediaTrackLike
}

const gone = (t: MediaTrackLike): boolean => (t as unknown as { stopped?: boolean }).stopped === true

function reg(): { r: MediaRegistry; devices: FakeDevices } {
  const devices = new FakeDevices()
  return { r: new MediaRegistry(() => ({}) as never, { devices, clock: new FakeClock() }), devices }
}

test('adopt 는 owner external 로 올린다 — 장치 수명 관리 대상이 아니다', () => {
  const { r } = reg()
  const track = r.adopt(appTrack('canvas'), 'camera')
  assert.equal(track.owner, 'external')
  assert.equal(track.kind, 'video')
  assert.equal(track.source, 'camera')
  assert.equal(track.state, 'acquired')
})

test('adopt 한 트랙은 switchDevice 가 건드리지 않는다', async () => {
  const { r } = reg()
  const track = r.adopt(appTrack('canvas'), 'camera')
  const before = track.media
  await r.switchDevice('camera', 'cam-b')
  assert.equal(track.media, before, 'SDK 가 남의 소스를 갈아 끼우지 않는다')
})

test('stop 은 외부 트랙을 정지하지 않는다 — 앱 것이다', async () => {
  const { r } = reg()
  const media = appTrack('canvas')
  const track = r.adopt(media, 'camera')
  await r.stop(track)
  assert.equal(gone(media), false)
})

test('adopt 한 트랙도 all 에 보인다 — 전량이라야 앱이 셀 수 있다', () => {
  const { r } = reg()
  r.adopt(appTrack('canvas'), 'camera')
  assert.equal(r.all.length, 1)
})

test('마이크를 앱이 주면 반이중으로도 올릴 수 있다 — kind 는 audio 다', () => {
  const { r } = reg()
  const track = r.adopt(appTrack('mixed'), 'microphone')
  assert.equal(track.kind, 'audio')
  assert.equal(track.owner, 'external')
})
