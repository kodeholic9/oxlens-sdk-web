// author: kodeholic (powered by Claude)
// 연§3-1·§3-2 짝짓기·윈도우·우선순위·타이머. 각 단언 옆에 "무엇을 어기면 빨개지나"를 적는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { Op } from '../src/internal/wire.js'
import { RequestFailed, Signaling, SignalingClosed, T_REQ_MS } from '../src/internal/signaling.js'
import { FakeClock, FakeSocket, tick } from './_fakes.js'

function stand(window?: number): { sock: FakeSocket; clock: FakeClock; sig: Signaling } {
  const sock = new FakeSocket()
  const clock = new FakeClock()
  const sig = new Signaling(sock, window === undefined ? { clock } : { clock, window })
  return { sock, clock, sig }
}

const sentOps = (s: FakeSocket): number[] => s.sent.map((b) => decode(b).op)

test('요청 하나에 응답 하나 — op·pid 로 짝을 짓는다', async () => {
  const { sock, sig } = stand()
  const p = sig.request(Op.RoomJoin, { room_id: 'r1' })
  const out = decode(sock.sent[0]!)
  assert.equal(out.kind, Kind.Request)
  assert.equal(out.op, Op.RoomJoin)
  assert.deepEqual(out.body, { room_id: 'r1' })

  sock.deliver(encode(Kind.Ok, Op.RoomJoin, out.pid, { version: { epoch: 'e', seq: 1 } }))
  assert.deepEqual(await p, { version: { epoch: 'e', seq: 1 } })
})

test('pid 가 다른 응답은 짝이 아니다 — 아무 요청도 풀리지 않는다', async () => {
  const { sock, sig } = stand()
  let settled = false
  void sig.request(Op.RoomJoin, {}).then(() => { settled = true }, () => { settled = true })
  const mine = decode(sock.sent[0]!).pid
  sock.deliver(encode(Kind.Ok, Op.RoomJoin, (mine + 7) >>> 0, {}))
  await tick()
  assert.equal(settled, false, 'pid 를 안 보면 남의 응답으로 풀린다')
})

test('pid 는 맞고 op 이 다르면 짝이 아니다', async () => {
  const { sock, sig } = stand()
  let settled = false
  const p = sig.request(Op.RoomJoin, {})
  p.then(() => { settled = true }, () => { settled = true })
  sock.deliver(encode(Kind.Ok, Op.RoomLeave, decode(sock.sent[0]!).pid, {}))
  await tick()
  assert.equal(settled, false, 'op 을 안 보면 남의 응답이 ROOM_JOIN 을 푼다')
})

test('실패 응답은 code 를 그대로 들고 온다', async () => {
  const { sock, sig } = stand()
  const p = sig.request(Op.RoomJoin, { room_id: 'nope' })
  const pid = decode(sock.sent[0]!).pid
  sock.deliver(encode(Kind.Fail, Op.RoomJoin, pid, { code: 3001, name: 'ROOM_NOT_FOUND' }))
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof RequestFailed)
    assert.equal(e.failure.code, 3001)
    assert.equal(e.failure.name, 'ROOM_NOT_FOUND')
    return true
  })
})

test('윈도우 기본 1 — 응답 전에는 다음 요청이 안 나간다', async () => {
  const { sock, sig } = stand()
  void sig.request(Op.RoomJoin, { room_id: 'a' })
  void sig.request(Op.RoomJoin, { room_id: 'b' })
  assert.equal(sock.sent.length, 1, '윈도우를 안 지키면 둘 다 나간다')

  const pid = decode(sock.sent[0]!).pid
  sock.deliver(encode(Kind.Ok, Op.RoomJoin, pid, {}))
  await tick()
  assert.equal(sock.sent.length, 2)
  assert.deepEqual(decode(sock.sent[1]!).body, { room_id: 'b' }, '순서가 곧 상태다')
})

test('RESUME 은 윈도우 밖이다 — 막힌 창에서도 나간다', async () => {
  const { sock, sig } = stand()
  void sig.request(Op.RoomJoin, {})
  void sig.request(Op.Resume, { rooms: ['r1'] })
  assert.deepEqual(sentOps(sock), [Op.RoomJoin, Op.Resume], 'RESUME 을 세면 창에 막힌다')
})

test('낮은 단이 먼저, 같은 단은 먼저 온 것부터', async () => {
  const { sock, sig } = stand()
  void sig.request(Op.RoomJoin, {})
  void sig.request(Op.Task, {})
  void sig.request(Op.Message, {})
  void sig.request(Op.RoomLeave, {})

  const pid = decode(sock.sent[0]!).pid
  sock.deliver(encode(Kind.Ok, Op.RoomJoin, pid, {}))
  await tick()
  for (let i = 1; i < 4; i += 1) {
    sock.deliver(encode(Kind.Ok, decode(sock.sent[i]!).op, decode(sock.sent[i]!).pid, {}))
    await tick()
  }
  assert.deepEqual(sentOps(sock), [Op.RoomJoin, Op.RoomLeave, Op.Message, Op.Task],
    '단을 안 보면 도착 순서 그대로 나간다')
})

test('통지는 ACK 이 먼저 나가고 그 다음 주인에게 간다', async () => {
  const { sock, sig } = stand()
  const it = sig.notifications()
  sock.deliver(encode(Kind.Request, Op.ParticipantEvent, 77, { type: 'joined', room_id: 'r1' }))

  const got = await it.next()
  assert.equal(got.value?.op, Op.ParticipantEvent)
  assert.deepEqual(got.value?.body, { type: 'joined', room_id: 'r1' })

  const ack = decode(sock.sent[0]!)
  assert.equal(ack.kind, Kind.Ok, 'ACK 은 빈 01 응답이다')
  assert.equal(ack.op, Op.ParticipantEvent)
  assert.equal(ack.pid, 77, '받은 pid 를 그대로 되돌린다')
  assert.equal(sock.sent[0]!.length, 8, 'body 는 0바이트다')
})

test('통지 ACK 은 내 요청 윈도우를 쓰지 않는다', async () => {
  const { sock, sig } = stand()
  void sig.request(Op.RoomJoin, {})
  sock.deliver(encode(Kind.Request, Op.TrackEvent, 5, { type: 'add' }))
  await tick()
  const pid = decode(sock.sent[0]!).pid
  sock.deliver(encode(Kind.Ok, Op.RoomJoin, pid, {}))
  await tick()
  assert.equal(sock.sent.length, 2, 'ACK 이 창을 먹으면 여기서 막힌다')
})

test('T-req 30초 — 재전송이 아니라 끊는다', async () => {
  const { sock, clock, sig } = stand()
  const p = sig.request(Op.RoomJoin, {})
  p.catch(() => {})
  await clock.advance(T_REQ_MS - 1)
  assert.equal(sock.closedWith, null, '아직 이르다')

  await clock.advance(1)
  await assert.rejects(p)
  assert.equal(sock.sent.length, 1, '재전송하면 둘이 된다')
  assert.deepEqual(sock.closedWith, { code: 4001, reason: 'FLOW_TIMEOUT' })
})

test('응답이 오면 T-req 는 안 터진다', async () => {
  const { sock, clock, sig } = stand()
  const p = sig.request(Op.RoomJoin, {})
  sock.deliver(encode(Kind.Ok, Op.RoomJoin, decode(sock.sent[0]!).pid, {}))
  await p
  await clock.advance(T_REQ_MS * 2)
  assert.equal(sock.closedWith, null, '타이머를 안 끄면 응답 뒤에 끊긴다')
})

test('소켓이 닫히면 기다리던 것과 밀린 것이 전부 풀린다', async () => {
  const { sock, sig } = stand()
  const a = sig.request(Op.RoomJoin, {})
  const b = sig.request(Op.RoomLeave, {})
  a.catch(() => {}); b.catch(() => {})
  sock.close(4006, 'SERVER_SHUTDOWN')
  await tick()
  for (const p of [a, b]) {
    await assert.rejects(p, (e) => {
      assert.ok(e instanceof SignalingClosed)
      assert.equal(e.info.code, 4006)
      return true
    })
  }
})

test('하트비트는 준 주기로 나가고 닫히면 멈춘다', async () => {
  const { sock, clock, sig } = stand()
  sig.startHeartbeat(10_000)
  await clock.advance(10_000)
  assert.deepEqual(sentOps(sock), [Op.Heartbeat])

  sock.deliver(encode(Kind.Ok, Op.Heartbeat, decode(sock.sent[0]!).pid, {}))
  await tick()
  await clock.advance(10_000)
  assert.deepEqual(sentOps(sock), [Op.Heartbeat, Op.Heartbeat])

  sock.close(1000, '')
  await tick()
  await clock.advance(30_000)
  assert.equal(sock.sent.length, 2, '닫힌 뒤에도 뛰면 여기서 늘어난다')
})

test('깨진 프레임은 응답을 지을 수 없어 끊는다', async () => {
  const { sock } = stand()
  sock.deliver(Uint8Array.from([0x02, 0x00, 0x01, 0x01, 0, 0, 0, 1]))
  await tick()
  assert.deepEqual(sock.closedWith, { code: 4000, reason: 'PROTOCOL_ERROR' })
})

test('윈도우는 1~10 정수뿐이다', () => {
  for (const w of [0, 11, 1.5]) {
    assert.throws(() => stand(w), RangeError, `${w} 를 받으면 안 된다`)
  }
  assert.doesNotThrow(() => stand(10))
})
