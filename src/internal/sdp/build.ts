// author: kodeholic (powered by Claude)
// 연§9 — 서버 쪽 SDP 를 클라가 조립해 자기 브라우저에 먹인다.
// 보내기는 answer, 받기는 offer 다(연§9-0). 방향을 뒤집으면 받기 m-line 이 0개가 된다.
import { ServerConfig, clockRate, recvExtmap, recvFeedback, sendFeedback, supportsSend } from './config.js'
import { MSection, ParsedSdp, clockOf, codecOf, parse, rtxOf } from './parse.js'

/** 연§9-3 — 후보가 하나뿐이라 우선순위는 호스트 고정값이다. */
const HOST_PRIORITY = 2113937151
// RFC 6544 §4.2 — TCP 는 UDP 아래다. 둘 다 서면 UDP 가 이겨야 한다.
const TCP_HOST_PRIORITY = 1518280447
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

/**
 * 연§9-2 — `o=` 의 session-id 는 ★**숫자 문자열**이어야 한다(RFC 4566 §5.2).
 * 서버 신원(`sfu_id`)은 문자열이라 그대로 쓰면 ★Firefox 가 SDP 를 통째로 거부한다
 * ("SDP Parse Error: Invalid owner session id specified for o="). Chrome 은 받아 준다.
 * 그 신원을 안정 사상해 ★그 연결 내내 같은 값이면서 서버마다 다른 숫자를 얻는다.
 */
export function sessionIdOf(sfuId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < sfuId.length; i += 1) {
    h ^= sfuId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return String(h === 0 ? 1 : h)
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

/**
 * 연§9-3 — 후보 줄과 end-of-candidates 가 그것을 형식으로 닫는다.
 *
 * ★`tcp_port` 가 실려 있을 때만 TCP 후보가 한 줄 더 붙는다(RFC 6544). 서버가 `passive`
 * 이고 브라우저가 `active` 로 건다. ★**우선순위를 UDP 아래로 둔다** — 둘 다 서면 UDP 가
 * 이겨야 한다(RFC 6544 §4.2). 이 칸을 지우는 쪽은 `Rooms.attach` 다.
 */
/**
 * ★**QA 전용 — 상용 경로에서 절대 부르지 않는다.**
 *
 * `false` 면 UDP 후보 줄을 빼서 **TCP 만 남긴다**. 브라우저가 ICE-TCP 를 *할 수 있는가*
 * 와 *경쟁에서 지는가* 를 가르는 실험에만 쓴다(20260913 실측: Chrome 이 passive 후보를
 * 받고도 TCP 연결을 시도하지 않는다).
 */
let qaUdpCandidate = true

export function __qaSetUdpCandidate(on: boolean): void {
  qaUdpCandidate = on
}

function tail(cfg: ServerConfig): string[] {
  const lines = qaUdpCandidate
    ? [`a=candidate:1 1 udp ${HOST_PRIORITY} ${cfg.ice.ip} ${cfg.ice.port} typ host generation 0`]
    : []
  if (cfg.ice.tcp_port !== undefined) {
    lines.push(
      `a=candidate:2 1 tcp ${TCP_HOST_PRIORITY} ${cfg.ice.ip} ${cfg.ice.tcp_port} typ host tcptype passive generation 0`,
    )
  }
  lines.push('a=end-of-candidates')
  return lines
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

/** 연§4-2-1 ③ — 받기 m-line 도 `sdes:mid` 를 선언한다(12차에 뒤집혔다 — `config.ts` 참조). */
function extmapOfSection(m: MSection): readonly { id: number; uri: string }[] {
  return [...m.extmap].map(([id, uri]) => ({ id, uri }))
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

/**
 * 연§9-10-1 — ★**새 보내기 m-line**(트랙 추가). ★**클라가 절로 붙인다.**
 *
 * ★★**브라우저에 `addTransceiver` 를 하지 않는다** — 이 절을 받은 브라우저가
 * ★**제 트랜시버를 만든다**(RFC 8829 §5.10). 클라가 먼저 만들면 ★**둘이 되어**
 * 브라우저가 우리 절을 제 것에 안 붙이고 `inactive` 로 답한다(실측 20260913).
 */
export interface NewSend {
  readonly kind: 'audio' | 'video'
  /** ★**0~31 중 비어 있는 가장 작은 값**(§9-9-3) — 받기 몫(32~)과 겹치지 않는다. */
  readonly mid: string
  /** 연§6-3 무전 video — 그 방 슬롯 코덱으로 맞춘다. */
  readonly prefer?: { codec: string; fmtp?: string }
  readonly simulcast?: boolean
}

export interface UnifiedOptions extends SubscribeOptions {
  /** 연§9-10-1 — 보내기 코덱 줄의 출처. 내 offer 가 아니라 직전 협상이 확정한 answer 다. */
  readonly confirmed: string | ParsedSdp
  /** 브라우저가 지금 낸 offer — m-line 구조·extmap 번호·rid 의 출처. */
  readonly mine: string | ParsedSdp
  /** 이번 협상에서 새로 붙이는 보내기 절. */
  readonly add?: NewSend
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

  // ★★**자리 순서는 역사가 정한다**(RFC 3264 §8 — m-line 은 자리를 지킨다).
  //
  //   ★**mid 수치로 줄을 세우면 안 된다.** 새 보내기 절(화면공유 `mid:3`)이 받기 절
  //   (`mid:32`) **앞으로** 끼어들어 ★**이전 협상과 자리가 어긋나고**, 브라우저가
  //   *"order of m-lines … doesn't match"* 로 통째로 거부한다(실측 20260913).
  //   ★17차가 자리 확보 트랜시버를 철거하면서 **새 절이 실제로 생기게** 되어 드러난 자리다.
  //   ★**새 절은 맨 뒤에 붙인다** — 그 안에서만 mid 수치 오름차순이다.
  //   ★**자리 권위는 브라우저 offer(`mine`) 다** — 그 PC 가 이전 협상에서 세운 절을
  //   전부, ★**그 순서 그대로** 들고 있다(받기 절도 그 PC 의 트랜시버다). 확정본은 첫
  //   협상 것이라 뒤에 붙은 절을 모른다 — 그것으로 줄을 세우면 자리가 어긋난다.
  const seatBy = new Map(ordered.map((s) => [s.mid, s]))
  const was = mine.sections.map((m) => m.mid)
  const seen = new Set(was)
  // ★아직 그 PC 에 절이 없는 받기(갓 배정된 mid)와 ★**새로 붙이는 보내기 절**이 뒤에 온다.
  const fresh = [
    ...ordered.map((s) => s.mid).filter((m) => !seen.has(m)),
    ...(opts.add === undefined || seen.has(opts.add.mid) ? [] : [opts.add.mid]),
  ]
  const bundle = [...was, ...fresh]
  const sendBy = new Map(send.map((m) => [m.mid, m]))

  const lines = header(bundle, sid)
  for (const mid of bundle) {
    const seat = seatBy.get(mid)
    if (seat) {
      lines.push(...offerSection(seat, cfg, extmapOf(confirmed, seat.kind), false))
      continue
    }
    if (opts.add !== undefined && mid === opts.add.mid) {
      lines.push(...newSendSection(opts.add, confirmed, cfg))
      continue
    }
    const m = sendBy.get(mid)
    if (m) lines.push(...sendSection(m, byMid.get(mid), cfg))
  }
  return `${lines.join('\r\n')}\r\n`
}

/**
 * 연§9-10-1 — ★**새 보내기 절을 첫 협상 확정본에서 짓는다.**
 *
 * ★★**내 offer 에서 가져오면 안 된다** — 브라우저 offer 는 **협상 전 목록**이라 할 수 있는
 * 코덱이 전부 들어 있다. 그것을 되비추면 ★**answer 가 걸러냈던 코덱이 되살아나고**,
 * 브라우저가 거기에 자기 answer 를 새로 써서 ★**이미 서버에 보고한 합의를 조용히 갈아치운다.**
 * ★번호(PT·extmap)도 확정본 것이다 — 새로 매기면 와이어 확장 번호가 조용히 바뀐다.
 */
function newSendSection(add: NewSend, confirmed: ParsedSdp, cfg: ServerConfig): string[] {
  // ★그 kind 의 확정된 절을 본보기로 삼는다 — 없으면 지어낼 재료가 없다.
  const like = confirmed.sections.find((m) => m.kind === add.kind)
  if (!like) {
    throw new SdpError('negotiation', `확정본에 ${add.kind} 절이 없다 — 새 절의 코덱 출처가 없다`)
  }
  const attrs: string[] = []
  const pts: number[] = []
  // ★무전 video 는 그 방 슬롯 코덱으로 맞춘다(연§6-3) — 그 코덱을 첫 줄로 세운다.
  const wanted = add.prefer?.codec?.toLowerCase()
  const order = [...like.pts].sort((a, b) => {
    const rank = (pt: number) =>
      wanted !== undefined && like.rtpmap.get(pt)?.toLowerCase().startsWith(wanted) ? 0 : 1
    return rank(a) - rank(b)
  })
  for (const pt of order) {
    const rtpmap = like.rtpmap.get(pt)
    if (rtpmap === undefined) continue
    pts.push(pt)
    attrs.push(`a=rtpmap:${pt} ${rtpmap}`)
    const params = like.fmtp.get(pt)
    if (params !== undefined) attrs.push(`a=fmtp:${pt} ${params}`)
    if (!like.rtx.has(pt)) {
      for (const fb of sendFeedback(cfg, add.kind, codecOf(rtpmap))) attrs.push(`a=rtcp-fb:${pt} ${fb}`)
    }
  }
  if (pts.length === 0) {
    throw new SdpError('negotiation', `확정본 ${add.kind} 절에 코덱이 없다`)
  }
  for (const [id, uri] of like.extmap) attrs.push(`a=extmap:${id} ${uri}`)
  // ★확정본의 것을 `recv` 로 뒤집는다 — 낮은 품질부터(§9-4).
  if (add.simulcast === true) attrs.push('a=rid:l recv', 'a=rid:h recv', 'a=simulcast:recv l;h')
  return [
    `m=${add.kind} ${cfg.ice.port} UDP/TLS/RTP/SAVPF ${pts.join(' ')}`,
    ...head(cfg, add.mid, false),
    'a=rtcp-mux',
    ...(add.kind === 'video' ? ['a=rtcp-rsize'] : []),
    // ★서버 시각이다 — 서버가 받는다.
    'a=recvonly',
    ...attrs,
    ...tail(cfg),
  ]
}

/** 연§9-10-1 — 받기 확장 번호도 그 연결의 확정본을 쓴다. 한 BUNDLE 에 URI 마다 번호가 하나다.
 *  ★`sdes:mid` 를 포함한다(§4-2-1 ③) — 12차 전에는 뺐다. */
function extmapOf(confirmed: ParsedSdp, kind: 'audio' | 'video'): readonly { id: number; uri: string }[] {
  // ★보내기 절에서 읽는다 — 확정본에는 받기 절도 함께 있고(연§9-10 규칙 1), 번호는 한 BUNDLE 에
  // URI 마다 하나라 값은 같지만 출처를 정해 두지 않으면 절 순서에 따라 답이 흔들린다.
  const m = confirmed.sections.find((s) => s.kind === kind && s.direction === 'recvonly')
    ?? confirmed.sections.find((s) => s.kind === kind)
  if (!m) return []
  return [...m.extmap].map(([id, uri]) => ({ id, uri }))
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
  // ★★**새 보내기 절에는 확정본이 없다**(연§9-10-1 · 17차) — 자리 확보 트랜시버를 철거한
  //   뒤로 화면공유 같은 둘째 video 는 ★**m-line 을 새로 붙인다.** 그 절의 코덱 줄 출처는
  //   ★**내 offer** 다(아직 서버와 합의한 적이 없으므로 확정본이 있을 수가 없다).
  //   ★규칙 2(무중단 불변)는 **새 절을 더하는 것을 막지 않는다** — 무관한 절이 안 바뀌면 된다.
  //   ★**있는 절은 반드시 확정본에서 짓는다** — 내 offer 에서 가져오면 걸러냈던 코덱이
  //   되살아나 ★**보고한 것과 다른 코덱으로 보낸다**(§9-10-3 증상).
  const from = confirmed ?? m

  const attrs: string[] = []
  const pts: number[] = []
  for (const pt of from.pts) {
    const rtpmap = from.rtpmap.get(pt)
    if (rtpmap === undefined) continue
    pts.push(pt)
    attrs.push(`a=rtpmap:${pt} ${rtpmap}`)
    const params = from.fmtp.get(pt)
    if (params !== undefined) attrs.push(`a=fmtp:${pt} ${params}`)
    if (!from.rtx.has(pt)) {
      for (const fb of sendFeedback(cfg, m.kind, codecOf(rtpmap))) attrs.push(`a=rtcp-fb:${pt} ${fb}`)
    }
  }
  if (pts.length === 0) {
    throw new SdpError('negotiation', `mid=${m.mid} 에 코덱이 없다 — 지어내지 않는다`)
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
