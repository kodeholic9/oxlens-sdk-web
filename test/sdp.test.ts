// author: kodeholic (powered by Claude)
// 연:RULE-LINK-SDP-* 조립 — 판정 근거는 연동규격서 완성 예시(연:EX-LINK-SDP-PUB-ANSWER · SUB-OFFER · LISTEN-ONLY)다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Sdp from '../src/internal/sdp.js'
import { pickRoom } from '../src/internal/transport.js'
import { ROOM_OPUS_FMTP } from '../src/domain/defaults.js'
import { SC, ROWS, SUB_OFFER, PUB_OFFER, PUB_ANSWER, DC_OFFER, DC_ANSWER } from './_fixtures.js'

const sub: Sdp.Wire = { sc: SC, creds: { ufrag: 'subUf1', pwd: 'subPw1' }, udp: true }
const pub: Sdp.Wire = { sc: SC, creds: { ufrag: 'pubUf1', pwd: 'pubPw1' }, udp: true }
const lines = (s: string): string[] => s.split('\r\n').filter((l) => l)

test('연:EX-LINK-SDP-SUB-OFFER — 배정표만으로 구독 offer 를 짓는다(빈 줄도 같은 모양)', () => {
  assert.deepEqual(lines(Sdp.subOffer(sub, { id: '1756000000000', version: 1 }, ROWS)), SUB_OFFER)
})

test('연:EX-LINK-SDP-PUB-ANSWER — offer 의 m-line 순서 · 개수 그대로 · rtcp-fb 만 서버 값', () => {
  assert.deepEqual(lines(Sdp.answer(pub, Sdp.parse(PUB_OFFER), () => ROOM_OPUS_FMTP)), PUB_ANSWER)
})

test('연:EX-LINK-SDP-LISTEN-ONLY — m=application 하나로 협상이 선다', () => {
  assert.deepEqual(lines(Sdp.answer(pub, Sdp.parse(DC_OFFER), () => ROOM_OPUS_FMTP)), DC_ANSWER)
})

test('연:RULE-LINK-SDP-SUB-MLINE 정렬 — mid 수치 오름차순("10" 은 "2" 뒤)', () => {
  const rows = [{ ...ROWS[2]!, mid: '10' }, { ...ROWS[0]!, mid: '2' }]
  const got = lines(Sdp.subOffer(sub, { id: '1', version: 1 }, rows)).filter((l) => l.startsWith('a=mid:'))
  assert.deepEqual(got, ['a=mid:2', 'a=mid:10'])
})

test('연:RULE-LINK-SDP-SUB-MLINE RTX — 짝이 깨지면 실패로 다룬다', () => {
  const broken = [{ ...ROWS[1]!, rtx_ssrc: undefined } as unknown as (typeof ROWS)[number]]
  assert.throws(() => Sdp.subOffer(sub, { id: '1', version: 1 }, broken))
})

test('연:RULE-LINK-SDP-COMMON — tcp_port 가 오면 TCP passive 줄 · QA 스위치가 UDP 줄을 끈다', () => {
  const sc = { ...SC, ice: { ...SC.ice, tcp_port: 7443 } }
  const got = lines(Sdp.subOffer({ ...sub, sc, udp: false }, { id: '1', version: 1 }, [ROWS[0]!])).filter((l) => l.startsWith('a=candidate'))
  assert.deepEqual(got, ['a=candidate:2 1 tcp 2113937150 203.0.113.10 7443 typ host tcptype passive generation 0'])
})

test('연:RULE-LINK-SDP-PUB-MLINE 남는 코덱 0 개 — 조용히 넘어가지 않는다', () => {
  const vp8only = PUB_OFFER.replace('a=rtpmap:102 H264/90000', 'a=rtpmap:102 VP9/90000')
  const sc = { ...SC, codecs: SC.codecs.filter((c) => c.kind === 'audio') }
  assert.throws(() => Sdp.answer({ ...pub, sc }, Sdp.parse(vp8only), () => ROOM_OPUS_FMTP))
})

test('연:RULE-LINK-SDP-PUB-MLINE 시뮬캐스트 — rid 를 recv 로 뒤집고 낮은 품질부터', () => {
  const sim = PUB_OFFER.replace('a=mid:1\r\n', 'a=mid:1\r\na=rid:l send\r\na=rid:h send\r\na=simulcast:send l;h\r\n').replace(/a=inactive\r\na=rtcp-mux\r\na=rtpmap:102/, 'a=sendonly\r\na=rtcp-mux\r\na=rtpmap:102')
  const got = lines(Sdp.answer(pub, Sdp.parse(sim), () => ROOM_OPUS_FMTP))
  const v = got.slice(got.findIndex((l) => l.startsWith('m=video')))
  assert.ok(v.includes('a=recvonly'))
  assert.deepEqual(v.filter((l) => l.startsWith('a=rid') || l.startsWith('a=simulcast')), ['a=rid:l recv', 'a=rid:h recv', 'a=simulcast:recv l;h'])
})

test('연:RULE-LINK-SDP-PUB-MLINE 코덱 고르기 — H264 는 패킷화 · profile 이 방 값과 같은 줄(level 은 보지 않는다)', () => {
  const cs: Sdp.Codec[] = [
    { pt: 96, rtpmap: 'VP8/90000' },
    { pt: 100, rtpmap: 'H264/90000', fmtp: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { pt: 102, rtpmap: 'H264/90000', fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
    { pt: 108, rtpmap: 'H264/90000', fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034', rtx: 109 },
  ]
  assert.deepEqual(pickRoom(cs, { name: 'H264' }).map((c) => c.pt), [108])
  assert.deepEqual(pickRoom(cs, { name: 'VP8' }).map((c) => c.pt), [96])
})

test('연:RULE-LINK-SDP-1PC-FILL 구독 extmap — 번호표 번호 · 없으면 서버 번호 · 겹치면 둘 어디에도 없는 가장 작은 번호', () => {
  const mine = [{ id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }, { id: 3, uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01' }, { id: 5, uri: 'urn:example:other' }]
  assert.deepEqual(Sdp.onePcExtId(SC, mine, SC.extmap[0]!), { id: 1, uri: SC.extmap[0]!.uri })
  assert.deepEqual(Sdp.onePcExtId(SC, mine, SC.extmap[3]!), { id: 3, uri: SC.extmap[3]!.uri })
  assert.deepEqual(Sdp.onePcExtId(SC, mine, SC.extmap[1]!), { id: 4, uri: SC.extmap[1]!.uri })
  assert.deepEqual(Sdp.onePcExtId(SC, mine, SC.extmap[2]!), { id: 2, uri: SC.extmap[2]!.uri })
})

test('연:RULE-ROOM-JOIN-NUMBER-TAGS — 번호표는 offer 의 코덱 줄 전량 · 확장 ID 전량', () => {
  const t = Sdp.numberTags(PUB_OFFER)
  assert.deepEqual(t.codecs, [
    { kind: 'audio', pt: 111, name: 'opus', fmtp: 'minptime=10;useinbandfec=1' },
    { kind: 'video', pt: 102, name: 'H264', fmtp: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', rtx_pt: 103 },
  ])
  assert.deepEqual(t.extmap.map((e) => e.id), [1, 4, 6, 5])
})

test('연:RULE-LINK-SDP-1PC 통합 offer — 발행 절 · 구독 절 · 데이터 채널이 자리 그대로 한 벌에', () => {
  const ans = Sdp.parse(Sdp.answer(pub, Sdp.parse(PUB_OFFER), () => ROOM_OPUS_FMTP))
  const a = ans.media[0]!
  const sections: Sdp.OneSection[] = [
    { t: 'send', s: { mid: a.mid, kind: 'audio', dir: 'recvonly', codecs: a.codecs, ext: a.ext, rids: [] } },
    { t: 'app', mid: '2' },
    { t: 'recv', row: { ...ROWS[0]!, mid: '32' } },
  ]
  const got = lines(Sdp.onePcOffer(pub, { id: '4611731400430051336', version: 3 }, sections, Sdp.numberTags(PUB_OFFER).extmap))
  assert.equal(got[1], 'o=- 4611731400430051336 3 IN IP4 127.0.0.1')
  assert.equal(got[4], 'a=group:BUNDLE 0 2 32')
  assert.ok(got.includes('a=recvonly') && got.includes('a=sendonly'))
  assert.ok(got.every((l) => !l.startsWith('a=ice-ufrag:subUf1')), '1pc 는 subscribe 자격을 쓰지 않는다')
})
