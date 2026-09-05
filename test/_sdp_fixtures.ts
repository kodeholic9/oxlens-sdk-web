// author: kodeholic (powered by Claude)
// 연§9-9 완성 예시의 재료. 예시는 비규범이지만 표를 한 번에 투영한 것이라 대조 대상으로 쓴다.
import type { ServerConfig } from '../src/internal/sdp/config.js'

export const FP =
  'sha-256 AB:CD:EF:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D'

export const CFG: ServerConfig = {
  sfu_id: 'sfu-7f3a',
  pc_mode: '2pc',
  ice: {
    ip: '203.0.113.10', port: 7000,
    publish_ufrag: 'pubUf1', publish_pwd: 'pubPw1',
    subscribe_ufrag: 'subUf1', subscribe_pwd: 'subPw1',
  },
  dtls: { fingerprint: FP, setup: 'passive' },
  codecs: [
    { kind: 'audio', name: 'opus', rtcp_fb: ['transport-cc'] },
    { kind: 'video', name: 'H264', rtcp_fb: ['nack', 'nack pli', 'ccm fir', 'transport-cc'] },
    { kind: 'video', name: 'VP8', rtcp_fb: ['nack', 'nack pli', 'ccm fir', 'transport-cc'] },
  ],
  extmap: [
    { id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' },
    { id: 4, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' },
    { id: 5, uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time' },
    { id: 6, uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01' },
    { id: 10, uri: 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id' },
    { id: 11, uri: 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id' },
  ],
  max_bitrate_bps: 2_000_000,
}

/** 브라우저가 낸 offer — audio opus 111 · video H264 102(+rtx 103) · application. */
export const BROWSER_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'a=msid-semantic: WMS *',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:cliUf1',
  'a=ice-pwd:cliPw1',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtcp-fb:111 transport-cc',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=extmap:4 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 103',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:cliUf1',
  'a=ice-pwd:cliPw1',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:1',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtcp-rsize',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
  'a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  'a=extmap:6 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:cliUf1',
  'a=ice-pwd:cliPw1',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:2',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
].join('\r\n')

/** 연§9-9-3 — 트랙 없는 보내기 연결. 청취 전용의 정상 경로다. */
export const DC_ONLY_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic: WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:cliUf9',
  'a=ice-pwd:cliPw9',
  'a=fingerprint:sha-256 11:22:33',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
].join('\r\n')
