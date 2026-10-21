// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE internal/transport · PeerLink · 연:RULE-LINK-SDP-RENEGOTIATE · 연:RULE-LINK-SDP-1PC-PROC · 연:RULE-LINK-SDP-DC-OPENER · 연:RULE-LINK-SDP-COMMON 재시작 조립 · model: claude-opus-5-5
import type { ServerConfig, MlineEntry, ExtMap, PublishTrack } from './wire/ws.js'
import * as Sdp from './sdp.js'
import { createPeerConnection, udpCandidateOn, tcpCandidateOn } from '../platform/webrtc.js'
import { negotiationFault, type Fault } from '../platform/fault.js'
import { Queue } from '../platform/queue.js'
import type { Logger } from '../platform/log.js'

export type PcMode = '1pc' | '2pc'

/** 그 연결의 브라우저 사실 — 층마다 따로(SDK:RULE-LINK-LAYERS) · 2pc 는 나쁜 쪽으로 합친다 */
export type LinkFact =
  | { readonly t: 'ice'; readonly state: RTCIceConnectionState }
  | { readonly t: 'dtls'; readonly state: RTCDtlsTransportState }
  | { readonly t: 'sctp'; readonly state: RTCSctpTransportState }
  | { readonly t: 'dc'; readonly open: boolean }
  | { readonly t: 'dcData'; readonly data: Uint8Array }
  | { readonly t: 'track'; readonly mid: string; readonly track: MediaStreamTrack; readonly receiver: RTCRtpReceiver }

export interface Encoding {
  readonly rid?: string
  readonly scaleResolutionDownBy?: number
  readonly maxBitrate?: number
  readonly maxFramerate?: number
}

/** 발행 자리 하나 — 트랜시버 풀의 한 칸(SDK:IMPL-SRC-BLOCKS 조립 = 형 staged) */
export interface SendSlot {
  readonly kind: 'audio' | 'video'
  readonly simulcast: boolean
  mid: string
  transceiver: RTCRtpTransceiver | null
  /** 서버가 받는 절 — false 면 inactive */
  active: boolean
  /** 쓰는 자리 — false 면 풀에 돌아간 자리(같은 kind · 같은 구조가 되쓴다) */
  owned: boolean
  /** 방 미디어 코덱 고르기 */
  room: { readonly name: string; readonly fmtp?: string } | null
  /** opus fmtp 의 받는 쪽 선호(2pc — 트랙 단위) */
  opusFmtp: string
  readonly encodings: readonly Encoding[]
}

export interface NumberTags {
  readonly codecs: { kind: 'audio' | 'video'; pt: number; name: string; fmtp?: string; rtx_pt?: number }[]
  readonly extmap: ExtMap[]
}

export interface Negotiated {
  readonly ok: boolean
  readonly fault?: Fault
}

type Entry = { readonly t: 'send'; readonly slot: SendSlot } | { readonly t: 'recv'; readonly mid: string } | { readonly t: 'app'; readonly mid: string }

const RANK: Record<RTCIceConnectionState, number> = { failed: 5, disconnected: 4, closed: 6, new: 2, checking: 3, connected: 0, completed: 0 }

/**
 * 미디어 서버 하나에 대한 이 세션의 전송 묶음(SDK:IMPL-MOD-TABLE PeerLink) — 2pc 는 발행 PC(클라 answer · DC) + 구독 PC(클라 offer),
 * 1pc 는 하나에 둘 다 · 트랜시버 풀 · 협상 큐 · 그 서버 자격. ★negotiationneeded 를 듣지 않는다 — 협상은 큐가 시작한다.
 */
export class PeerLink {
  readonly facts = new Queue<LinkFact>()
  readonly slots: SendSlot[] = []
  private readonly pub: RTCPeerConnection
  private sub: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private rows: MlineEntry[] = []
  private readonly book: Entry[] = []
  private firstAnswer: Sdp.Parsed | null = null
  private mine: ExtMap[] = []
  private readonly sess = { id: String(Date.now()), version: 1 }
  private pubCreds: Sdp.Creds
  private subCreds: Sdp.Creds
  private restartPending = false
  private pubDirty = true
  private subDirty = false
  private lastIce: RTCIceConnectionState = 'new'
  private closed = false

  constructor(readonly mode: PcMode, public sc: ServerConfig | null, private readonly opusDefault: string, private readonly log: Logger) {
    this.pub = createPeerConnection()
    this.pubCreds = sc ? { ufrag: sc.ice.publish_ufrag, pwd: sc.ice.publish_pwd } : { ufrag: '', pwd: '' }
    this.subCreds = sc ? { ufrag: sc.ice.subscribe_ufrag, pwd: sc.ice.subscribe_pwd } : { ufrag: '', pwd: '' }
    this.watch(this.pub)
    this.openDc()
  }

  /** 다시 협상할 것이 있다 */
  get dirty(): boolean { return this.pubDirty || this.subDirty || this.restartPending }

  get dcOpen(): boolean { return this.dc?.readyState === 'open' }
  get pcs(): RTCPeerConnection[] { return this.sub ? [this.pub, this.sub] : [this.pub] }

  private watch(pc: RTCPeerConnection): void {
    pc.oniceconnectionstatechange = () => this.iceChanged()
    pc.ontrack = (ev) => {
      const mid = ev.transceiver.mid
      if (mid !== null) this.facts.push({ t: 'track', mid, track: ev.track, receiver: ev.receiver })
    }
  }

  private iceChanged(): void {
    let worst: RTCIceConnectionState = 'connected'
    for (const pc of this.pcs) if (RANK[pc.iceConnectionState] > RANK[worst]) worst = pc.iceConnectionState
    if (worst === this.lastIce) return
    this.lastIce = worst
    this.facts.push({ t: 'ice', state: worst })
  }

  get ice(): RTCIceConnectionState { return this.lastIce }

  private watchSctp(): void {
    const sctp = this.pub.sctp
    if (!sctp) return
    sctp.onstatechange = () => this.facts.push({ t: 'sctp', state: sctp.state })
    const dtls = sctp.transport
    dtls.onstatechange = () => this.facts.push({ t: 'dtls', state: dtls.state })
  }

  get sctpState(): RTCSctpTransportState | null { return this.pub.sctp?.state ?? null }
  get dtlsState(): RTCDtlsTransportState | null { return this.pub.sctp?.transport.state ?? null }

  /** DC — 발행 연결에 클라가 연다 · 이름 unreliable · 순서 끔 · 재전송 0(연:RULE-LINK-SDP-DC-OPENER) */
  private openDc(): void {
    const dc = this.pub.createDataChannel('unreliable', { ordered: false, maxRetransmits: 0 })
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => { if (this.dc === dc) this.facts.push({ t: 'dc', open: true }) }
    dc.onclose = () => { if (this.dc === dc && !this.closed) this.facts.push({ t: 'dc', open: false }) }
    dc.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) this.facts.push({ t: 'dcData', data: new Uint8Array(ev.data) }) }
    this.dc = dc
  }

  /** 같은 PC 위에 DC 를 새로 연다 — 재협상 없음(DCEP) */
  reopenDc(): void {
    const old = this.dc
    if (old) { old.onopen = null; old.onclose = null; old.onmessage = null; try { old.close() } catch { /* 닫혔다 */ } }
    this.openDc()
  }

  sendDc(bytes: Uint8Array): boolean {
    const dc = this.dc
    if (!dc || dc.readyState !== 'open') return false
    try { dc.send(new Uint8Array(bytes).buffer); return true } catch { return false }
  }

  private wire(creds: Sdp.Creds): Sdp.Wire {
    if (!this.sc) throw new Error('server_config 가 없다')
    return { sc: this.sc, creds, udp: udpCandidateOn(), tcp: tcpCandidateOn() }
  }

  /** 협상 큐 — 한 번에 하나씩(연:RULE-LINK-SDP-RENEGOTIATE) */
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** 1pc 첫 협상 ①~③ — DC · audio 1 + video 1 inactive · 브라우저 offer 까지. 그 offer 의 표가 번호표다 */
  first1pc(): Promise<NumberTags> {
    return this.queued(async () => {
      this.pub.addTransceiver('audio', { direction: 'inactive' })
      this.pub.addTransceiver('video', { direction: 'inactive' })
      const offer = await this.pub.createOffer()
      await this.pub.setLocalDescription(offer)
      const tags = Sdp.numberTags(offer.sdp ?? '')
      this.mine = tags.extmap
      return tags
    })
  }

  /** 1pc 첫 협상 ④ — 응답의 server_config 로 answer 를 지어 닫는다 · 서버 지원 코덱을 전부 남긴다 */
  complete1pc(sc: ServerConfig): Promise<Negotiated> {
    this.sc = sc
    this.pubCreds = { ufrag: sc.ice.publish_ufrag, pwd: sc.ice.publish_pwd }
    return this.queued(async () => {
      try {
        const offer = Sdp.parse(this.pub.localDescription?.sdp ?? '')
        const ans = Sdp.answer(this.wire(this.pubCreds), offer, () => this.opusDefault)
        await this.pub.setRemoteDescription({ type: 'answer', sdp: ans })
        this.firstAnswer = Sdp.parse(ans)
        this.sess.id = offer.sessionId
        this.sess.version = offer.version
        for (const m of offer.media) {
          if (m.kind === 'application') { this.book.push({ t: 'app', mid: m.mid }); continue }
          const tr = this.pub.getTransceivers().find((t) => t.mid === m.mid) ?? null
          const slot: SendSlot = { kind: m.kind, simulcast: false, mid: m.mid, transceiver: tr, active: false, owned: false, room: null, opusFmtp: this.opusDefault, encodings: [] }
          this.slots.push(slot)
          this.book.push({ t: 'send', slot })
        }
        this.watchSctp()
        this.pubDirty = false
        return { ok: true }
      } catch (e) {
        this.log.error('1pc 첫 협상 실패', { err: String(e) })
        return { ok: false, fault: negotiationFault('FIRST', e) }
      }
    })
  }

  /** 2pc — 발행 PC 를 DC 하나로 세운다(트랙이 없어도 — 청취 전용의 정상 경로) */
  open2pc(sc: ServerConfig): void {
    this.sc = sc
    this.pubCreds = { ufrag: sc.ice.publish_ufrag, pwd: sc.ice.publish_pwd }
    this.subCreds = { ufrag: sc.ice.subscribe_ufrag, pwd: sc.ice.subscribe_pwd }
    this.pubDirty = true
  }

  /** 배정표 줄 — 바뀌었으면 구독 쪽이 다시 짓는다 */
  setRows(rows: MlineEntry[]): void {
    this.rows = [...rows].sort((a, b) => Number(a.mid) - Number(b.mid))
    if (this.mode === '1pc') {
      for (const r of this.rows) if (!this.book.some((e) => e.t === 'recv' && e.mid === r.mid)) this.book.push({ t: 'recv', mid: r.mid })
    }
    this.subDirty = true
  }

  /** 발행 자리를 얻는다 — 같은 kind · 같은 구조의 쉬는 자리를 먼저 되쓴다(BUNDLE 천장 — SDK:IMPL-SRC-BLOCKS) */
  acquireSlot(kind: 'audio' | 'video', simulcast: boolean, encodings: readonly Encoding[], room: SendSlot['room'], opusFmtp: string): SendSlot {
    const free = this.slots.find((s) => !s.owned && s.kind === kind && s.simulcast === simulcast)
    if (free) {
      if (!free.active) this.pubDirty = true
      free.owned = true
      free.active = true
      free.room = room
      free.opusFmtp = opusFmtp
      ;(free as { encodings: readonly Encoding[] }).encodings = encodings
      if (free.transceiver && free.transceiver.direction !== 'sendonly') free.transceiver.direction = 'sendonly'
      return free
    }
    const slot: SendSlot = { kind, simulcast, mid: '', transceiver: null, active: true, owned: true, room, opusFmtp, encodings }
    if (this.mode === '2pc') {
      const init: RTCRtpTransceiverInit = { direction: 'sendonly' }
      if (simulcast) init.sendEncodings = encodings.map((e) => ({ ...e }))
      slot.transceiver = this.pub.addTransceiver(kind, init)
    } else {
      slot.mid = this.freeMid()
      this.book.push({ t: 'send', slot })
    }
    this.slots.push(slot)
    this.pubDirty = true
    return slot
  }

  /** 새 발행 m-line 의 mid — 0~31 중 비어 있는 가장 작은 값(연:EX-LINK-SDP-LISTEN-ONLY) */
  private freeMid(): string {
    const used = new Set(this.book.map((e) => (e.t === 'send' ? e.slot.mid : e.mid)))
    for (let i = 0; i < 32; i++) if (!used.has(String(i))) return String(i)
    throw new Error('클라 m-line 32 를 다 썼다')
  }

  /** 자리를 풀에 돌린다 — 트랜시버는 그대로 · 방향도 그대로(재협상 없음 — 연:RULE-PUB-OFF) */
  releaseSlot(slot: SendSlot): void {
    slot.owned = false
  }

  /** 서버가 지운 발행 — 트랜시버를 inactive 로 돌려 재협상한다(연:PUB.C.SENDING.revoked) */
  deactivate(slot: SendSlot): void {
    slot.owned = false
    slot.active = false
    if (slot.transceiver) slot.transceiver.direction = 'inactive'
    this.pubDirty = true
  }

  /** ICE 재시작 — 새 서버 자격으로 다시 협상한다 · 지문 · setup 은 한 글자도 안 바꾼다 */
  restartWith(pub: Sdp.Creds, sub: Sdp.Creds | null): void {
    this.pubCreds = pub
    if (sub) this.subCreds = sub
    this.restartPending = true
  }

  /** 협상 — 바뀐 쪽만 다시 짓는다 · 큐로 하나씩 */
  negotiate(): Promise<Negotiated> {
    return this.queued(async () => {
      if (this.closed || !this.sc) return { ok: false, fault: negotiationFault('CLOSED') }
      try {
        if (this.mode === '2pc') {
          if (this.pubDirty || this.restartPending) await this.negotiatePub2pc()
          if (this.subDirty || (this.restartPending && this.sub)) await this.negotiateSub2pc()
        } else {
          await this.negotiate1pc()
        }
        this.restartPending = false
        return { ok: true }
      } catch (e) {
        this.log.error('협상 실패', { err: String(e) })
        for (const pc of this.pcs) {
          if (pc.signalingState !== 'stable' && pc.signalingState !== 'closed') {
            try { await pc.setLocalDescription({ type: 'rollback' }) } catch { /* 되돌릴 것이 없다 */ }
          }
        }
        return { ok: false, fault: negotiationFault(this.mode === '1pc' ? 'ONE_PC' : 'APPLY', e) }
      }
    })
  }

  private async negotiatePub2pc(): Promise<void> {
    this.pubDirty = false
    const offer = await this.pub.createOffer(this.restartPending ? { iceRestart: true } : {})
    await this.pub.setLocalDescription(offer)
    const parsed = Sdp.parse(offer.sdp ?? '')
    const bySection = (s: Sdp.Section): SendSlot | undefined => this.slots.find((x) => x.transceiver?.mid === s.mid)
    const ans = Sdp.answer(this.wire(this.pubCreds), parsed, (s) => bySection(s)?.opusFmtp ?? this.opusDefault, (s, cs) => {
      const slot = bySection(s)
      if (!slot?.room) return cs
      return pickRoom(cs, slot.room)
    })
    await this.pub.setRemoteDescription({ type: 'answer', sdp: ans })
    for (const slot of this.slots) if (slot.transceiver?.mid) slot.mid = slot.transceiver.mid
    this.watchSctp()
  }

  private async negotiateSub2pc(): Promise<void> {
    this.subDirty = false
    if (!this.rows.length) return
    if (!this.sub) { this.sub = createPeerConnection(); this.watch(this.sub) }
    const sub = this.sub
    if (sub.signalingState !== 'stable') await sub.setLocalDescription({ type: 'rollback' })
    this.sess.version += 1
    const offer = Sdp.subOffer(this.wire(this.subCreds), this.sess, this.rows)
    await sub.setRemoteDescription({ type: 'offer', sdp: offer })
    const ans = await sub.createAnswer()
    await sub.setLocalDescription(ans)
  }

  private async negotiate1pc(): Promise<void> {
    this.pubDirty = false
    this.subDirty = false
    const pc = this.pub
    if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' })
    const sections: Sdp.OneSection[] = []
    for (const e of this.book) {
      if (e.t === 'app') sections.push({ t: 'app', mid: e.mid })
      else if (e.t === 'recv') {
        const row = this.rows.find((r) => r.mid === e.mid)
        if (row) sections.push({ t: 'recv', row })
      } else sections.push({ t: 'send', s: this.sendSection(e.slot) })
    }
    this.sess.version += 1
    const offer = Sdp.onePcOffer(this.wire(this.pubCreds), this.sess, sections, this.mine)
    await pc.setRemoteDescription({ type: 'offer', sdp: offer })
    for (const slot of this.slots) {
      const tr = pc.getTransceivers().find((t) => t.mid === slot.mid) ?? null
      if (!tr) continue
      slot.transceiver = tr
      const dir: RTCRtpTransceiverDirection = slot.active ? 'sendonly' : 'inactive'
      if (tr.direction !== dir) tr.direction = dir
    }
    const ans = await pc.createAnswer()
    await pc.setLocalDescription(ans)
  }

  /** 1pc 발행 절 — 확정본에서 가져온다(연:RULE-LINK-SDP-1PC-FILL) · 방향은 서버 시각 */
  private sendSection(slot: SendSlot): Sdp.SendSection {
    const base = this.firstAnswer?.media.find((m) => m.mid === slot.mid) ?? this.firstAnswer?.media.find((m) => m.kind === slot.kind)
    const all = base?.codecs ?? []
    const ext = base?.ext ?? []
    if (!slot.active || !slot.room) return { mid: slot.mid, kind: slot.kind, dir: slot.active ? 'recvonly' : 'inactive', codecs: all, ext, rids: [] }
    const codecs = pickRoom(all, slot.room)
    if (!codecs.length) throw new Error(`확정본에 방 코덱 ${slot.room.name} 줄이 없다`)
    return { mid: slot.mid, kind: slot.kind, dir: 'recvonly', codecs, ext, rids: slot.simulcast ? slot.encodings.map((e) => e.rid ?? '').filter((r) => r) : [] }
  }

  /** 발행 재료 — ssrc 는 내 쪽 SDP · fmtp · 확장 번호는 확정본(answer)에서(연:PUB.type.PublishTrack) */
  sendInfo(slot: SendSlot): { track: Omit<PublishTrack, 'source' | 'duplex' | 'simulcast'>; ext: Record<string, number> } | null {
    const pc = this.pub
    const local = pc.localDescription ? Sdp.parse(pc.localDescription.sdp) : null
    const remote = pc.remoteDescription ? Sdp.parse(pc.remoteDescription.sdp) : null
    if (!local || !remote) return null
    const ans = this.mode === '2pc' ? remote : local
    const mine = local.media.find((m) => m.mid === slot.mid)
    const conf = ans.media.find((m) => m.mid === slot.mid)
    if (!mine || !conf || !conf.codecs.length) return null
    const c = conf.codecs[0]!
    const ssrc = slot.simulcast ? 0 : (mine.fid ? mine.fid[0] : mine.ssrcs[0] ?? 0)
    const t: { kind: 'audio' | 'video'; ssrc: number; mid: string; pt: number; codec?: string; fmtp?: string; rtx_pt?: number; rtx_ssrc?: number } = { kind: slot.kind, ssrc, mid: slot.mid, pt: c.pt }
    t.codec = Sdp.codecName(c)
    if (c.fmtp) t.fmtp = c.fmtp
    if (c.rtx !== undefined) t.rtx_pt = c.rtx
    if (!slot.simulcast && mine.fid) t.rtx_ssrc = mine.fid[1]
    const ext: Record<string, number> = {}
    for (const e of conf.ext) {
      if (e.uri === 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01') ext['twcc_extmap_id'] = e.id
      else if (e.uri === 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id') ext['rid_extmap_id'] = e.id
      else if (e.uri === 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id') ext['repair_rid_extmap_id'] = e.id
      else if (e.uri === 'urn:ietf:params:rtp-hdrext:sdes:mid') ext['mid_extmap_id'] = e.id
      else if (e.uri === 'urn:ietf:params:rtp-hdrext:ssrc-audio-level') ext['audio_level_extmap_id'] = e.id
    }
    return { track: t, ext }
  }

  receiverOf(mid: string): RTCRtpReceiver | null {
    if (this.slots.some((s) => s.mid === mid)) return null
    for (const pc of this.pcs) {
      const tr = pc.getTransceivers().find((t) => t.mid === mid)
      if (tr) return tr.receiver
    }
    return null
  }

  async stats(): Promise<RTCStatsReport[]> {
    const out: RTCStatsReport[] = []
    for (const pc of this.pcs) { try { out.push(await pc.getStats()) } catch { /* 닫혔다 */ } }
    return out
  }

  /** pc.close() 가 DC 를 같이 닫는다 → DC 핸들러 정리는 뒤(SDK:RULE-MOD-TEARDOWN) */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pc of this.pcs) { try { pc.close() } catch { /* 닫혔다 */ } }
    const dc = this.dc
    if (dc) { dc.onopen = null; dc.onclose = null; dc.onmessage = null }
    for (const pc of this.pcs) { pc.oniceconnectionstatechange = null; pc.ontrack = null }
    this.facts.end()
  }
}

/** 방 미디어 코덱의 줄만 — H264 는 패킷화 · profile 이 같은 줄 하나(연:RULE-LINK-SDP-PUB-MLINE 코덱 고르기) */
export function pickRoom(cs: Sdp.Codec[], room: { readonly name: string; readonly fmtp?: string }): Sdp.Codec[] {
  const hit = cs.find((c) => Sdp.sameCodec(c, room.name, room.fmtp))
  return hit ? [hit] : []
}
