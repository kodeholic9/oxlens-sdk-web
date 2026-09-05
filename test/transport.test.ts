// author: kodeholic (powered by Claude)
// SDK§8-2 PeerLink · 연§9-7 · §9-8 · §9-10 · SDK§10-2. 실제 협상 없이 절차와 상태기를 잰다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DISCONNECT_GRACE_MS, LinkError, PeerLink } from '../src/internal/transport/link.js'
import { Serial } from '../src/internal/transport/serial.js'
import { parse } from '../src/internal/sdp/parse.js'
import { Seat } from '../src/internal/sdp/build.js'
import { BROWSER_OFFER, CFG, DC_ONLY_OFFER } from './_sdp_fixtures.js'
import { FakeClock, FakePeers, tick } from './_fakes.js'

const SEAT: Seat = {
  mid: '32', kind: 'audio', room_id: 'r1', user_id: 'u2', track_id: 't-u2-mic',
  ssrc: 1001, pt: 111, codec: 'opus',
}

function stand(mode: '1pc' | '2pc', offer = BROWSER_OFFER): {
  peers: FakePeers; clock: FakeClock; link: PeerLink
} {
  const peers = new FakePeers(offer)
  const clock = new FakeClock()
  const link = new PeerLink({ ...CFG, pc_mode: mode }, { peers, clock })
  return { peers, clock, link }
}

test('전송로는 트랙이 없어도 선다 — 발언권이 그 위로 간다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  const dc = peers.made[0]!.channel!
  assert.equal(dc.label, 'unreliable', '이름은 계약이다 — 다른 이름은 서버가 거부한다')
  assert.deepEqual(dc.init, { ordered: false, maxRetransmits: 0 })
})

test('데이터 채널은 offer 를 만들기 전에 연다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  const calls = peers.made[0]!.calls
  assert.ok(calls.indexOf('createDataChannel:unreliable') < calls.indexOf('createOffer'),
    '나중에 열면 offer 에 m=application 이 없어 발언권 요청이 아무 데도 안 간다')
})

test('2pc 는 연결 둘, 1pc 는 하나다', async () => {
  const two = stand('2pc', DC_ONLY_OFFER)
  await two.link.open()
  assert.equal(two.peers.made.length, 2)

  const one = stand('1pc')
  await one.link.open()
  assert.equal(one.peers.made.length, 1, '전송로가 하나여야 keepalive 가 한 벌로 준다')
})

test('1pc 는 세우면서 audio·video 트랜시버를 inactive 로 함께 세운다', async () => {
  const { peers, link } = stand('1pc')
  await link.open()
  assert.deepEqual(
    peers.made[0]!.calls.filter((c) => c.startsWith('addTransceiver')),
    ['addTransceiver:audio:inactive', 'addTransceiver:video:inactive'],
    '안 세우면 첫 마이크에서 가져올 코덱 확정본이 없다',
  )
})

test('2pc 는 트랜시버를 미리 세우지 않는다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  assert.equal(peers.made[0]!.calls.filter((c) => c.startsWith('addTransceiver')).length, 0)
})

test('보내기는 브라우저 offer → 클라 answer 차례다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  assert.deepEqual(peers.made[0]!.calls.filter((c) => !c.startsWith('createDataChannel')),
    ['createOffer', 'setLocal:offer', 'setRemote:answer'])
  assert.equal(peers.made[0]!.remoteDescription?.type, 'answer')
  assert.ok(peers.made[0]!.remoteDescription!.sdp!.includes('a=setup:passive'))
})

test('받기는 클라 offer → 브라우저 answer 차례다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  await link.negotiateSubscribe([SEAT])

  const sub = peers.made[1]!
  assert.deepEqual(sub.calls, ['setRemote:offer', 'createAnswer', 'setLocal:answer'],
    '브라우저에게 offer 를 만들게 하면 m-line 이 하나도 없다')
  const got = parse(sub.remoteDescription!.sdp!)
  assert.deepEqual(got.sections.map((m) => m.mid), ['32'])
  assert.ok(sub.remoteDescription!.sdp!.includes('a=ice-ufrag:subUf1'))
})

test('협상 중이면 rollback 을 먼저 한다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  const sub = peers.made[1]!
  sub.signalingState = 'have-local-offer'
  await link.negotiateSubscribe([SEAT])
  assert.equal(sub.calls[0], 'setLocal:rollback')
})

test('stable 이면 rollback 을 부르지 않는다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  await link.negotiateSubscribe([SEAT])
  assert.ok(!peers.made[1]!.calls.includes('setLocal:rollback'))
})

test('협상은 하나씩 돈다 — 겹치면 한쪽이 통째로 버려진다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  const sub = peers.made[1]!
  const a = link.negotiateSubscribe([SEAT])
  const b = link.negotiateSubscribe([SEAT, { ...SEAT, mid: '33', ssrc: 2, track_id: 't2' }])
  await Promise.all([a, b])

  const rounds = sub.calls.join(',').split('setRemote:offer').length - 1
  assert.equal(rounds, 2)
  assert.deepEqual(sub.calls, [
    'setRemote:offer', 'createAnswer', 'setLocal:answer',
    'setRemote:offer', 'createAnswer', 'setLocal:answer',
  ], '섞이면 have-local-offer 에 offer 가 도착한다')
})

test('1pc 는 받기도 보내기도 통합 offer 로 한 연결에 먹인다', async () => {
  const { peers, link } = stand('1pc')
  await link.open()
  await link.negotiateSubscribe([SEAT])

  const pc = peers.made[0]!
  const offer = parse(pc.remoteDescription!.sdp!)
  assert.deepEqual(offer.bundle, ['0', '1', '2', '32'], '보내기와 받기가 한 BUNDLE 이다')
  assert.ok(!pc.remoteDescription!.sdp!.includes('subUf1'), 'ICE 자격은 한 벌뿐이다')
})

test('확정본 없이 통합 offer 를 조립하지 않는다', async () => {
  const { link } = stand('1pc')
  await assert.rejects(link.negotiateSubscribe([SEAT]), (e) => {
    assert.ok(e instanceof LinkError)
    assert.equal(e.reason, 'not_open')
    return true
  })
})

test('READY{transport} 재료는 확정본에서 뽑는다', async () => {
  const { link } = stand('1pc')
  await link.open()
  const report = link.transportReport()

  assert.deepEqual(report.codecs, [
    { kind: 'audio', pt: 111, name: 'opus', fmtp: 'minptime=10;useinbandfec=1' },
    {
      kind: 'video', pt: 102, name: 'H264',
      fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      rtx_pt: 103,
    },
  ])
  const uris = report.extmap.map((e) => `${e.id}:${e.uri.split(/[:/]/).pop()!}`)
  assert.ok(uris.includes('1:mid') && uris.includes('4:ssrc-audio-level'))
})

test('SDK§10-2 — 모든 PC 가 붙어 있어야 살아 있다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  assert.equal(link.alive(), false, '안 세운 링크는 살아 있지 않다')
  await link.open()

  peers.made[0]!.setIce('connected')
  peers.made[1]!.setIce('checking')
  await tick()
  assert.equal(link.alive(), false, 'checking 은 아직 붙은 것이 아니다')
  assert.equal(link.dead(), false, '그렇다고 죽은 것도 아니다 — 판정 전이다')

  peers.made[1]!.setIce('completed')
  await tick()
  assert.equal(link.alive(), true)

  peers.made[1]!.setIce('failed')
  await tick()
  assert.equal(link.alive(), false, '한쪽만 죽어도 살아 있지 않다')
  assert.equal(link.dead(), true)
})

test('disconnected 는 이어진 시간으로 판정한다', async () => {
  const { peers, clock, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  for (const p of peers.made) p.setIce('connected')
  await tick()

  peers.made[0]!.setIce('disconnected')
  await tick()
  assert.equal(link.dead(clock.now()), false, '순간 끊김을 죽음으로 보면 안 된다')
  assert.equal(link.dead(clock.now() + DISCONNECT_GRACE_MS - 1), false)
  assert.equal(link.dead(clock.now() + DISCONNECT_GRACE_MS), true)

  peers.made[0]!.setIce('connected')
  await tick()
  assert.equal(link.dead(clock.now() + DISCONNECT_GRACE_MS * 10), false, '돌아오면 계수가 풀린다')
  assert.equal(link.alive(), true)
})

test('닫으면 받기부터 놓고 다시 못 쓴다', async () => {
  const { peers, link } = stand('2pc', DC_ONLY_OFFER)
  await link.open()
  link.close()

  assert.ok(peers.made.every((p) => p.closed))
  assert.equal(link.isOpen, false)
  assert.equal(link.channel, null)
  await assert.rejects(link.negotiateSubscribe([SEAT]), LinkError)
})

test('직렬 큐는 앞이 던져도 뒤를 태운다', async () => {
  const s = new Serial()
  const seen: string[] = []
  const a = s.run(() => Promise.reject(new Error('첫째가 깨졌다')))
  const b = s.run(async () => { seen.push('b') })
  await assert.rejects(a)
  await b
  assert.deepEqual(seen, ['b'], '앞 협상의 실패가 큐를 막으면 안 된다')
})
