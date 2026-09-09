// author: kodeholic (powered by Claude)
// 연§7-5 · §6-2 — 방 상태기와 서버 단위. 연결은 방마다가 아니라 미디어 서버마다 하나다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { Op } from '../src/internal/wire.js'
import { Signaling } from '../src/internal/signaling.js'
import { RoomError, Rooms } from '../src/domain/rooms.js'
import { CFG, DC_ONLY_OFFER } from './_sdp_fixtures.js'
import { FakeClock, FakePeers, FakeSocket, tick } from './_fakes.js'

const CFG2 = { ...CFG, sfu_id: 'sfu-b', ice: { ...CFG.ice, publish_ufrag: 'pubUf2', port: 7001 } }

function joinBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_id: 'r1',
    participants: [{ user_id: 'u1', select: true }],
    affiliation: { sub_rooms: ['r1'], pub_room: 'r1' },
    server_config: CFG,
    tracks: [],
    version: { epoch: CFG.sfu_id, seq: 1 },
    ...over,
  }
}


interface Stand {
  clock: FakeClock
  sock: FakeSocket
  peers: FakePeers
  rooms: Rooms
  ops(): number[]
  reply(op: number, body: Record<string, unknown>, kind?: number): void
  fail(op: number, code: number, name: string): void
}

function stand(): Stand {
  const sock = new FakeSocket()
  const clock = new FakeClock()

  const sig = new Signaling(sock, { clock, window: 10 })
  const peers = new FakePeers(DC_ONLY_OFFER)
  const rooms = new Rooms(() => sig, { peers, clock })
  const answered = new Set<string>()
  const pending = (op: number): number[] => sock.sent.map(decode)
    .filter((x) => x.op === op && x.kind === Kind.Request && !answered.has(`${op}:${x.pid}`))
    .map((x) => { answered.add(`${op}:${x.pid}`); return x.pid })
  return {
    clock, sock, peers, rooms,
    ops: () => sock.sent.map((b) => decode(b).op),
    reply: (op, body) => { for (const pid of pending(op)) sock.deliver(encode(Kind.Ok, op, pid, body)) },
    fail: (op, code, name) => { for (const pid of pending(op)) sock.deliver(encode(Kind.Fail, op, pid, { code, name })) },
  }
}

/**
 * 밀린 요청에 차례로 답한다. 한 서버에 방이 여럿이면 재협상 뒤 READY 가 방마다 나가므로
 * (연§6-3 — 한 방에만 보내면 나머지 방 영상이 검다) 한 번의 답으로는 안 끝난다.
 */
async function settle(s: Stand, join?: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick()
    s.reply(Op.Affiliation, {})
    if (join) s.reply(Op.RoomJoin, join)
    s.reply(Op.Ready, {})
    s.reply(Op.RoomLeave, {})
  }
}

async function joinOnce(s: Stand, roomId: string, body?: Record<string, unknown>): Promise<void> {
  const p = s.rooms.join(roomId)
  await settle(s, body ?? joinBody({ room_id: roomId }))
  await p
}

test('입장하면 그 서버 전송로가 서고 READY{tracks} 가 나간다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  assert.equal(s.rooms.stateOf('r1'), 'joined')
  assert.equal(s.peers.made.length, 2, '2pc 는 보내기·받기 둘이다')
  assert.deepEqual(s.ops(), [Op.RoomJoin, Op.Ready])
  const ready = decode(s.sock.sent[1]!).body as Record<string, unknown>
  assert.deepEqual(ready, { room_id: 'r1', type: 'tracks' }, '빠뜨리면 수신 영상이 영구히 검다')
})

test('같은 서버의 두 방은 연결을 나눠 쓴다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  await joinOnce(s, 'r2', joinBody({ room_id: 'r2', version: { epoch: CFG.sfu_id, seq: 1 } }))

  assert.equal(s.peers.made.length, 2, '방마다 연결을 따로 만들면 ICE 자격이 충돌한다')
  assert.equal(s.rooms.serverOf('r1'), s.rooms.serverOf('r2'))
})

test('다른 서버는 연결을 따로 세운다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  await joinOnce(s, 'r2', joinBody({
    room_id: 'r2', server_config: CFG2, version: { epoch: CFG2.sfu_id, seq: 1 },
  }))
  assert.equal(s.peers.made.length, 4)
  assert.notEqual(s.rooms.serverOf('r1')!.sfuId, s.rooms.serverOf('r2')!.sfuId)
})

test('세션 모드와 다른 pc_mode 로 답하면 연결을 세우지 않는다', async () => {
  const s = stand()
  const p = s.rooms.join('r1')
  await tick()
  s.reply(Op.RoomJoin, joinBody({ server_config: { ...CFG, pc_mode: '1pc' } }))
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof RoomError)
    assert.equal(e.failureName, 'PC_MODE_MISMATCH')
    return true
  }, '서버가 조용히 다른 모드로 돌리는 경로는 없다')
  assert.equal(s.peers.made.length, 0)
  assert.equal(s.rooms.stateOf('r1'), 'none')
})

test('입장 실패는 방을 none 으로 돌린다', async () => {
  const s = stand()
  const p = s.rooms.join('nope')
  await tick()
  s.fail(Op.RoomJoin, 3001, 'ROOM_NOT_FOUND')
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof RoomError)
    assert.equal(e.code, 3001)
    return true
  })
  assert.equal(s.rooms.stateOf('nope'), 'none')
})

test('발행 방을 다른 서버로 옮기면 옛 서버에 pub_deselect 가 먼저 간다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')

  const p = s.rooms.join('r2')
  await tick()
  assert.equal(decode(s.sock.sent[2]!).op, Op.Affiliation, '전역 단일성은 클라가 지킨다')
  assert.deepEqual(decode(s.sock.sent[2]!).body, { pub_deselect: true })
  await settle(s, joinBody({ room_id: 'r2', server_config: CFG2, version: { epoch: CFG2.sfu_id, seq: 1 } }))
  await p
  assert.equal(s.rooms.speakingRoom, 'r2')
})

test('청취 전용 입장은 발행 방을 건드리지 않는다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  const p = s.rooms.join('r2', { select: false })
  await tick()
  assert.equal(decode(s.sock.sent[2]!).op, Op.RoomJoin, '청취 전용은 발행 축을 안 건드린다')
  assert.equal((decode(s.sock.sent[2]!).body as Record<string, unknown>).select, false)
  await settle(s, joinBody({ room_id: 'r2' }))
  await p
  assert.equal(s.rooms.speakingRoom, 'r1')
})

test('나갈 때는 통보가 먼저다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  await joinOnce(s, 'r2', joinBody({ room_id: 'r2' }))

  const p = s.rooms.leave('r1')
  await tick()
  assert.equal(decode(s.sock.sent.at(-1)!).op, Op.RoomLeave)
  assert.equal(s.peers.made[0]!.closed, false, '로컬을 먼저 닫으면 서버는 20초 회수로만 안다')
  await settle(s)
  await p
  assert.equal(s.rooms.stateOf('r1'), 'none')
})

test('그 서버의 마지막 방을 나가면 연결을 닫는다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  const p = s.rooms.leave('r1')
  await settle(s)
  await p
  assert.ok(s.peers.made.every((x) => x.closed))
  assert.equal(s.rooms.serverOf('r1'), undefined)
})

test('없는 방을 나가라는 응답은 성공과 같이 다룬다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  const p = s.rooms.leave('r1')
  await tick(); s.fail(Op.RoomLeave, 3002, 'NOT_IN_ROOM'); await settle(s); await p
  assert.equal(s.rooms.stateOf('r1'), 'none', '서버에 없는 방을 붙들 이유가 없다')
})

test('미디어가 죽은 서버의 방만 내린다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  await joinOnce(s, 'r2', joinBody({ room_id: 'r2', server_config: CFG2, version: { epoch: CFG2.sfu_id, seq: 1 } }))

  const again = await s.rooms.rebuildServer(CFG.sfu_id)
  assert.deepEqual(again, ['r1'])
  assert.equal(s.rooms.stateOf('r1'), 'none')
  assert.equal(s.rooms.stateOf('r2'), 'joined', '다른 서버의 방은 건드리지 않는다')
})

test('신고 목록은 미디어가 살아 있는 방만이다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  assert.deepEqual(s.rooms.liveRooms(), [], 'ICE 가 안 붙었으면 살아 있지 않다')

  for (const p of s.peers.made) p.setIce('connected')
  await tick()
  assert.deepEqual(s.rooms.liveRooms(), ['r1'])

  s.peers.made[1]!.setIce('failed')
  await tick()
  assert.deepEqual(s.rooms.liveRooms(), [], '죽은 서버의 방은 RESUME 에 넣지 않는다')
})

test('통지는 보관본 문 하나를 지난다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  const v = { epoch: CFG.sfu_id, seq: 2 }
  const track = {
    room_id: 'r1', kind: 'audio' as const, ssrc: 1, track_id: 't1', mid: '0', pt: 111,
  }
  assert.equal(s.rooms.applyEvent('r1', v, { kind: 'add', tracks: [track] }), 'ok')
  // ★연§4-6 둘째 예외 — 같은 seq 는 에코다(나에게만 온 프레임). 버리면 재배정·소속 결과가 삼켜진다.
  assert.equal(s.rooms.applyEvent('r1', v, { kind: 'add', tracks: [track] }), 'ok')
  assert.equal(s.rooms.applyEvent('r1', { epoch: CFG.sfu_id, seq: 1 }, { kind: 'add', tracks: [track] }), 'stale')
  assert.equal(s.rooms.applyEvent('r1', { epoch: CFG.sfu_id, seq: 9 }, { kind: 'add', tracks: [track] }), 'resync')
})

test('닫으면 전송로가 전부 놓인다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  s.rooms.closeAll()
  assert.ok(s.peers.made.every((x) => x.closed))
  assert.deepEqual(s.rooms.joined, [])
})

test('죽은 서버를 따로 가려낸다 — 방아쇠가 그것이다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  assert.deepEqual(s.rooms.deadServers(), [], '판정 전은 죽은 것이 아니다')
  s.peers.made[0]!.setIce('failed')
  await tick()
  assert.deepEqual(s.rooms.deadServers(), [CFG.sfu_id])
})

test('한 서버에 방이 여럿이면 READY 는 방마다 나간다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  await joinOnce(s, 'r2', joinBody({ room_id: 'r2' }))

  const readies = s.sock.sent.map(decode)
    .filter((f) => f.op === Op.Ready)
    .map((f) => (f.body as Record<string, unknown>).room_id)
  assert.deepEqual(readies, ['r1', 'r1', 'r2'],
    '한 방에만 보내면 나머지 방 영상이 검고 이미 말하는 사람도 안 뜬다')
})

test('나가기가 5xxx 로 실패해도 방은 내리고 앱에 알린다', async () => {
  const s = stand()
  await joinOnce(s, 'r1')
  const p = s.rooms.leave('r1')
  p.catch(() => {})
  for (let i = 0; i < 10; i += 1) {
    await tick()
    s.fail(Op.RoomLeave, 5002, 'SFU_ERROR')
    await tick()
    await s.clock.advance(3_000)
  }
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof RoomError)
    assert.equal(e.code, 5002)
    return true
  })
  assert.equal(s.rooms.stateOf('r1'), 'none', 'LEAVING 에 두지 않는다 — 서버 회수가 뒤를 맡는다')
})

test('사건별 절차가 있는 실패는 다시 보내지 않는다', async () => {
  const s = stand()
  const p = s.rooms.join('nope')
  p.catch(() => {})
  await tick()
  s.fail(Op.RoomJoin, 4005, 'MID_LIMIT')
  await assert.rejects(p)
  assert.equal(s.sock.sent.filter((b) => decode(b).op === Op.RoomJoin).length, 1,
    '다른 방을 나가기 전에는 재시도해도 같다')
})
