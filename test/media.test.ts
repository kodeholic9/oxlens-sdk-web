// author: kodeholic (powered by Claude)
// 연§7-4 · §6-3 · SDK§6-1 — 발행 3단과 되돌리기, 그리고 등록에 실을 값의 출처.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { Op } from '../src/internal/wire.js'
import { Signaling } from '../src/internal/signaling.js'
import { PeerLink } from '../src/internal/transport/link.js'
import { DEVICE_ACQUIRE_TIMEOUT_MS, MediaRegistry, PublishError } from '../src/domain/media-registry.js'
import { DeviceError } from '../src/platform/media.js'
import { CFG, PUBLISH_OFFER } from './_sdp_fixtures.js'
import { FakeClock, FakeDevices, FakePeers, FakeSocket, tick } from './_fakes.js'

interface Stand {
  sock: FakeSocket
  clock: FakeClock
  devices: FakeDevices
  peers: FakePeers
  link: PeerLink
  reg: MediaRegistry
  reply(op: number, body?: Record<string, unknown>): void
  fail(op: number, code: number, name: string): void
  target(): { link: PeerLink; roomId: string; sfuId: string }
}

function stand(mode: '1pc' | '2pc' = '2pc', opusFmtpDefault?: Record<string, string | number | boolean>): Stand {
  const sock = new FakeSocket()
  const clock = new FakeClock()
  const sig = new Signaling(sock, { clock, window: 10 })
  const peers = new FakePeers(PUBLISH_OFFER)
  const devices = new FakeDevices()
  const link = new PeerLink({ ...CFG, pc_mode: mode }, {
    peers, clock, ...(opusFmtpDefault ? { opusFmtpDefault } : {}),
  })
  const reg = new MediaRegistry(() => sig, { devices, clock })
  const seen = new Set<number>()
  const pending = (op: number): number[] => sock.sent.map(decode)
    .filter((x) => x.op === op && x.kind === Kind.Request && !seen.has(x.pid))
    .map((x) => { seen.add(x.pid); return x.pid })
  return {
    sock, clock, devices, peers, link, reg,
    reply: (op, body) => { for (const pid of pending(op)) sock.deliver(encode(Kind.Ok, op, pid, body ?? {})) },
    fail: (op, code, name) => { for (const pid of pending(op)) sock.deliver(encode(Kind.Fail, op, pid, { code, name })) },
    target: () => ({ link, roomId: 'r1', sfuId: CFG.sfu_id }),
  }
}

/** 연§7-0-1 재시도가 붙는 실패는 사다리를 다 돌려야 끝난다. */
async function failAll(s: Stand, op: number, code: number, name: string): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick()
    s.fail(op, code, name)
    await tick()
    await s.clock.advance(3_000)
  }
}

/** 밀린 요청에 차례로 답한다. */
async function drain(s: Stand, op: number, body?: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) { await tick(); s.reply(op, body); await tick() }
}

const bodyOf = (s: Stand, op: number, n = 0): Record<string, unknown> =>
  s.sock.sent.map(decode).filter((f) => f.op === op)[n]!.body as Record<string, unknown>

async function publishOne(s: Stand, kind: 'microphone' | 'camera'): Promise<Awaited<ReturnType<MediaRegistry['publish']>>> {
  const [track] = await s.reg.acquire([{ kind }])
  const p = s.reg.publish(track!, s.target())
  await tick()
  s.reply(Op.PublishTracks, { action: 'add', tracks: [{ mid: track!.transceiver!.mid, track_id: `srv-${kind}` }] })
  return p
}

test('획득은 발행을 모른다 — 접속도 방도 없이 된다', async () => {
  const s = stand()
  const got = await s.reg.acquire([{ kind: 'microphone' }, { kind: 'camera' }])
  assert.deepEqual(got.map((t) => [t.kind, t.state, t.owner]),
    [['audio', 'acquired', 'app'], ['video', 'acquired', 'app']])
  assert.equal(s.sock.sent.length, 0, '로비에서는 와이어를 안 탄다')
})

test('획득은 전부 아니면 전무다', async () => {
  const s = stand()
  s.devices.fail = 'camera'
  await assert.rejects(s.reg.acquire([{ kind: 'microphone' }, { kind: 'camera' }]), DeviceError)
  assert.deepEqual(s.devices.stopped, ['microphone-1'], '이미 획득한 것을 놓아야 한다')
  assert.deepEqual(s.reg.all, [])
})

test('프롬프트를 방치하면 DEVICE_TIMEOUT 이고 늦게 온 스트림은 즉시 정지한다', async () => {
  const s = stand()
  s.devices.hang = 'microphone'
  const p = s.reg.acquire([{ kind: 'microphone' }])
  p.catch(() => {})
  await tick()
  await s.clock.advance(DEVICE_ACQUIRE_TIMEOUT_MS)
  await assert.rejects(p, (e: unknown) => e instanceof DeviceError && e.reason === 'timeout' && e.kind === 'microphone')
  assert.deepEqual(s.reg.all, [])
  s.devices.hung[0]!()
  await tick()
  assert.deepEqual(s.devices.stopped, ['microphone-1'], '앱은 실패로 아는데 표시등이 켜진 채 남으면 안 된다')
})

test('호출별 timeoutMs 가 기본 상한을 덮는다', async () => {
  const s = stand()
  s.devices.hang = 'camera'
  const p = s.reg.acquire([{ kind: 'camera', timeoutMs: 1_000 }])
  p.catch(() => {})
  await tick()
  await s.clock.advance(999)
  assert.equal(s.clock.pending, 1, '아직 기다린다')
  await s.clock.advance(1)
  await assert.rejects(p, (e: unknown) => e instanceof DeviceError && e.reason === 'timeout')
})

test('제때 오면 시계를 걷고 트랙을 돌려준다', async () => {
  const s = stand()
  const [track] = await s.reg.acquire([{ kind: 'microphone', timeoutMs: 1_000 }])
  assert.equal(track!.state, 'acquired')
  assert.equal(s.clock.pending, 0, '남은 시계가 없다')
})

test('발행은 트랜시버 → 협상 → 등록 → 송신 차례다', async () => {
  const s = stand()
  await s.link.open()
  const track = await publishOne(s, 'microphone')

  assert.equal(track.state, 'sending')
  assert.equal(track.trackId, 'srv-microphone', '이후 모든 식별이 이 값이다')
  assert.equal(track.server, CFG.sfu_id)
  assert.equal(track.owner, 'sdk', 'publish 가 끝나면 장치 수명은 SDK 몫이다')
  const calls = s.peers.made[0]!.calls
  assert.ok(calls.indexOf('addTransceiver:audio:sendonly') < calls.lastIndexOf('setRemote:answer'),
    'RTP 는 협상 뒤다')
})

test('등록에 실을 값은 내 offer 에서, ★fmtp 는 확정본에서 읽는다', async () => {
  const s = stand()
  await s.link.open()
  await publishOne(s, 'microphone')

  const body = bodyOf(s, Op.PublishTracks)
  assert.equal(body.room_id, 'r1')
  assert.equal(body.action, 'add')
  // ★연§6-3 — fmtp 는 kind 를 안 가린다. audio 도 확정본에 있으면 싣는다.
  // opus 는 연§9-4 예외로 answer 가 받는 쪽 선호를 정하므로, offer 에서 읽으면
  // useinbandfec·minptime 협상 결과가 구독자에게 영영 안 간다.
  assert.deepEqual(body.tracks, [{
    kind: 'audio', ssrc: 11111, mid: '0', pt: 111, duplex: 'full', source: 'microphone',
    fmtp: 'minptime=10;useinbandfec=1',
  }])
  assert.equal(body.mid_extmap_id, 1, '협상 결과 번호를 신고한다')
  assert.equal(body.audio_level_extmap_id, 4)
  assert.equal(body.twcc_extmap_id, 6)
})

test('video 는 codec 과 fmtp 를 반드시 싣는다 — 확정본이 출처다', async () => {
  const s = stand()
  await s.link.open()
  s.link.sender('audio')
  await publishOne(s, 'camera')

  const tracks = bodyOf(s, Op.PublishTracks).tracks as Record<string, unknown>[]
  assert.equal(tracks[0]!.codec, 'H264')
  assert.equal(tracks[0]!.fmtp, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    '없으면 남의 화면이 검다 — 구독자 fmtp 의 출처가 이것 하나다')
  assert.equal(tracks[0]!.rtx_pt, 103)
  assert.equal(tracks[0]!.rtx_ssrc, 22223)
  assert.equal(tracks[0]!.simulcast, false,
    '★추론에 맡기면 단일 레이어가 시뮬캐스트로 등록돼 물리가 첫 RTP 를 영원히 기다린다')
})

test('등록이 실패하면 그 단만 되돌린다 — 트랜시버는 둔다', async () => {
  const s = stand()
  await s.link.open()
  const [track] = await s.reg.acquire([{ kind: 'microphone' }])
  const p = s.reg.publish(track!, s.target())
  p.catch(() => {})
  await failAll(s, Op.PublishTracks, 4002, 'TRACK_LIMIT')
  await assert.rejects(p)

  assert.equal(track!.state, 'acquired', '실패는 그 단만 되돌린다')
  assert.equal(track!.transceiver!.direction, 'inactive', '트랜시버를 없애면 협상이 또 돈다')
  assert.notEqual(track!.transceiver, null)
  assert.equal(track!.owner, 'app', '발행이 실패한 트랙은 앱 것 그대로다')
})

test('송신이 안 붙으면 remove 를 보내 되돌린다', async () => {
  const s = stand()
  await s.link.open()
  const [track] = await s.reg.acquire([{ kind: 'microphone' }])
  const p = s.reg.publish(track!, s.target())
  p.catch(() => {})
  await tick()

  const mid = track!.transceiver!.mid
  track!.transceiver!.sender.replaceTrack = () => Promise.reject(new Error('sender 가 막혔다'))
  s.reply(Op.PublishTracks, { tracks: [{ mid, track_id: 'srv-a' }] })
  await drain(s, Op.PublishTracks)
  await assert.rejects(p, PublishError)

  const removes = s.sock.sent.map(decode)
    .filter((f) => f.op === Op.PublishTracks && (f.body as Record<string, unknown>).action === 'remove')
  assert.equal(removes.length, 1, '빠뜨리면 유령 등록이 상한을 소진해 4002 가 잦아진다')
  assert.deepEqual((removes[0]!.body as Record<string, unknown>).track_ids, ['srv-a'])
})

test('반이중은 등록된 채로 머문다 — 게이트는 발언권이 연다', async () => {
  const s = stand()
  await s.link.open()
  const [track] = await s.reg.acquire([{ kind: 'microphone' }])
  track!.duplex = 'half'
  const p = s.reg.publish(track!, s.target())
  await tick()
  s.reply(Op.PublishTracks, { tracks: [{ mid: track!.transceiver!.mid, track_id: 'srv-h' }] })
  await p

  assert.equal(track!.state, 'registered', '허가 없이 소리가 나가지 않는다')
  await s.reg.gate(track!, true)
  assert.equal(track!.state, 'sending')
  await s.reg.gate(track!, false)
  assert.equal(track!.state, 'registered')
})

test('반이중 마이크는 RTP 없이도 신고한다', async () => {
  const s = stand()
  await s.link.open()
  const [track] = await s.reg.acquire([{ kind: 'microphone' }])
  track!.duplex = 'half'
  const p = s.reg.publish(track!, s.target())
  await tick()
  s.reply(Op.PublishTracks, { tracks: [{ mid: track!.transceiver!.mid, track_id: 'srv-h' }] })
  await p
  assert.deepEqual(s.reg.liveTracks(), [{ track_id: 'srv-h', kind: 'audio' }],
    '등록 생존이 기준이다 — RTP 흐름이 아니다')
})

test('remove 는 등록 응답이 준 track_id 로 지목한다', async () => {
  const s = stand()
  await s.link.open()
  const track = await publishOne(s, 'microphone')
  const p = s.reg.remove(track)
  await drain(s, Op.PublishTracks)
  await p

  const body = bodyOf(s, Op.PublishTracks, 1)
  assert.deepEqual(body, { action: 'remove', room_id: 'r1', track_ids: ['srv-microphone'] })
  assert.equal(track.state, 'acquired')
  assert.equal(track.trackId, null)
})

test('muted 와 duplex 는 배타다', async () => {
  const s = stand()
  await s.link.open()
  const track = await publishOne(s, 'microphone')
  await assert.rejects(s.reg.set(track, {}), PublishError)
  await assert.rejects(s.reg.set(track, { muted: true, duplex: 'half' }), PublishError)
})

test('duplex 전환은 응답 뒤에 게이트를 움직인다', async () => {
  const s = stand()
  await s.link.open()
  const track = await publishOne(s, 'microphone')
  assert.equal(track.state, 'sending')

  const p = s.reg.set(track, { duplex: 'half' })
  await tick()
  assert.equal(track.state, 'sending', '응답 전엔 아무것도 바꾸지 않는다')
  assert.equal(track.duplex, 'full', '낙관 갱신은 없다 — 3006 이 오면 벙어리로 남는다')
  s.reply(Op.TrackSet, { duplex: 'half' })
  await p
  assert.equal(track.duplex, 'half')
  assert.equal(track.state, 'registered', '발언권 없이는 안 나간다')
})

test('camera 신고는 등록 뒤에 그 track_id 로 나간다', async () => {
  const s = stand()
  await s.link.open()
  s.link.sender('audio')
  const track = await publishOne(s, 'camera')
  const p = s.reg.announceCamera(track)
  await drain(s, Op.Ready)
  await p

  assert.deepEqual(bodyOf(s, Op.Ready), { room_id: 'r1', type: 'camera', track_id: 'srv-camera' },
    '안 보내면 남들 화면엔 아바타가 그대로다')
})

test('1pc 는 m-line 을 늘리지 않고 세워 둔 자리를 되쓴다', async () => {
  const s = stand('1pc')
  await s.link.open()
  const before = s.peers.made[0]!.transceivers.length
  const t = s.link.sender('audio')
  assert.equal(s.peers.made[0]!.transceivers.length, before,
    'addTransceiver 를 다시 부르면 최초 한 번만 허용된 클라 offer 경로가 또 필요해진다')
  assert.equal(t.direction, 'sendonly')
})
