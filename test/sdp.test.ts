// author: kodeholic (powered by Claude)
// 연§9 조립. 규격 §9-9 의 완성 예시와 줄 단위로 대조한다 — 표가 이기지만 예시와 어긋나면
// 둘 중 하나가 틀린 것이라 그 자리에서 드러나야 한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publishAnswer, SdpError, Seat, subscribeOffer, unifiedOffer } from '../src/internal/sdp/build.js'
import { parse } from '../src/internal/sdp/parse.js'
import { BROWSER_OFFER, CFG, DC_ONLY_OFFER, FP } from './_sdp_fixtures.js'

const lines = (sdp: string): string[] => sdp.split('\r\n').filter((l) => l.length > 0)
const section = (sdp: string, i: number): string[] => {
  const all = lines(sdp)
  const heads = all.map((l, n) => (l.startsWith('m=') ? n : -1)).filter((n) => n >= 0)
  return all.slice(heads[i]!, heads[i + 1] ?? all.length)
}

test('연§9-9-1 보내기 answer — 예시와 전 줄이 같다', () => {
  const got = publishAnswer(BROWSER_OFFER, CFG, { session: { id: '4611731400430051336', version: 2 } })
  assert.deepEqual(lines(got), [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1 2',
    'a=msid-semantic: WMS *',
    'a=ice-lite',
    'm=audio 7000 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:pubUf1',
    'a=ice-pwd:pubPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:0',
    'a=rtcp-mux',
    'a=recvonly',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtcp-fb:111 transport-cc',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
    'm=video 7000 UDP/TLS/RTP/SAVPF 102 103',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:pubUf1',
    'a=ice-pwd:pubPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:1',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=recvonly',
    'a=rtpmap:102 H264/90000',
    'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtcp-fb:102 nack',
    'a=rtcp-fb:102 nack pli',
    'a=rtcp-fb:102 ccm fir',
    'a=rtcp-fb:102 transport-cc',
    'a=rtpmap:103 rtx/90000',
    'a=fmtp:103 apt=102',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
    'm=application 7000 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:pubUf1',
    'a=ice-pwd:pubPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:2',
    'a=sendrecv',
    'a=sctp-port:5000',
    'a=max-message-size:65536',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
  ])
})

test('연§9-9-3 청취 전용 — 미디어 m-line 없이도 협상이 선다', () => {
  const got = publishAnswer(DC_ONLY_OFFER, CFG, { session: { id: '4611731400430051336', version: 2 } })
  assert.deepEqual(lines(got), [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS *',
    'a=ice-lite',
    'm=application 7000 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:pubUf1',
    'a=ice-pwd:pubPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:0',
    'a=sendrecv',
    'a=sctp-port:5000',
    'a=max-message-size:65536',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
  ], '트랙이 없다고 이 연결을 안 세우면 누가 말하는지 영영 안 뜬다')
})

test('answer 의 m-line 개수와 순서는 offer 와 같다', () => {
  const got = parse(publishAnswer(BROWSER_OFFER, CFG))
  const offer = parse(BROWSER_OFFER)
  assert.deepEqual(got.sections.map((m) => [m.kind, m.mid]), offer.sections.map((m) => [m.kind, m.mid]))
  assert.deepEqual(got.bundle, offer.bundle, 'BUNDLE 은 offer 에서 읽은 목록 그대로다')
})

test('서버가 모르는 코덱은 PT 줄째로 빠지고 아는 것은 남는다', () => {
  const offer = BROWSER_OFFER
    .replace('m=video 9 UDP/TLS/RTP/SAVPF 102 103', 'm=video 9 UDP/TLS/RTP/SAVPF 102 103 104')
    .replace('a=rtpmap:103 rtx/90000', 'a=rtpmap:104 VP9/90000\r\na=rtpmap:103 rtx/90000')
  const video = section(publishAnswer(offer, CFG), 1)
  assert.ok(!video.some((l) => l.includes('VP9')), '서버가 못 알아보는 PT 로 보내게 두면 안 된다')
  assert.ok(video[0]!.endsWith('102 103'), 'm-line 의 PT 목록에서도 빠진다')
  assert.ok(video.includes('a=rtpmap:102 H264/90000'))
})

test('남는 코덱이 0개면 조용히 넘어가지 않고 협상 실패다', () => {
  const offer = BROWSER_OFFER.replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:111 PCMU/8000')
  assert.throws(() => publishAnswer(offer, CFG), (e) => {
    assert.ok(e instanceof SdpError)
    assert.equal(e.reason, 'negotiation')
    return true
  }, '코덱 없는 m-line 이 나가면 검은 화면이 된다')
})

test('extmap 번호는 offer 것을 쓴다 — 새로 매기면 rid·mid·twcc 파싱이 죽는다', () => {
  const offer = BROWSER_OFFER.replace(
    'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:7 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  )
  const audio = section(publishAnswer(offer, CFG), 0)
  assert.ok(audio.includes('a=extmap:7 urn:ietf:params:rtp-hdrext:ssrc-audio-level'))
  assert.ok(!audio.some((l) => l.startsWith('a=extmap:4 ')), '서버 번호로 되돌리면 안 된다')
})

test('서버가 선언하지 않은 확장은 answer 에 안 남는다', () => {
  const offer = BROWSER_OFFER.replace(
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=extmap:4',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\na=extmap:9 urn:3gpp:video-orientation\r\na=extmap:4',
  )
  assert.ok(!publishAnswer(offer, CFG).includes('video-orientation'))
})

test('시뮬캐스트는 방향을 recv 로 뒤집는다', () => {
  const offer = BROWSER_OFFER.replace('a=mid:1', 'a=mid:1\r\na=simulcast:send h;l')
  const video = section(publishAnswer(offer, CFG), 1)
  assert.ok(video.includes('a=rid:h recv') && video.includes('a=rid:l recv'))
  assert.ok(video.includes('a=simulcast:recv h;l'), '빼면 브라우저가 한 단만 보낸다')
  assert.ok(!section(publishAnswer(BROWSER_OFFER, CFG), 1).some((l) => l.startsWith('a=rid:')),
    'offer 에 없으면 넣지 않는다')
})

test('opus 받는 쪽 선호만 answer 가 정하고 이름·클럭·PT 는 원문이다', () => {
  const audio = section(publishAnswer(BROWSER_OFFER, CFG, { audioPrefs: { usedtx: 1, stereo: 0 } }), 0)
  assert.ok(audio.includes('a=rtpmap:111 opus/48000/2'), '코덱 줄은 offer 원문 그대로다')
  const fmtp = audio.find((l) => l.startsWith('a=fmtp:111'))!
  assert.match(fmtp, /minptime=10/)
  assert.match(fmtp, /useinbandfec=1/)
  assert.match(fmtp, /usedtx=1/)
  assert.match(fmtp, /stereo=0/)
})

test('offer 가 inactive 면 answer 도 inactive 다', () => {
  const offer = BROWSER_OFFER.replace('a=mid:1\r\na=sendrecv', 'a=mid:1\r\na=inactive')
  assert.ok(section(publishAnswer(offer, CFG), 1).includes('a=inactive'))
})

const SEATS: Seat[] = [
  {
    mid: '0', kind: 'audio', room_id: 'r1', user_id: 'u2', track_id: 't-u2-mic',
    ssrc: 1001, pt: 111, codec: 'opus', fmtp: 'minptime=10;useinbandfec=1',
  },
  {
    mid: '1', kind: 'video', room_id: 'r1', track_id: 'ptt-r1-video',
    ssrc: 2001, rtx_ssrc: 2002, pt: 102, rtx_pt: 103, codec: 'H264',
    fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  },
  { mid: '2', kind: 'video', room_id: 'r1', track_id: 't-u3-cam', pt: 102, codec: 'H264', active: false },
]

// ★연§9-5 표는 받기 audio 확장을 4·5·6 으로 정하는데 §9-9-2 예시에는 5 가 없다.
// 규격이 "표가 이긴다"고 못박으므로 표를 따른다.
test('연§9-9-2 받기 offer — 예시와 전 줄이 같다(표가 이기는 한 줄만 다르다)', () => {
  const got = subscribeOffer(SEATS, CFG, { session: { id: '1756000000000', version: 1 } })
  assert.deepEqual(lines(got), [
    'v=0',
    'o=- 1756000000000 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1 2',
    'a=msid-semantic: WMS *',
    'a=ice-lite',
    'm=audio 7000 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:subUf1',
    'a=ice-pwd:subPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:0',
    'a=rtcp-mux',
    'a=sendonly',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtcp-fb:111 transport-cc',
    'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=msid:ox-u2 t-u2-mic',
    'a=ssrc:1001 cname:ox-sfu',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
    'm=video 7000 UDP/TLS/RTP/SAVPF 102 103',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:subUf1',
    'a=ice-pwd:subPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:1',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=sendonly',
    'a=rtpmap:102 H264/90000',
    'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtcp-fb:102 nack',
    'a=rtcp-fb:102 nack pli',
    'a=rtcp-fb:102 ccm fir',
    'a=rtcp-fb:102 transport-cc',
    'a=rtpmap:103 rtx/90000',
    'a=fmtp:103 apt=102',
    'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=msid:ox-ptt ptt-r1-video',
    'a=ssrc:2001 cname:ox-sfu',
    'a=ssrc:2002 cname:ox-sfu',
    'a=ssrc-group:FID 2001 2002',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
    'm=video 7 UDP/TLS/RTP/SAVPF 102',
    'c=IN IP4 203.0.113.10',
    'a=ice-ufrag:subUf1',
    'a=ice-pwd:subPw1',
    `a=fingerprint:${FP}`,
    'a=setup:passive',
    'a=mid:2',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=inactive',
    'a=rtpmap:102 H264/90000',
    'a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0',
    'a=end-of-candidates',
  ])
})

test('받기에서 sdes:mid 는 어느 m-line 에도 없다', () => {
  assert.ok(!subscribeOffer(SEATS, CFG).includes('sdes:mid'),
    '선언하면 브라우저가 RTP mid 로 m-line 을 골라 BUNDLE 구분이 깨진다')
})

test('조립 순서는 mid 수치다', () => {
  const many: Seat[] = ['10', '2', '0'].map((mid) => ({
    ...SEATS[0]!, mid, track_id: `t${mid}`, ssrc: 1000 + Number(mid),
  }))
  const got = parse(subscribeOffer(many, CFG))
  assert.deepEqual(got.sections.map((m) => m.mid), ['0', '2', '10'])
  assert.deepEqual(got.bundle, ['0', '2', '10'], 'BUNDLE 도 같은 차례다')
})

test('pt 가 없으면 정책표로 채우지 않고 실패로 다룬다', () => {
  const seat = { ...SEATS[0]! } as Record<string, unknown>
  delete seat.pt
  assert.throws(() => subscribeOffer([seat as unknown as Seat], CFG), (e) => {
    assert.ok(e instanceof SdpError)
    assert.equal(e.reason, 'missing_pt')
    return true
  }, '폴백은 조용히 검은 화면을 만든다')
})

test('audio 에는 NACK 을 협상하지 않는다', () => {
  const cfg = {
    ...CFG,
    codecs_sub: [{ kind: 'audio' as const, name: 'opus', rtcp_fb: ['nack', 'transport-cc'] }],
  }
  const audio = section(subscribeOffer([SEATS[0]!], cfg), 0)
  assert.ok(!audio.some((l) => l.startsWith('a=rtcp-fb:111 nack')),
    '반이중 슬롯은 화자 교대마다 seq 가 건너뛰어 NACK 이 폭주한다')
  assert.ok(audio.includes('a=rtcp-fb:111 transport-cc'))
})

test('받기 rtcp_fb 는 codecs_sub 가 오면 그것이 지배한다', () => {
  const cfg = {
    ...CFG,
    codecs_sub: [{ kind: 'video' as const, name: 'H264', rtcp_fb: ['nack pli'] }],
  }
  const video = section(subscribeOffer([SEATS[1]!], cfg), 0)
  assert.deepEqual(video.filter((l) => l.startsWith('a=rtcp-fb:')), ['a=rtcp-fb:102 nack pli'])
})

test('codecs_sub 는 rtcp_fb 만 지배한다 — PT·코덱·fmtp 는 TrackEntry 것이다', () => {
  const cfg = { ...CFG, codecs_sub: [{ kind: 'video' as const, name: 'VP8', rtcp_fb: ['nack'] }] }
  const video = section(subscribeOffer([SEATS[1]!], cfg), 0)
  assert.ok(video.includes('a=rtpmap:102 H264/90000'))
  assert.ok(video.some((l) => l.startsWith('a=fmtp:102 level-asymmetry-allowed=1')))
})

test('rtx 는 ssrc 두 줄과 FID 를 짝으로 갖는다', () => {
  const video = section(subscribeOffer([SEATS[1]!], CFG), 0).join('\n')
  assert.ok(video.includes('a=ssrc-group:FID 2001 2002'),
    'FID 를 빠뜨리면 재전송 패킷을 원본으로 오인한다')

  const noRtx = { ...SEATS[1]! } as Record<string, unknown>
  delete noRtx.rtx_ssrc; delete noRtx.rtx_pt
  const plain = section(subscribeOffer([noRtx as unknown as Seat], CFG), 0).join('\n')
  assert.ok(!plain.includes('ssrc-group') && !plain.includes('rtx/'))
})

test('무전 슬롯은 stream-id 가 ox-ptt 하나다', () => {
  assert.ok(section(subscribeOffer([SEATS[1]!], CFG), 0).includes('a=msid:ox-ptt ptt-r1-video'))
})

test('일반 트랙의 stream-id 는 source 까지 붙는다', () => {
  const seat: Seat = { ...SEATS[0]!, user_id: 'u9', source: 'screen', track_id: 't-u9-scr' }
  assert.ok(section(subscribeOffer([seat], CFG), 0).includes('a=msid:ox-u9-screen t-u9-scr'))
})

test('안 쓰는 m-line 은 port 7 이고 msid·ssrc 가 없다', () => {
  const seat = section(subscribeOffer([SEATS[2]!], CFG), 0)
  assert.ok(seat[0]!.startsWith('m=video 7 '), 'port 0 이면 BUNDLE 태그가 옮겨가 전송이 깨진다')
  assert.ok(!seat.some((l) => l.startsWith('a=msid') || l.startsWith('a=ssrc')))
  assert.ok(seat.includes('a=rtpmap:102 H264/90000'), '코덱 줄은 그 자리의 pt·codec 으로 짓는다')
})

test('ICE 자격은 연결마다 다르다', () => {
  assert.ok(subscribeOffer(SEATS, CFG).includes('a=ice-ufrag:subUf1'))
  assert.ok(publishAnswer(BROWSER_OFFER, CFG).includes('a=ice-ufrag:pubUf1'))
})

// ── 연§9-10 1pc — 2pc 가 구조로 공짜로 얻는 것을 손으로 지키는 자리 ──────────────

const CONFIRMED = publishAnswer(BROWSER_OFFER, CFG)

test('통합 offer 는 보내기·받기를 한 BUNDLE 에 담는다', () => {
  const got = parse(unifiedOffer([{ ...SEATS[0]!, mid: '32' }], CFG, {
    mine: BROWSER_OFFER, confirmed: CONFIRMED,
  }))
  assert.deepEqual(got.bundle, ['0', '1', '2', '32'])
  assert.deepEqual(got.sections.map((m) => m.mid), ['0', '1', '2', '32'])
})

test('1pc 는 ICE 자격을 publish 한 벌만 쓴다', () => {
  const sdp = unifiedOffer([{ ...SEATS[0]!, mid: '32' }], CFG, { mine: BROWSER_OFFER, confirmed: CONFIRMED })
  assert.ok(!sdp.includes('subUf1'), '한 BUNDLE 에 자격이 둘이면 전송로가 안 선다')
  assert.equal(sdp.split('a=ice-ufrag:pubUf1').length - 1, 4)
})

test('보내기 방향은 서버 시각으로 뒤집힌다', () => {
  const sdp = unifiedOffer([{ ...SEATS[0]!, mid: '32' }], CFG, { mine: BROWSER_OFFER, confirmed: CONFIRMED })
  assert.equal(section(sdp, 0).includes('a=recvonly'), true, '내 트랙은 서버가 받는다')
  assert.equal(section(sdp, 3).includes('a=sendonly'), true, '남의 트랙은 서버가 보낸다')
  assert.ok(section(sdp, 2).includes('a=sendrecv'), '데이터 채널은 양방향이다')
})

test('보내기 코덱 줄은 확정 answer 에서 온다 — 내 offer 목록이 아니다', () => {
  const mine = BROWSER_OFFER
    .replace('m=audio 9 UDP/TLS/RTP/SAVPF 111', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 8')
    .replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:111 opus/48000/2\r\na=rtpmap:8 PCMA/8000')
  const audio = section(unifiedOffer([], CFG, { mine, confirmed: CONFIRMED }), 0)
  assert.ok(!audio.some((l) => l.includes('PCMA')),
    '내 offer 를 되비추면 answer 가 걸러냈던 코덱이 되살아난다')
  assert.ok(audio[0]!.endsWith('SAVPF 111'))
})

test('확정 answer 가 없는 m-line 은 조용히 넘어가지 않는다', () => {
  assert.throws(() => unifiedOffer([], CFG, { mine: BROWSER_OFFER, confirmed: 'v=0\r\n' }), (e) => {
    assert.ok(e instanceof SdpError)
    assert.equal(e.reason, 'negotiation')
    return true
  }, '2단계에서 inactive 트랜시버를 안 세우면 여기서 멈춘다')
})

test('extmap 번호는 내 offer 것이고 받기도 확정본 번호를 쓴다', () => {
  const mine = BROWSER_OFFER.replace(
    'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:7 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  )
  const confirmed = publishAnswer(mine, CFG)
  const sdp = unifiedOffer([{ ...SEATS[0]!, mid: '32' }], CFG, { mine, confirmed })
  assert.ok(section(sdp, 0).includes('a=extmap:7 urn:ietf:params:rtp-hdrext:ssrc-audio-level'))
  assert.ok(section(sdp, 3).includes('a=extmap:7 urn:ietf:params:rtp-hdrext:ssrc-audio-level'),
    '한 BUNDLE 이라 URI 마다 번호가 하나여야 한다')
})

test('1pc 받기에서도 sdes:mid 는 뺀다', () => {
  const sdp = unifiedOffer([{ ...SEATS[0]!, mid: '32' }], CFG, { mine: BROWSER_OFFER, confirmed: CONFIRMED })
  assert.ok(!section(sdp, 3).some((l) => l.includes('sdes:mid')))
  assert.ok(section(sdp, 0).some((l) => l.includes('sdes:mid')), '보내기에는 남는다')
})

test('msid 는 따로 줄로 쓰고 ssrc 에는 cname 만 단다', () => {
  const recv = section(unifiedOffer([{ ...SEATS[0]!, mid: '32' }], CFG, {
    mine: BROWSER_OFFER, confirmed: CONFIRMED,
  }), 3)
  assert.ok(recv.includes('a=msid:ox-u2 t-u2-mic'))
  assert.ok(recv.includes('a=ssrc:1001 cname:ox-sfu'))
  assert.ok(!recv.some((l) => l.startsWith('a=ssrc:') && l.includes('msid:')),
    '합쳐 쓰면 같은 연결의 시뮬캐스트 송신 단이 증발한다')
})

test('비게 된 보내기 m-line 은 inactive 로 남는다', () => {
  const mine = BROWSER_OFFER.replace('a=mid:1\r\na=sendrecv', 'a=mid:1\r\na=inactive')
  const sdp = unifiedOffer([], CFG, { mine, confirmed: publishAnswer(mine, CFG) })
  const video = section(sdp, 1)
  assert.ok(video.includes('a=inactive'))
  assert.ok(parse(sdp).bundle.includes('1'), '없애면 BUNDLE 태그가 옮겨가 전송이 깨진다')
})

// 연§9-10 규칙 1 — `1pc` 은 한 벌이라 브라우저 offer 에 받기 m-line 이 딸려 나온다.
// 그 자리를 `recvonly` 로 답하면 브라우저가 방향 불일치로 거부한다.
const ONE_PC_OFFER = [
  'v=0',
  'o=- 4611731400430051336 3 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 32',
  'a=msid-semantic: WMS *',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:cliUf1',
  'a=ice-pwd:cliPw1',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendonly',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:cliUf1',
  'a=ice-pwd:cliPw1',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:32',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
].join('\r\n')

const SEAT_32: Seat = {
  mid: '32', kind: 'audio', pt: 111, codec: 'opus', ssrc: 1001, track_id: 't-u2-mic', user_id: 'u2', room_id: 'r1',
}

test('연§9-10 규칙 1 — 딸려 나온 받기 자리를 sendonly + SSRC 로 답한다', () => {
  const got = publishAnswer(ONE_PC_OFFER, CFG, { seats: [SEAT_32] })
  const recv = section(got, 1)
  assert.ok(recv.includes('a=mid:32') && recv.includes('a=sendonly'), '받기 자리는 서버가 보낸다')
  assert.ok(!recv.includes('a=recvonly'), 'recvonly 로 답하면 방향 불일치로 거부된다')
  assert.ok(recv.includes('a=msid:ox-u2 t-u2-mic') && recv.includes('a=ssrc:1001 cname:ox-sfu'))
  assert.ok(!recv.some((l) => l.startsWith('a=extmap:1 ')), '받기에서 sdes:mid 는 뺀다(연§9-5)')
  assert.equal(section(got, 0).find((l) => l.startsWith('a=recv') || l.startsWith('a=send')), 'a=recvonly')
  assert.ok(lines(got).includes('a=group:BUNDLE 0 32'), 'm-line 개수와 순서는 offer 그대로다')
})

test('연§9-10 규칙 2 — 상대 축 번호는 offer 에 선 것 그대로다', () => {
  const recv = section(publishAnswer(ONE_PC_OFFER, CFG, { seats: [SEAT_32] }), 1)
  assert.deepEqual(recv.filter((l) => l.startsWith('a=extmap:')), [
    'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  ])
})

test('연§9-10-1 — 받기 mid 가 내 offer 에도 있으면 한 번만 싣는다', () => {
  const got = unifiedOffer([SEAT_32], CFG, { mine: ONE_PC_OFFER, confirmed: publishAnswer(ONE_PC_OFFER, CFG, { seats: [SEAT_32] }) })
  assert.ok(lines(got).includes('a=group:BUNDLE 0 32'), 'mid 가 BUNDLE 에 두 번 들어가지 않는다')
  assert.equal(lines(got).filter((l) => l === 'a=mid:32').length, 1, 'm-line 이 겹치지 않는다')
})
