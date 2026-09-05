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
