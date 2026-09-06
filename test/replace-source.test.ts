import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MediaRegistry } from '../src/domain/media-registry.js'
import { FakeClock, FakeDevices } from './_fakes.js'
import { MediaTrackLike } from '../src/platform/webrtc.js'

function fakeTrack(id: string): MediaTrackLike {
  const t = { id, kind: 'audio', enabled: true, stopped: false, stop(): void { t.stopped = true } }
  return t as unknown as MediaTrackLike
}

function reg(): { r: MediaRegistry; devices: FakeDevices } {
  const devices = new FakeDevices()
  return { r: new MediaRegistry(() => ({}) as never, { devices, clock: new FakeClock() }), devices }
}

async function acquired(): Promise<{ r: MediaRegistry; track: Awaited<ReturnType<MediaRegistry['acquire']>>[number]; devices: FakeDevices }> {
  const { r, devices } = reg()
  const [track] = await r.acquire([{ kind: 'microphone' }])
  track!.owner = 'sdk'
  return { r, track: track!, devices }
}

const gone = (t: MediaTrackLike): boolean => (t as unknown as { stopped?: boolean }).stopped === true

test('외부 트랙을 넣으면 owner 가 external 이 되고 자기 장치 트랙은 살려 둔다', async () => {
  const { r, track, devices } = await acquired()
  const own = track.media
  const outside = fakeTrack('ext')
  await r.replaceSource(track, outside)
  assert.equal(track.owner, 'external')
  assert.equal(track.media, outside)
  assert.ok(!devices.stopped.includes(own.id), '살려 두지 않으면 복귀에 프롬프트가 또 뜬다')
})

test('null 이면 살려 둔 자기 트랙으로 돌아오고 owner 가 sdk 다', async () => {
  const { r, track } = await acquired()
  const own = track.media
  await r.replaceSource(track, fakeTrack('ext'))
  const outside = track.media
  await r.replaceSource(track, null)
  assert.equal(track.owner, 'sdk')
  assert.equal(track.media, own)
  assert.ok(gone(outside), '외부 트랙은 놓는다')
})

test('외부에서 외부로 바꾸면 옛 외부 트랙을 놓고 자기 트랙은 그대로 살아 있다', async () => {
  const { r, track, devices } = await acquired()
  const own = track.media
  await r.replaceSource(track, fakeTrack('ext1'))
  const first = track.media
  await r.replaceSource(track, fakeTrack('ext2'))
  assert.ok(gone(first))
  assert.ok(!devices.stopped.includes(own.id))
  assert.equal(track.owner, 'external')
})

test('같은 트랙을 다시 넣으면 아무 일도 안 한다', async () => {
  const { r, track } = await acquired()
  const outside = fakeTrack('ext')
  await r.replaceSource(track, outside)
  await r.replaceSource(track, outside)
  assert.equal(track.media, outside)
  assert.equal(track.owner, 'external')
})

test('외부 소스가 없는데 null 을 넣으면 아무 일도 안 한다', async () => {
  const { r, track } = await acquired()
  const own = track.media
  await r.replaceSource(track, null)
  assert.equal(track.media, own)
  assert.equal(track.owner, 'sdk')
})

test('muted 였으면 새 소스도 muted 로 얹힌다', async () => {
  const { r, track } = await acquired()
  track.muted = true
  const outside = fakeTrack('ext')
  await r.replaceSource(track, outside)
  assert.equal((outside as unknown as { enabled: boolean }).enabled, false)
})

test('stop 은 살려 둔 자기 트랙도 놓는다 — 안 놓으면 마이크가 켜진 채 남는다', async () => {
  const { r, track, devices } = await acquired()
  const own = track.media
  await r.replaceSource(track, fakeTrack('ext'))
  await r.stop(track)
  assert.ok(devices.stopped.includes(own.id))
})

test('switchDevice 는 owner sdk 만 바꾼다 — 앱·외부 것은 대상이 아니다', async () => {
  const { r, devices } = reg()
  const [mine] = await r.acquire([{ kind: 'microphone' }])
  const [theirs] = await r.acquire([{ kind: 'microphone' }])
  mine!.owner = 'sdk'
  theirs!.owner = 'app'
  const before = { mine: mine!.media, theirs: theirs!.media }
  devices.taken.length = 0
  await r.switchDevice('microphone', 'mic-b')
  assert.notEqual(mine!.media, before.mine)
  assert.equal(theirs!.media, before.theirs, 'SDK 가 남의 장치 수명을 만지지 않는다')
  assert.ok(devices.stopped.includes(before.mine.id))
})

test('switchDevice 는 kind 가 다른 트랙을 건드리지 않는다', async () => {
  const { r } = reg()
  const [cam] = await r.acquire([{ kind: 'camera' }])
  cam!.owner = 'sdk'
  const before = cam!.media
  await r.switchDevice('microphone', 'mic-b')
  assert.equal(cam!.media, before)
})
