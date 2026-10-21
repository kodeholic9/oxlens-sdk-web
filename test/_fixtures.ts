// author: kodeholic (powered by Claude)
// 연:EX-LINK-SDP-PUB-ANSWER · 연:EX-LINK-SDP-SUB-OFFER · 연:EX-LINK-SDP-LISTEN-ONLY 의 재료(규격 원천 areas/link/model/sdp.ts 의 예시 값 그대로)
import type { ServerConfig, MlineEntry } from '../src/internal/wire/ws.js'

export const FP = 'sha-256 AB:CD:EF:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D'

export const SC: ServerConfig = {
  sfu_id: 'sfu-7f3a', pc_mode: '2pc',
  ice: { ip: '203.0.113.10', port: 7000, publish_ufrag: 'pubUf1', publish_pwd: 'pubPw1', subscribe_ufrag: 'subUf1', subscribe_pwd: 'subPw1' },
  dtls: { fingerprint: FP, setup: 'passive' },
  codecs: [{ kind: 'audio', name: 'opus', rtcp_fb: ['transport-cc'] }, { kind: 'video', name: 'H264', rtcp_fb: ['nack', 'nack pli', 'ccm fir', 'transport-cc'] }],
  extmap: [
    { id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }, { id: 4, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' },
    { id: 5, uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time' }, { id: 6, uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01' },
    { id: 10, uri: 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id' }, { id: 11, uri: 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id' },
  ],
  max_bitrate_bps: 800000,
}

const H264 = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'

/** 배정표 — 전이중 줄 1 + 무전 슬롯 1 + 빈 줄 1(연:EX-LINK-SDP-SUB-OFFER) */
export const ROWS: MlineEntry[] = [
  { mid: '0', kind: 'audio', pt: 111, codec: 'opus', fmtp: 'minptime=10;useinbandfec=1', track_id: 't-u2-mic', room_id: 'r1', ssrc: 2147484649, stream_id: 'ox-m0' },
  { mid: '1', kind: 'video', pt: 102, codec: 'H264', fmtp: H264, rtx_pt: 103, track_id: 'ptt-r1-video', room_id: 'r1', ssrc: 2147485649, rtx_ssrc: 2147485650, stream_id: 'ox-ptt' },
  { mid: '2', kind: 'video', pt: 102, codec: 'H264', fmtp: H264, rtx_pt: 103, ssrc: 2147486649, rtx_ssrc: 2147486650, stream_id: 'ox-m2' },
]

function head(mid: string, ufrag: string, pwd: string, video: boolean, media = true): string[] {
  return ['c=IN IP4 203.0.113.10', `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:${FP}`, 'a=setup:passive', `a=mid:${mid}`, ...(media ? ['a=rtcp-mux'] : []), ...(video ? ['a=rtcp-rsize'] : [])]
}
const TAIL = ['a=candidate:1 1 udp 2113937151 203.0.113.10 7000 typ host generation 0', 'a=end-of-candidates']
const VFB = ['a=rtcp-fb:102 nack', 'a=rtcp-fb:102 nack pli', 'a=rtcp-fb:102 ccm fir', 'a=rtcp-fb:102 transport-cc']
const VEXT = ['a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', 'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01']

/** 연:EX-LINK-SDP-SUB-OFFER 조립 결과 그대로 */
export const SUB_OFFER = [
  'v=0', 'o=- 1756000000000 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2', 'a=msid-semantic: WMS *', 'a=ice-lite',
  'm=audio 7000 UDP/TLS/RTP/SAVPF 111', ...head('0', 'subUf1', 'subPw1', false), 'a=sendonly', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtcp-fb:111 transport-cc',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', 'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=msid:ox-m0 ox-m0', 'a=ssrc:2147484649 cname:ox-sfu', ...TAIL,
  'm=video 7000 UDP/TLS/RTP/SAVPF 102 103', ...head('1', 'subUf1', 'subPw1', true), 'a=sendonly', 'a=rtpmap:102 H264/90000', `a=fmtp:102 ${H264}`, ...VFB, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...VEXT,
  'a=msid:ox-ptt ox-m1', 'a=ssrc:2147485649 cname:ox-sfu', 'a=ssrc:2147485650 cname:ox-sfu', 'a=ssrc-group:FID 2147485649 2147485650', ...TAIL,
  'm=video 7000 UDP/TLS/RTP/SAVPF 102 103', ...head('2', 'subUf1', 'subPw1', true), 'a=sendonly', 'a=rtpmap:102 H264/90000', `a=fmtp:102 ${H264}`, ...VFB, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...VEXT,
  'a=msid:ox-m2 ox-m2', 'a=ssrc:2147486649 cname:ox-sfu', 'a=ssrc:2147486650 cname:ox-sfu', 'a=ssrc-group:FID 2147486649 2147486650', ...TAIL,
]

/** 연:EX-LINK-SDP-PUB-ANSWER 의 브라우저 offer — audio 0 · video 1 inactive · application 2 */
export const PUB_OFFER = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2', 'a=msid-semantic: WMS',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:cliUf9', 'a=ice-pwd:cliPw9', 'a=fingerprint:sha-256 11:22', 'a=setup:actpass', 'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=inactive', 'a=rtcp-mux', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 103', 'c=IN IP4 0.0.0.0', 'a=mid:1',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', 'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'a=inactive', 'a=rtcp-mux', 'a=rtpmap:102 H264/90000', `a=fmtp:102 ${H264}`, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=mid:2', 'a=sctp-port:5000', 'a=max-message-size:262144',
].join('\r\n') + '\r\n'

const AEXT = ['a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01']

/** 연:EX-LINK-SDP-PUB-ANSWER 조립 결과 그대로 */
export const PUB_ANSWER = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2', 'a=msid-semantic: WMS *', 'a=ice-lite',
  'm=audio 7000 UDP/TLS/RTP/SAVPF 111', ...head('0', 'pubUf1', 'pubPw1', false), 'a=inactive', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtcp-fb:111 transport-cc', ...AEXT, ...TAIL,
  'm=video 7000 UDP/TLS/RTP/SAVPF 102 103', ...head('1', 'pubUf1', 'pubPw1', true), 'a=inactive', 'a=rtpmap:102 H264/90000', `a=fmtp:102 ${H264}`, ...VFB, 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102', ...VEXT, ...TAIL,
  'm=application 7000 UDP/DTLS/SCTP webrtc-datachannel', ...head('2', 'pubUf1', 'pubPw1', false, false), 'a=sendrecv', 'a=sctp-port:5000', 'a=max-message-size:65536', ...TAIL,
]

/** 연:EX-LINK-SDP-LISTEN-ONLY 브라우저 offer */
export const DC_OFFER = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:cliUf9', 'a=ice-pwd:cliPw9', 'a=fingerprint:sha-256 11:22:…', 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
].join('\r\n') + '\r\n'

export const DC_ANSWER = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS *', 'a=ice-lite',
  'm=application 7000 UDP/DTLS/SCTP webrtc-datachannel', ...head('0', 'pubUf1', 'pubPw1', false, false), 'a=sendrecv', 'a=sctp-port:5000', 'a=max-message-size:65536', ...TAIL,
]
