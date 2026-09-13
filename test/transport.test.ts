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

function stand(
  mode: '1pc' | '2pc',
  offer = BROWSER_OFFER,
  opusFmtpDefault?: { dtx?: boolean; fec?: boolean; stereo?: boolean; maxAverageBitrate?: number },
): { peers: FakePeers; clock: FakeClock; link: PeerLink } {
  const peers = new FakePeers(offer)
  const clock = new FakeClock()
  const link = new PeerLink({ ...CFG, pc_mode: mode }, {
    peers, clock, ...(opusFmtpDefault ? { opusFmtpDefault } : {}),
  })
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

test('★1pc 첫 협상은 audio 1 + video 1 + DC 다 — 자리 확보는 없다(17차)', async () => {
  // ★★**둘째 video(자리 확보 트랜시버)를 철거했다**(17차, M5 실측) — 트랙이 늘면
  //   합성 offer 로 보내기 m-line 을 붙인다(연§9-10-1). 규칙 2(무중단 불변)는
  //   ★**새 절을 더하는 것을 막지 않는다** — 무관한 절이 한 글자도 안 바뀌면 된다.
  // ★미리 세워 두면 ★**쓰지도 않는 m-line 을 모두에게 영구히 지운다**(BUNDLE 천장은
  //   동시 개수가 아니라 그 연결이 지금까지 만든 누적이다, 연§4-1).
  const { peers, link } = stand('1pc')
  await link.open()
  assert.deepEqual(
    peers.made[0]!.calls.filter((c) => c.startsWith('addTransceiver')),
    ['addTransceiver:audio:inactive', 'addTransceiver:video:inactive'],
    '번호표(PT·확장 ID)를 얻는 데 필요한 최소다 — 안 세우면 내 번호 없이 서버가 배정한다',
  )
})

test('★씨앗을 다 쓰면 새 m-line 을 붙인다 — 화면공유가 그 자리다(17차)', async () => {
  // ★종전 시험은 *"카메라와 화면공유가 m-line 을 안 늘린다"* 였다 — 둘째 video 를 미리
  //   세워 뒀기 때문이다. 17차가 그것을 철거했으므로 ★**화면공유는 절을 늘린다.**
  const { peers, link } = stand('1pc')
  await link.open()
  const before = peers.made[0]!.calls.filter((c) => c.startsWith('addTransceiver')).length

  const cam = link.sender('video')      // 씨앗 video 를 되쓴다 — 안 는다
  assert.equal(
    peers.made[0]!.calls.filter((c) => c.startsWith('addTransceiver')).length, before,
    '씨앗이 남아 있으면 되쓴다 — SSRC·대역 추정이 보존된다',
  )
  const screen = link.sender('video')   // 씨앗이 없다 — 는다
  assert.equal(
    peers.made[0]!.calls.filter((c) => c.startsWith('addTransceiver')).length, before + 1,
    '★씨앗이 없으면 늘린다 — 그 절의 코덱 줄 출처는 확정본이 아니라 내 offer 다',
  )
  assert.notEqual(cam.mid, screen.mid, '두 자리는 서로 다른 m-line 이다')
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

// ★연§9-4 예외(RFC 7587 §6.1) — opus 받는 쪽 선호는 ★answer 가 정한다. 그 확정본이 곧
// PUBLISH_TRACKS.fmtp 의 출처이고(연§6-3), READY{transport} 신고표와 ★한 출처다.
// offer 에서 읽던 옛 길로는 앱이 정한 값이 wire 에 영영 못 닿았다.
test('★opusFmtpDefault 가 확정 answer 에 박힌다 — 앱 값이 wire 에 닿는다', async () => {
  const { peers, link } = stand('1pc', BROWSER_OFFER, { dtx: false, fec: true, maxAverageBitrate: 24000 })
  await link.open()

  const answer = peers.made[0]!.remoteDescription!.sdp!
  assert.ok(answer.includes('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=0;maxaveragebitrate=24000'),
    'offer 원문(minptime=10;useinbandfec=1)에 앱 선호가 얹힌 값이라야 한다')
  // ★번호표는 14차부터 **브라우저 offer** 에서 읽어 `ROOM_JOIN` 에 싣는다 — 확정본이 아니다.
  //   여기서 보는 것은 ★**확정본에 박혔나** 하나다(등록 신고 `fmtp` 의 출처, 연§6-3).
  assert.ok(link.confirmedAnswer()?.includes('usedtx=0;maxaveragebitrate=24000'),
    '확정본이 등록 신고 fmtp 의 유일한 출처다')
})

test('★2pc 는 opusFmtpDefault 를 쓰지 않는다 — 발행마다 조립한다(정책서 §4-1)', async () => {
  const { peers, link } = stand('2pc', BROWSER_OFFER, { dtx: false })
  await link.open()

  const answer = peers.made[0]!.remoteDescription!.sdp!
  assert.ok(answer.includes('a=fmtp:111 minptime=10;useinbandfec=1'), 'offer 원문 그대로다')
  assert.ok(!answer.includes('usedtx'), '2pc 는 PeerLink 단위 값을 굳히지 않는다')
})

test('★번호표는 브라우저 offer 에서 뽑아 ROOM_JOIN 에 싣는다(14차)', async () => {
  const { link } = stand('1pc')
  const report = await link.seedOffer()

  // ★★**번호표는 브라우저 offer 의 것**이다(14차) — 아직 answer 가 없으므로 앱 선호가
  //   안 얹혀 있다. ★그것이 맞다: 서버가 피해 배정해야 하는 것은 ★**내가 제안한 번호**이고,
  //   앱 선호(`usedtx`·`stereo`)는 ★**등록 신고 `fmtp`** 의 축이라 확정본에서 따로 간다(연§6-3).
  assert.deepEqual(report.codecs, [
    { kind: 'audio', pt: 111, name: 'opus', fmtp: 'minptime=10;useinbandfec=1' },
    {
      kind: 'video', pt: 102, name: 'H264',
      fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      rtx_pt: 103,
    },
  ])
  const uris = report.extmap.map((e) => `${e.id}:${e.uri.split(/[:/]/).pop()!}`)
  assert.ok(uris.includes('4:ssrc-audio-level'), '받기 절이 쓰는 확장은 번호째로 신고한다')
  // ★★**`sdes:mid` 도 신고한다**(연§9-4) — 서버가 ①수신에서 SSRC 학습 재료로 읽고
  //   ②송신에서 ★**그 번호로 받기 mid 를 다시 쓴다**(§4-2-1 ③).
  //   ★빼면 서버가 제 선언값으로 쓰는데 SDP 에는 브라우저 번호가 서 있어 ★**확장이 안 읽히고**,
  //   같은 PT 의 받기 절 둘에서 demuxer 기준이 겹친다(3층 `ONEPC-03` 실측 20260913).
  assert.ok(uris.some((u) => u.endsWith(':mid')), '★sdes:mid 를 신고표에 넣는다')
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
