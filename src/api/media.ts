// author: kodeholic (powered by Claude)
// SDK§6-1 — 발행 표면. 길은 둘이다: 고수준 enable*(획득+발행) · 저수준 acquire → publish.
import { LocalTrack as InnerTrack, MediaRegistry } from '../domain/media-registry.js'
import { Devices as DevicePort, CaptureKind } from '../platform/media.js'
import { MediaTrackLike } from '../platform/webrtc.js'
import { Playback } from '../domain/playback.js'
import { DevicesHandle } from './devices.js'
import { toOxLensError } from './errors.js'
import { NotImplementedError } from './not-implemented.js'
import {
  AcquireOptions, AudioPlayback, CameraOptions, DeviceKind, Devices, LocalTrack, Media, MicrophoneOptions,
  OxLensError, PermissionState, ScreenOptions, TrackKind, TrackSource,
} from './types.js'

/** 발언 방이 없으면 wire 를 안 탄다 — code 0 이다(SDK§6-1). */
export function noSpeakingRoom(): OxLensError {
  return new OxLensError({
    category: 'state', code: 0, name: 'STATE_NO_SPEAKING_ROOM', permanent: false,
    message: '발언 방이 없다 — setSpeakingRoom 뒤에 부른다',
  })
}

export interface MediaHost {
  /** 지금 발행이 걸릴 자리. 없으면 null 이다. */
  publishTarget(): { link: import('../internal/transport/link.js').PeerLink; roomId: string; sfuId: string } | null
}

export class LocalTrackHandle implements LocalTrack {
  constructor(readonly inner: InnerTrack, private readonly reg: MediaRegistry) {}

  get id(): string { return this.inner.id }
  get kind(): TrackKind { return this.inner.kind }
  get source(): TrackSource { return this.inner.source as TrackSource }
  get state(): InnerTrack['state'] { return this.inner.state }
  get owner(): InnerTrack['owner'] { return this.inner.owner }
  get duplex(): InnerTrack['duplex'] { return this.inner.duplex }
  get muted(): boolean { return this.inner.muted }
  get server(): string { return this.inner.server as string }
  get mediaStreamTrack(): MediaStreamTrack { return this.inner.media as unknown as MediaStreamTrack }

  stop(): Promise<void> { return this.reg.stop(this.inner) }
  setMuted(muted: boolean): Promise<void> { return this.reg.set(this.inner, { muted }) }
  setDuplex(duplex: 'full' | 'half'): Promise<void> { return this.reg.set(this.inner, { duplex }) }
  /** SDK§6-1 — SSRC·등록·발언권을 보존한다. 반이중은 게이트가 닫혀 있으면 보관만 한다. */
  replaceSource(t: MediaStreamTrack | null): Promise<void> {
    return this.reg.replaceSource(this.inner, t as unknown as MediaTrackLike | null)
      .catch((e: unknown) => { throw toOxLensError(e) })
  }
  setEncoding(): Promise<void> { return Promise.reject(new NotImplementedError('setEncoding')) }
  /** SDK§11-2 — 양단 비교의 한쪽. 시뮬캐스트면 ssrc 가 0 이라 계수가 비어 온다. */
  async getStats(): Promise<RTCStatsReport> {
    const ssrc = this.inner.ssrc
    if (ssrc === null || this.inner.link === null) return new Map() as unknown as RTCStatsReport
    const rows = await this.inner.link.statsFor(ssrc, 'outbound')
    return rows as unknown as RTCStatsReport
  }
  on(): this { return this }
  off(): this { return this }
  once(): this { return this }
}

export class MediaSurface implements Media {
  private readonly handles = new Map<InnerTrack, LocalTrackHandle>()

  private readonly deviceList: DevicesHandle

  constructor(
    private readonly reg: MediaRegistry,
    private readonly host: MediaHost,
    port: DevicePort,
    private readonly playback: Playback,
  ) {
    this.deviceList = new DevicesHandle(port)
    this.deviceList.watch()
    this.port = port
  }

  private readonly port: DevicePort

  get tracks(): readonly LocalTrack[] { return this.reg.all.map((t) => this.wrap(t)) }

  async acquire(opts: AcquireOptions): Promise<readonly LocalTrack[]> {
    const reqs = kindsOf(opts)
    try {
      const got = await this.reg.acquire(reqs)
      return got.map((t) => this.wrap(t))
    } catch (e) {
      throw toOxLensError(e)
    }
  }

  async publish(track: LocalTrack | MediaStreamTrack, _opts?: unknown): Promise<LocalTrack> {
    if (!(track instanceof LocalTrackHandle)) {
      throw new NotImplementedError('publish(MediaStreamTrack) — 예외 경로')
    }
    const to = this.host.publishTarget()
    if (to === null) throw noSpeakingRoom()
    try {
      return this.wrap(await this.reg.publish(track.inner, to))
    } catch (e) {
      throw toOxLensError(e)
    }
  }

  enableMicrophone(opts?: MicrophoneOptions): Promise<LocalTrack> { return this.enable('microphone', opts) }
  enableCamera(opts?: CameraOptions): Promise<LocalTrack> { return this.enable('camera', opts) }
  enableScreen(_opts?: ScreenOptions): Promise<LocalTrack> { return this.enable('screen') }

  /** 획득 + 발행 한 덩어리. ★실패하면 자기가 만든 트랙을 SDK 가 정지한다. */
  private async enable(kind: CaptureKind, opts?: { readonly deviceId?: string }): Promise<LocalTrack> {
    const to = this.host.publishTarget()
    if (to === null) throw noSpeakingRoom()
    const [got] = await this.reg.acquire([{ kind, ...(opts?.deviceId === undefined ? {} : { deviceId: opts.deviceId }) }])
      .catch((e: unknown) => { throw toOxLensError(e) })
    try {
      await this.reg.publish(got!, to)
    } catch (e) {
      await this.reg.stop(got!)
      throw toOxLensError(e)
    }
    return this.wrap(got!)
  }

  get devices(): Devices { return this.deviceList }

  /** SDK§12-1 — 브라우저 autoplay 정책의 표면. `false` 면 앱이 제스처 핸들러에서 `startAudio()`. */
  get audio(): AudioPlayback {
    const play = this.playback
    return {
      get playbackAllowed() { return play.playbackAllowed },
      startAudio: () => play.startAudio(),
    }
  }

  /**
   * SDK§6-4 — `deviceId` 는 명시 선택(고정), `null` 은 자동(OS 기본 추종)으로 돌아간다.
   * ★고른 값을 `devices.preferred` 에 남긴다 — 다음 획득이 그것을 쓴다.
   * `audiooutput` 은 잡는 장치가 아니라 ★내는 자리라 재생 쪽으로 간다.
   */
  async switchDevice(kind: DeviceKind, deviceId: string | null): Promise<void> {
    this.deviceList.prefer(kind, deviceId)
    if (kind === 'audiooutput') return this.playback.setSink(deviceId)
    try {
      await this.reg.switchDevice(kind === 'audioinput' ? 'microphone' : 'camera', deviceId)
    } catch (e) {
      throw toOxLensError(e)
    }
  }

  /** SDK§12-1 — `setSinkId` 가 있는 플랫폼만. 없으면 조용히 넘긴다(앱 실패로 만들지 않는다). */
  audioOutput(deviceId: string | null): Promise<void> { return this.playback.setSink(deviceId) }

  /**
   * SDK§2-3 — 브라우저가 모르면 `unknown` 이다. ★모른다고 `prompt` 로 지어내지 않는다:
   * 앱이 그 값을 보고 프롬프트를 띄울지 정하는데, 지어낸 값은 헛 프롬프트를 만든다.
   */
  async permissions(): Promise<{ readonly microphone: PermissionState; readonly camera: PermissionState }> {
    const [microphone, camera] = await Promise.all([
      this.port.permission('microphone'),
      this.port.permission('camera'),
    ])
    return { microphone, camera }
  }

  /** 방을 닫을 때 장치 감시를 놓는다 — 주인이 쥐고 주인이 놓는다. */
  close(): void { this.deviceList.close() }

  private wrap(inner: InnerTrack): LocalTrackHandle {
    let h = this.handles.get(inner)
    if (!h) { h = new LocalTrackHandle(inner, this.reg); this.handles.set(inner, h) }
    return h
  }
}

function kindsOf(opts: AcquireOptions): { kind: CaptureKind; deviceId?: string }[] {
  const out: { kind: CaptureKind; deviceId?: string }[] = []
  for (const kind of ['microphone', 'camera', 'screen'] as const) {
    const req = (opts as Record<string, { deviceId?: string } | undefined>)[kind]
    if (req === undefined) continue
    out.push({ kind, ...(req.deviceId === undefined ? {} : { deviceId: req.deviceId }) })
  }
  return out
}
