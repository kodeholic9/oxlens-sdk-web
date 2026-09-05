// author: kodeholic (powered by Claude)
// 연§4-2 ServerConfig — 미디어를 붙이는 재료. 미디어 서버의 신원은 sfu_id 이지 주소가 아니다.

export interface IceConfig {
  readonly ip: string
  readonly port: number
  readonly publish_ufrag: string
  readonly publish_pwd: string
  readonly subscribe_ufrag?: string
  readonly subscribe_pwd?: string
}

export interface CodecPolicy {
  readonly kind: 'audio' | 'video'
  readonly name: string
  readonly rtcp_fb?: readonly string[]
}

export interface ServerConfig {
  readonly sfu_id: string
  readonly pc_mode: '1pc' | '2pc'
  readonly ice: IceConfig
  readonly dtls: { readonly fingerprint: string; readonly setup: string }
  readonly codecs: readonly CodecPolicy[]
  readonly codecs_sub?: readonly CodecPolicy[]
  readonly extmap: readonly { readonly id: number; readonly uri: string }[]
  readonly max_bitrate_bps?: number
}

export const URI_MID = 'urn:ietf:params:rtp-hdrext:sdes:mid'
export const URI_AUDIO_LEVEL = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level'
export const URI_ABS_SEND_TIME = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'
export const URI_TWCC = 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'
export const URI_RID = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'
export const URI_REPAIRED_RID = 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id'

/** 연§4-2 — 받기에 실을 수 있는 확장. sdes:mid 는 뺀다(연§9-5). */
const RECV_URIS: Readonly<Record<'audio' | 'video', readonly string[]>> = {
  audio: [URI_AUDIO_LEVEL, URI_ABS_SEND_TIME, URI_TWCC],
  video: [URI_ABS_SEND_TIME, URI_TWCC],
}

export function recvExtmap(cfg: ServerConfig, kind: 'audio' | 'video'): readonly { id: number; uri: string }[] {
  return cfg.extmap.filter((e) => RECV_URIS[kind].includes(e.uri))
}

/** 연§9-5 — 코덱 이름에서 정해지는 상수다. PT 폴백 금지와는 다른 물건이다. */
export function clockRate(codec: string): { hz: number; channels?: number } {
  if (codec.toLowerCase() === 'opus') return { hz: 48000, channels: 2 }
  return { hz: 90000 }
}

/**
 * 연§9-5 — rtcp_fb 는 codecs_sub 가 오면 그것이, 없으면 codecs 가 지배한다.
 * audio 에는 NACK 을 협상하지 않는다(반이중 슬롯은 화자 교대마다 seq 가 건너뛴다).
 */
export function recvFeedback(cfg: ServerConfig, kind: 'audio' | 'video', codec: string): readonly string[] {
  const table = cfg.codecs_sub ?? cfg.codecs
  const hit = table.find((c) => c.kind === kind && c.name.toLowerCase() === codec.toLowerCase())
  const fb = hit?.rtcp_fb ?? []
  return kind === 'audio' ? fb.filter((f) => !f.startsWith('nack')) : fb
}

export function sendFeedback(cfg: ServerConfig, kind: 'audio' | 'video', codec: string): readonly string[] {
  const hit = cfg.codecs.find((c) => c.kind === kind && c.name.toLowerCase() === codec.toLowerCase())
  return hit?.rtcp_fb ?? []
}

export function supportsSend(cfg: ServerConfig, kind: 'audio' | 'video', codec: string): boolean {
  return cfg.codecs.some((c) => c.kind === kind && c.name.toLowerCase() === codec.toLowerCase())
}
