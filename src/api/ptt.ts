// author: kodeholic (powered by Claude)
// SDK§5 — 발언 표면. 상태기(domain/floor)가 판정하고 여기서 DC 송신과 마이크 게이트를 집행한다.
import { FloorRoom, Outcome } from '../domain/floor.js'
import { LocalTrack, MediaRegistry } from '../domain/media-registry.js'
import { MediaTrackLike } from '../platform/webrtc.js'
import { Tlv, encode, frame, text } from '../internal/mbcp.js'
import { Message } from '../internal/mbcp.js'
import { PeerLink } from '../internal/transport/link.js'
import { Clock } from '../platform/clock.js'
import { Bus } from './emitter.js'
import { NotImplementedError } from './not-implemented.js'

/** 정책서 §4 `micColdAfterMs` — 무발화 뒤 `cold` 진입. 실측 20260624 기준값이다. */
const COLD_AFTER_MS = 30_000
import {
  CameraOptions, LocalTrack as ApiLocalTrack, MicPower, MicrophoneOptions, Ptt, PttEvents,
  PttState, TransmitSource,
} from './types.js'

export interface PttHost {
  /** 이 방으로 발행이 걸릴 자리. 발언 방이 아니면 SDK 가 먼저 옮긴다(연§7-7-1). */
  target(roomId: string): { link: PeerLink; roomId: string; sfuId: string } | null
  selectSpeaking(roomId: string): Promise<void>
  /**
   * 연§6-3 — ★**"그 방의 무전 코덱" 은 슬롯 트랙이 알려준다.** 보관본에서 `room_id` 가 그 방이고
   * `duplex:'half'`·`kind:'video'` 인 항목의 `codec`+`fmtp` 다. ★없으면 첫 화자가 정한다.
   */
  slotVideoCodec(roomId: string): { codec: string; fmtp?: string } | null
  /** 안쪽 트랙을 앱이 쥘 표면으로 — 같은 트랙이 두 핸들로 갈리지 않게 한 곳에서만 감싼다. */
  wrap(inner: LocalTrack): ApiLocalTrack
}

export class PttHandle extends Bus<PttEvents> implements Ptt {
  input: 'hold' | 'toggle' = 'hold'
  private mic: LocalTrack | null = null
  private cam: LocalTrack | null = null
  /** SDK§5-4 — `hot`(허가 중) → `hot_standby`(트랙 유지) → `cold`(장치 반납).
   *  SDK§7-3 — `trusted`·`draining` 은 이 표면이 내는 「지금 왜 이런가」 상태다. */
  private power: MicPower = 'hot_standby'
  /** 정책서 `micColdAfterMs` 기본 30초. `keepWarm(ms)` 가 이 값을 민다(0 = 기본). */
  private coldAfterMs = COLD_AFTER_MS
  /** 진행 중인 식힘을 끊는 손잡이 — 다시 뜨거워지면 그 자리에서 접는다. */
  private cooling: AbortController | null = null
  private lastSource: TransmitSource | undefined

  constructor(
    readonly floor: FloorRoom,
    private readonly registry: MediaRegistry,
    private readonly host: PttHost,
    private readonly clock: Clock,
  ) {
    super()
  }

  get priority(): number { return this.floor.priority }
  set priority(v: number) { this.floor.priority = v }

  get state(): PttState {
    const f = this.floor
    return {
      phase: f.phase,
      acceptPending: f.acceptPending,
      canRequest: f.canRequest,
      draining: f.draining,
      trusted: f.trusted,
      mic: this.power,
      ...(f.remainingSec === undefined ? {} : { remainingSec: f.remainingSec }),
      ...(f.grantedPriority === undefined ? {} : { priority: f.grantedPriority }),
      ...(f.queue === undefined ? {} : { queue: f.queue }),
      ...(f.talkingSince === undefined ? {} : { talkingSince: f.talkingSince }),
      ...(f.lastDeny === undefined ? {} : { lastDeny: f.lastDeny }),
      ...(f.lastRevoke === undefined ? {} : { lastRevoke: f.lastRevoke }),
      ...(f.lastEnd === undefined ? {} : { lastEnd: f.lastEnd }),
      ...(this.lastSource === undefined ? {} : { source: this.lastSource }),
    }
  }

  /** SDK§5 — 이 서버에 반이중 마이크를 세운다. 부르지 않아도 press 가 한다. */
  async enable(opts?: MicrophoneOptions & { track?: MediaStreamTrack }): Promise<void> {
    if (this.mic !== null) return
    const to = this.host.target(this.floor.roomId)
    if (to === null) throw new NotImplementedError(`room(${this.floor.roomId}) 전송로가 없다`)

    // ★앱 트랙을 주면 `owner:'external'` — 등록·전송만 하고 장치 수명은 앱 것이다(SDK§6-1).
    const track = opts?.track === undefined
      ? (await this.registry.acquire([{ kind: 'microphone' }]))[0]
      : this.registry.adopt(opts.track as unknown as MediaTrackLike, 'microphone')
    track!.duplex = 'half'
    try {
      await this.registry.publish(track!, to)
    } catch (e) {
      await this.registry.stop(track!)
      throw e
    }
    this.mic = track!
    this.setPower('hot_standby')
    this.run(this.floor.armed())
  }

  /** 연§7-7-1 — (등록 없으면 등록) → (발언 방이 아니면 전환) → REQUEST. */
  async press(opts?: { source?: TransmitSource }): Promise<void> {
    this.lastSource = opts?.source ?? 'user'
    if (this.mic === null) await this.enable()
    // ★식었으면 먼저 데운다 — 재획득 360~640ms 가 첫 음절을 먹는다(§5-4).
    await this.warm()
    await this.host.selectSpeaking(this.floor.roomId)
    this.run(this.floor.press(this.clock.now()))
  }

  release(): Promise<void> {
    this.run(this.floor.release(this.clock.now()))
    return Promise.resolve()
  }

  /** DC 가 프레임을 물어 왔다. 방 가르기는 상태기가 0x1D 로 한다. */
  deliver(msg: Message): void {
    this.run(this.floor.receive(msg, this.clock.now()))
  }

  tick(): void { this.run(this.floor.tick(this.clock.now())) }

  setTrusted(on: boolean): void { this.run(this.floor.setTrusted(on)) }

  reset(cause: Parameters<FloorRoom['reset']>[0]): void { this.run(this.floor.reset(cause)) }

  /**
   * SDK§5-4 — `cold` 진입을 미룬다. `0` 은 기본값(정책서 `micColdAfterMs`)이다.
   *
   * ★`cold` 에서 `press()` 하면 재획득에 360~640ms 라 **첫 음절이 잘린다**(실측 20260624).
   * 곧 말할 것을 아는 앱(무전기 버튼을 쥔 손)이 그 값을 늘려 그 손실을 없앤다.
   */
  keepWarm(ms: number): void {
    this.coldAfterMs = ms > 0 ? ms : COLD_AFTER_MS
    if (this.power === 'hot_standby') this.armCooling()
  }

  /**
   * SDK§5-4 — 무발화가 이어지면 장치를 반납한다. ★`owner:'sdk'` 트랙만 내려간다.
   *
   * 앱·외부 소유 동안 반납하면 ★**앱 처리기 파이프라인이 30초 뒤 끊긴다**(review01 §2-1).
   * 무시가 아니라 대상이 아니다.
   */
  private armCooling(): void {
    this.cooling?.abort()
    if (this.mic === null || this.mic.owner !== 'sdk') return
    const stop = new AbortController()
    this.cooling = stop
    void (async () => {
      await this.clock.sleep(this.coldAfterMs, stop.signal)
      if (stop.signal.aborted || this.mic === null || this.mic.owner !== 'sdk') return
      // ★게이트는 이미 닫혀 있다(허가가 없다) — 장치만 놓는다. 등록·SSRC 는 그대로다.
      this.mic.media.stop()
      this.power = 'cold'
    })()
  }

  /** 허가가 서면 뜨겁다 — 식힘을 접는다. 놓으면 다시 식기 시작한다. */
  private setPower(next: MicPower): void {
    if (next === 'hot') { this.cooling?.abort(); this.cooling = null }
    this.power = next
    if (next === 'hot_standby') this.armCooling()
  }

  /** ★`cold` 면 새로 잡아 `Encoder.source` 로 보관한다 — sender 에 얹는 것은 허가 때다(§6-5). */
  private async warm(): Promise<void> {
    if (this.power !== 'cold' || this.mic === null) return
    const media = await this.registry.acquire([{ kind: 'microphone' }])
    await this.registry.replaceSourceOwn(this.mic, media[0]!.media)
    this.registry.forget(media[0]!)
    this.setPower('hot_standby')
  }
  /**
   * 연§6-3 — 반이중 영상. ★**그 방 슬롯 코덱에 맞춰 등록한다.**
   *
   * ★슬롯이 있으면 **보내기 전에 읽고 맞춘다** — 찍어 보고 `1006` 으로 배우지 않는다.
   * 슬롯이 없으면 ★**내가 정하는 것**이고, 뒤에 오는 화자들이 나를 따른다.
   * 송출은 허가 동안만이다 — 등록 즉시 게이트가 닫히고(`duplex:'half'`), 발언권이 연다(§6-5).
   */
  async enableVideo(opts?: CameraOptions & { track?: MediaStreamTrack }): Promise<ApiLocalTrack> {
    if (this.cam !== null) return this.host.wrap(this.cam)
    const to = this.host.target(this.floor.roomId)
    if (to === null) throw new NotImplementedError(`room(${this.floor.roomId}) 전송로가 없다`)

    const slot = this.host.slotVideoCodec(this.floor.roomId)
    const track = opts?.track === undefined
      ? (await this.registry.acquire([{ kind: 'camera' }]))[0]!
      : this.registry.adopt(opts.track as unknown as MediaTrackLike, 'camera')
    track.duplex = 'half'
    try {
      await this.registry.publish(track, to, slot ?? undefined)
    } catch (e) {
      // ★앱이 준 트랙은 SDK 가 정지하지 않는다 — 등록만 되돌린다.
      await this.registry.stop(track)
      throw e
    }
    this.cam = track
    // 허가 중이면 곧바로 열어 준다 — 마이크가 이미 열려 있는데 영상만 막히면 반쪽이다.
    if (this.power === 'hot') await this.registry.gate(track, true)
    return this.host.wrap(track)
  }

  /** 판정 결과를 집행한다 — 보낼 것, 게이트, 앱 이벤트 차례다. */
  private run(out: Outcome): void {
    const to = this.host.target(this.floor.roomId)
    const dc = to?.link.channel
    for (const msg of out.send) {
      if (dc === null || dc === undefined || dc.readyState !== 'open') break
      dc.send(frame(encode(msg)))
    }
    if (out.gate !== undefined && this.mic !== null) void this.registry.gate(this.mic, out.gate)
    // SDK§5-4 — 게이트가 곧 전원 축이다. 열려 있으면 뜨겁고, 닫히면 그때부터 식기 시작한다.
    if (out.gate !== undefined) this.setPower(out.gate ? 'hot' : 'hot_standby')
    for (const s of out.signals) {
      if (s.kind === 'speaker') {
        this.emit('speaker', { userId: s.userId, trackIds: [] })
        continue
      }
      if (s.kind === 'phase') { this.emit('state', this.state); continue }
      this.emit(s.kind, this.state)
      this.emit('state', this.state)
    }
  }
}

/** 프레임에 실린 방 — 어느 방 것인지가 이 값 하나로 갈린다(연§11-3 0x1D). */
export function roomOf(msg: Message): string | undefined {
  return text(msg, Tlv.Room)
}
