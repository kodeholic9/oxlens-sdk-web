// author: kodeholic (powered by Claude)
// floor 원천 · TS 24.380 §6.2.4 — 클라 전이. 상태기가 값을 돌려주므로 시계만 돌려 전량을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Message, Tlv, Type, byte, short, str } from '../src/internal/mbcp.js'
import { C100, C101, C104, FloorRoom, Outcome, T100_MS, T101_MS, T104_MS, T132_MS } from '../src/domain/floor.js'

function room(input: 'hold' | 'toggle' = 'hold'): FloorRoom {
  const r = new FloorRoom('r1', 'me', input)
  r.armed()
  return r
}

const types = (o: Outcome): number[] => o.send.map((m) => m.type)
const names = (o: Outcome): string[] => o.signals.map((s) => s.kind)

const granted = (priority = 0, duration = 30): Message => ({
  type: Type.Granted, ack: true,
  fields: [short(Tlv.Duration, duration), byte(Tlv.Priority, priority), str(Tlv.Room, 'r1')],
})
const deny = (cause: number): Message => ({ type: Type.Deny, ack: true, fields: [byte(Tlv.Cause, cause), str(Tlv.Room, 'r1')] })
const revoke = (cause: number): Message => ({ type: Type.Revoke, ack: false, fields: [byte(Tlv.Cause, cause), str(Tlv.Room, 'r1')] })
const taken = (who: string): Message => ({ type: Type.Taken, ack: false, fields: [short(Tlv.Seq, 1), str(Tlv.Speaker, who), str(Tlv.Room, 'r1')] })
const idle = (): Message => ({ type: Type.Idle, ack: false, fields: [short(Tlv.Seq, 2), str(Tlv.Room, 'r1')] })
const qinfo = (pos: number, prio = 0): Message => ({
  type: Type.QueueInfo, ack: false, fields: [{ id: Tlv.QueueInfo, value: new Uint8Array([pos, prio]) }, str(Tlv.Room, 'r1')],
})

test('6.2.4.3.5 — 누르면 REQUEST(우선순위 · 방)만 나가고 시간 필드는 없다', () => {
  const r = room()
  r.priority = 3
  const o = r.press(0)
  assert.deepEqual(types(o), [Type.Request])
  assert.deepEqual(o.send[0]!.fields.map((f) => f.id), [Tlv.Priority, Tlv.Room])
  assert.equal(r.phase, 'pending_request')
  assert.equal(o.gate, undefined)
})

test('6.2.4.4.2 — 허가에 ACK 하고 has permission · 마이크를 연다', () => {
  const r = room()
  r.press(0)
  const o = r.receive(granted(2, 25), 10)
  assert.deepEqual(types(o), [Type.Ack])
  assert.equal(r.phase, 'has_permission')
  assert.equal(o.gate, true)
  assert.equal(r.remainingSec, 25)
  assert.equal(r.grantedPriority, 2)
})

test('6.2.4.4.4 — 거절에 ACK 하고 사유를 남긴다', () => {
  const r = room()
  r.press(0)
  const o = r.receive(deny(7), 10)
  assert.deepEqual(types(o), [Type.Ack])
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastDeny?.cause, 7)
  assert.ok(names(o).includes('denied'))
})

test('6.2.4.4.5·.6 — T101 은 C101 회까지 보내고 소진하면 has no permission', () => {
  const r = room()
  r.press(0)
  let sent = 1
  let now = 0
  while (r.phase === 'pending_request') {
    now += T101_MS
    sent += types(r.tick(now)).filter((t) => t === Type.Request).length
  }
  assert.equal(sent, C101)
  assert.equal(r.lastEnd, 'no_response')
})

test('6.2.4.4.8 — 허가 전에 떼면 RELEASE 와 pending Release', () => {
  const r = room()
  r.press(0)
  const o = r.release(5)
  assert.deepEqual(types(o), [Type.Release])
  assert.equal(r.phase, 'pending_release')
})

test('6.2.4.4.11 · DEV-PREQ-TAKEN-STAY — pending Request 에서 남의 TAKEN 을 받아도 남는다', () => {
  const r = room()
  r.press(0)
  const o = r.receive(taken('u2'), 5)
  assert.equal(r.phase, 'pending_request')
  assert.equal(r.speaker, 'u2')
  assert.deepEqual(types(o), [])
})

test('6.2.4.4.9 · 6.2.4.9.4 — 대기 뒤 승계 허가, hold 는 곧바로 has permission', () => {
  const r = room('hold')
  r.press(0)
  r.receive(qinfo(1, 0), 5)
  assert.equal(r.phase, 'queued')
  assert.deepEqual(r.queue, { position: 1, priority: 0 })
  const o = r.receive(granted(), 50)
  assert.deepEqual(types(o), [Type.Ack])
  assert.equal(r.phase, 'has_permission')
  assert.equal(o.gate, true)
})

test('6.2.4.9.12·.13 — toggle 은 T132 안에 다시 눌러야 열고, 지나면 RELEASE 하고 못 쓴다', () => {
  const r = room('toggle')
  r.press(0)
  r.receive(qinfo(1), 5)
  r.receive(granted(), 50)
  assert.equal(r.acceptPending, true)
  const lapse = r.tick(50 + T132_MS)
  assert.deepEqual(types(lapse), [Type.Release])
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 't132_expired')

  const s = room('toggle')
  s.press(0)
  s.receive(qinfo(1), 5)
  s.receive(granted(), 50)
  const yes = s.press(100)
  assert.equal(s.phase, 'has_permission')
  assert.equal(yes.gate, true)
})

test('6.2.4.9.6 — 대기 철회도 pending Release 로 가고 서버의 TAKEN 이 확인이다', () => {
  const r = room()
  r.press(0)
  r.receive(qinfo(1), 5)
  const o = r.release(10)
  assert.deepEqual(types(o), [Type.Release])
  assert.equal(r.phase, 'pending_release')
  r.receive(taken('u2'), 20)
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 'released')
})

test('6.2.4.9.8 — queued 에서 IDLE 이면 대기가 끝났다', () => {
  const r = room()
  r.press(0)
  r.receive(qinfo(1), 5)
  r.receive(idle(), 10)
  assert.equal(r.phase, 'no_permission')
})

test('6.2.4.9.9~.11 — 순번은 앱이 물을 때만, T104 소진이면 RELEASE 하고 pending Release', () => {
  const r = room()
  r.press(0)
  r.receive(qinfo(2), 5)
  assert.deepEqual(types(r.tick(100_000)), [], '주기 폴링 시계가 없다')
  assert.deepEqual(types(r.queuePosition(10)), [Type.QueuePosRequest])
  let sent = 1
  let now = 10
  while (r.phase === 'queued') {
    now += T104_MS
    const o = r.tick(now)
    sent += types(o).filter((t) => t === Type.QueuePosRequest).length
  }
  assert.equal(sent, C104)
  assert.equal(r.phase, 'pending_release')

  const q = room()
  q.press(0)
  q.receive(qinfo(2), 5)
  q.queuePosition(10)
  q.receive(qinfo(1, 4), 20)
  assert.deepEqual(q.queue, { position: 1, priority: 4 })
  assert.deepEqual(types(q.tick(20 + T104_MS)), [])
})

test('6.2.4.5.4 — 회수에 ACK 없이 마이크를 끄고 RELEASE · pending Release', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 5)
  const o = r.receive(revoke(4), 10)
  assert.deepEqual(types(o), [Type.Release])
  assert.equal(o.gate, false)
  assert.equal(r.phase, 'pending_release')
  assert.equal(r.lastRevoke?.cause, 4)
  r.receive(taken('u2'), 20)
  assert.equal(r.lastEnd, 'revoked')
})

test('6.2.4.5.7·.8 · 6.2.4.1 — has permission 에서 IDLE·TAKEN·DENY 는 버린다(ACK 도 없다)', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 5)
  for (const m of [idle(), taken('u2'), deny(3)]) {
    const o = r.receive(m, 10)
    assert.deepEqual(types(o), [])
    assert.equal(r.phase, 'has_permission')
  }
})

test('6.2.4.6.8 — pending Release 의 GRANTED 는 ACK 하고 남는다', () => {
  const r = room()
  r.press(0)
  r.release(5)
  const o = r.receive(granted(), 10)
  assert.deepEqual(types(o), [Type.Ack])
  assert.equal(r.phase, 'pending_release')
})

test('6.2.4.6.2·.3 — 확인이 없으면 T100 으로 C100 회까지 RELEASE 하고 포기한다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 5)
  r.release(10)
  let sent = 1
  let now = 10
  while (r.phase === 'pending_release') {
    now += T100_MS
    sent += types(r.tick(now)).filter((t) => t === Type.Release).length
  }
  assert.equal(sent, C100)
})

test('6.2.4.3 · 6.2.4.1 — has no permission 에서 늦은 GRANTED·QUEUE_INFO 는 버린다', () => {
  const r = room()
  assert.deepEqual(types(r.receive(granted(), 0)), [])
  assert.deepEqual(types(r.receive(qinfo(1), 0)), [])
  assert.equal(r.phase, 'no_permission')
})

test('누름 절이 없는 상태에서는 누름을 버린다', () => {
  const r = room()
  r.press(0)
  assert.deepEqual(types(r.press(1)), [])
  r.receive(granted(), 5)
  assert.deepEqual(types(r.press(6)), [])
  r.release(7)
  assert.deepEqual(types(r.press(8)), [])
})

test('다른 방 것은 이 상태기에 닿지 않는다(0x1D)', () => {
  const r = room()
  r.press(0)
  const other: Message = { type: Type.Granted, ack: true, fields: [str(Tlv.Room, 'r2')] }
  assert.deepEqual(types(r.receive(other, 5)), [])
  assert.equal(r.phase, 'pending_request')
})

test('DEV-DC-DOWN — DC 만 끊기면 상태는 그대로, 믿을 수 없다고만 알린다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 5)
  const o = r.setTrusted(false)
  assert.equal(r.phase, 'has_permission')
  assert.equal(r.trusted, false)
  assert.equal(o.gate, undefined)
})

test('DEV-PUB-AWAY — 발행 방을 떠나면 has no permission · 마이크를 닫는다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 5)
  const o = r.reset('moved')
  assert.equal(r.phase, 'no_permission')
  assert.equal(o.gate, false)
  assert.equal(r.lastEnd, 'moved')
})
