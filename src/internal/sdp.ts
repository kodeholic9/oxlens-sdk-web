// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE internal/sdp · 연:RULE-LINK-SDP-SESSION-HEADER · 연:RULE-LINK-SDP-COMMON · 연:RULE-LINK-SDP-PUB-MLINE · 연:RULE-LINK-SDP-SUB-MLINE · 연:RULE-LINK-SDP-DC-MLINE · 연:RULE-LINK-SDP-1PC-FILL · model: claude-opus-5-5
import type { ServerConfig, MlineEntry, ExtMap } from './wire/ws.js'

export type Kind = 'audio' | 'video' | 'application'
export type Dir = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'

export interface Codec {
  readonly pt: number
  /** rtpmap 원문 — `opus/48000/2` */
  readonly rtpmap: string
  readonly fmtp?: string
  readonly rtx?: number
}

export interface Section {
  readonly kind: Kind
  readonly mid: string
  readonly dir: Dir
  readonly codecs: Codec[]
  readonly ext: ExtMap[]
  readonly rids: string[]
  readonly simulcast: boolean
  readonly ssrcs: number[]
  readonly fid: [number, number] | null
}

export interface Parsed {
  readonly sessionId: string
  readonly version: number
  readonly bundle: string[]
  readonly media: Section[]
}

export interface Creds {
  readonly ufrag: string
  readonly pwd: string
}

export const CNAME = 'ox-sfu'
const UDP_PRIO = 2113937151
const TCP_PRIO = 2113937150

/** 코덱 클럭 표(연:LINK.fact.SdpClock) — 이름에서 정해지는 상수 */
export function clockOf(codec: string): { clock: number; rate: string } {
  const n = codec.toLowerCase()
  if (n === 'opus') return { clock: 48000, rate: '48000/2' }
  if (n === 'vp8' || n === 'vp9' || n === 'h264' || n === 'av1') return { clock: 90000, rate: '90000' }
  throw new Error(`코덱 클럭 표에 ${codec} 이 없다`)
}

export function codecName(c: Codec): string {
  return c.rtpmap.split('/')[0] ?? ''
}

/** 브라우저 SDP 를 읽는다 — 조립에 쓰는 줄만 */
export function parse(sdp: string): Parsed {
  const lines = sdp.split(/\r?\n/).filter((l) => l.length)
  let sessionId = '0'
  let version = 0
  let bundle: string[] = []
  const media: Section[] = []
  type Draft = { kind: Kind; mid: string; dir: Dir; pts: number[]; rtpmap: Map<number, string>; fmtp: Map<number, string>; ext: ExtMap[]; rids: string[]; simulcast: boolean; ssrcs: number[]; fid: [number, number] | null }
  let cur: Draft | null = null
  const flush = (): void => {
    if (!cur) return
    const d = cur
    const apt = new Map<number, number>()
    for (const [pt, f] of d.fmtp) {
      const m = /apt=(\d+)/.exec(f)
      if (m && /^rtx\//i.test(d.rtpmap.get(pt) ?? '')) apt.set(Number(m[1]), pt)
    }
    const codecs: Codec[] = []
    for (const pt of d.pts) {
      const rm = d.rtpmap.get(pt)
      if (!rm) continue
      const nm = (rm.split('/')[0] ?? '').toLowerCase()
      if (nm === 'rtx' || nm === 'red' || nm === 'ulpfec' || nm === 'flexfec-03' || nm === 'cn' || nm === 'telephone-event') continue
      const f = d.fmtp.get(pt)
      const rtx = apt.get(pt)
      const c: { pt: number; rtpmap: string; fmtp?: string; rtx?: number } = { pt, rtpmap: rm }
      if (f !== undefined) c.fmtp = f
      if (rtx !== undefined) c.rtx = rtx
      codecs.push(c)
    }
    media.push({ kind: d.kind, mid: d.mid, dir: d.dir, codecs, ext: d.ext, rids: d.rids, simulcast: d.simulcast, ssrcs: d.ssrcs, fid: d.fid })
    cur = null
  }
  for (const l of lines) {
    if (l.startsWith('o=')) {
      const p = l.slice(2).split(' ')
      sessionId = p[1] ?? '0'
      version = Number(p[2] ?? 0)
    } else if (l.startsWith('a=group:BUNDLE') && !cur) {
      bundle = l.slice('a=group:BUNDLE'.length).trim().split(/\s+/).filter((x) => x)
    } else if (l.startsWith('m=')) {
      flush()
      const p = l.slice(2).split(' ')
      cur = { kind: p[0] as Kind, mid: '', dir: 'sendrecv', pts: p.slice(3).map(Number).filter((n) => !Number.isNaN(n)), rtpmap: new Map(), fmtp: new Map(), ext: [], rids: [], simulcast: false, ssrcs: [], fid: null }
    } else if (cur) {
      if (l.startsWith('a=mid:')) cur.mid = l.slice(6).trim()
      else if (l === 'a=sendrecv' || l === 'a=sendonly' || l === 'a=recvonly' || l === 'a=inactive') cur.dir = l.slice(2) as Dir
      else if (l.startsWith('a=rtpmap:')) { const m = /^a=rtpmap:(\d+) (.+)$/.exec(l); if (m) cur.rtpmap.set(Number(m[1]), m[2]!) }
      else if (l.startsWith('a=fmtp:')) { const m = /^a=fmtp:(\d+) (.+)$/.exec(l); if (m) cur.fmtp.set(Number(m[1]), m[2]!) }
      else if (l.startsWith('a=extmap:')) { const m = /^a=extmap:(\d+)(?:\/\w+)? (\S+)/.exec(l); if (m) cur.ext.push({ id: Number(m[1]), uri: m[2]! }) }
      else if (l.startsWith('a=rid:')) { const m = /^a=rid:(\S+) (\w+)/.exec(l); if (m && !cur.rids.includes(m[1]!)) cur.rids.push(m[1]!) }
      else if (l.startsWith('a=simulcast:')) cur.simulcast = true
      else if (l.startsWith('a=ssrc-group:FID')) { const p = l.split(' ').slice(1).map(Number); if (p.length >= 2) cur.fid = [p[0]!, p[1]!] }
      else if (l.startsWith('a=ssrc:')) { const n = Number(l.slice(7).split(' ')[0]); if (!cur.ssrcs.includes(n)) cur.ssrcs.push(n) }
    }
  }
  flush()
  return { sessionId, version, bundle, media }
}

/** 1pc 번호표 — 브라우저 offer 의 코덱 줄 전량 · 확장 ID 전량(연:ROOM.op.ROOM_JOIN · 연:RULE-ROOM-JOIN-NUMBER-TAGS) */
export function numberTags(sdp: string): { codecs: { kind: 'audio' | 'video'; pt: number; name: string; fmtp?: string; rtx_pt?: number }[]; extmap: ExtMap[] } {
  const codecs: { kind: 'audio' | 'video'; pt: number; name: string; fmtp?: string; rtx_pt?: number }[] = []
  const extmap: ExtMap[] = []
  let kind: string | null = null
  let rtpmap = new Map<number, string>()
  let fmtp = new Map<number, string>()
  const flush = (): void => {
    if (kind !== 'audio' && kind !== 'video') return
    const k = kind
    const apt = new Map<number, number>()
    for (const [pt, f] of fmtp) { const m = /apt=(\d+)/.exec(f); if (m && /^rtx\//i.test(rtpmap.get(pt) ?? '')) apt.set(Number(m[1]), pt) }
    for (const [pt, rm] of rtpmap) {
      const name = rm.split('/')[0] ?? ''
      if (name.toLowerCase() === 'rtx') continue
      if (codecs.some((c) => c.kind === k && c.pt === pt)) continue
      const c: { kind: 'audio' | 'video'; pt: number; name: string; fmtp?: string; rtx_pt?: number } = { kind: k, pt, name }
      const f = fmtp.get(pt)
      if (f !== undefined) c.fmtp = f
      const r = apt.get(pt)
      if (r !== undefined) c.rtx_pt = r
      codecs.push(c)
    }
  }
  for (const l of sdp.split(/\r?\n/)) {
    if (l.startsWith('m=')) { flush(); kind = l.slice(2).split(' ')[0] ?? null; rtpmap = new Map(); fmtp = new Map() }
    else if (l.startsWith('a=rtpmap:')) { const m = /^a=rtpmap:(\d+) (.+)$/.exec(l); if (m) rtpmap.set(Number(m[1]), m[2]!) }
    else if (l.startsWith('a=fmtp:')) { const m = /^a=fmtp:(\d+) (.+)$/.exec(l); if (m) fmtp.set(Number(m[1]), m[2]!) }
    else if (l.startsWith('a=extmap:')) { const m = /^a=extmap:(\d+)(?:\/\w+)? (\S+)/.exec(l); if (m && !extmap.some((e) => e.uri === m[2])) extmap.push({ id: Number(m[1]), uri: m[2]! }) }
  }
  flush()
  return { codecs, extmap }
}

/** 세션 헤더(연:LINK.sdp.session) — o= 의 session-id 는 숫자 문자열 · ice-lite 는 반드시 */
function session(id: string, version: number, mids: string[]): string[] {
  return ['v=0', `o=- ${id} ${version} IN IP4 127.0.0.1`, 's=-', 't=0 0', `a=group:BUNDLE ${mids.join(' ')}`, 'a=msid-semantic: WMS *', 'a=ice-lite']
}

export interface Wire {
  readonly sc: ServerConfig
  readonly creds: Creds
  /** QA 스위치가 끄지 않는 한 UDP 후보 한 줄 — SDK:RULE-PLAT-WEB */
  readonly udp: boolean
}

function head(w: Wire, mid: string, kind: Kind): string[] {
  const out = [`c=IN IP4 ${w.sc.ice.ip}`, `a=ice-ufrag:${w.creds.ufrag}`, `a=ice-pwd:${w.creds.pwd}`, `a=fingerprint:${w.sc.dtls.fingerprint}`, 'a=setup:passive', `a=mid:${mid}`]
  if (kind !== 'application') out.push('a=rtcp-mux')
  if (kind === 'video') out.push('a=rtcp-rsize')
  return out
}

function tail(w: Wire): string[] {
  const out: string[] = []
  if (w.udp) out.push(`a=candidate:1 1 udp ${UDP_PRIO} ${w.sc.ice.ip} ${w.sc.ice.port} typ host generation 0`)
  if (w.sc.ice.tcp_port !== undefined) out.push(`a=candidate:2 1 tcp ${TCP_PRIO} ${w.sc.ice.ip} ${w.sc.ice.tcp_port} typ host tcptype passive generation 0`)
  out.push('a=end-of-candidates')
  return out
}

function dc(w: Wire, mid: string): string[] {
  return [`m=application ${w.sc.ice.port} UDP/DTLS/SCTP webrtc-datachannel`, ...head(w, mid, 'application'), 'a=sendrecv', 'a=sctp-port:5000', 'a=max-message-size:65536', ...tail(w)]
}

function fbOf(list: ServerConfig['codecs'], kind: Kind, name: string): string[] {
  return list.find((c) => c.kind === kind && c.name.toLowerCase() === name.toLowerCase())?.rtcp_fb ?? []
}

/** opus fmtp 의 받는 쪽 선호는 answer 가 정한다(연:RULE-LINK-SDP-PUB-MLINE 예외) — 그 밖 코덱은 offer 원문 그대로 */
function answerFmtp(c: Codec, opus: string): string | undefined {
  return codecName(c).toLowerCase() === 'opus' ? opus : c.fmtp
}

export interface SendSection {
  readonly mid: string
  readonly kind: 'audio' | 'video'
  readonly dir: 'recvonly' | 'inactive'
  readonly codecs: Codec[]
  readonly ext: ExtMap[]
  readonly rids: string[]
}

/** 발행 m-line(연:LINK.sdp.send) — 서버가 받는다 */
function send(w: Wire, s: SendSection, opus: string | null): string[] {
  if (!s.codecs.length) throw new Error(`mid ${s.mid} 에 남는 코덱이 없다`)
  const pts = s.codecs.flatMap((c) => (c.rtx !== undefined ? [c.pt, c.rtx] : [c.pt]))
  const out = [`m=${s.kind} ${w.sc.ice.port} UDP/TLS/RTP/SAVPF ${pts.join(' ')}`, ...head(w, s.mid, s.kind), `a=${s.dir}`]
  for (const c of s.codecs) {
    out.push(`a=rtpmap:${c.pt} ${c.rtpmap}`)
    const f = opus === null ? c.fmtp : answerFmtp(c, opus)
    if (f) out.push(`a=fmtp:${c.pt} ${f}`)
    for (const fb of fbOf(w.sc.codecs, s.kind, codecName(c))) out.push(`a=rtcp-fb:${c.pt} ${fb}`)
    if (c.rtx !== undefined) {
      out.push(`a=rtpmap:${c.rtx} rtx/${c.rtpmap.split('/')[1] ?? '90000'}`)
      out.push(`a=fmtp:${c.rtx} apt=${c.pt}`)
    }
  }
  for (const e of s.ext) out.push(`a=extmap:${e.id} ${e.uri}`)
  if (s.rids.length) {
    for (const r of s.rids) out.push(`a=rid:${r} recv`)
    out.push(`a=simulcast:recv ${s.rids.join(';')}`)
  }
  out.push(...tail(w))
  return out
}

/** 서버가 받는 코덱만 남긴다 — 서버 codecs 에 없는 것은 PT 줄째로 뺀다 */
export function serverCodecs(sc: ServerConfig, kind: Kind, codecs: Codec[]): Codec[] {
  const names = new Set(sc.codecs.filter((c) => c.kind === kind).map((c) => c.name.toLowerCase()))
  return codecs.filter((c) => names.has(codecName(c).toLowerCase()))
}

/** offer 와 서버 선언의 교집합 — 번호는 offer 것 */
export function serverExt(sc: ServerConfig, ext: ExtMap[]): ExtMap[] {
  return ext.filter((e) => sc.extmap.some((x) => x.uri === e.uri))
}

/**
 * 발행 answer — 브라우저 offer 의 m-line 순서 · 개수 그대로(연:RULE-LINK-SDP-ORDER-PUB).
 * pick 이 주어지면 그 m-line 의 코덱을 거기서 고른 것만 남긴다(방 미디어 코덱 — 연:RULE-LINK-SDP-PUB-MLINE 코덱 고르기).
 */
export function answer(w: Wire, offer: Parsed, opus: (s: Section) => string, pick?: (s: Section, cs: Codec[]) => Codec[]): string {
  const out = session(offer.sessionId, offer.version, offer.bundle.length ? offer.bundle : offer.media.map((m) => m.mid))
  for (const m of offer.media) {
    if (m.kind === 'application') { out.push(...dc(w, m.mid)); continue }
    let cs = serverCodecs(w.sc, m.kind, m.codecs)
    if (pick) cs = pick(m, cs)
    const s: SendSection = { mid: m.mid, kind: m.kind, dir: m.dir === 'inactive' || m.dir === 'recvonly' ? 'inactive' : 'recvonly', codecs: cs, ext: serverExt(w.sc, m.ext), rids: m.simulcast ? m.rids : [] }
    out.push(...send(w, s, opus(m)))
  }
  return out.join('\r\n') + '\r\n'
}

const WHERE: Record<string, 'both' | 'audio' | 'none'> = {
  'urn:ietf:params:rtp-hdrext:sdes:mid': 'both',
  'urn:ietf:params:rtp-hdrext:ssrc-audio-level': 'audio',
  'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time': 'both',
  'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01': 'both',
  'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id': 'none',
  'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id': 'none',
}

/** 구독 m-line 의 extmap — 그 m-line 종류의 것만(연:LINK.fact.ServerExtMap 어디에 열) */
function recvExt(sc: ServerConfig, kind: 'audio' | 'video', mine: ExtMap[] | null): ExtMap[] {
  const out: ExtMap[] = []
  for (const e of sc.extmap) {
    const w = WHERE[e.uri] ?? 'none'
    if (w === 'none' || (w === 'audio' && kind !== 'audio')) continue
    out.push(mine ? onePcExtId(sc, mine, e) : e)
  }
  return out
}

/**
 * 1pc 한 BUNDLE 의 URI 마다 번호 하나(연:RULE-LINK-SDP-1PC-FILL 구독 m-line 의 extmap) —
 * 번호표에 그 URI 가 있으면 그 번호 · 없으면 서버 번호, 그 번호가 번호표에서 다른 URI 면 둘 어디에도 없는 가장 작은 번호(1~14).
 */
export function onePcExtId(sc: ServerConfig, mine: ExtMap[], e: ExtMap): ExtMap {
  const hit = mine.find((m) => m.uri === e.uri)
  if (hit) return { id: hit.id, uri: e.uri }
  const clash = mine.find((m) => m.id === e.id && m.uri !== e.uri)
  if (!clash) return e
  const used = new Set([...mine.map((m) => m.id), ...sc.extmap.map((m) => m.id)])
  for (let id = 1; id <= 14; id++) if (!used.has(id)) return { id, uri: e.uri }
  return e
}

/** 구독 m-line(연:LINK.sdp.recv) — 재료는 배정표 줄 하나뿐 · track_id 는 보지 않는다 */
function recv(w: Wire, r: MlineEntry, mine: ExtMap[] | null): string[] {
  const rtx = r.rtx_pt !== undefined && r.rtx_ssrc !== undefined
  if ((r.rtx_pt !== undefined) !== (r.rtx_ssrc !== undefined)) throw new Error(`mid ${r.mid} 의 rtx 짝이 깨졌다`)
  const { clock, rate } = clockOf(r.codec)
  const pts = rtx ? [r.pt, r.rtx_pt!] : [r.pt]
  const out = [`m=${r.kind} ${w.sc.ice.port} UDP/TLS/RTP/SAVPF ${pts.join(' ')}`, ...head(w, r.mid, r.kind), 'a=sendonly', `a=rtpmap:${r.pt} ${r.codec}/${rate}`]
  if (r.fmtp) out.push(`a=fmtp:${r.pt} ${r.fmtp}`)
  for (const fb of fbOf(w.sc.codecs_sub ?? w.sc.codecs, r.kind, r.codec)) out.push(`a=rtcp-fb:${r.pt} ${fb}`)
  if (rtx) { out.push(`a=rtpmap:${r.rtx_pt} rtx/${clock}`, `a=fmtp:${r.rtx_pt} apt=${r.pt}`) }
  for (const e of recvExt(w.sc, r.kind, mine)) out.push(`a=extmap:${e.id} ${e.uri}`)
  out.push(`a=msid:${r.stream_id} ox-m${r.mid}`, `a=ssrc:${r.ssrc} cname:${CNAME}`)
  if (rtx) out.push(`a=ssrc:${r.rtx_ssrc} cname:${CNAME}`, `a=ssrc-group:FID ${r.ssrc} ${r.rtx_ssrc}`)
  out.push(...tail(w))
  return out
}

/** 구독 offer(2pc) — 배정표 줄을 mid 수치 오름차순으로(연:RULE-LINK-SDP-ORDER-SUB) */
export function subOffer(w: Wire, sess: { id: string; version: number }, rows: MlineEntry[]): string {
  const sorted = [...rows].sort((a, b) => Number(a.mid) - Number(b.mid))
  const out = session(sess.id, sess.version, sorted.map((r) => r.mid))
  for (const r of sorted) out.push(...recv(w, r, null))
  return out.join('\r\n') + '\r\n'
}

/** 1pc 통합 offer 의 절 하나 — 발행 · 구독 · 데이터 채널 · 비게 된 절 */
export type OneSection =
  | { readonly t: 'send'; readonly s: SendSection }
  | { readonly t: 'recv'; readonly row: MlineEntry }
  | { readonly t: 'app'; readonly mid: string }

/** 1pc 통합 offer — 절의 자리는 바꾸지 않는다 · 무관한 절은 한 글자도 안 바뀐다(연:RULE-LINK-SDP-1PC 규칙 2) */
export function onePcOffer(w: Wire, sess: { id: string; version: number }, sections: OneSection[], mine: ExtMap[]): string {
  const mids = sections.map((x) => (x.t === 'send' ? x.s.mid : x.t === 'recv' ? x.row.mid : x.mid))
  const out = session(sess.id, sess.version, mids)
  for (const x of sections) {
    if (x.t === 'app') out.push(...dc(w, x.mid))
    else if (x.t === 'send') out.push(...send(w, x.s, null))
    else out.push(...recv(w, x.row, mine))
  }
  return out.join('\r\n') + '\r\n'
}

/** answer 에서 그 m-line 의 확정값 — fmtp · 확장 번호 · SSRC(PUBLISH_TRACKS 재료 · 연:PUB.type.PublishTrack) */
export function sectionOf(p: Parsed, mid: string): Section | undefined {
  return p.media.find((m) => m.mid === mid)
}

/** H264 의 패킷화 · profile 이 방 값과 같은가 — level 은 보지 않는다(연:RULE-LINK-SDP-PUB-MLINE 코덱 고르기) */
export function sameCodec(c: Codec, room: string, roomFmtp?: string): boolean {
  const name = codecName(c).toLowerCase()
  if (name !== room.toLowerCase()) return false
  if (name !== 'h264') return true
  const kv = (f: string | undefined): Map<string, string> => new Map((f ?? '').split(';').map((x) => x.trim().split('=') as [string, string]).filter((x) => x.length === 2))
  const mine = kv(c.fmtp)
  const want = kv(roomFmtp ?? 'packetization-mode=1;profile-level-id=42e01f')
  const pm = (m: Map<string, string>): string => m.get('packetization-mode') ?? '0'
  const prof = (m: Map<string, string>): string => (m.get('profile-level-id') ?? '42001f').slice(0, 4).toLowerCase()
  return pm(mine) === pm(want) && prof(mine) === prof(want)
}
