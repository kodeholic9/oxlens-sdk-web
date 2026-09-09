import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grade, StatsMeter, worst } from '../src/domain/quality.js'

test('4단 문턱은 정책서 값이다 — 손실 2%/5% · RTT 150/400ms', () => {
  assert.equal(grade({ lossPct: 1.9, rttMs: 149 }, false), 'excellent')
  assert.equal(grade({ lossPct: 2.0, rttMs: 10 }, false), 'good')
  assert.equal(grade({ lossPct: 0, rttMs: 150 }, false), 'good')
  assert.equal(grade({ lossPct: 4.9, rttMs: 399 }, false), 'good')
  assert.equal(grade({ lossPct: 5, rttMs: 10 }, false), 'poor')
  assert.equal(grade({ lossPct: 0, rttMs: 400 }, false), 'poor')
  assert.equal(grade(null, false), 'good', '아직 잰 것이 없으면 good')
  assert.equal(grade({ lossPct: 0, rttMs: 0 }, true), 'lost', '죽음 판정이 이긴다')
})

test('여러 서버면 최악값이다', () => {
  assert.equal(worst(['excellent', 'poor', 'good']), 'poor')
  assert.equal(worst(['excellent']), 'excellent', '서버 하나면 그 값이다')
  assert.equal(worst(['good', 'lost']), 'lost')
  assert.equal(worst([]), 'good')
})

function report(received: number, lost: number, rtt: number): Map<string, Record<string, unknown>> {
  return new Map([
    ['cp', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rtt }],
    ['in', { type: 'inbound-rtp', packetsReceived: received, packetsLost: lost }],
  ])
}

test('손실은 두 스냅샷의 차분이고 RTT 는 선택된 후보쌍 값이다', () => {
  const m = new StatsMeter()
  assert.deepEqual(m.sample([report(1000, 0, 0.1)]), { lossPct: 0, rttMs: 100 })
  const second = m.sample([report(1100, 10, 0.1)])
  assert.ok(second !== null && Math.abs(second.lossPct - 100 * 10 / 110) < 1e-9, '누적이 아니라 구간 손실이다')
  assert.equal(new StatsMeter().sample([new Map()]), null, '계수가 없으면 판정할 것이 없다')
})

test('보내는 쪽 손실은 remote-inbound-rtp 의 fractionLost 로 본다', () => {
  const r = new StatsMeter().sample([new Map([['ri', { type: 'remote-inbound-rtp', fractionLost: 0.03, roundTripTime: 0.2 }]])])
  assert.ok(r !== null && Math.abs(r.lossPct - 3) < 1e-9 && r.rttMs === 200)
})

test('후보쌍이 succeeded 가 아니면 RTT 로 안 센다', () => {
  const r = new StatsMeter().sample([new Map([
    ['cp', { type: 'candidate-pair', state: 'in-progress', currentRoundTripTime: 9 }],
    ['in', { type: 'inbound-rtp', packetsReceived: 10, packetsLost: 0 }],
  ])])
  assert.deepEqual(r, { lossPct: 0, rttMs: 0 })
})
