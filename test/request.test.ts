// author: kodeholic (powered by Claude)
// 연§7-0-1 — 실패 응답을 어떻게 가르나. 재시도는 사다리의 둘째~넷째 칸이고 첫 칸은 재접속 것이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { Op } from '../src/internal/wire.js'
import { RequestFailed, Signaling } from '../src/internal/signaling.js'
import { RETRY_MS, request, retryable } from '../src/domain/request.js'
import { FakeClock, FakeSocket, tick } from './_fakes.js'

function stand(): { sock: FakeSocket; clock: FakeClock; sig: Signaling } {
  const sock = new FakeSocket()
  const clock = new FakeClock()
  return { sock, clock, sig: new Signaling(sock, { clock, window: 10 }) }
}

const answered = new WeakMap<FakeSocket, Set<number>>()
function fail(sock: FakeSocket, op: number, body: Record<string, unknown>): number {
  const seen = answered.get(sock) ?? new Set<number>()
  answered.set(sock, seen)
  let n = 0
  for (const f of sock.sent.map(decode)) {
    if (f.op === op && f.kind === Kind.Request && !seen.has(f.pid)) {
      seen.add(f.pid); sock.deliver(encode(Kind.Fail, op, f.pid, body)); n += 1
    }
  }
  return n
}

test('1xxx 는 클라 버그다 — 다시 보내지 않는다', () => {
  assert.equal(retryable(new RequestFailed(Op.RoomJoin, { code: 1002, name: 'BAD_BODY' })), false)
  assert.equal(retryable(new RequestFailed(Op.RoomJoin, { code: 1005, name: 'CODEC_REQUIRED' })), false)
})

test('permanent 는 다시 보내도 같다', () => {
  const e = new RequestFailed(Op.RoomJoin, { code: 3001, name: 'ROOM_NOT_FOUND' } as never)
  assert.equal(retryable(e), true)
  assert.equal(retryable(new RequestFailed(Op.RoomJoin,
    { code: 3001, name: 'ROOM_NOT_FOUND', permanent: true } as never)), false)
})

test('사다리 둘째~넷째 칸으로 세 번 더 보낸다', async () => {
  const s = stand()
  const p = request(s.sig, s.clock, Op.Ready, { room_id: 'r1' })
  p.catch(() => {})

  await tick()
  assert.equal(fail(s.sock, Op.Ready, { code: 5002, name: 'SFU_ERROR' }), 1)
  await tick()
  assert.equal(s.sock.sent.length, 1, '곧바로 다시 보내지 않는다 — 첫 칸 0ms 는 재접속 것이다')

  for (const wait of RETRY_MS) {
    await s.clock.advance(wait)
    await tick()
    assert.equal(fail(s.sock, Op.Ready, { code: 5002, name: 'SFU_ERROR' }), 1)
    await tick()
  }
  await assert.rejects(p, RequestFailed)
  assert.equal(s.sock.sent.length, 4, '처음 하나에 재시도 셋이다')
})

test('성공하면 거기서 멈춘다', async () => {
  const s = stand()
  const p = request(s.sig, s.clock, Op.Ready, {})
  await tick()
  fail(s.sock, Op.Ready, { code: 5002, name: 'SFU_ERROR' })
  await tick()
  await s.clock.advance(RETRY_MS[0]!)
  await tick()

  const pid = decode(s.sock.sent[1]!).pid
  s.sock.deliver(encode(Kind.Ok, Op.Ready, pid, { ok: true }))
  assert.deepEqual(await p, { ok: true })
  assert.equal(s.sock.sent.length, 2)
})

test('사건별 절차가 있는 코드는 한 번에 끝난다', async () => {
  const s = stand()
  const p = request(s.sig, s.clock, Op.RoomJoin, {}, [4005])
  p.catch(() => {})
  await tick()
  fail(s.sock, Op.RoomJoin, { code: 4005, name: 'MID_LIMIT' })
  await assert.rejects(p)
  await s.clock.advance(10_000)
  assert.equal(s.sock.sent.length, 1)
})

test('목록에 없는 코드는 그 op 이라도 재시도한다', async () => {
  const s = stand()
  const p = request(s.sig, s.clock, Op.RoomJoin, {}, [4005])
  p.catch(() => {})
  await tick()
  fail(s.sock, Op.RoomJoin, { code: 5001, name: 'SFU_UNAVAILABLE' })
  await tick()
  await s.clock.advance(RETRY_MS[0]!)
  await tick()
  assert.equal(s.sock.sent.length, 2)
})
