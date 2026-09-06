import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collect, ProbeSources } from '../src/internal/probe.js'
import { DiagnosticsHandle } from '../src/api/diagnostics.js'
import { LogRecord } from '../src/api/types.js'

const bare: ProbeSources = {
  publishing: () => [],
  subscribed: () => [],
  state: () => ({ session: { state: 'active' } }),
}

test('state 는 항상 있다', async () => {
  const p = await collect(bare)
  assert.deepEqual(p.state, { session: { state: 'active' } })
})

test('못 모은 칸은 null 이 아니라 아예 없다 — 연§6-6', async () => {
  const p = await collect(bare)
  assert.equal('pub_tracks' in p, false)
  assert.equal('sub_tracks' in p, false)
  assert.equal('env' in p, false)
  assert.equal('devices' in p, false)
  assert.equal('permissions' in p, false)
  assert.equal('network' in p, false)
  assert.equal('error' in p, false)
})

test('빈 배열도 싣지 않는다 — 있다는 말과 없다는 말이 다르다', async () => {
  const p = await collect({ ...bare, devices: () => Promise.resolve([]) })
  assert.equal('devices' in p, false)
})

test('발행 트랙은 정체와 상태를 낸다 — 계수는 전송로가 있을 때만', async () => {
  const p = await collect({
    ...bare,
    publishing: () => [{
      id: 'lt1', kind: 'audio', source: 'microphone', state: 'sending', owner: 'sdk',
      duplex: 'half', muted: false, media: {}, transceiver: null, ownMedia: null,
      trackId: 'tr-1', server: 'sfu-1', room: 'r1', ssrc: 7, link: null,
    }] as never,
  })
  assert.equal(p.pub_tracks!.length, 1)
  const row = p.pub_tracks![0]!
  assert.equal(row.track_id, 'tr-1')
  assert.equal(row.ssrc, 7)
  assert.equal(row.room_id, 'r1')
  assert.equal('stats' in row, false, '전송로가 없으면 계수 칸 자체가 없다')
})

test('수신 트랙은 보관본 그대로 낸다 — 모르는 필드는 빼고', async () => {
  const p = await collect({
    ...bare,
    subscribed: () => [{
      entry: { track_id: 'ptt-r1-audio', kind: 'audio', room_id: 'r1', ssrc: 9, mid: '0' },
      link: null,
    }] as never,
  })
  const row = p.sub_tracks![0]!
  assert.equal(row.track_id, 'ptt-r1-audio')
  assert.equal('user_id' in row, false, '무전 슬롯은 user_id 가 없다 — 지어내지 않는다')
  assert.equal('codec' in row, false)
})

test('수집이 던지면 error 만 남고 state 는 그대로다', async () => {
  const p = await collect({
    ...bare,
    devices: () => Promise.reject(new Error('장치를 못 물어봤다')),
  })
  assert.equal(p.error, '장치를 못 물어봤다')
  assert.deepEqual(p.state, { session: { state: 'active' } })
})

test('로그는 문턱 아래를 안 낸다', () => {
  const d = new DiagnosticsHandle(bare)
  const seen: LogRecord[] = []
  d.on('log', (r) => seen.push(r))
  d.setLogLevel('warn')
  d.log('info', 'signaling', '조용히')
  d.log('warn', 'signaling', '이건 난다')
  assert.deepEqual(seen.map((r) => r.level), ['warn'])
})

test('silent 는 전부 막는다', () => {
  const d = new DiagnosticsHandle(bare)
  let n = 0
  d.on('log', () => { n += 1 })
  d.setLogLevel('silent')
  d.log('error', 'x', 'y')
  assert.equal(n, 0)
})

test('ctx 는 없으면 필드 자체가 없다', () => {
  const d = new DiagnosticsHandle(bare)
  const seen: LogRecord[] = []
  d.on('log', (r) => seen.push(r))
  d.log('error', 'm', 'msg')
  assert.equal('ctx' in seen[0]!, false)
})
