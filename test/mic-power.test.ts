import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Op } from '../src/internal/wire.js'
import { createClient } from '../src/index.js'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { CFG, PUBLISH_OFFER } from './_sdp_fixtures.js'
import { FakeClock, FakeDevices, FakeHttp, FakePeers, FakeSocket, tick } from './_fakes.js'
import { OxLensClient, Room } from '../src/api/types.js'

const BIND_OK = {
  user_id: 'u1', role: 'user', server_ver: 1,
  heartbeat_interval: 10_000, session_id: 's-1', resume_window_ms: 60_000, pc_mode: '2pc',
}

interface Stand {
  client: OxLensClient
  sock: FakeSocket
  clock: FakeClock
  devices: FakeDevices
  reply(op: number, body?: Record<string, unknown>): void
}

function stand(): Stand {
  const sock = new FakeSocket()
  const clock = new FakeClock()
  const devices = new FakeDevices()
  const client = createClient({ base: 'https://hub.example', token: 't' }, {
    connect: () => Promise.resolve(sock),
    peers: new FakePeers(PUBLISH_OFFER), devices, clock, http: new FakeHttp(),
  })
  const seen = new Set<string>()
  return {
    client, sock, clock, devices,
    reply(op, body) {
      for (const f of sock.sent.map(decode)) {
        if (f.op !== op || f.kind !== Kind.Request || seen.has(`${op}:${f.pid}`)) continue
        seen.add(`${op}:${f.pid}`)
        sock.deliver(encode(Kind.Ok, op, f.pid, body ?? {}))
      }
    },
  }
}

async function joinedTalk(s: Stand): Promise<Room> {
  const c = s.client.connect()
  await tick()
  s.reply(Op.Bind, BIND_OK)
  await c
  const p = s.client.join('r1', { mode: 'talk' })
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.reply(Op.Affiliation, {})
    s.reply(Op.RoomJoin, {
      room_id: 'r1', participants: [{ user_id: 'u1', select: true }],
      affiliation: { sub_rooms: ['r1'], pub_room: 'r1' },
      server_config: CFG, tracks: [], version: { epoch: CFG.sfu_id, seq: 1 },
    })
    s.reply(Op.Ready, {})
  }
  return p
}

async function armed(s: Stand, room: Room): Promise<void> {
  const p = room.ptt.enable()
  for (let i = 0; i < 6; i += 1) { await tick(); s.reply(Op.PublishTracks, { tracks: [{ mid: '0', track_id: 'tr-1' }] }) }
  await p
}

test('발행 직후 마이크는 hot_standby 다 — 트랙은 살아 있고 장치도 쥐고 있다', async () => {
  const s = stand()
  const room = await joinedTalk(s)
  await armed(s, room)
  assert.equal(room.ptt.state.mic, 'hot_standby')
})

test('무발화가 이어지면 cold 로 내려가고 장치를 놓는다', async () => {
  const s = stand()
  const room = await joinedTalk(s)
  await armed(s, room)
  const before = s.devices.stopped.length
  await s.clock.advance(30_000)
  await tick()
  assert.equal(room.ptt.state.mic, 'cold')
  assert.equal(s.devices.stopped.length, before + 1, '장치를 반납하지 않으면 배터리를 먹는다')
})

test('keepWarm 이 cold 를 미룬다 — 곧 말할 것을 아는 앱이 첫 음절을 지킨다', async () => {
  const s = stand()
  const room = await joinedTalk(s)
  await armed(s, room)
  room.ptt.keepWarm(120_000)
  await s.clock.advance(30_000)
  await tick()
  assert.equal(room.ptt.state.mic, 'hot_standby')
})

test('keepWarm(0) 은 기본값으로 되돌린다', async () => {
  const s = stand()
  const room = await joinedTalk(s)
  await armed(s, room)
  room.ptt.keepWarm(120_000)
  room.ptt.keepWarm(0)
  await s.clock.advance(30_000)
  await tick()
  assert.equal(room.ptt.state.mic, 'cold')
})

test('cold 에서 press 하면 새로 잡는다 — 재획득이 첫 음절을 먹는 자리다', async () => {
  const s = stand()
  const room = await joinedTalk(s)
  await armed(s, room)
  await s.clock.advance(30_000)
  await tick()
  assert.equal(room.ptt.state.mic, 'cold')

  const taken = s.devices.taken.length
  void room.ptt.press()
  await tick()
  await tick()
  assert.equal(s.devices.taken.length, taken + 1)
  assert.notEqual(room.ptt.state.mic, 'cold')
})
