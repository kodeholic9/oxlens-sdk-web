// author: kodeholic (powered by Claude)
// 연§7-7 · §11-5 · §8-4 — 발언권 전이. 상태기가 값을 돌려주므로 시계만 돌려 전량을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Message, Tlv, Type, byte, short, str, text, u8 } from '../src/internal/mbcp.js'
import {
  C100, C101, FloorRoom, Outcome, T100_MS, T101_MS, T132_MS, T3_MS, T_QUEUEPOS_MS,
} from '../src/domain/floor.js'

const enc = new TextEncoder()

function room(input: 'hold' | 'toggle' = 'hold'): FloorRoom {
  const r = new FloorRoom('r1', 'me', input)
  r.armed()
  return r
}

const types = (o: Outcome): number[] => o.send.map((m) => m.type)
const names = (o: Outcome): string[] => o.signals.map((s) => s.kind)

const granted = (over: Partial<{ duration: number; priority: number }> = {}): Message => ({
  type: Type.Granted, ack: true,
  fields: [
    short(Tlv.Duration, over.duration ?? 30),
    byte(Tlv.Priority, over.priority ?? 3),
    str(Tlv.Room, 'r1'),
  ],
})

const taken = (seq: number, who: string): Message => ({
  type: Type.Taken, ack: false,
  fields: [short(Tlv.Seq, seq), str(Tlv.Speaker, who), str(Tlv.Room, 'r1')],
})

const idle = (seq: number): Message => ({
  type: Type.Idle, ack: false, fields: [short(Tlv.Seq, seq), str(Tlv.Room, 'r1')],
})

test('off 에서도 누를 수 있다 — press 가 등록을 대신한다', () => {
  const r = new FloorRoom('r1', 'me')
  assert.equal(r.phase, 'off', '이 서버에 반이중 마이크가 아직 없다')
  assert.equal(r.canRequest, true, '연§2-6 — canRequest 는 off·no_permission 둘 다다')
  r.armed()
  assert.equal(r.phase, 'no_permission')
  assert.deepEqual(r.armed().signals, [], '두 번 서지 않는다')
})

test('말하는 중에는 새 요청 자리가 아니다', () => {
  const r = room()
  r.press(0)
  assert.equal(r.canRequest, false)
  r.receive(granted(), 100)
  assert.equal(r.canRequest, false, '버튼은 놓기로 바뀐다')
})

test('press 는 방을 실은 REQUEST 를 낸다', () => {
  const r = room()
  r.priority = 7
  r.durationSec = 20
  const out = r.press(0)
  assert.deepEqual(types(out), [Type.Request])
  const msg = out.send[0]!
  assert.equal(u8(msg, Tlv.Priority), 7)
  assert.equal(text(msg, Tlv.Room), 'r1', '서버가 어느 방 floor 를 돌릴지가 이 값으로 정해진다')
  assert.equal(r.phase, 'pending_request')
})

test('A 비트가 선 메시지에는 ACK 이 먼저 나가고 대상 방을 에코한다', () => {
  const r = room()
  r.press(0)
  const out = r.receive(granted(), 100)
  assert.equal(out.send[0]!.type, Type.Ack)
  assert.equal(u8(out.send[0]!, Tlv.AckType), Type.Granted, '무엇에 대한 ACK 인지를 싣는다')
  assert.equal(text(out.send[0]!, Tlv.Room), 'r1')
})

test('A 비트가 없으면 ACK 을 보내지 않는다', () => {
  const r = room()
  assert.deepEqual(types(r.receive(taken(1, 'u2'), 0)), [],
    '100명 방이면 ACK 100개다 — 타이머로 지켜지는 것에는 안 얹는다')
})

test('허가는 마이크를 열고 남은 시간을 준다', () => {
  const r = room()
  r.press(0)
  const out = r.receive(granted({ duration: 30, priority: 3 }), 100)
  assert.equal(out.gate, true)
  assert.ok(names(out).includes('granted'))
  assert.equal(r.phase, 'has_permission')
  assert.equal(r.remainingSec, 30, '표의 기본값이 아니라 실려 온 값이다')
  assert.equal(r.grantedPriority, 3, '허가값은 min(요청, 토큰) 이라 요청값과 다를 수 있다')
  assert.equal(r.talkingSince, 100)
})

test('거절은 사유를 남기고 마이크를 닫는다', () => {
  const r = room()
  r.press(0)
  const out = r.receive({
    type: Type.Deny, ack: true,
    fields: [byte(Tlv.Cause, 7), { id: Tlv.CauseText, value: enc.encode('queue full') }, str(Tlv.Room, 'r1')],
  }, 100)
  assert.equal(out.gate, false)
  assert.deepEqual(r.lastDeny, { cause: 7, text: 'queue full' })
  assert.equal(r.phase, 'no_permission')
})

test('T101 은 세 번까지 다시 보내고 그 뒤엔 포기한다', () => {
  const r = room()
  r.press(0)
  for (let i = 1; i <= C101; i += 1) {
    assert.deepEqual(types(r.tick(T101_MS * i)), [Type.Request], `${i}번째 재전송`)
  }
  const last = r.tick(T101_MS * (C101 + 1))
  assert.deepEqual(types(last), [], '타이머만 있고 횟수가 없으면 영원히 다시 보낸다')
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 'no_response')
})

test('응답이 오면 재전송이 멎는다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  assert.deepEqual(types(r.tick(10_000)), [])
})

test('반환은 IDLE 로 확인된다 — 반환의 결과물이 곧 확인이다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  const out = r.release(200)
  assert.deepEqual(types(out), [Type.Release])
  assert.equal(r.phase, 'pending_release')
  assert.equal(out.gate, false)

  const done = r.receive(idle(5), 300)
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 'released')
  assert.ok(names(done).includes('released'))
  assert.deepEqual(types(r.tick(10_000)), [], 'T100 이 멎는다')
})

test('내가 화자가 아닌 TAKEN 도 반환의 확인이다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.release(200)
  r.receive(taken(5, 'u9'), 300)
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.speaker, 'u9')
})

test('내가 화자인 TAKEN 은 확인이 아니다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.release(200)
  r.receive(taken(5, 'me'), 300)
  assert.equal(r.phase, 'pending_release', '내 것이 아직 안 끝났다')
})

test('C100 을 소진하면 포기하고 has no permission 으로 간다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.release(200)
  for (let i = 1; i <= C100; i += 1) {
    assert.deepEqual(types(r.tick(200 + T100_MS * i)), [Type.Release])
  }
  r.tick(200 + T100_MS * (C100 + 1))
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 'no_response', '확인을 못 받고 포기한 것이지 놓아 준 것이 아니다')
})

test('말하는 중에 남이 화자가 되면 서버가 회수한 것이다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  const out = r.receive(taken(3, 'u9'), 200)
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 't1_reclaimed', 'RTP 를 안 보내 T1 로 회수된 자리다')
  assert.equal(out.gate, false)
})

test('말하는 중에 방이 비면 내 허가도 끝난 것이다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.receive(idle(3), 200)
  assert.equal(r.lastEnd, 't1_reclaimed')
})

test('내 TAKEN 은 내 허가를 흔들지 않는다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.receive(taken(3, 'me'), 200)
  assert.equal(r.phase, 'has_permission')
})

test('되감긴 seq 는 버린다 — 화자 표시가 되감기면 안 된다', () => {
  const r = room()
  r.receive(taken(9, 'u2'), 0)
  assert.equal(r.speaker, 'u2')
  const stale = r.receive(taken(8, 'u3'), 10)
  assert.equal(r.speaker, 'u2', 'DC 가 ordered:false 라 이것이 순서의 유일한 장치다')
  assert.deepEqual(names(stale), [])
})

test('다른 방 메시지는 이 방을 건드리지 않는다', () => {
  const r = room()
  const out = r.receive({
    type: Type.Taken, ack: false,
    fields: [short(Tlv.Seq, 1), str(Tlv.Speaker, 'u9'), str(Tlv.Room, 'other')],
  }, 0)
  assert.deepEqual(names(out), [])
  assert.equal(r.speaker, null, '한 개념 한 필드 — 0x1D 가 방을 가른다')
})

test('큐에 들어가면 위치를 알고 30초마다 다시 묻는다', () => {
  const r = room()
  r.press(0)
  const out = r.receive({
    type: Type.QueueInfo, ack: false,
    fields: [{ id: Tlv.QueueInfo, value: Uint8Array.of(2, 5) }, byte(Tlv.QueueSize, 4), str(Tlv.Room, 'r1')],
  }, 100)
  assert.equal(r.phase, 'queued')
  assert.deepEqual(r.queue, { position: 2, size: 4 })
  assert.ok(names(out).includes('queued'))

  assert.deepEqual(types(r.tick(100 + T_QUEUEPOS_MS - 1)), [])
  assert.deepEqual(types(r.tick(100 + T_QUEUEPOS_MS)), [Type.QueuePosRequest],
    '위치를 폴링하는 유일한 시계다')
})

test('hold 는 큐 승계를 곧바로 받는다 — 눌린 채인 것이 곧 표시다', () => {
  const r = room('hold')
  r.press(0)
  r.receive({ type: Type.QueueInfo, ack: false, fields: [{ id: Tlv.QueueInfo, value: Uint8Array.of(1, 3) }, str(Tlv.Room, 'r1')] }, 100)
  const out = r.receive(granted(), 200)
  assert.equal(r.phase, 'has_permission')
  assert.equal(out.gate, true)
  assert.equal(r.acceptPending, false)
})

test('toggle 은 T132 안의 press 를 수락으로 읽는다', () => {
  const r = room('toggle')
  r.press(0)
  r.receive({ type: Type.QueueInfo, ack: false, fields: [{ id: Tlv.QueueInfo, value: Uint8Array.of(1, 3) }, str(Tlv.Room, 'r1')] }, 100)
  const held = r.receive(granted(), 200)
  assert.equal(r.phase, 'queued', '아직 발언이 아니다')
  assert.equal(r.acceptPending, true)
  assert.equal(held.gate, undefined)

  const accept = r.press(300)
  assert.equal(r.phase, 'has_permission', '새 요청이 아니라 수락이다')
  assert.equal(accept.gate, true)
  assert.deepEqual(types(accept), [], 'REQUEST 를 또 내지 않는다')
})

test('T132 가 끝나면 우리가 RELEASE 를 보내고 못 쓴다고 알린다', () => {
  const r = room('toggle')
  r.press(0)
  r.receive({ type: Type.QueueInfo, ack: false, fields: [{ id: Tlv.QueueInfo, value: Uint8Array.of(1, 3) }, str(Tlv.Room, 'r1')] }, 100)
  r.receive(granted(), 200)
  const out = r.tick(200 + T132_MS)
  assert.deepEqual(types(out), [Type.Release])
  assert.equal(r.phase, 'no_permission')
  assert.equal(out.gate, false)
})

test('큐 철회는 확인 사건이 없어 표시가 즉시 내려간다', () => {
  const r = room()
  r.press(0)
  r.receive({ type: Type.QueueInfo, ack: false, fields: [{ id: Tlv.QueueInfo, value: Uint8Array.of(1, 3) }, str(Tlv.Room, 'r1')] }, 100)
  const out = r.release(200)
  assert.deepEqual(types(out), [Type.Release])
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.lastEnd, 'released')
})

test('회수는 마이크를 지금 닫고 T3 동안 배수한다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  const out = r.receive({
    type: Type.Revoke, ack: false, fields: [byte(Tlv.Cause, 2), str(Tlv.Room, 'r1')],
  }, 200)

  assert.equal(out.gate, false, '마이크는 지금 닫는다')
  assert.deepEqual(types(out), [Type.Release], 'T8 재전송을 멎게 하는 것은 RELEASE 다')
  assert.equal(r.draining, true, '회수를 보내고도 T3 동안 내 RTP 가 흐른다')
  assert.deepEqual(r.lastRevoke, { cause: 2 })
  assert.equal(r.lastEnd, 'revoked')

  assert.equal(r.tick(200 + T3_MS - 1).signals.length, 0)
  r.tick(200 + T3_MS)
  assert.equal(r.draining, false)
})

test('선점 회수는 코드로 갈린다 — 처방이 반대다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.receive({ type: Type.Revoke, ack: false, fields: [byte(Tlv.Cause, 4), str(Tlv.Room, 'r1')] }, 200)
  assert.equal(r.lastEnd, 'revoked')
  assert.deepEqual(r.lastRevoke, { cause: 4 }, '2(상한)와 4(선점)는 처방이 반대라 코드로 가른다')
})

test('DC 가 끊기면 표시를 믿을 수 없다고 알린다', () => {
  const r = room()
  const out = r.setTrusted(false)
  assert.deepEqual(names(out), ['phase'])
  assert.equal(r.canRequest, false, '미디어 지표로는 안 잡히는 자리다')
  assert.deepEqual(names(r.setTrusted(false)), [], '같은 값에는 안 알린다')
})

test('재구축은 허가를 내리고 화자를 지운다', () => {
  const r = room()
  r.press(0)
  r.receive(granted(), 100)
  r.receive(taken(1, 'me'), 110)
  const out = r.reset('rebuilt')
  assert.equal(r.phase, 'no_permission')
  assert.equal(r.speaker, null)
  assert.equal(r.lastEnd, 'rebuilt')
  assert.equal(out.gate, false)
})

test('pending_request 에서 또 눌러도 요청이 겹치지 않는다', () => {
  const r = room()
  r.press(0)
  assert.deepEqual(types(r.press(10)), [])
})
