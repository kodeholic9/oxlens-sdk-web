// author: kodeholic (powered by Claude)
// SDK§8-2 PeerLink — 미디어 서버 하나에 대한 이 세션의 전송 묶음.
// 수명은 그 서버 첫 방 입장에 나고 마지막 방 퇴장·미디어 사망·전면 재구축에 닫힌다(연§7-5).
import { Clock, systemClock } from '../../platform/clock.js'
import {
  DataChannelLike, IceState, MediaTrackLike, PeerConnectionLike, PeerFactory, RemoteTrackArrival,
  TransceiverLike,
} from '../../platform/webrtc.js'
import { publishAnswer, Seat, subscribeOffer, unifiedOffer } from '../sdp/build.js'
import { ServerConfig } from '../sdp/config.js'
import { parse } from '../sdp/parse.js'
import { Serial } from './serial.js'

/** 연§3-3 — 이름은 이것 하나다. 다른 이름은 서버가 거부한다. */
export const DC_LABEL = 'unreliable'
/** SDK§10-2 — disconnected 가 이만큼 이어지면 죽은 것으로 본다. */
export const DISCONNECT_GRACE_MS = 10_000

const LIVE: readonly IceState[] = ['connected', 'completed']

export interface LinkOptions {
  readonly peers: PeerFactory
  readonly clock?: Clock
  readonly disconnectGraceMs?: number
}

/** 연§6-3 READY{transport} 의 재료 — 1pc 확정본에서 뽑는다. */
export interface TransportReport {
  readonly extmap: readonly { id: number; uri: string }[]
  readonly codecs: readonly {
    kind: 'audio' | 'video'; pt: number; name: string; fmtp?: string; rtx_pt?: number
  }[]
}

export class LinkError extends Error {
  override readonly name = 'LinkError'
  constructor(readonly reason: 'not_open' | 'mode_mismatch' | 'no_confirmed', why: string) {
    super(why)
  }
}

export class PeerLink {
  private readonly clock: Clock
  private readonly grace: number
  private readonly serial = new Serial()
  private pub: PeerConnectionLike | null = null
  private sub: PeerConnectionLike | null = null
  private dc: DataChannelLike | null = null
  /** 연§9-10-1 — 보내기 코덱 줄의 출처. 2단계 협상이 만든다. */
  private confirmed: string | null = null
  private sendVersion = 1
  private recvVersion = 1
  private droppedAt = new Map<PeerConnectionLike, number>()

  constructor(readonly cfg: ServerConfig, private readonly opts: LinkOptions) {
    this.clock = opts.clock ?? systemClock
    this.grace = opts.disconnectGraceMs ?? DISCONNECT_GRACE_MS
  }

  get sfuId(): string { return this.cfg.sfu_id }
  get onePc(): boolean { return this.cfg.pc_mode === '1pc' }
  get channel(): DataChannelLike | null { return this.dc }
  get isOpen(): boolean { return this.pub !== null }
  get queued(): number { return this.serial.pending }

  /**
   * 연§9-7 · §9-10-3 2 — 전송로를 세운다. 트랙이 하나도 없어도 세운다:
   * 데이터 채널이 이 위에 있고 발언권이 그리로 간다.
   */
  open(): Promise<void> {
    return this.serial.run(async () => {
      if (this.pub) return
      const pub = this.opts.peers.create()
      this.pub = pub
      this.watch(pub)
      this.dc = pub.createDataChannel(DC_LABEL, { ordered: false, maxRetransmits: 0 })
      // 연§9-10-3 2② — 확정 answer 를 만들어 둔다. 없으면 첫 마이크에서 코덱 줄의 출처가 없다.
      if (this.onePc) {
        pub.addTransceiver('audio', { direction: 'inactive' })
        pub.addTransceiver('video', { direction: 'inactive' })
      }
      await this.clientOffer(pub)
      if (!this.onePc) {
        const sub = this.opts.peers.create()
        this.sub = sub
        this.watch(sub)
      }
    })
  }

  /** 연§9-1-1 — 브라우저가 offer, 클라가 answer. 최초 한 번과 2pc 보내기 재협상이 이 경로다. */
  private async clientOffer(pc: PeerConnectionLike): Promise<void> {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const local = pc.localDescription?.sdp ?? offer.sdp ?? ''
    const answer = publishAnswer(local, this.cfg, {
      session: { id: this.cfg.sfu_id, version: this.sendVersion },
    })
    this.sendVersion += 1
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    this.confirmed = answer
  }

  /**
   * 보낼 자리를 얻는다. ★1pc 는 m-line 을 늘리지 않는다(연§9-10-3 2-1) —
   * 세울 때 만든 inactive 트랜시버를 되쓴다. addTransceiver 를 다시 부르면
   * 최초 한 번만 허용된 클라 offer 경로가 다시 필요해지고 SSRC 도 새로 시작한다.
   */
  /**
   * 보낼 자리 하나. ★`prefer` 를 주면 그 코덱을 offer 의 첫 줄로 세운다(연§6-3 무전 video).
   *
   * ★`1pc` 의 예비 트랜시버를 재사용할 때는 선호를 못 정한다 — 이미 협상된 m-line 이라
   * 코덱 줄이 서 있다. 그때는 서버가 `1006` 으로 가른다(찍어 보는 것이 아니라 못 맞추는 것이다).
   */
  sender(kind: 'audio' | 'video', prefer?: { codec: string; fmtp?: string }): TransceiverLike {
    const pub = this.require(this.pub)
    if (this.onePc) {
      const spare = pub.getTransceivers().find((t) => t.direction === 'inactive' && this.kindOf(t) === kind)
      if (spare) { spare.direction = 'sendonly'; return spare }
    }
    const t = pub.addTransceiver(kind, { direction: 'sendonly' })
    if (prefer !== undefined) applyPreference(t, kind, prefer)
    return t
  }

  /** 연§6-3 — 등록에 실을 ssrc·pt·fmtp 는 내 offer 에서 읽는다. */
  localOffer(): string | null {
    return this.pub?.localDescription?.sdp ?? null
  }

  private kindOf(t: TransceiverLike): string {
    return t.receiver.track.kind
  }

  /** 연§9-8 — 내가 트랙을 더하거나 뺐다. 2pc 는 보내기 연결만 다시 협상한다. */
  renegotiatePublish(seats: readonly Seat[] = []): Promise<void> {
    return this.serial.run(async () => {
      const pub = this.require(this.pub)
      if (this.onePc) return this.unified(pub, seats)
      await this.clientOffer(pub)
    })
  }

  /**
   * 연§9-1-2 — 받기는 클라가 offer 를 조립해 먹인다.
   * 성공하면 부르는 쪽이 READY{tracks} 를 보낸다. 실패했으면 보내지 않는다.
   */
  negotiateSubscribe(seats: readonly Seat[]): Promise<void> {
    return this.serial.run(async () => {
      if (this.onePc) return this.unified(this.require(this.pub), seats)
      const sub = this.require(this.sub)
      const offer = subscribeOffer(seats, this.cfg, {
        session: { id: this.cfg.sfu_id, version: this.recvVersion },
      })
      this.recvVersion += 1
      await this.rollbackIfBusy(sub)
      await sub.setRemoteDescription({ type: 'offer', sdp: offer })
      const answer = await sub.createAnswer()
      await sub.setLocalDescription(answer)
    })
  }

  private async unified(pc: PeerConnectionLike, seats: readonly Seat[]): Promise<void> {
    if (this.confirmed === null) {
      throw new LinkError('no_confirmed', '확정 answer 가 없다 — 전송로 세우기가 끝나지 않았다')
    }
    const mine = await pc.createOffer()
    const offer = unifiedOffer(seats, this.cfg, {
      mine: mine.sdp ?? '',
      confirmed: this.confirmed,
      session: { id: this.cfg.sfu_id, version: this.recvVersion },
    })
    this.recvVersion += 1
    await this.rollbackIfBusy(pc)
    await pc.setRemoteDescription({ type: 'offer', sdp: offer })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
  }

  /** 연§9-1-2 · §9-10-3 4 — 브라우저가 이미 협상 중이면 되돌리고 시작한다. */
  private async rollbackIfBusy(pc: PeerConnectionLike): Promise<void> {
    if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' })
  }

  /** 연§6-3 — 서버가 egress 확장 번호·PT 를 이 표로 재기록한다. */
  transportReport(): TransportReport {
    if (this.confirmed === null) {
      throw new LinkError('no_confirmed', '신고할 확정본이 없다')
    }
    const parsed = parse(this.confirmed)
    const extmap = new Map<string, number>()
    const codecs: { kind: 'audio' | 'video'; pt: number; name: string; fmtp?: string; rtx_pt?: number }[] = []
    for (const m of parsed.sections) {
      if (m.kind === 'application') continue
      for (const [id, uri] of m.extmap) extmap.set(uri, id)
      for (const pt of m.pts) {
        const rtpmap = m.rtpmap.get(pt)
        if (rtpmap === undefined || m.rtx.has(pt)) continue
        const fmtp = m.fmtp.get(pt)
        let rtxPt: number | undefined
        for (const [candidate, apt] of m.rtx) if (apt === pt) rtxPt = candidate
        codecs.push({
          kind: m.kind, pt, name: rtpmap.split('/')[0]!,
          ...(fmtp === undefined ? {} : { fmtp }),
          ...(rtxPt === undefined ? {} : { rtx_pt: rtxPt }),
        })
      }
    }
    return { extmap: [...extmap].map(([uri, id]) => ({ id, uri })), codecs }
  }

  /**
   * SDK§10-2 — 모든 PC 가 connected·completed 여야 살아 있다.
   * ★살아 있지 않은 것과 죽은 것은 다르다 — checking 은 아직 판정 전이라 둘 다 거짓이다.
   */
  alive(): boolean {
    const pcs = this.peerList()
    return pcs.length > 0 && pcs.every((pc) => LIVE.includes(pc.iceConnectionState))
  }

  /** SDK§10-2 — failed, 또는 disconnected 가 유예를 넘겼다. 판정 시점은 부르는 쪽이 정한다. */
  dead(now = this.clock.now()): boolean {
    const pcs = this.peerList()
    if (pcs.length === 0) return false
    return pcs.some((pc) => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') return true
      const since = this.droppedAt.get(pc)
      return since !== undefined && now - since >= this.grace
    })
  }

  private peerList(): readonly PeerConnectionLike[] {
    return [this.pub, this.sub].filter((p): p is PeerConnectionLike => p !== null)
  }

  /**
   * SDK§11-2 — 그 ssrc 에 매인 계수만 골라 준다.
   * ★한 연결의 전량을 주면 부르는 쪽이 다시 고르게 되고, 그 고르기가 두 곳에 생긴다.
   */
  async statsFor(ssrc: number, direction: 'inbound' | 'outbound'): Promise<Map<string, Record<string, unknown>>> {
    const pc = direction === 'inbound' && !this.onePc ? this.sub : this.pub
    const out = new Map<string, Record<string, unknown>>()
    if (!pc) return out
    for (const [id, row] of await pc.getStats()) {
      if (row.ssrc === ssrc) out.set(id, row)
    }
    return out
  }

  /** 그 m-line 에 실제로 도착한 트랙. 보관본의 mid 와 여기서 맞춘다. */
  mediaFor(mid: string): MediaTrackLike | null {
    const pc = this.onePc ? this.pub : this.sub
    const t = pc?.getTransceivers().find((x) => x.mid === mid)
    return t?.receiver.track ?? null
  }

  /**
   * 그 트랙을 받고 있는 수신기. SDK§12 — 재생 지연 손잡이가 거기 달려 있다.
   *
   * ★`mid` 가 아니라 트랙 자체로 찾는다 — 부르는 쪽(`RemoteTrack`)이 쥔 것이 트랙이고,
   * 보관본의 `mid` 를 한 번 더 거치면 그 사이에 재협상이 들면 어긋난다.
   */
  receiverOf(track: MediaTrackLike): RTCRtpReceiver | null {
    const pc = this.onePc ? this.pub : this.sub
    const t = pc?.getTransceivers().find((x) => x.receiver.track === track)
    return (t?.receiver as RTCRtpReceiver | undefined) ?? null
  }

  /** 남의 트랙이 도착한다. 주인이 훑는다 — 콜백을 주입받지 않는다. */
  async *remoteTracks(): AsyncIterableIterator<RemoteTrackArrival> {
    const pc = this.onePc ? this.pub : this.sub
    if (!pc) return
    yield* pc.remoteTracks()
  }

  /** SDK§10-6 — pc.close() 가 DC 를 같이 닫는다. DC 핸들러 정리는 뒤다. */
  close(): void {
    for (const pc of [this.sub, this.pub]) pc?.close()
    this.dc?.close()
    this.pub = null
    this.sub = null
    this.dc = null
    this.confirmed = null
    this.droppedAt.clear()
  }

  private require(pc: PeerConnectionLike | null): PeerConnectionLike {
    if (!pc) throw new LinkError('not_open', `${this.cfg.sfu_id} 전송로가 아직 안 섰다`)
    return pc
  }

  private watch(pc: PeerConnectionLike): void {
    void (async () => {
      for await (const state of pc.iceStates()) {
        if (state === 'disconnected') {
          if (!this.droppedAt.has(pc)) this.droppedAt.set(pc, this.clock.now())
        } else {
          this.droppedAt.delete(pc)
        }
      }
    })()
  }
}

/**
 * 연§6-3 — 그 코덱을 맨 앞으로 민다. ★**빼지 않고 순서만 바꾼다** — 빼면 협상이 통째로 실패할 수
 * 있고, 서버는 첫 줄을 쓴다. `fmtp` 까지 맞는 것이 있으면 그것을 먼저 세운다(H264 는 프로파일에서 갈린다).
 * 브라우저가 능력표나 선호 설정을 안 주면 ★조용히 넘긴다 — 그때는 서버 순서다.
 */
function applyPreference(
  t: TransceiverLike,
  kind: 'audio' | 'video',
  prefer: { codec: string; fmtp?: string },
): void {
  const caps = (globalThis as { RTCRtpSender?: { getCapabilities?: (k: string) => { codecs: Codec[] } | null } })
    .RTCRtpSender?.getCapabilities?.(kind)
  applyPreferenceForTest(t, caps?.codecs ?? null, prefer)
}

interface Codec { mimeType: string; sdpFmtpLine?: string }

/** 순수 부분 — 능력표와 선호만 받는다. 브라우저 없이 1층이 판정한다. */
export function applyPreferenceForTest(
  t: TransceiverLike,
  codecs: readonly Codec[] | null,
  prefer: { codec: string; fmtp?: string },
): void {
  if (codecs === null || codecs.length === 0 || !t.setCodecPreferences) return
  const want = prefer.codec.toLowerCase()
  const score = (c: Codec): number => {
    if (!c.mimeType.toLowerCase().endsWith(`/${want}`)) return 0
    return prefer.fmtp !== undefined && c.sdpFmtpLine === prefer.fmtp ? 2 : 1
  }
  const sorted = [...codecs].sort((a, b) => score(b) - score(a))
  if (score(sorted[0] ?? { mimeType: '' }) === 0) return
  t.setCodecPreferences(sorted)
}
