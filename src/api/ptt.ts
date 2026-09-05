// author: kodeholic (powered by Claude)
// SDK§5 — 발언 표면. 상태기(domain/floor)가 판정하고 여기서 DC 송신과 마이크 게이트를 집행한다.
import { FloorRoom, Outcome } from '../domain/floor.js'
import { LocalTrack, MediaRegistry } from '../domain/media-registry.js'
import { Tlv, encode, frame, text } from '../internal/mbcp.js'
import { Message } from '../internal/mbcp.js'
import { PeerLink } from '../internal/transport/link.js'
import { Clock } from '../platform/clock.js'
import { Bus } from './emitter.js'
import { NotImplementedError } from './not-implemented.js'
import { CameraOptions, MicrophoneOptions, Ptt, PttEvents, PttState, TransmitSource } from './types.js'

export interface PttHost {
  /** 이 방으로 발행이 걸릴 자리. 발언 방이 아니면 SDK 가 먼저 옮긴다(연§7-7-1). */
  target(roomId: string): { link: PeerLink; roomId: string; sfuId: string } | null
  selectSpeaking(roomId: string): Promise<void>
}

export class PttHandle extends Bus<PttEvents> implements Ptt {
  input: 'hold' | 'toggle' = 'hold'
  private mic: LocalTrack | null = null
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
      mic: 'hot',
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
    if (opts?.track !== undefined) throw new NotImplementedError('ptt.enable({track})')
    const to = this.host.target(this.floor.roomId)
    if (to === null) throw new NotImplementedError(`room(${this.floor.roomId}) 전송로가 없다`)

    const [track] = await this.registry.acquire([{ kind: 'microphone' }])
    track!.duplex = 'half'
    try {
      await this.registry.publish(track!, to)
    } catch (e) {
      await this.registry.stop(track!)
      throw e
    }
    this.mic = track!
    this.run(this.floor.armed())
  }

  /** 연§7-7-1 — (등록 없으면 등록) → (발언 방이 아니면 전환) → REQUEST. */
  async press(opts?: { source?: TransmitSource }): Promise<void> {
    this.lastSource = opts?.source ?? 'user'
    if (this.mic === null) await this.enable()
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

  keepWarm(_ms: number): void { throw new NotImplementedError('keepWarm') }
  enableVideo(_opts?: CameraOptions & { track?: MediaStreamTrack }): Promise<never> {
    return Promise.reject(new NotImplementedError('ptt.enableVideo'))
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
