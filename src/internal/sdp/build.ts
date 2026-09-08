// author: kodeholic (powered by Claude)
// 연§9 — 서버 쪽 SDP 를 클라가 조립해 자기 브라우저에 먹인다.
// 보내기는 answer, 받기는 offer 다(연§9-0). 방향을 뒤집으면 받기 m-line 이 0개가 된다.
import { ServerConfig, URI_MID, clockRate, recvExtmap, recvFeedback, sendFeedback, supportsSend } from './config.js'
import { MSection, ParsedSdp, clockOf, codecOf, parse, rtxOf } from './parse.js'

/** 연§9-3 — 후보가 하나뿐이라 우선순위는 호스트 고정값이다. */
const HOST_PRIORITY = 2113937151
const CNAME = 'ox-sfu'
const PTT_STREAM = 'ox-ptt'
/** 연§9-5 — 안 쓰는 m-line 은 port 7 이다. 0 을 쓰면 BUNDLE 태그가 옮겨가 전송이 깨진다. */
const INACTIVE_PORT = 7

export class SdpError extends Error {
  override readonly name = 'SdpError'
  constructor(readonly reason: 'negotiation' | 'missing_pt', why: string) {
    super(why)
  }
}

export interface SessionId {
  readonly id: string
  readonly version: number
}

/** 연§9-5 — 자리를 지키는 줄. 항목이 지워져도 m-line 은 남는다. */
export interface Seat {
  readonly mid: string
  readonly kind: 'audio' | 'video'
  readonly pt?: number
  readonly codec?: string
  readonly fmtp?: string
  readonly room_id?: string
  readonly ssrc?: number
  readonly track_id?: string
  readonly user_id?: string
  readonly source?: string
  readonly rtx_ssrc?: number
  readonly rtx_pt?: number
  readonly active?: boolean
}

function header(bundle: readonly string[], sid: SessionId): string[] {
  return [
    'v=0',
    `o=- ${sid.id} ${sid.version} IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${bundle.join(' ')}`,
    'a=msid-semantic: WMS *',
    // 연§9-2 — 이 줄이 있어야 브라우저가 controlling 이 되어 검사를 주도한다.
    'a=ice-lite',
  ]
}

/** 연§9-3 공통 — ICE 자격은 연결마다 다르고 재협상에도 같은 값을 계속 쓴다. */
function head(cfg: ServerConfig, mid: string, subscribe: boolean): string[] {
  const ufrag = subscribe ? cfg.ice.subscribe_ufrag ?? cfg.ice.publish_ufrag : cfg.ice.publish_ufrag
  const pwd = subscribe ? cfg.ice.subscribe_pwd ?? cfg.ice.publish_pwd : cfg.ice.publish_pwd
  return [
    `c=IN IP4 ${cfg.ice.ip}`,
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:${cfg.dtls.fingerprint}`,
    'a=setup:passive',
    `a=mid:${mid}`,
  ]
}

/** 연§9-3 — 후보 한 줄이 전부이고 end-of-candidates 가 그것을 형식으로 닫는다. */
function tail(cfg: ServerConfig): string[] {
  return [
    `a=candidate:1 1 udp ${HOST_PRIORITY} ${cfg.ice.ip} ${cfg.ice.port} typ host generation 0`,
    'a=end-of-candidates',
  ]
}

/**
 * 연§9-4 예외 — opus 의 받는 쪽 선호(RFC 7587 §6.1)는 answer 가 정한다.
 * 코덱 이름·클럭·PT·프로파일은 offer 원문 그대로다.
 */
function withAudioPrefs(params: string, prefs: Readonly<Record<string, string | number | boolean>>): string {
  const kv = new Map<string, string>()
  for (const part of params.split(';')) {
    const [k, v] = part.split('=')
    if (k?.trim()) kv.set(k.trim(), (v ?? '').trim())
  }
  for (const [k, v] of Object.entries(prefs)) {
    kv.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  return [...kv].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')
}

export interface PublishOptions {
  readonly session?: SessionId
  /** opus 받는 쪽 선호. 없으면 offer 원문 그대로 간다. */
  readonly audioPrefs?: Readonly<Record<string, string | number | boolean>>
  /**
   * 연§9-10 규칙 1 — `1pc` 은 한 벌이라 브라우저 offer 에 ★받기 m-line 도 딸려 나온다.
   * 그 자리를 §9-5 표대로 `sendonly` + SSRC 로 답한다. `recvonly` 로 답하면 브라우저가
   * 방향 불일치로 거부한다. `2pc` 는 이 목록이 비어 있다.
   */
  readonly seats?: readonly Seat[]
}

/**
 * 연§9-1-1 — 브라우저 offer 에 대응하는 서버 answer.
 * m-line 개수와 순서가 offer 와 같아야 브라우저가 받는다.
 */
export function publishAnswer(offer: string | ParsedSdp, cfg: ServerConfig, opts: PublishOptions = {}): string {
  const parsed = typeof offer === 'string' ? parse(offer) : offer
  const sid = opts.session ?? { id: '1', version: 1 }
  const seats = new Map((opts.seats ?? []).map((s) => [s.mid, s]))
  const lines = header(parsed.bundle, sid)
  for (const m of parsed.sections) {
    const seat = seats.get(m.mid)
    // 연§9-10 규칙 2 무중단 불변 — 상대 축의 번호는 offer 에 서 있는 것을 그대로 쓴다.
    lines.push(...(seat === undefined ? answerSection(m, cfg, opts) : offerSection(seat, cfg, extmapOfSection(m), false)))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** 연§9-5 — 받기 m-line 에서 `sdes:mid` 는 뺀다. BUNDLE 구분이 SSRC 로 떨어져야 한다. */
function extmapOfSection(m: MSection): readonly { id: number; uri: string }[] {
  return [...m.extmap].filter(([, uri]) => uri !== URI_MID).map(([id, uri]) => ({ id, uri }))
}

function answerSection(m: MSection, cfg: ServerConfig, opts: PublishOptions): string[] {
  if (m.kind === 'application') {
    return [
      `m=application ${cfg.ice.port} UDP/DTLS/SCTP webrtc-datachannel`,
      ...head(cfg, m.mid, false),
      'a=sendrecv',
      'a=sctp-port:5000',
      'a=max-message-size:65536',
      ...tail(cfg),
    ]
  }

  const kind = m.kind
  const media = m.pts.filter((pt) => {
    const rtpmap = m.rtpmap.get(pt)
    return rtpmap !== undefined && !m.rtx.has(pt) && supportsSend(cfg, kind, codecOf(rtpmap))
  })
  if (media.length === 0) {
    throw new SdpError('negotiation', `${kind} m-line(mid=${m.mid}) 에 서버가 아는 코덱이 없다`)
  }

  const pts: number[] = []
  const attrs: string[] = []
  for (const pt of media) {
    const rtpmap = m.rtpmap.get(pt)!
    pts.push(pt)
    attrs.push(`a=rtpmap:${pt} ${rtpmap}`)
    const params = m.fmtp.get(pt)
    const prefs = kind === 'audio' && codecOf(rtpmap).toLowerCase() === 'opus' ? opts.audioPrefs : undefined
    if (params !== undefined || prefs) {
      attrs.push(`a=fmtp:${pt} ${prefs ? withAudioPrefs(params ?? '', prefs) : params!}`)
    }
    // 연§9-4 — rtcp-fb 는 여기만 서버가 정한다. "나한테 이 피드백을 보내라"는 요구다.
    for (const fb of sendFeedback(cfg, kind, codecOf(rtpmap))) attrs.push(`a=rtcp-fb:${pt} ${fb}`)

    const rtxPt = rtxOf(m, pt)
    if (rtxPt !== undefined) {
      pts.push(rtxPt)
      attrs.push(`a=rtpmap:${rtxPt} rtx/${clockOf(rtpmap) ?? 90000}`)
      attrs.push(`a=fmtp:${rtxPt} apt=${pt}`)
    }
  }

  // 연§9-4 — 번호는 offer 것을 쓴다. 새로 매기면 rid·mid·twcc 파싱이 죽는다.
  const declared = new Set(cfg.extmap.map((e) => e.uri))
  for (const [id, uri] of m.extmap) if (declared.has(uri)) attrs.push(`a=extmap:${id} ${uri}`)

  // 연§9-4 — 방향을 recv 로 뒤집는다. 빼면 브라우저가 한 단만 보낸다.
  if (m.simulcastSend) attrs.push('a=rid:h recv', 'a=rid:l recv', 'a=simulcast:recv h;l')
  return [
    `m=${kind} ${cfg.ice.port} UDP/TLS/RTP/SAVPF ${pts.join(' ')}`,
    ...head(cfg, m.mid, false),
    'a=rtcp-mux',
    ...(kind === 'video' ? ['a=rtcp-rsize'] : []),
    m.direction === 'inactive' ? 'a=inactive' : 'a=recvonly',
    ...attrs,
    ...tail(cfg),
  ]
}

export interface SubscribeOptions {
  readonly session?: SessionId
}

/** 연§9-1-2 — 보관한 배열로 처음부터 조립한다. 붙어 있는 SDP 를 읽어 고치지 않는다. */
export function subscribeOffer(seats: readonly Seat[], cfg: ServerConfig, opts: SubscribeOptions = {}): string {
  const sid = opts.session ?? { id: '1', version: 1 }
  const ordered = [...seats].sort((a, b) => Number.parseInt(a.mid, 10) - Number.parseInt(b.mid, 10))
  const lines = header(ordered.map((s) => s.mid), sid)
  for (const s of ordered) lines.push(...offerSection(s, cfg, recvExtmap(cfg, s.kind), true))
  return `${lines.join('\r\n')}\r\n`
}

function offerSection(
  s: Seat, cfg: ServerConfig, extmap: readonly { id: number; uri: string }[], subscribeCreds: boolean,
): string[] {
  if (s.pt === undefined) {
    throw new SdpError('missing_pt', `mid=${s.mid} 에 pt 가 없다 — 정책표로 채우지 않는다`)
  }
  const codec = s.codec ?? (s.kind === 'audio' ? 'opus' : '')
  if (codec === '') {
    throw new SdpError('missing_pt', `mid=${s.mid} video 에 codec 이 없다`)
  }
  const { hz, channels } = clockRate(codec)
  const live = s.ssrc !== undefined && s.track_id !== undefined && s.active !== false
  const rtpmap = `a=rtpmap:${s.pt} ${codec}/${hz}${channels === undefined ? '' : `/${channels}`}`

  // 연§9-5 안 쓰는 m-line — 자리와 코덱 줄만 남기고 msid·ssrc 는 뺀다. BUNDLE 에는 남는다.
  if (!live) {
    return [
      `m=${s.kind} ${INACTIVE_PORT} UDP/TLS/RTP/SAVPF ${s.pt}`,
      ...head(cfg, s.mid, subscribeCreds),
      'a=rtcp-mux',
      ...(s.kind === 'video' ? ['a=rtcp-rsize'] : []),
      'a=inactive',
      rtpmap,
      ...(s.fmtp === undefined ? [] : [`a=fmtp:${s.pt} ${s.fmtp}`]),
      ...tail(cfg),
    ]
  }

  const withRtx = s.rtx_ssrc !== undefined && s.rtx_pt !== undefined
  const pts = withRtx ? [s.pt, s.rtx_pt!] : [s.pt]
  const attrs: string[] = [rtpmap]
  // 연§9-5 — fmtp 가 오면 반드시 넣는다. 이름만 맞추면 패킷은 오는데 디코딩이 0 이다.
  if (s.fmtp !== undefined) attrs.push(`a=fmtp:${s.pt} ${s.fmtp}`)
  for (const fb of recvFeedback(cfg, s.kind, codec)) attrs.push(`a=rtcp-fb:${s.pt} ${fb}`)
  if (withRtx) attrs.push(`a=rtpmap:${s.rtx_pt!} rtx/${hz}`, `a=fmtp:${s.rtx_pt!} apt=${s.pt}`)
  for (const e of extmap) attrs.push(`a=extmap:${e.id} ${e.uri}`)

  // 연§9-5 — 무전 슬롯은 여러 사람이 돌려쓰므로 stream-id 가 하나다(입술 동기가 한 묶음).
  const stream = s.user_id === undefined
    ? PTT_STREAM
    : `ox-${s.user_id}${s.source === undefined ? '' : `-${s.source}`}`
  attrs.push(`a=msid:${stream} ${s.track_id!}`, `a=ssrc:${s.ssrc!} cname:${CNAME}`)
  if (withRtx) {
    attrs.push(`a=ssrc:${s.rtx_ssrc!} cname:${CNAME}`, `a=ssrc-group:FID ${s.ssrc!} ${s.rtx_ssrc!}`)
  }

  return [
    `m=${s.kind} ${cfg.ice.port} UDP/TLS/RTP/SAVPF ${pts.join(' ')}`,
    ...head(cfg, s.mid, subscribeCreds),
    'a=rtcp-mux',
    ...(s.kind === 'video' ? ['a=rtcp-rsize'] : []),
    'a=sendonly',
    ...attrs,
    ...tail(cfg),
  ]
}

export interface UnifiedOptions extends SubscribeOptions {
  /** 연§9-10-1 — 보내기 코덱 줄의 출처. 내 offer 가 아니라 직전 협상이 확정한 answer 다. */
  readonly confirmed: string | ParsedSdp
  /** 브라우저가 지금 낸 offer — m-line 구조·extmap 번호·rid 의 출처. */
  readonly mine: string | ParsedSdp
}

/**
 * 연§9-10-1 — 보내기와 받기가 한 BUNDLE 에 섞인 서버 offer.
 * ICE 자격은 publish 한 벌뿐이다(규격 1). 자격이 둘이면 전송로가 안 선다.
 */
export function unifiedOffer(seats: readonly Seat[], cfg: ServerConfig, opts: UnifiedOptions): string {
  const mine = typeof opts.mine === 'string' ? parse(opts.mine) : opts.mine
  const confirmed = typeof opts.confirmed === 'string' ? parse(opts.confirmed) : opts.confirmed
  const sid = opts.session ?? { id: '1', version: 1 }
  const byMid = new Map(confirmed.sections.map((m) => [m.mid, m]))
  const ordered = [...seats].sort((a, b) => Number.parseInt(a.mid, 10) - Number.parseInt(b.mid, 10))

  // ★받기 mid 는 `seats` 가 짓는다 — 브라우저 offer 에도 그 자리가 있으므로 빼지 않으면
  // 한 mid 가 BUNDLE 에 두 번 들어가고 m-line 이 겹친다.
  const seatMids = new Set(ordered.map((s) => s.mid))
  const send = mine.sections.filter((m) => !seatMids.has(m.mid))
  const bundle = [...send.map((m) => m.mid), ...ordered.map((s) => s.mid)]
  const lines = header(bundle, sid)
  for (const m of send) lines.push(...sendSection(m, byMid.get(m.mid), cfg))
  for (const s of ordered) lines.push(...offerSection(s, cfg, extmapOf(confirmed, s.kind), false))
  return `${lines.join('\r\n')}\r\n`
}

/** 연§9-10-1 — 받기 확장 번호도 그 연결의 확정본을 쓴다. 한 BUNDLE 에 URI 마다 번호가 하나다. */
function extmapOf(confirmed: ParsedSdp, kind: 'audio' | 'video'): readonly { id: number; uri: string }[] {
  // ★보내기 절에서 읽는다 — 확정본에는 받기 절도 함께 있고(연§9-10 규칙 1), 번호는 한 BUNDLE 에
  // URI 마다 하나라 값은 같지만 출처를 정해 두지 않으면 절 순서에 따라 답이 흔들린다.
  const m = confirmed.sections.find((s) => s.kind === kind && s.direction === 'recvonly')
    ?? confirmed.sections.find((s) => s.kind === kind)
  if (!m) return []
  return [...m.extmap]
    .filter(([, uri]) => uri !== URI_MID)
    .map(([id, uri]) => ({ id, uri }))
}

function sendSection(m: MSection, confirmed: MSection | undefined, cfg: ServerConfig): string[] {
  if (m.kind === 'application') {
    return [
      `m=application ${cfg.ice.port} UDP/DTLS/SCTP webrtc-datachannel`,
      ...head(cfg, m.mid, false),
      'a=sendrecv',
      'a=sctp-port:5000',
      'a=max-message-size:65536',
      ...tail(cfg),
    ]
  }
  if (!confirmed) {
    throw new SdpError('negotiation', `mid=${m.mid} 의 확정 answer 가 없다 — 코덱 줄의 출처가 없다`)
  }

  const attrs: string[] = []
  const pts: number[] = []
  for (const pt of confirmed.pts) {
    const rtpmap = confirmed.rtpmap.get(pt)
    if (rtpmap === undefined) continue
    pts.push(pt)
    attrs.push(`a=rtpmap:${pt} ${rtpmap}`)
    const params = confirmed.fmtp.get(pt)
    if (params !== undefined) attrs.push(`a=fmtp:${pt} ${params}`)
    if (!confirmed.rtx.has(pt)) {
      for (const fb of sendFeedback(cfg, m.kind, codecOf(rtpmap))) attrs.push(`a=rtcp-fb:${pt} ${fb}`)
    }
  }
  if (pts.length === 0) {
    throw new SdpError('negotiation', `mid=${m.mid} 확정 answer 에 코덱이 없다`)
  }
  // 연§9-10-1 — 확장 번호만 내 offer 것이다. 새로 매기면 와이어 번호가 조용히 바뀐다.
  const declared = new Set(cfg.extmap.map((e) => e.uri))
  for (const [id, uri] of m.extmap) if (declared.has(uri)) attrs.push(`a=extmap:${id} ${uri}`)
  if (m.simulcastSend) attrs.push('a=rid:h recv', 'a=rid:l recv', 'a=simulcast:recv h;l')

  return [
    `m=${m.kind} ${cfg.ice.port} UDP/TLS/RTP/SAVPF ${pts.join(' ')}`,
    ...head(cfg, m.mid, false),
    'a=rtcp-mux',
    ...(m.kind === 'video' ? ['a=rtcp-rsize'] : []),
    m.direction === 'inactive' ? 'a=inactive' : 'a=recvonly',
    ...attrs,
    ...tail(cfg),
  ]
}
