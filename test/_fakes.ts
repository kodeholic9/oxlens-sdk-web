// author: kodeholic (powered by Claude)
// 1층 대역 — 실시간과 소켓을 지운다. 시험이 재는 것은 SDK 의 판단이지 브라우저가 아니다.
import type { Clock } from '../src/platform/clock.js'
import type { CloseInfo, Socket } from '../src/platform/socket.js'

interface Timer { at: number; resolve(): void }

export class FakeClock implements Clock {
  private t = 0
  private timers: Timer[] = []

  now(): number { return this.t }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const timer: Timer = { at: this.t + ms, resolve }
      this.timers.push(timer)
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((x) => x !== timer)
        resolve()
      }, { once: true })
    })
  }

  /** 시각을 옮기고 그때까지의 잠을 깨운다. 깨어난 쪽이 다 돌 때까지 기다린다. */
  async advance(ms: number): Promise<void> {
    this.t += ms
    const due = this.timers.filter((x) => x.at <= this.t)
    this.timers = this.timers.filter((x) => x.at > this.t)
    for (const d of due) d.resolve()
    await tick()
  }

  get pending(): number { return this.timers.length }
}

export class FakeSocket implements Socket {
  readonly sent: Uint8Array[] = []
  private pending: Uint8Array[] = []
  private wake: (() => void) | null = null
  private done = false
  private settle: (info: CloseInfo) => void = () => {}
  readonly closed: Promise<CloseInfo>
  closedWith: CloseInfo | null = null

  constructor() {
    this.closed = new Promise<CloseInfo>((r) => { this.settle = r })
  }

  send(data: Uint8Array): void {
    if (this.done) throw new Error('닫힌 소켓에 보냈다')
    this.sent.push(data)
  }

  close(code: number, reason: string): void {
    if (this.done) return
    this.closedWith = { code, reason }
    this.done = true
    this.settle(this.closedWith)
    this.wake?.()
  }

  /** 서버가 프레임을 보냈다. */
  deliver(...frames: Uint8Array[]): void {
    this.pending.push(...frames)
    this.wake?.()
  }

  async *frames(): AsyncIterableIterator<Uint8Array> {
    for (;;) {
      while (this.pending.length > 0) yield this.pending.shift()!
      if (this.done) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = null
    }
  }
}

/** 대기 중인 마이크로태스크를 다 흘린다. */
export async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
  await new Promise<void>((r) => { setTimeout(r, 0) })
}

// ── WebRTC 대역 ──────────────────────────────────────────────────────────────
import type {
  DataChannelLike, Description, IceState, MediaTrackLike, PeerConnectionLike, PeerFactory,
  RemoteTrackArrival, SignalingState, TransceiverDirection, TransceiverLike,
} from '../src/platform/webrtc.js'
import { parse as parseSdp } from '../src/internal/sdp/parse.js'

export interface FakeChannel extends DataChannelLike {
  readonly init: { ordered: boolean; maxRetransmits: number }
  readonly sent: Uint8Array[]
  deliver(data: Uint8Array): void
  markOpen(): void
}

export class FakePeer implements PeerConnectionLike {
  readonly calls: string[] = []
  readonly transceivers: TransceiverLike[] = []
  channel: FakeChannel | null = null
  signalingState: SignalingState = 'stable'
  iceConnectionState: IceState = 'new'
  localDescription: Description | null = null
  remoteDescription: Description | null = null
  closed = false

  private readonly ice = pump<IceState>()
  private readonly tracks = pump<RemoteTrackArrival>()

  constructor(private readonly offerSdp: string, private readonly answerSdp = 'v=0\r\n') {}

  createOffer(): Promise<Description> {
    this.calls.push('createOffer')
    return Promise.resolve({ type: 'offer', sdp: this.offerSdp })
  }

  createAnswer(): Promise<Description> {
    this.calls.push('createAnswer')
    return Promise.resolve({ type: 'answer', sdp: this.answerSdp })
  }

  setLocalDescription(desc?: Description): Promise<void> {
    this.calls.push(`setLocal:${desc?.type ?? 'implicit'}`)
    if (desc?.type === 'rollback') { this.signalingState = 'stable'; return Promise.resolve() }
    if (desc) this.localDescription = desc
    this.signalingState = desc?.type === 'offer' ? 'have-local-offer' : 'stable'
    return Promise.resolve()
  }

  setRemoteDescription(desc: Description): Promise<void> {
    this.calls.push(`setRemote:${desc.type}`)
    this.remoteDescription = desc
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable'
    // 브라우저는 받은 offer 를 보고 수신 트랜시버를 스스로 만든다(연§9-0).
    if (desc.type === 'offer' && desc.sdp) {
      for (const m of parseSdp(desc.sdp).sections) {
        if (m.kind === 'application') continue
        if (this.transceivers.some((t) => t.mid === m.mid)) continue
        this.transceivers.push({
          mid: m.mid,
          direction: 'recvonly',
          sender: { replaceTrack: () => Promise.resolve() },
          receiver: { track: { id: `rx-${m.mid}`, kind: m.kind, stop() {} } },
        })
      }
    }
    return Promise.resolve()
  }

  addTransceiver(kind: 'audio' | 'video', init?: { direction: TransceiverDirection }): TransceiverLike {
    this.calls.push(`addTransceiver:${kind}:${init?.direction ?? 'sendrecv'}`)
    const t: TransceiverLike = {
      mid: String(this.transceivers.length),
      direction: init?.direction ?? 'sendrecv',
      sender: { replaceTrack: () => Promise.resolve() },
      receiver: { track: { id: `r${this.transceivers.length}`, kind, stop() {} } },
    }
    this.transceivers.push(t)
    return t
  }

  getTransceivers(): readonly TransceiverLike[] { return this.transceivers }

  createDataChannel(label: string, init: { ordered: boolean; maxRetransmits: number }): DataChannelLike {
    this.calls.push(`createDataChannel:${label}`)
    const msgs = pump<Uint8Array>()
    let markOpen: () => void = () => {}
    let markClosed: () => void = () => {}
    const ch: FakeChannel = {
      label, init, sent: [],
      readyState: 'connecting',
      send: (d) => { ch.sent.push(d) },
      close: () => { msgs.end(); markClosed() },
      messages: () => msgs.iter(),
      opened: new Promise<void>((r) => { markOpen = r }),
      closed: new Promise<void>((r) => { markClosed = r }),
      deliver: (d) => { msgs.push(d) },
      markOpen: () => { (ch as { readyState: string }).readyState = 'open'; markOpen() },
    }
    this.channel = ch
    return ch
  }

  getStats(): Promise<ReadonlyMap<string, Record<string, unknown>>> {
    return Promise.resolve(new Map())
  }

  close(): void { this.calls.push('close'); this.closed = true; this.ice.end(); this.tracks.end() }
  iceStates(): AsyncIterableIterator<IceState> { return this.ice.iter() }
  remoteTracks(): AsyncIterableIterator<RemoteTrackArrival> { return this.tracks.iter() }

  /** 브라우저가 상태를 바꿨다. */
  setIce(state: IceState): void { this.iceConnectionState = state; this.ice.push(state) }
}

export class FakePeers implements PeerFactory {
  readonly made: FakePeer[] = []
  constructor(private readonly offerSdp: string, private readonly answerSdp = 'v=0\r\n') {}
  create(): PeerConnectionLike {
    const p = new FakePeer(this.offerSdp, this.answerSdp)
    this.made.push(p)
    return p
  }
}

function pump<T>(): { push(v: T): void; end(): void; iter(): AsyncIterableIterator<T> } {
  const queue: T[] = []
  let wake: (() => void) | null = null
  let done = false
  return {
    push(v) { queue.push(v); wake?.() },
    end() { done = true; wake?.() },
    async *iter() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (done) return
        await new Promise<void>((r) => { wake = r })
        wake = null
      }
    },
  }
}

// ── 장치 대역 ────────────────────────────────────────────────────────────────
import type { CaptureRequest, Devices, PlatformDeviceInfo, PlatformPermission } from '../src/platform/media.js'
import { DeviceError } from '../src/platform/media.js'

export class FakeDevices implements Devices {
  readonly taken: string[] = []
  readonly stopped: string[] = []
  fail: string | null = null
  list: PlatformDeviceInfo[] = []
  perm: Record<string, PlatformPermission> = {}
  private n = 0
  private watchers = new Set<() => void>()

  enumerate(): Promise<ReadonlyArray<PlatformDeviceInfo>> { return Promise.resolve(this.list) }

  onChange(fn: () => void): () => void {
    this.watchers.add(fn)
    return () => this.watchers.delete(fn)
  }

  permission(name: 'microphone' | 'camera'): Promise<PlatformPermission> {
    return Promise.resolve(this.perm[name] ?? 'unknown')
  }

  plug(list: PlatformDeviceInfo[]): void {
    this.list = list
    for (const fn of this.watchers) fn()
  }

  capture(req: CaptureRequest): Promise<MediaTrackLike> {
    if (this.fail === req.kind) {
      return Promise.reject(new DeviceError(req.kind, 'user', `${req.kind} 를 막았다`))
    }
    this.n += 1
    const id = `${req.kind}-${this.n}`
    this.taken.push(id)
    const self = this
    return Promise.resolve({
      id,
      kind: req.kind === 'microphone' ? 'audio' : 'video',
      stop() { self.stopped.push(id) },
    })
  }
}

// ── HTTP 대역 ────────────────────────────────────────────────────────────────
import type { Http, HttpResponse } from '../src/platform/http.js'

export class FakeHttp implements Http {
  readonly calls: { url: string; headers: Record<string, string> }[] = []
  /** 경로 접미사 → 응답. 없으면 404 다(조용히 빈 것을 주지 않는다). */
  readonly routes = new Map<string, unknown>()
  status = 200

  get(url: string, headers: Readonly<Record<string, string>>): Promise<HttpResponse> {
    this.calls.push({ url, headers: { ...headers } })
    for (const [suffix, body] of this.routes) {
      if (url.endsWith(suffix)) return Promise.resolve({ status: this.status, body })
    }
    return Promise.resolve({ status: 404, body: null })
  }
}
