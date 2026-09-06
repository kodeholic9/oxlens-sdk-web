import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Playback } from '../src/domain/playback.js'
import { AudioElementLike, AudioOut } from '../src/platform/audio.js'
import { MediaTrackLike } from '../src/platform/webrtc.js'

class FakeEl implements AudioElementLike {
  volume = 1
  muted = false
  srcObject: unknown = null
  released = false
  plays = 0
  sink: string | null = null
  blocked = false
  constructor(readonly id: string) {}
  play(): Promise<void> {
    this.plays += 1
    return this.blocked ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()
  }
  pause(): void {}
  release(): void { this.released = true }
  setSinkId(deviceId: string): Promise<void> { this.sink = deviceId; return Promise.resolve() }
}

class FakeOut implements AudioOut {
  readonly made: FakeEl[] = []
  blocked = false
  private visible: Array<() => void> = []
  create(): AudioElementLike {
    const el = new FakeEl(`el${this.made.length}`)
    el.blocked = this.blocked
    this.made.push(el)
    return el
  }
  onVisible(fn: () => void): () => void {
    this.visible.push(fn)
    return () => { this.visible = this.visible.filter((x) => x !== fn) }
  }
  becomeVisible(): void { for (const fn of [...this.visible]) fn() }
}

const TRACK = {} as MediaTrackLike

function stand(): { out: FakeOut; play: Playback; events: boolean[] } {
  const out = new FakeOut()
  const events: boolean[] = []
  const play = new Playback(out)
  void (async () => { for await (const a of play.changes()) events.push(a) })()
  return { out, play, events }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

test('수신 audio 는 SDK 가 낸다 — 트랙마다 요소를 만들어 재생한다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  assert.equal(out.made.length, 1)
  assert.equal(out.made[0].plays, 1)
  assert.equal(play.playbackAllowed, true)
})

test('같은 트랙을 두 번 넣어도 요소는 하나다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  await play.add('t1', 'r1', TRACK)
  assert.equal(out.made.length, 1)
})

test('remove 는 요소를 놓는다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  play.remove('t1')
  assert.equal(out.made[0].released, true)
})

test('방 볼륨·뮤트가 그 방 트랙에만 걸린다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  await play.add('t2', 'r2', TRACK)
  play.setRoom('r1', { volume: 0.5, muted: true })
  assert.equal(out.made[0].volume, 0.5)
  assert.equal(out.made[0].muted, true)
  assert.equal(out.made[1].volume, 1)
  assert.equal(out.made[1].muted, false)
})

test('트랙 볼륨은 방 볼륨과 곱해진다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  play.setRoom('r1', { volume: 0.5 })
  play.setTrackVolume('t1', 0.5)
  assert.equal(out.made[0].volume, 0.25)
})

test('나중에 들어온 트랙도 그 방 설정을 물려받는다', async () => {
  const { out, play } = stand()
  play.setRoom('r1', { volume: 0.25, muted: true })
  await play.add('t1', 'r1', TRACK)
  assert.equal(out.made[0].volume, 0.25)
  assert.equal(out.made[0].muted, true)
})

test('autoplay 가 막히면 playbackAllowed 가 false 로 떨어지고 이벤트가 한 번 난다', async () => {
  const { out, play, events } = stand()
  out.blocked = true
  await play.add('t1', 'r1', TRACK)
  assert.equal(play.playbackAllowed, false)
  await settle()
  assert.deepEqual(events, [false])
  await play.add('t2', 'r1', TRACK)
  await settle()
  assert.deepEqual(events, [false], '같은 값은 다시 안 낸다')
})

test('제스처 뒤 startAudio 가 풀면 true 이벤트가 난다', async () => {
  const { out, play, events } = stand()
  out.blocked = true
  await play.add('t1', 'r1', TRACK)
  out.made[0].blocked = false
  await play.startAudio()
  assert.equal(play.playbackAllowed, true)
  await settle()
  assert.deepEqual(events, [false, true])
})

test('탭이 다시 보이면 SDK 가 스스로 재시도한다', async () => {
  const { out, play, events } = stand()
  out.blocked = true
  await play.add('t1', 'r1', TRACK)
  out.made[0].blocked = false
  out.becomeVisible()
  await new Promise((r) => setTimeout(r, 0))
  await settle()
  assert.deepEqual(events, [false, true])
})

test('출력 장치는 뒤에 들어온 트랙에도 걸린다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  await play.setSink('spk-a')
  await play.add('t2', 'r1', TRACK)
  assert.equal(out.made[0].sink, 'spk-a')
  assert.equal(out.made[1].sink, 'spk-a')
})

test('setSinkId 가 없는 플랫폼이면 조용히 넘긴다', async () => {
  const out = new FakeOut()
  const play = new Playback({
    create: () => {
      const el = new FakeEl('bare') as AudioElementLike
      delete (el as { setSinkId?: unknown }).setSinkId
      return el
    },
    onVisible: () => () => {},
  })
  await play.add('t1', 'r1', TRACK)
  await play.setSink('spk-a')
  assert.equal(out.made.length, 0)
})

test('close 는 모든 요소를 놓는다', async () => {
  const { out, play } = stand()
  await play.add('t1', 'r1', TRACK)
  await play.add('t2', 'r2', TRACK)
  play.close()
  assert.deepEqual(out.made.map((e) => e.released), [true, true])
})
