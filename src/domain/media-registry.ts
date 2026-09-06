// author: kodeholic (powered by Claude)
// 연§7-4 · SDK§6-1 — 발행 3단(트랜시버·등록·송신). 되돌리기는 한 곳이고 그 단만 되돌린다.
import { Clock } from '../platform/clock.js'
import { CaptureKind, CaptureRequest, Devices } from '../platform/media.js'
import { MediaTrackLike, TransceiverLike } from '../platform/webrtc.js'
import { Signaling } from '../internal/signaling.js'
import { parse } from '../internal/sdp/parse.js'
import { PeerLink } from '../internal/transport/link.js'
import { Op } from '../internal/wire.js'
import { request } from './request.js'

/** SDK§6-1 — 연§2-4 넷 앞에 acquired(트랙은 있고 발행 전)를 더한 다섯. */
export type LocalTrackState = 'idle' | 'acquired' | 'staged' | 'registered' | 'sending'
/** SDK§6-1 — 장치 수명 관리는 sdk 것에만 걸린다. */
export type Owner = 'app' | 'sdk' | 'external'
export type Duplex = 'full' | 'half'

const SOURCE_OF: Readonly<Record<CaptureKind, string>> = {
  microphone: 'microphone', camera: 'camera', screen: 'screen',
}

export interface LocalTrack {
  readonly id: string
  readonly kind: 'audio' | 'video'
  readonly source: string
  state: LocalTrackState
  owner: Owner
  duplex: Duplex
  muted: boolean
  media: MediaTrackLike
  transceiver: TransceiverLike | null
  /** 등록 응답이 준 값 — 이후 모든 식별이 이것이다(연§7-4-3). */
  trackId: string | null
  server: string | null
  room: string | null
  /** 브라우저가 정한 값. 시뮬캐스트면 0 이라 계수를 못 고른다(연§6-3). */
  ssrc: number | null
  /** 계수를 물어볼 자리(SDK§11-2). 등록이 풀리면 없다. */
  link: PeerLink | null
  /**
   * SDK§6-1 — 외부 소스가 걸린 동안 SDK 가 ★**살려 두는** 자기 장치 트랙.
   * `replaceSource(null)` 이 여기로 돌아온다. 살려 두지 않으면 복귀에 장치를 다시 잡아야 하고
   * 프롬프트가 또 뜬다(그 자리가 `cold` 미적용의 이유이기도 하다).
   */
  ownMedia: MediaTrackLike | null
}

export class PublishError extends Error {
  override readonly name = 'PublishError'
  constructor(readonly reason: 'no_mid' | 'no_pt' | 'no_ssrc' | 'no_codec' | 'wire', why: string) {
    super(why)
  }
}

/** SDK§6-3 — 인코딩 값. 구조는 여기 없다. */
export interface EncodingChange {
  readonly maxBitrate?: number
  readonly maxFramerate?: number
  readonly degradationPreference?: string
  readonly layers?: ReadonlyArray<{ maxBitrate?: number; maxFramerate?: number; active?: boolean }>
}

export interface PublishTarget {
  readonly link: PeerLink
  readonly roomId: string
  readonly sfuId: string
}

export interface RegistryOptions {
  readonly devices: Devices
  readonly clock: Clock
}

export class MediaRegistry {
  private readonly tracks = new Map<string, LocalTrack>()
  private seq = 0

  constructor(private readonly sig: () => Signaling, private readonly opts: RegistryOptions) {}

  get all(): readonly LocalTrack[] { return [...this.tracks.values()] }

  /**
   * 연§7-3-2 4 — 등록이 살아 있으면 신고한다.
   * ★반이중 마이크는 RTP 없이도 신고한다(registered 가 정상이다).
   */
  liveTracks(): readonly { track_id: string; kind: string }[] {
    return this.all
      .filter((t) => t.trackId !== null && (t.state === 'registered' || t.state === 'sending'))
      .map((t) => ({ track_id: t.trackId!, kind: t.kind }))
  }

  /**
   * SDK§6-1 — 획득만. 접속·방·발언 방이 없어도 된다(로비가 이 자리다).
   * ★전부 아니면 전무 — 하나가 실패하면 이미 획득한 것을 SDK 가 정지한다.
   */
  async acquire(reqs: readonly CaptureRequest[]): Promise<readonly LocalTrack[]> {
    const got: LocalTrack[] = []
    try {
      for (const req of reqs) {
        const media = await this.opts.devices.capture(req)
        got.push(this.enroll(media, req.kind, 'app'))
      }
    } catch (e) {
      for (const t of got) { t.media.stop(); this.tracks.delete(t.id) }
      throw e
    }
    return got
  }

  /**
   * SDK§6-1 예외 경로 — SDK 가 소스를 못 잡는 것(캔버스·파일·외부 캡처)을 등록에 올린다.
   *
   * ★`owner:'external'` 이다 — 등록·전송만 하고 ★**장치 수명 관리 대상이 아니다**
   * (`cold`·`switchDevice`·재획득·`silence` 가 안 걸린다. 무시가 아니라 대상이 아니다).
   * 소스가 죽는 것은 앱이 안다 — SDK 는 `device_lost` 를 내지 않는다.
   */
  adopt(media: MediaTrackLike, kind: CaptureKind): LocalTrack {
    return this.enroll(media, kind, 'external')
  }

  /**
   * 연§7-4-1~§7-4-4 — 트랜시버 → 협상 → 등록 → 송신.
   * ★②가 성공한 뒤 ③에서 실패하면 remove 를 보내 되돌린다. 안 하면 유령 등록이 상한을 먹는다.
   */
  async publish(
    track: LocalTrack,
    to: PublishTarget,
    prefer?: { codec: string; fmtp?: string },
  ): Promise<LocalTrack> {
    if (track.state !== 'acquired' && track.state !== 'idle') return track

    // 연§6-3 — 무전 video 는 그 방 슬롯 코덱과 같아야 한다. ★보내기 전에 맞춘다.
    const transceiver = to.link.sender(track.kind, prefer)
    track.transceiver = transceiver
    await to.link.renegotiatePublish()
    track.state = 'staged'

    const line = this.lineOf(to, transceiver, track)
    let registered: { mid: string; track_id: string }[]
    try {
      const res = await request(this.sig(), this.opts.clock, Op.PublishTracks, {
        action: 'add',
        room_id: to.roomId,
        tracks: [line.entry],
        ...line.extmap,
      })
      registered = (res.tracks ?? []) as { mid: string; track_id: string }[]
    } catch (e) {
      // 연§7-4-6 — 트랜시버 자체는 둔다. 되돌리는 것은 그 단까지다.
      transceiver.direction = 'inactive'
      track.state = 'acquired'
      await to.link.renegotiatePublish()
      throw e
    }

    track.trackId = registered.find((r) => r.mid === transceiver.mid)?.track_id ?? registered[0]?.track_id ?? null
    track.server = to.sfuId
    track.room = to.roomId
    track.link = to.link
    track.ssrc = typeof line.entry.ssrc === 'number' && line.entry.ssrc !== 0 ? line.entry.ssrc : null
    track.state = 'registered'
    if (track.owner === 'app') track.owner = 'sdk'

    // 연§7-4-4 — 반이중은 등록된 채로 둔다. 게이트는 발언권이 연다(SDK§6-5).
    if (track.duplex === 'full') {
      try {
        await transceiver.sender.replaceTrack(track.media)
        track.state = 'sending'
      } catch (e) {
        await this.remove(track)
        throw new PublishError('wire', `송신을 못 붙여 되돌렸다: ${(e as Error).message}`)
      }
    }
    return track
  }

  /** 연§7-4-5 — 첫 프레임이 나야 보낸다. 안 보내면 남들 화면엔 아바타가 그대로다. */
  async announceCamera(track: LocalTrack): Promise<void> {
    if (track.trackId === null || track.room === null) return
    await request(this.sig(), this.opts.clock, Op.Ready, {
      room_id: track.room, type: 'camera', track_id: track.trackId,
    })
  }

  /**
   * 연§7-4-6 · SDK§10-6 — 게이트를 닫고 등록을 풀되 트랜시버는 둔다(없애면 협상이 또 돈다).
   * ★게이트가 안 닫혀도 등록은 푼다 — 서버에 유령 등록을 남기는 쪽이 더 나쁘다.
   */
  async remove(track: LocalTrack): Promise<void> {
    const { trackId, room } = track
    track.state = 'acquired'
    track.trackId = null
    track.server = null
    track.room = null
    track.link = null
    track.ssrc = null
    if (track.transceiver) {
      await track.transceiver.sender.replaceTrack(null).catch(() => {})
      track.transceiver.direction = 'inactive'
    }
    if (trackId === null || room === null) return
    await request(this.sig(), this.opts.clock, Op.PublishTracks, {
      action: 'remove', room_id: room, track_ids: [trackId],
    })
  }

  /** SDK§10-6 — 부른 쪽이 끝낸다. owner 무관이다. */
  async stop(track: LocalTrack): Promise<void> {
    await this.remove(track)
    if (track.owner !== 'external') track.media.stop()
    // 외부 소스가 걸린 동안 살려 둔 자기 장치 트랙도 여기서 놓는다 — 안 놓으면 마이크가 켜진 채 남는다.
    track.ownMedia?.stop()
    track.ownMedia = null
    track.state = 'idle'
    this.tracks.delete(track.id)
  }

  /** 연§6-3 TRACK_SET — muted 와 duplex 는 배타다. 응답 전엔 아무것도 바꾸지 않는다. */
  async set(track: LocalTrack, change: { muted?: boolean; duplex?: Duplex }): Promise<void> {
    if ((change.muted === undefined) === (change.duplex === undefined)) {
      throw new PublishError('wire', 'muted 와 duplex 는 배타다 — 하나만 보낸다')
    }
    if (track.trackId === null || track.room === null) {
      throw new PublishError('wire', '등록되지 않은 트랙은 상태를 바꿀 수 없다')
    }
    await request(this.sig(), this.opts.clock, Op.TrackSet, {
      room_id: track.room, track_id: track.trackId, ...change,
    })
    if (change.muted !== undefined) {
      track.muted = change.muted
      // SDK§6-1 — 손잡이는 enabled 다. 인코더는 계속 돈다.
      ;(track.media as { enabled?: boolean }).enabled = !change.muted
      return
    }
    track.duplex = change.duplex!
    // SDK§6-1 — full→half 는 응답 즉시 게이트를 닫는다. 발언권 없이는 안 나간다.
    if (change.duplex === 'half') {
      await track.transceiver?.sender.replaceTrack(null)
      track.state = 'registered'
    } else {
      await track.transceiver?.sender.replaceTrack(track.media)
      track.state = 'sending'
    }
  }

  /**
   * SDK§6-1 런타임 전환 — `Encoder.source` 를 바꾸는 것이라 ★**SSRC·등록·발언권을 보존**한다
   * (재협상도 재등록도 없다). 처리기 on/off 토글의 자리다.
   *
   * ★**반이중은 게이트가 닫혀 있으면 보관만 한다** — 허가 없이 소리가 나가면 안 된다(§6-5).
   * ★외부 트랙을 넣으면 `owner:'external'`(장치 수명 관리 대상 아님), `null` 이면 살려 둔
   * 자기 장치 트랙으로 돌아오며 `owner:'sdk'` 다.
   */
  async replaceSource(track: LocalTrack, media: MediaTrackLike | null): Promise<void> {
    if (media === null) {
      if (track.owner !== 'external' || !track.ownMedia) return
      const own = track.ownMedia
      track.ownMedia = null
      if (track.media !== own) track.media.stop()
      track.media = own
      track.owner = 'sdk'
    } else {
      if (track.media === media) return
      if (track.owner !== 'external') track.ownMedia = track.media
      else track.media.stop()
      track.media = media
      track.owner = 'external'
    }
    ;(track.media as { enabled?: boolean }).enabled = !track.muted
    const closed = track.duplex === 'half' && track.state !== 'sending'
    if (!track.transceiver || closed) return
    await track.transceiver.sender.replaceTrack(track.media)
  }

  /**
   * SDK§6-4 장치 전환 — ★**대상은 `owner:'sdk'` 트랙만**이다.
   *
   * `app` 은 앱 것이고 `external` 은 등록·전송만 하는 소스라 ★**무시가 아니라 대상이 아니다**
   * (SDK 가 남의 장치 수명을 만지지 않는다). 새 장치를 잡은 **뒤에** 옛 것을 놓는다 —
   * 먼저 놓으면 실패했을 때 소리가 끊긴 채 남는다.
   * ★`replaceSource` 와 달리 소유권은 `sdk` 그대로다(장치를 바꾼 것이지 소스를 넘긴 게 아니다).
   */
  async switchDevice(kind: CaptureKind, deviceId: string | null): Promise<void> {
    const want = kind === 'microphone' ? 'audio' : 'video'
    for (const track of this.all) {
      if (track.owner !== 'sdk' || track.kind !== want) continue
      const media = await this.opts.devices.capture({ kind, ...(deviceId === null ? {} : { deviceId }) })
      const old = track.media
      track.media = media
      ;(media as { enabled?: boolean }).enabled = !track.muted
      const closed = track.duplex === 'half' && track.state !== 'sending'
      if (track.transceiver && !closed) await track.transceiver.sender.replaceTrack(media)
      old.stop()
    }
  }

  /**
   * SDK§6-3 — 인코딩 ★**값만** 바꾼다(`maxBitrate`·`maxFramerate`·레이어 `active`).
   *
   * ★레이어 **구조**(시뮬캐스트 개수·`rid`·`scaleResolutionDownBy` 의 단 배치)는
   * `addTransceiver({sendEncodings})` 때뿐이라 ★**여기서 못 바꾼다** — 바꾸려면 `stop` → 재발행이다
   * (W3C webrtc-pc 사실). 그래서 층 수가 다른 `layers` 가 와도 ★있는 단에만 얹는다.
   * ★발행 전이면 얹을 자리가 없다 — 조용히 넘긴다(값은 발행 때 `sendEncodings` 가 든다).
   */
  async setEncoding(track: LocalTrack, encoding: EncodingChange): Promise<void> {
    const sender = track.transceiver?.sender
    if (!sender?.getParameters || !sender.setParameters) return
    const params = sender.getParameters()
    const encodings = params.encodings ?? []
    if (encodings.length === 0) return
    if (encoding.layers) {
      // ★`layers` 는 낮은 단부터다(l, h) — `getParameters` 순서와 같은 축으로 맞춘다.
      encodings.forEach((enc, i) => {
        const want = encoding.layers?.[i]
        if (!want) return
        if (want.maxBitrate !== undefined) enc.maxBitrate = want.maxBitrate
        if (want.maxFramerate !== undefined) enc.maxFramerate = want.maxFramerate
        if (want.active !== undefined) enc.active = want.active
      })
    }
    if (encoding.maxBitrate !== undefined) for (const enc of encodings) enc.maxBitrate = encoding.maxBitrate
    if (encoding.maxFramerate !== undefined) for (const enc of encodings) enc.maxFramerate = encoding.maxFramerate
    if (encoding.degradationPreference !== undefined) params.degradationPreference = encoding.degradationPreference
    await sender.setParameters({ ...params, encodings })
  }

  /**
   * SDK§5-4 데우기 — ★**자기 장치 트랙을 새것으로 갈아 끼운다**(소유권은 `sdk` 그대로).
   *
   * `replaceSource` 와 다르다: 그쪽은 소스를 앱에 넘기는 것이고 이쪽은 ★같은 소유로 장치만
   * 다시 잡은 것이다. ★게이트가 닫혀 있으면 sender 에 얹지 않는다 — 허가 없이 소리가 나가면 안 된다.
   */
  async replaceSourceOwn(track: LocalTrack, media: MediaTrackLike): Promise<void> {
    track.media = media
    ;(media as { enabled?: boolean }).enabled = !track.muted
    const closed = track.duplex === 'half' && track.state !== 'sending'
    if (!track.transceiver || closed) return
    await track.transceiver.sender.replaceTrack(media)
  }

  /** 장부에서만 뺀다 — ★장치는 안 놓는다(그 트랙이 다른 자리로 옮겨 갔을 때 쓴다). */
  forget(track: LocalTrack): void { this.tracks.delete(track.id) }

  /** SDK§6-5 — 반이중 게이트. 발언권이 열고 닫는다. */
  async gate(track: LocalTrack, open: boolean): Promise<void> {
    if (track.duplex !== 'half' || !track.transceiver) return
    await track.transceiver.sender.replaceTrack(open ? track.media : null)
    track.state = open ? 'sending' : 'registered'
  }

  private enroll(media: MediaTrackLike, kind: CaptureKind, owner: Owner): LocalTrack {
    this.seq += 1
    const track: LocalTrack = {
      id: `lt${this.seq}`,
      kind: kind === 'microphone' ? 'audio' : 'video',
      source: SOURCE_OF[kind],
      state: 'acquired',
      owner,
      ownMedia: null,
      duplex: 'full',
      muted: false,
      media,
      transceiver: null,
      trackId: null,
      server: null,
      room: null,
      ssrc: null,
      link: null,
    }
    this.tracks.set(track.id, track)
    return track
  }

  /**
   * 연§6-3 — 등록에 실을 값은 전부 ★내 offer 에서 읽는다.
   * pt·ssrc·mid 는 폴백이 없고, video 는 codec·fmtp 도 없으면 서버가 전체를 거절한다.
   */
  private lineOf(to: PublishTarget, transceiver: TransceiverLike, track: LocalTrack): {
    entry: Record<string, unknown>
    extmap: Record<string, number>
  } {
    const sdp = to.link.localOffer()
    const mid = transceiver.mid
    if (sdp === null || mid === null) throw new PublishError('no_mid', '내 offer 에 이 트랙의 m-line 이 없다')
    const m = parse(sdp).sections.find((x) => x.mid === mid)
    if (!m) throw new PublishError('no_mid', `mid=${mid} m-line 을 못 찾았다`)

    const pt = m.pts.find((p) => m.rtpmap.has(p) && !m.rtx.has(p))
    if (pt === undefined) throw new PublishError('no_pt', `mid=${mid} 에 쓸 PT 가 없다 — 폴백은 무음을 조용히 만든다`)
    const rtpmap = m.rtpmap.get(pt)!
    const codec = rtpmap.split('/')[0]!
    const simulcast = m.simulcastSend
    // 연§6-3 — 시뮬캐스트면 SDP 에 a=ssrc 가 없고 0 이 정상이다.
    const ssrc = simulcast ? 0 : m.ssrcs[0]
    if (ssrc === undefined) throw new PublishError('no_ssrc', `mid=${mid} 에 ssrc 가 없다`)

    const entry: Record<string, unknown> = {
      kind: track.kind, ssrc, mid, pt, duplex: track.duplex, source: track.source,
    }
    if (track.kind === 'video') {
      entry.codec = codec
      const fmtp = m.fmtp.get(pt)
      // 연§6-3 — offer 에 있으면 반드시 싣는다. 구독자 fmtp 의 출처가 이것 하나다.
      if (fmtp !== undefined) entry.fmtp = fmtp
      // ★연§6-3 은 안 보내면 서버가 추론한다고 하나(full=true), 내 offer 가 진실을 안다.
      // 추론에 맡기면 단일 레이어를 시뮬캐스트로 등록해 물리가 첫 RTP 를 영원히 기다린다.
      entry.simulcast = simulcast
      let rtxPt: number | undefined
      for (const [candidate, apt] of m.rtx) if (apt === pt) rtxPt = candidate
      if (rtxPt !== undefined) entry.rtx_pt = rtxPt
      if (!simulcast && m.fid) entry.rtx_ssrc = m.fid[1]
    }

    // 연§6-3 — 협상 결과 번호를 신고한다. 안 보내면 서버가 자기 선언값으로 폴백한다.
    const byUri = new Map([...m.extmap].map(([id, uri]) => [uri, id]))
    const extmap: Record<string, number> = {}
    const pick = (field: string, uri: string): void => {
      const id = byUri.get(uri)
      if (id !== undefined) extmap[field] = id
    }
    pick('mid_extmap_id', 'urn:ietf:params:rtp-hdrext:sdes:mid')
    pick('audio_level_extmap_id', 'urn:ietf:params:rtp-hdrext:ssrc-audio-level')
    pick('twcc_extmap_id', 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01')
    pick('rid_extmap_id', 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id')
    pick('repair_rid_extmap_id', 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id')
    return { entry, extmap }
  }
}
