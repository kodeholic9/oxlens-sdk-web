// author: kodeholic (powered by Claude)
// 연§3-1·§3-2 — 소켓 하나 위의 요청/응답 짝짓기. 00 프레임 하나에 01 또는 10 하나가 돌아온다.
//
// 통지는 여기서 ACK 을 먼저 보내고(연§7-0-2) 큐에 쌓는다. 주인이 notifications() 를 훑는다 —
// 콜백을 주입받지 않아야 흐름이 소스에 그대로 보인다(SDK§8-1).
import { Clock, systemClock } from '../platform/clock.js'
import { CloseInfo, Socket } from '../platform/socket.js'
import { decode, encode, Frame, FrameError, Kind } from './frame.js'
import { countsTowardWindow, Failure, Op, opName, tierOf } from './wire.js'

/** 연§8-1 — 요청은 재전송하지 않는다. 30초에 끊는다. */
export const T_REQ_MS = 30_000
export const WINDOW_MIN = 1
export const WINDOW_MAX = 10
export const WINDOW_DEFAULT = 1
/** 연§3-1 — 밀린 프레임이 이보다 많으면 끊는다. */
export const BACKLOG_MAX = 1_000

export interface SignalingOptions {
  readonly window?: number
  readonly clock?: Clock
}

/** 실패 응답(10). code 는 연§10-2 숫자 그대로 — 합치거나 바꾸지 않는다. */
export class RequestFailed extends Error {
  override readonly name = 'RequestFailed'
  constructor(readonly op: number, readonly failure: Failure) {
    super(`${opName(op)} 실패 ${failure.code} ${failure.name}`)
  }
}

/** 소켓이 닫혀 응답을 받을 수 없다. 끊긴 이유는 closed 가 갖는다. */
export class SignalingClosed extends Error {
  override readonly name = 'SignalingClosed'
  constructor(readonly info: CloseInfo) {
    super(`시그널링이 닫혔다 ${info.code} ${info.reason}`)
  }
}

export interface Notification {
  readonly op: number
  readonly body: Record<string, unknown>
}

interface Pending {
  readonly op: number
  readonly tier: number
  readonly seq: number
  readonly body: unknown
  resolve(body: Record<string, unknown>): void
  reject(err: Error): void
}

interface Inflight extends Pending {
  readonly pid: number
  readonly abort: AbortController
}

export class Signaling {
  private readonly clock: Clock
  private readonly window: number
  private readonly queue: Pending[] = []
  private readonly inflight = new Map<number, Inflight>()
  private readonly inbox: Notification[] = []
  private nextPid = 0
  private seq = 0
  private wake: (() => void) | null = null
  private shutdown: CloseInfo | null = null
  private beat: AbortController | null = null

  readonly closed: Promise<CloseInfo>

  constructor(private readonly socket: Socket, opts: SignalingOptions = {}) {
    const w = opts.window ?? WINDOW_DEFAULT
    if (w < WINDOW_MIN || w > WINDOW_MAX || !Number.isInteger(w)) {
      throw new RangeError(`윈도우는 ${WINDOW_MIN}~${WINDOW_MAX} 정수다 (받은 값 ${w})`)
    }
    this.window = w
    this.clock = opts.clock ?? systemClock
    this.closed = socket.closed
    void this.pump()
    void socket.closed.then((info) => { this.abandon(info) })
  }

  /** 연§3-1 — 00 을 보내고 그 짝을 기다린다. 성공이면 body, 실패면 RequestFailed. */
  request(op: number, body?: unknown): Promise<Record<string, unknown>> {
    if (this.shutdown) return Promise.reject(new SignalingClosed(this.shutdown))
    return new Promise((resolve, reject) => {
      this.queue.push({ op, tier: tierOf(op), seq: this.seq++, body, resolve, reject })
      this.queue.sort((a, b) => a.tier - b.tier || a.seq - b.seq)
      this.drain()
    })
  }

  /** 연§8-1 T-hb — BIND 응답이 준 주기로 보낸다. 멈추는 것은 소켓이 닫힐 때뿐이다. */
  startHeartbeat(intervalMs: number): void {
    this.beat?.abort()
    const ctl = new AbortController()
    this.beat = ctl
    void (async () => {
      while (!ctl.signal.aborted && !this.shutdown) {
        await this.clock.sleep(intervalMs, ctl.signal)
        if (ctl.signal.aborted || this.shutdown) return
        try {
          await this.request(Op.Heartbeat)
        } catch {
          return
        }
      }
    })()
  }

  /** 주인이 훑는다. 소켓이 닫히면 남은 것을 다 낸 뒤 끝난다. */
  async *notifications(): AsyncIterableIterator<Notification> {
    for (;;) {
      while (this.inbox.length > 0) yield this.inbox.shift()!
      if (this.shutdown) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = null
    }
  }

  close(code: number, reason: string): void {
    this.beat?.abort()
    this.socket.close(code, reason)
  }

  private drain(): void {
    for (let i = 0; i < this.queue.length;) {
      const p = this.queue[i]!
      if (countsTowardWindow(p.op) && this.inflight.size >= this.window) return
      this.queue.splice(i, 1)
      this.dispatch(p)
    }
  }

  private dispatch(p: Pending): void {
    const pid = this.nextPid
    this.nextPid = (this.nextPid + 1) >>> 0
    const abort = new AbortController()
    const shot: Inflight = { ...p, pid, abort }
    this.inflight.set(pid, shot)
    try {
      this.socket.send(encode(Kind.Request, p.op, pid, p.body))
    } catch (e) {
      this.inflight.delete(pid)
      p.reject(e as Error)
      return
    }
    void this.deadline(shot)
  }

  private async deadline(shot: Inflight): Promise<void> {
    await this.clock.sleep(T_REQ_MS, shot.abort.signal)
    if (shot.abort.signal.aborted || this.shutdown) return
    this.inflight.delete(shot.pid)
    shot.reject(new Error(`${opName(shot.op)} 응답이 ${T_REQ_MS}ms 안에 안 왔다`))
    this.close(4001, 'FLOW_TIMEOUT')
  }

  private async pump(): Promise<void> {
    for await (const raw of this.socket.frames()) {
      let f: Frame
      try {
        f = decode(raw)
      } catch (e) {
        const fe = e as FrameError
        this.close(fe.closeCode, fe.closeReason)
        return
      }
      if (f.kind === Kind.Request) this.onNotification(f)
      else this.onReply(f)
    }
  }

  private onNotification(f: Frame): void {
    this.socket.send(encode(Kind.Ok, f.op, f.pid))
    if (this.inbox.length >= BACKLOG_MAX) {
      this.close(4002, 'FLOW_OVERFLOW')
      return
    }
    this.inbox.push({ op: f.op, body: (f.body ?? {}) as Record<string, unknown> })
    this.wake?.()
  }

  /** 짝은 방향까지 보고 짓는다 — 이쪽은 내가 보낸 00 의 응답만 본다(연§3-1). */
  private onReply(f: Frame): void {
    const shot = this.inflight.get(f.pid)
    if (!shot || shot.op !== f.op) return
    this.inflight.delete(f.pid)
    shot.abort.abort()
    if (f.kind === Kind.Ok) shot.resolve((f.body ?? {}) as Record<string, unknown>)
    else shot.reject(new RequestFailed(f.op, (f.body ?? {}) as unknown as Failure))
    this.drain()
  }

  private abandon(info: CloseInfo): void {
    this.shutdown = info
    this.beat?.abort()
    const orphans = [...this.inflight.values(), ...this.queue]
    this.inflight.clear()
    this.queue.length = 0
    for (const o of orphans) {
      if ('abort' in o) (o as Inflight).abort.abort()
      o.reject(new SignalingClosed(info))
    }
    this.wake?.()
  }
}
