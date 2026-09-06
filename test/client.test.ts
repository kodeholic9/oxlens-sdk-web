// author: kodeholic (powered by Claude)
// SDK§3·§4·§6 — 표면 결선. 브라우저 없이 접속→입장→트랙 도착→발행 한 벌을 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { Op } from '../src/internal/wire.js'
import { createClient } from '../src/index.js'
import { OxLensClient, RemoteTrack, Room } from '../src/api/types.js'
import {
  decode as decodeMbcp, encode as encodeMbcp, frame, short as mbcpShort, str as mbcpStr,
  text as mbcpText, Tlv, Type, unframe,
} from '../src/internal/mbcp.js'
import { CFG, PUBLISH_OFFER } from './_sdp_fixtures.js'
import { FakeClock, FakeDevices, FakeHttp, FakePeers, FakeSocket, tick } from './_fakes.js'

const BIND_OK = {
  user_id: 'u1', role: 'user', server_ver: 1,
  heartbeat_interval: 10_000, session_id: 's-1', resume_window_ms: 60_000, pc_mode: '2pc',
}

const MIC_TRACK = {
  room_id: 'r1', kind: 'audio' as const, user_id: 'u2', ssrc: 1001,
  track_id: 't-u2-mic', mid: '0', pt: 111,
}

interface Stand {
  live(): Promise<void>
  client: OxLensClient
  sock: FakeSocket
  clock: FakeClock
  peers: FakePeers
  devices: FakeDevices
  http: FakeHttp
  ops(): number[]
  reply(op: number, body?: Record<string, unknown>): void
  notify(op: number, body: Record<string, unknown>): void
  drain(op: number, body?: Record<string, unknown>): Promise<void>
}

function stand(): Stand {
  const socks: FakeSocket[] = []
  const sock = new FakeSocket()
  socks.push(sock)
  let dials = 0
  const clock = new FakeClock()
  const peers = new FakePeers(PUBLISH_OFFER)
  const devices = new FakeDevices()
  const http = new FakeHttp()
  const client = createClient(
    { base: 'https://hub.example', token: 't' },
    {
      // ★재접속마다 새 소켓이다 — 같은 것을 돌려주면 두 번째 BIND 가 닫힌 소켓에 실린다.
      connect: () => {
        dials += 1
        if (dials === 1) return Promise.resolve(sock)
        const next = new FakeSocket()
        socks.push(next)
        return Promise.resolve(next)
      },
      peers, devices, clock, http,
    },
  )
  const seen = new Set<string>()
  // ★소켓까지 보고 짓는다 — pid 는 소켓마다 0 부터 다시 매겨진다.
  const live = (): FakeSocket => socks[socks.length - 1]!
  const pending = (op: number): number[] => live().sent.map(decode)
    .filter((x) => x.op === op && x.kind === Kind.Request && !seen.has(`${socks.length}:${op}:${x.pid}`))
    .map((x) => { seen.add(`${socks.length}:${op}:${x.pid}`); return x.pid })
  let notifyPid = 500
  const s: Stand = {
    client, sock, clock, peers, devices, http,
    // 미디어가 살아 있어야 RESUME 을 보낸다 — 죽은 방은 신고 자체를 안 한다(연§7-3-2 4).
    live: async () => { for (const p of peers.made) p.setIce('connected'); await tick() },
    ops: () => live().sent.map((b) => decode(b).op),
    reply: (op, body) => { for (const pid of pending(op)) sock.deliver(encode(Kind.Ok, op, pid, body ?? {})) },
    notify: (op, body) => { notifyPid += 1; sock.deliver(encode(Kind.Request, op, notifyPid, body)) },
    async drain(op, body) { for (let i = 0; i < 4; i += 1) { await tick(); s.reply(op, body); await tick() } },
  }
  return s
}

function joinBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_id: 'r1',
    participants: [{ user_id: 'u1', select: false }],
    affiliation: { sub_rooms: ['r1'], pub_room: null },
    server_config: CFG,
    tracks: [],
    version: { epoch: CFG.sfu_id, seq: 1 },
    ...over,
  }
}

async function connected(s: Stand): Promise<void> {
  const p = s.client.connect()
  await tick()
  s.reply(Op.Bind, BIND_OK)
  await p
}

async function joined2(s: Stand, roomId: string): Promise<Room> {
  const p = s.client.join(roomId)
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.reply(Op.Affiliation, {})
    s.reply(Op.RoomJoin, joinBody({ room_id: roomId, affiliation: { sub_rooms: ['r1', roomId], pub_room: null } }))
    s.reply(Op.Ready, {})
  }
  return p
}

async function joined(s: Stand, over?: Record<string, unknown>, opts?: { mode: 'listen' | 'talk' }): Promise<Room> {
  const p = s.client.join('r1', opts)
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.reply(Op.Affiliation, {})
    s.reply(Op.RoomJoin, joinBody(over))
    s.reply(Op.Ready, {})
  }
  return p
}

test('connect 는 BIND 까지다', async () => {
  const s = stand()
  await connected(s)
  assert.equal(s.client.session.state, 'active')
  assert.equal(s.client.session.userId, 'u1')
  assert.equal(s.client.session.pcMode, '2pc')
})

test('기본 입장은 청취다 — 지령대 모니터링이 기본 경로다', async () => {
  const s = stand()
  await connected(s)
  await joined(s)
  const body = decode(s.sock.sent.map(decode).find((f) => f.op === Op.RoomJoin)!.pid === 0
    ? s.sock.sent[1]! : s.sock.sent[1]!).body as Record<string, unknown>
  assert.equal(body.select, false, 'wire 기본과 반대다')
  assert.equal(s.client.rooms.get('r1')!.mode, 'listen')
  assert.equal(s.client.rooms.get('r1')!.state, 'joined')
})

test('입장 응답의 초기 트랙은 join 전에 건 리스너가 받는다', async () => {
  const s = stand()
  await connected(s)
  const seen: RemoteTrack[] = []
  s.client.on('track', (_room, t) => seen.push(t))

  const room = await joined(s, { tracks: [MIC_TRACK] })
  await tick()
  assert.equal(seen.length, 1, 'client.on(track) 을 join 전에 걸면 초기 트랙을 안 놓친다')
  assert.equal(seen[0]!.id, 't-u2-mic')
  assert.equal(seen[0]!.roomId, 'r1')
  assert.equal(seen[0]!.userId, 'u2')
  assert.equal(seen[0]!.slot, false)
  assert.deepEqual(room.tracks.map((t) => t.id), ['t-u2-mic'])
})

test('무전 슬롯은 user_id 부재로 안다 — track_id 를 파싱하지 않는다', async () => {
  const s = stand()
  await connected(s)
  const slotTrack = { ...MIC_TRACK, track_id: 'ptt-r1-audio', user_id: undefined }
  delete (slotTrack as Record<string, unknown>).user_id
  const room = await joined(s, { tracks: [slotTrack] })
  await tick()
  assert.equal(room.tracks[0]!.slot, true)
})

test('입퇴장도 보관본 문을 지난다 — seq 는 그때도 오른다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const seen: string[] = []
  room.on('track', (t) => seen.push(t.id))

  s.notify(Op.ParticipantEvent, {
    room_id: 'r1', type: 'joined', user_id: 'u2', version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await tick()
  s.notify(Op.TrackEvent, {
    action: 'add', room_id: 'r1', tracks: [MIC_TRACK], version: { epoch: CFG.sfu_id, seq: 3 },
  })
  await s.drain(Op.Ready, {})
  assert.deepEqual(seen, ['t-u2-mic'],
    '입퇴장이 문을 안 지나면 뒤따르는 트랙이 매번 갭으로 보여 영영 안 붙는다')
})

test('TRACK_EVENT 는 보관본 문을 지나 트랙 이벤트가 된다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const seen: string[] = []
  room.on('track', (t) => seen.push(t.id))

  s.notify(Op.TrackEvent, {
    action: 'add', room_id: 'r1', tracks: [MIC_TRACK], version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await s.drain(Op.Ready, {})
  assert.deepEqual(seen, ['t-u2-mic'], '갈래는 action 이다 — type 이 아니다')
})

test('통지에는 ACK 이 먼저 나간다', async () => {
  const s = stand()
  await connected(s)
  await joined(s)
  const before = s.sock.sent.length
  s.notify(Op.ParticipantEvent, {
    room_id: 'r1', type: 'joined', user_id: 'u9', version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await tick()
  const ack = decode(s.sock.sent[before]!)
  assert.equal(ack.kind, Kind.Ok)
  assert.equal(ack.op, Op.ParticipantEvent)
  assert.equal(s.sock.sent[before]!.length, 8, 'ACK 은 빈 body 다')
})

test('명단은 통지대로 는다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  s.notify(Op.ParticipantEvent, {
    room_id: 'r1', type: 'joined', user_id: 'u9', select: true, version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await tick()
  assert.deepEqual(room.participants.map((p) => [p.userId, p.mode]), [['u1', 'listen'], ['u9', 'talk']])

  s.notify(Op.ParticipantEvent, {
    room_id: 'r1', type: 'left', user_id: 'u9', version: { epoch: CFG.sfu_id, seq: 3 },
  })
  await tick()
  assert.deepEqual(room.participants.map((p) => p.userId), ['u1'])
})

test('낡은 통지는 트랙 이벤트를 만들지 않는다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const seen: string[] = []
  room.on('track', (t) => seen.push(t.id))
  const before = s.ops().length
  s.notify(Op.TrackEvent, {
    action: 'add', room_id: 'r1', tracks: [MIC_TRACK], version: { epoch: CFG.sfu_id, seq: 1 },
  })
  await tick()
  assert.deepEqual(seen, [], '되감기면 그 사이 트랙이 영영 안 붙는다')
  assert.deepEqual(room.tracks, [])
  const after = s.sock.sent.map(decode).slice(before)
  assert.ok(!after.some((f) => f.op === Op.Ready && f.kind === Kind.Request),
    '낡은 것에 재협상을 걸면 붙어 있는 배관을 헛되이 흔든다')
})

test('갭이면 그 방을 통짜로 다시 받는다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  let resync = 0
  room.on('resync', () => { resync += 1 })
  s.http.routes.set('/rooms/r1?tracks=1', {
    room_id: 'r1', name: 'r1', capacity: 10, user_count: 1, created_at: 0, rec: false,
    participants: [{ user_id: 'u1' }, { user_id: 'u2' }],
    version: { epoch: CFG.sfu_id, seq: 9 },
    tracks: [MIC_TRACK],
  })

  s.notify(Op.TrackEvent, {
    action: 'add', room_id: 'r1', tracks: [MIC_TRACK], version: { epoch: CFG.sfu_id, seq: 9 },
  })
  await s.drain(Op.Ready, {})

  assert.equal(resync, 1)
  const call = s.http.calls.at(-1)!
  assert.ok(call.url.endsWith('/rooms/r1?tracks=1'), '★tracks=1 은 명시적으로 요구한다')
  assert.equal(call.headers['X-OxLens-Session'], 's-1',
    '★세션 헤더로 부른다 — 그래야 입장 중인 방의 mid 가 채워진다')
  assert.deepEqual(room.tracks.map((t) => t.id), ['t-u2-mic'], '갭 뒤 보관본이 통째로 맞춰진다')
  assert.deepEqual(room.participants.map((p) => p.userId), ['u1', 'u2'])
})

test('여러 방이 어긋나도 조립은 한 번이다', async () => {
  const s = stand()
  await connected(s)
  await joined(s)
  await joined2(s, 'r2')
  for (const id of ['r1', 'r2']) {
    s.http.routes.set(`/rooms/${id}?tracks=1`, {
      room_id: id, name: id, capacity: 10, user_count: 1, created_at: 0, rec: false,
      participants: [], version: { epoch: CFG.sfu_id, seq: 20 }, tracks: [],
    })
  }
  const before = s.sock.sent.filter((b) => decode(b).op === Op.Ready).length

  for (const id of ['r1', 'r2']) {
    s.notify(Op.TrackEvent, {
      action: 'add', room_id: id, tracks: [], version: { epoch: CFG.sfu_id, seq: 9 },
    })
  }
  await s.drain(Op.Ready, {})

  assert.equal(s.http.calls.filter((c) => c.url.includes('tracks=1')).length, 2)
  const rounds = s.peers.made[1]!.calls.filter((c) => c === 'setRemote:offer').length
  assert.equal(rounds, 3, '★입장 둘 + 재동기 한 번 — 방마다 조립하면 중간 상태로 협상이 돈다')
  assert.ok(s.sock.sent.filter((b) => decode(b).op === Op.Ready).length > before)
})

test('결말은 cause 가 아니라 목록이 정한다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  let cause = ''
  let stillThere = 0
  room.on('forced', (e) => { cause = e.cause })
  room.on('affiliation', () => { stillThere += 1 })

  s.notify(Op.RoomEvent, {
    type: 'affiliation', room_id: 'r1', cause: 'moderate',
    affiliation: { sub_rooms: ['r1'], pub_room: null }, version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await tick()
  assert.equal(stillThere, 1, '목록에 남아 있으면 방은 유지다')
  assert.equal(room.state, 'joined')

  s.notify(Op.RoomEvent, {
    type: 'affiliation', room_id: 'r1', cause: 'kick',
    affiliation: { sub_rooms: [], pub_room: null }, version: { epoch: CFG.sfu_id, seq: 3 },
  })
  await tick()
  assert.equal(cause, 'kick')
  assert.equal(room.state, 'closed')
  assert.equal(s.client.rooms.has('r1'), false)
})

test('★방을 내리는 결말은 견주기에 걸리지 않는다 — 급사 통지가 삼켜지면 방이 영영 안 닫힌다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  let cause = ''
  room.on('forced', (e) => { cause = e.cause })

  // 정§15-1 — sfud 급사는 hub 가 알린다. hub 는 seq 를 발급할 수 없어(연§4-6 단일 발급자)
  // ★마지막으로 통과시킨 값을 그대로 싣는다 — 그것은 클라 보관값과 **같다**.
  // seq 견주기를 걸면 규칙 2(작거나 같으면 버린다)에 걸려 종결이 통째로 삼켜진다.
  s.notify(Op.RoomEvent, {
    type: 'affiliation', room_id: 'r1', cause: 'room_closed',
    affiliation: { sub_rooms: [], pub_room: null }, version: { epoch: CFG.sfu_id, seq: 1 },
  })
  await tick()
  assert.equal(cause, 'room_closed')
  assert.equal(room.state, 'closed')
  assert.equal(s.client.rooms.has('r1'), false)
})

test('★방을 유지하는 결말은 그대로 견준다 — 낡은 소속 갱신은 버린다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  let stillThere = 0
  room.on('affiliation', () => { stillThere += 1 })
  s.notify(Op.RoomEvent, {
    type: 'affiliation', room_id: 'r1', cause: 'moderate',
    affiliation: { sub_rooms: ['r1'], pub_room: null }, version: { epoch: CFG.sfu_id, seq: 1 },
  })
  await tick()
  assert.equal(stillThere, 0, '보관값과 같은 seq — 되감기라 버린다')
  assert.equal(room.state, 'joined')
})

test('sync_required 도 같은 문으로 간다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  let resync = 0
  room.on('resync', () => { resync += 1 })
  s.http.routes.set('/rooms/r1?tracks=1', {
    room_id: 'r1', name: 'r1', capacity: 10, user_count: 1, created_at: 0, rec: false,
    participants: [], version: { epoch: CFG.sfu_id, seq: 5 }, tracks: [],
  })
  s.notify(Op.RoomEvent, {
    type: 'sync_required', room_id: 'r1', reason: 'no_media_flow', version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await s.drain(Op.Ready, {})
  assert.equal(resync, 1)
  assert.ok(s.http.calls.some((c) => c.url.includes('tracks=1')))
})

test('미리보기는 방에 안 들어가고 본다', async () => {
  const s = stand()
  await connected(s)
  s.http.routes.set('/rooms/lobby', {
    room_id: 'lobby', name: '로비', capacity: 50, user_count: 2, created_at: 17, rec: false,
    participants: [{ user_id: 'a', select: false }, { user_id: 'b', select: true }],
    version: { epoch: 'e', seq: 3 },
  })
  const p = await s.client.preview('lobby')
  assert.equal(p.roomId, 'lobby')
  assert.equal(p.userCount, 2)
  assert.deepEqual(p.participants.map((x) => [x.userId, x.mode]), [['a', 'listen'], ['b', 'talk']])
  assert.equal(s.client.rooms.size, 0, '정원을 먹지 않고 명단에 오르지 않는다')
  assert.equal(s.http.calls.at(-1)!.headers.Authorization, 'Bearer t', '미리보기는 토큰 축이다')
  assert.ok(!s.http.calls.at(-1)!.url.includes('tracks'), '기본은 tracks=0 이다 — payload 가 크다')
})

test('방 목록에는 참가자 이름이 없다', async () => {
  const s = stand()
  await connected(s)
  s.http.routes.set('/rooms', {
    rooms: [{ room_id: 'r1', name: 'n', capacity: 10, user_count: 3, created_at: 1, rec: true }],
    total: 1,
  })
  const list = await s.client.listRooms()
  assert.deepEqual(list, [{ roomId: 'r1', name: 'n', capacity: 10, userCount: 3, createdAt: 1, rec: true }])
})

test('HTTP 실패는 표면 오류로 온다', async () => {
  const s = stand()
  await connected(s)
  await assert.rejects(s.client.preview('nope'), (e: unknown) => {
    assert.equal((e as { category: string }).category, 'bug')
    return true
  })
})

test('TRACK_STATE 는 트랙 하나의 표시만 고친다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s, { tracks: [MIC_TRACK] })
  await tick()
  const track = room.tracks[0]!
  assert.equal(track.active, true)

  s.notify(Op.TrackState, {
    type: 'muted', room_id: 'r1', user_id: 'u2', track_id: 't-u2-mic', ssrc: 1001,
    kind: 'audio', active: false, version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await tick()
  assert.equal(track.active, false, '배열이 아니라 track_id 로 지목한다')
  assert.equal(room.tracks.length, 1, '지우는 것이 아니다')
})

test('발언 방이 없으면 발행은 wire 를 안 탄다', async () => {
  const s = stand()
  await connected(s)
  await joined(s)
  await assert.rejects(s.client.media.enableMicrophone(), (e: unknown) => {
    const err = e as { category: string; code: number; name: string }
    assert.equal(err.category, 'state')
    assert.equal(err.code, 0, 'wire 를 안 탔으니 code 는 0 이다')
    assert.equal(err.name, 'STATE_NO_SPEAKING_ROOM')
    return true
  })
  assert.equal(s.devices.taken.length, 0, '장치도 안 잡는다')
})

test('발언 방이 있으면 마이크가 등록까지 간다', async () => {
  const s = stand()
  await connected(s)
  await joined(s, { affiliation: { sub_rooms: ['r1'], pub_room: 'r1' } }, { mode: 'talk' })

  const p = s.client.media.enableMicrophone()
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.reply(Op.PublishTracks, { tracks: [{ mid: '0', track_id: 'srv-mic' }] })
  }
  const track = await p
  assert.equal(track.state, 'sending')
  assert.equal(track.owner, 'sdk')
  assert.equal(track.server, CFG.sfu_id)
  assert.deepEqual(s.client.media.tracks.map((t) => t.id), [track.id])
})

test('획득 실패는 device 로 온다', async () => {
  const s = stand()
  await connected(s)
  await joined(s, { affiliation: { sub_rooms: ['r1'], pub_room: 'r1' } }, { mode: 'talk' })
  s.devices.fail = 'microphone'
  await assert.rejects(s.client.media.enableMicrophone(), (e: unknown) => {
    const err = e as { category: string; details?: Record<string, unknown> }
    assert.equal(err.category, 'device')
    assert.equal(err.details?.kind, 'microphone', '어느 kind 에서 막혔는지가 프롬프트를 다시 띄울 자리다')
    return true
  })
})

test('close 는 방을 나가고 전송로와 소켓을 놓는다', async () => {
  const s = stand()
  await connected(s)
  await joined(s)
  const p = s.client.close()
  await s.drain(Op.RoomLeave, {})
  await p
  assert.ok(s.ops().includes(Op.RoomLeave),
    '통보가 먼저다 — 로컬을 먼저 닫으면 서버는 20초 회수로만 안다')
  assert.equal(s.client.rooms.size, 0)
  assert.ok(s.peers.made.every((x) => x.closed))
  assert.deepEqual(s.sock.closedWith, { code: 1000, reason: '' })
})

test('아직 안쪽이 없는 진입은 조용히 통과하지 않는다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  assert.throws(() => room.ptt.keepWarm(0), /not implemented/)
  await assert.rejects(room.ptt.enableVideo(), /not implemented/)
  await assert.rejects(s.client.media.publish({} as MediaStreamTrack, { source: 'camera' }), /not implemented/)
})

test('switchDevice 는 고른 값을 preferred 에 남긴다 — 다음 획득이 그것을 쓴다', async () => {
  const s = stand()
  await connected(s)
  await joined(s)
  await s.client.media.switchDevice('audioinput', 'mic-a')
  assert.equal(s.client.media.devices.preferred.audioinput, 'mic-a')
  await s.client.media.switchDevice('audioinput', null)
  assert.equal(s.client.media.devices.preferred.audioinput, undefined)
})

test('발언권은 DC 로 오간다 — 권위가 하나다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s, { affiliation: { sub_rooms: ['r1'], pub_room: 'r1' } }, { mode: 'talk' })
  const dc = s.peers.made[0]!.channel!
  dc.markOpen()

  const phases: string[] = []
  room.ptt.on('state', (st) => phases.push(st.phase))

  const p = room.ptt.press()
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.reply(Op.Affiliation, {})
    s.reply(Op.PublishTracks, { tracks: [{ mid: '0', track_id: 'srv-ptt' }] })
  }
  await p

  const sent = dc.sent.map((b) => decodeMbcp(unframe(b)!.payload)!)
  assert.deepEqual(sent.map((m) => m.type), [Type.Request], 'WS 가 아니라 DC 로 간다')
  assert.equal(mbcpText(sent[0]!, Tlv.Room), 'r1')
  assert.equal(room.ptt.state.phase, 'pending_request')

  dc.deliver(frame(encodeMbcp({
    type: Type.Granted, ack: true,
    fields: [mbcpShort(Tlv.Duration, 30), mbcpStr(Tlv.Room, 'r1')],
  })))
  await tick()

  assert.equal(room.ptt.state.phase, 'has_permission')
  assert.equal(room.ptt.state.remainingSec, 30)
  const ack = dc.sent.map((b) => decodeMbcp(unframe(b)!.payload)!).at(-1)!
  assert.equal(ack.type, Type.Ack, 'A 비트가 선 것에는 반드시 ACK 이다')
  assert.ok(phases.includes('has_permission'))
})

test('반이중 마이크는 허가 동안만 송신한다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s, { affiliation: { sub_rooms: ['r1'], pub_room: 'r1' } }, { mode: 'talk' })
  s.peers.made[0]!.channel!.markOpen()

  const p = room.ptt.press()
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.reply(Op.Affiliation, {})
    s.reply(Op.PublishTracks, { tracks: [{ mid: '0', track_id: 'srv-ptt' }] })
  }
  await p
  const mic = s.client.media.tracks[0]!
  assert.equal(mic.duplex, 'half')
  assert.equal(mic.state, 'registered', '허가 없이 소리가 나가지 않는다')

  s.peers.made[0]!.channel!.deliver(frame(encodeMbcp({
    type: Type.Granted, ack: false, fields: [mbcpStr(Tlv.Room, 'r1')],
  })))
  await tick()
  assert.equal(mic.state, 'sending')
})

test('발성 감지(svc 0x02)는 읽지 않는다 — 이 문서 밖이다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const dc = s.peers.made[0]!.channel!
  dc.markOpen()

  const seen: string[] = []
  room.ptt.on('speaker', (e) => seen.push(String(e.userId)))
  const taken = encodeMbcp({
    type: Type.Taken, ack: false,
    fields: [mbcpShort(Tlv.Seq, 1), mbcpStr(4, 'u2'), mbcpStr(Tlv.Room, 'r1')],
  })
  dc.deliver(frame(taken, 0x02))
  await tick()
  assert.deepEqual(seen, [], '확장 svc 를 MBCP 로 읽으면 안 된다')

  dc.deliver(frame(taken))
  await tick()
  assert.deepEqual(seen, ['u2'])
})

test('방을 안 실은 프레임은 어느 방에도 안 간다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const dc = s.peers.made[0]!.channel!
  dc.markOpen()

  const seen: string[] = []
  room.ptt.on('speaker', (e) => seen.push(String(e.userId)))
  dc.deliver(frame(encodeMbcp({
    type: Type.Taken, ack: false, fields: [mbcpShort(Tlv.Seq, 1), mbcpStr(4, 'u2')],
  })))
  await tick()
  assert.deepEqual(seen, [], '다방에서 어느 방 것인지가 이 값 하나로 갈린다')
})

test('DC 가 끊기면 그 서버 방의 표시를 못 믿는다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const dc = s.peers.made[0]!.channel!
  dc.markOpen()
  await tick()
  assert.equal(room.ptt.state.trusted, true)

  dc.close()
  await tick()
  assert.equal(room.ptt.state.trusted, false, '미디어 지표로는 안 잡히는 자리다')
  assert.equal(room.ptt.state.canRequest, false)
})

test('재동기가 실패하면 보관본을 안 건드리고 앱에 알린다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s, { tracks: [MIC_TRACK] })
  await tick()
  const errors: string[] = []
  room.on('error', (e) => errors.push(e.name))

  // 라우트를 안 등록하면 404 다 — 조용히 빈 것을 주지 않는다.
  s.notify(Op.RoomEvent, {
    type: 'sync_required', room_id: 'r1', reason: 'no_media_flow', version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await s.drain(Op.Ready, {})

  assert.equal(errors.length, 1, '못 받았으면 못 받았다고 알린다')
  assert.deepEqual(room.tracks.map((t) => t.id), ['t-u2-mic'],
    '★못 받은 응답으로 보관본을 비우면 화면이 통째로 꺼진다')
})

test('낡은 재동기 응답은 버린다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s, { tracks: [MIC_TRACK], version: { epoch: CFG.sfu_id, seq: 7 } })
  await tick()
  s.http.routes.set('/rooms/r1?tracks=1', {
    room_id: 'r1', name: 'r1', capacity: 10, user_count: 1, created_at: 0, rec: false,
    participants: [], version: { epoch: CFG.sfu_id, seq: 3 }, tracks: [],
  })
  s.notify(Op.RoomEvent, {
    type: 'sync_required', room_id: 'r1', reason: 'x', version: { epoch: CFG.sfu_id, seq: 8 },
  })
  await s.drain(Op.Ready, {})

  assert.deepEqual(room.tracks.map((t) => t.id), ['t-u2-mic'],
    '★계약은 하나다 — 낡은 응답은 버린다. 안 그러면 되감긴 상태로 조립한다')
})

test('오류 응답에 body 가 실려 와도 반영하지 않는다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s, { tracks: [MIC_TRACK] })
  await tick()
  const errors: string[] = []
  room.on('error', (e) => errors.push(e.name))

  // ★401 인데 방처럼 생긴 body 가 온다 — 상태를 안 보면 그대로 반영된다.
  s.http.status = 401
  s.http.routes.set('/rooms/r1?tracks=1', {
    room_id: 'r1', name: 'r1', capacity: 10, user_count: 0, created_at: 0, rec: false,
    participants: [], version: { epoch: CFG.sfu_id, seq: 99 }, tracks: [],
  })
  s.notify(Op.RoomEvent, {
    type: 'sync_required', room_id: 'r1', reason: 'x', version: { epoch: CFG.sfu_id, seq: 2 },
  })
  await s.drain(Op.Ready, {})

  assert.equal(errors.length, 1)
  assert.deepEqual(room.tracks.map((t) => t.id), ['t-u2-mic'],
    '★상태를 안 보면 401 의 빈 방으로 화면이 꺼진다')
})


test('문자는 응답으로 내 것을 알고 남의 것은 통지로 온다', async () => {
  const s = stand()
  await connected(s)
  const room = await joined(s)
  const seen: { userId: string; content: string }[] = []
  room.on('message', (m) => seen.push(m))

  const p = room.sendMessage('여기 u1')
  await tick()
  const sent = decode(s.sock.sent.at(-1)!)
  assert.equal(sent.op, Op.Message)
  assert.deepEqual(sent.body, { room_id: 'r1', content: '여기 u1' },
    '★신원을 안 싣는다 — 서버가 세션에서 넣는다')
  s.reply(Op.Message, { msg_id: 'm-1' })
  assert.deepEqual(await p, { msgId: 'm-1' }, '자기 것은 응답으로 안다')
  assert.deepEqual(seen, [], '★보낸 사람에게는 에코가 오지 않는다')

  s.notify(Op.Message, { room_id: 'r1', user_id: 'u2', content: '들린다' })
  await tick()
  assert.deepEqual(seen, [{ userId: 'u2', content: '들린다' }])
})
