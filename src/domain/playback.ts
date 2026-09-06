import { AudioElementLike, AudioOut } from '../platform/audio.js'
import { MediaTrackLike } from '../platform/webrtc.js'

interface Playing {
  readonly roomId: string
  readonly el: AudioElementLike
  trackVolume: number
}

interface RoomMix {
  muted: boolean
  volume: number
}

export class Playback {
  private readonly playing = new Map<string, Playing>()
  private readonly mix = new Map<string, RoomMix>()
  private sinkId: string | null = null
  private allowed = true
  private offVisible: (() => void) | null = null

  private waiters: Array<(v: IteratorResult<boolean>) => void> = []
  private pending: boolean[] = []

  constructor(private readonly out: AudioOut) {}

  get playbackAllowed(): boolean { return this.allowed }

  /**
   * autoplay 허용이 바뀔 때마다 하나씩. ★**주인이 훑는다** — 콜백을 주입받지 않는다.
   *
   * 훅 릴레이로 만들면 흐름이 런타임에만 드러나 추적이 안 된다(`arch_check` 가 그것을 막는다).
   * 탭이 다시 보여 스스로 푸는 경우처럼 ★부르는 쪽 호출 없이 바뀌는 자리가 있어 반환값으로는 부족하다.
   */
  async *changes(): AsyncIterableIterator<boolean> {
    for (;;) {
      const next = this.pending.shift()
      if (next !== undefined) { yield next; continue }
      const got = await new Promise<IteratorResult<boolean>>((resolve) => this.waiters.push(resolve))
      if (got.done) return
      yield got.value
    }
  }

  async add(trackId: string, roomId: string, track: MediaTrackLike): Promise<void> {
    if (this.playing.has(trackId)) return
    const el = this.out.create(track)
    const entry: Playing = { roomId, el, trackVolume: 1 }
    this.playing.set(trackId, entry)
    this.apply(entry)
    if (this.sinkId !== null) await this.applySink(el, this.sinkId)
    await this.tryPlay([entry])
  }

  remove(trackId: string): void {
    const entry = this.playing.get(trackId)
    if (!entry) return
    entry.el.release()
    this.playing.delete(trackId)
  }

  setRoom(roomId: string, patch: Partial<RoomMix>): void {
    const cur = this.mix.get(roomId) ?? { muted: false, volume: 1 }
    const next = { ...cur, ...patch }
    this.mix.set(roomId, next)
    for (const entry of this.playing.values()) {
      if (entry.roomId === roomId) this.apply(entry)
    }
  }

  setTrackVolume(trackId: string, volume: number): void {
    const entry = this.playing.get(trackId)
    if (!entry) return
    entry.trackVolume = clamp01(volume)
    this.apply(entry)
  }

  async startAudio(): Promise<void> {
    await this.tryPlay([...this.playing.values()], true)
  }

  async setSink(deviceId: string | null): Promise<void> {
    this.sinkId = deviceId
    if (deviceId === null) return
    for (const entry of this.playing.values()) await this.applySink(entry.el, deviceId)
  }

  close(): void {
    this.offVisible?.()
    this.offVisible = null
    for (const trackId of [...this.playing.keys()]) this.remove(trackId)
    const waiting = this.waiters
    this.waiters = []
    for (const resolve of waiting) resolve({ done: true, value: undefined })
  }

  private apply(entry: Playing): void {
    const room = this.mix.get(entry.roomId) ?? { muted: false, volume: 1 }
    entry.el.muted = room.muted
    entry.el.volume = clamp01(room.volume * entry.trackVolume)
  }

  private async applySink(el: AudioElementLike, deviceId: string): Promise<void> {
    if (!el.setSinkId) return
    try {
      await el.setSinkId(deviceId)
    } catch {
      return
    }
  }

  private async tryPlay(entries: Playing[], byGesture = false): Promise<void> {
    let blocked = false
    for (const entry of entries) {
      try {
        await entry.el.play()
      } catch {
        blocked = true
      }
    }
    if (blocked) {
      this.setAllowed(false)
      if (!byGesture) this.watchVisible()
      return
    }
    if (entries.length > 0 || byGesture) this.setAllowed(true)
  }

  private setAllowed(next: boolean): void {
    if (this.allowed === next) return
    this.allowed = next
    if (next) { this.offVisible?.(); this.offVisible = null }
    const resolve = this.waiters.shift()
    if (resolve) resolve({ done: false, value: next })
    else this.pending.push(next)
  }

  private watchVisible(): void {
    if (this.offVisible) return
    this.offVisible = this.out.onVisible(() => { void this.tryPlay([...this.playing.values()]) })
  }
}

function clamp01(v: number): number { return Math.min(1, Math.max(0, v)) }
