// author: kodeholic (powered by Claude)
// 연§7-0~§7-3 · §8-1·§8-2 — 연결 상태기. 시그널링을 소유하고 백오프 사다리를 돈다.
// ★WS 만 끊긴 것과 세션이 죽은 것은 다르다 — 미디어는 여기서 닫지 않는다.
import { Clock, systemClock } from '../platform/clock.js'
import { CLOSE_NORMAL, CloseInfo, Socket } from '../platform/socket.js'
import { RequestFailed, Signaling, SignalingOptions } from '../internal/signaling.js'
import { Op, reconnectable } from '../internal/wire.js'

/** 연§8-2 — 대기만 44초. 지터는 3번째부터 0~1000ms 를 더한다. */
export const BACKOFF_MS: readonly number[] = [0, 300, 1200, 2700, 4800, 7000, 7000, 7000, 7000, 7000]
export const JITTER_FROM = 2
export const JITTER_MAX_MS = 1_000
/** 연§8-1 T-bind. */
export const T_BIND_MS = 10_000

export type ConnectionState = 'disconnected' | 'connecting' | 'active' | 'resuming'

export interface BindResult {
  readonly user_id: string
  readonly role: string
  readonly session_id: string
  readonly heartbeat_interval: number
  readonly resume_window_ms: number
  readonly pc_mode: '1pc' | '2pc'
}

/** 연§7-3-2 4 — 살아 있는 것만 신고한다. 미디어 생존을 아는 쪽이 낸다. */
export interface LiveReport {
  rooms(): readonly string[]
  publish(): readonly { readonly track_id: string; readonly kind: string }[]
}

/** 연§6-1 — 이어받은 방마다의 따라잡기 스냅샷. 끊겨 있는 동안 사라진 통지를 대신한다. */
export interface ResumeOutcome {
  readonly resumed: readonly string[]
  readonly failed: readonly string[]
  readonly publish_failed: readonly string[]
  readonly snapshot: Readonly<Record<string, unknown>>
}

export type SessionEvent =
  | { readonly kind: 'active'; readonly bind: BindResult; readonly resumed: boolean }
  | { readonly kind: 'caught_up'; readonly outcome: ResumeOutcome }
  | { readonly kind: 'resuming' }
  | { readonly kind: 'rebuild'; readonly why: 'no_session' | 'window_expired' | 'resume_failed' }
  | { readonly kind: 'closed'; readonly info: CloseInfo; readonly retryable: boolean }

export interface SessionOptions {
  readonly url: string
  readonly token: string
  readonly pcMode?: '1pc' | '2pc'
  readonly connect: (url: string) => Promise<Socket>
  readonly live: LiveReport
  readonly clock?: Clock
  readonly signaling?: SignalingOptions
  /** 지터를 결정적으로 만드는 자리 — 1층이 사다리를 잰다. */
  readonly jitter?: () => number
}

export class Session {
  private readonly clock: Clock
  private readonly jitter: () => number
  private sig: Signaling | null = null
  private bind: BindResult | null = null
  private attempt = 0
  private droppedAt: number | null = null
  private stopped = false
  private events: SessionEvent[] = []
  private wake: (() => void) | null = null

  state: ConnectionState = 'disconnected'

  constructor(private opts: SessionOptions) {
    this.clock = opts.clock ?? systemClock
    this.jitter = opts.jitter ?? (() => Math.floor(Math.random() * JITTER_MAX_MS))
  }

  get signaling(): Signaling | null { return this.sig }
  get info(): BindResult | null { return this.bind }
  /** 재구축이 도는 동안 참을 유지한다 — 끊겼다 붙었다를 앱에 낱낱이 알리지 않는다(SDK§10-5). */
  get recovering(): boolean { return this.state === 'resuming' }

  setToken(token: string): void { this.opts = { ...this.opts, token } }

  /** 연§7-1-1 — 앱이 접속을 요청했다. */
  async connect(): Promise<BindResult> {
    this.stopped = false
    this.attempt = 0
    this.droppedAt = null
    const bind = await this.dial(false)
    void this.watchClose()
    return bind
  }

  /** SDK§10-6 — 클라가 먼저 끊는 정상 종료. */
  close(): void {
    this.stopped = true
    this.sig?.close(CLOSE_NORMAL, '')
    this.state = 'disconnected'
    this.push({ kind: 'closed', info: { code: CLOSE_NORMAL, reason: '' }, retryable: false })
  }

  async *listen(): AsyncIterableIterator<SessionEvent> {
    for (;;) {
      while (this.events.length > 0) yield this.events.shift()!
      if (this.stopped && this.sig === null) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = null
    }
  }

  /** 연§7-2-1·§7-2-2 — 소켓을 열고 BIND 부터 보낸다. 서버는 먼저 말하지 않는다. */
  private async dial(resuming: boolean): Promise<BindResult> {
    this.state = resuming ? 'resuming' : 'connecting'
    const socket = await this.opts.connect(this.opts.url)
    const sig = new Signaling(socket, { clock: this.clock, ...this.opts.signaling })
    this.sig = sig

    const previous = this.bind?.session_id
    const body: Record<string, unknown> = {
      token: this.opts.token,
      client_ver: 1,
      pc_mode: this.opts.pcMode ?? '2pc',
    }
    // 연§6-1 — session_id 가 유효하면 그것이 이긴다. 토큰은 보지 않는다.
    if (resuming && previous !== undefined && !this.windowExpired()) body.session_id = previous

    const bind = await this.withDeadline(sig.request(Op.Bind, body), T_BIND_MS, socket)
    const result = bind as unknown as BindResult
    this.bind = result
    sig.startHeartbeat(result.heartbeat_interval)
    this.state = 'active'
    this.attempt = 0
    this.droppedAt = null

    // 연§6-1 — 응답의 session_id 가 내가 보낸 것과 같아야 이어받은 것이다.
    const resumed = resuming && previous !== undefined && result.session_id === previous
    if (resuming && !resumed) this.push({ kind: 'rebuild', why: 'no_session' })
    else if (resumed) await this.resume()
    this.push({ kind: 'active', bind: result, resumed })
    return result
  }

  /** 연§6-1 RESUME — 시그널만 끊겼다. 살아 있는 것만 신고한다. */
  private async resume(): Promise<void> {
    const rooms = this.opts.live.rooms()
    const publish = this.opts.live.publish()
    if (rooms.length === 0 && publish.length === 0) {
      this.push({ kind: 'rebuild', why: 'resume_failed' })
      return
    }
    try {
      const res = await this.sig!.request(Op.Resume, { rooms, publish })
      // ★응답을 반영하지 않으면 재접속이 복구가 아니라 "보냈다는 사실" 로 끝난다.
      this.push({
        kind: 'caught_up',
        outcome: {
          resumed: (res.resumed ?? []) as string[],
          failed: (res.failed ?? []) as string[],
          publish_failed: (res.publish_failed ?? []) as string[],
          snapshot: (res.snapshot ?? {}) as Record<string, unknown>,
        },
      })
    } catch (e) {
      if (e instanceof RequestFailed) this.push({ kind: 'rebuild', why: 'resume_failed' })
      else throw e
    }
  }

  /** 연§7-0-3 — 끊겼다. 미디어는 닫지 않는다. */
  private async watchClose(): Promise<void> {
    for (;;) {
      const info = await this.sig!.closed
      if (this.stopped) { this.sig = null; this.wake?.(); return }
      this.droppedAt ??= this.clock.now()
      if (!reconnectable(info.code)) {
        this.state = 'disconnected'
        this.push({ kind: 'closed', info, retryable: false })
        this.sig = null
        return
      }
      this.state = 'resuming'
      this.push({ kind: 'resuming' })
      if (!(await this.retry(info))) return
    }
  }

  /** 연§8-2 — 사다리는 재구축이 끝나 active 가 될 때만 0 으로 돌아간다. */
  private async retry(last: CloseInfo): Promise<boolean> {
    while (this.attempt < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[this.attempt]! + (this.attempt >= JITTER_FROM ? this.jitter() : 0)
      this.attempt += 1
      await this.clock.sleep(wait)
      if (this.stopped) return false
      // 연§8-2 — 창을 넘겼으면 이어받기 왕복을 태우지 않는다.
      if (this.windowExpired()) this.push({ kind: 'rebuild', why: 'window_expired' })
      try {
        await this.dial(true)
        return true
      } catch {
        this.sig?.close(4000, 'PROTOCOL_ERROR')
      }
    }
    this.state = 'disconnected'
    this.push({ kind: 'closed', info: last, retryable: true })
    this.sig = null
    return false
  }

  private windowExpired(): boolean {
    if (this.droppedAt === null || this.bind === null) return false
    return this.clock.now() - this.droppedAt > this.bind.resume_window_ms
  }

  /** 연§8-1 T-bind — 응답이 없으면 소켓을 닫고 백오프로 간다. */
  private async withDeadline<T>(job: Promise<T>, ms: number, socket: Socket): Promise<T> {
    const ctl = new AbortController()
    const timer = this.clock.sleep(ms, ctl.signal).then(() => {
      if (!ctl.signal.aborted) socket.close(4003, 'HEARTBEAT_TIMEOUT')
      return Promise.reject(new Error(`BIND 응답이 ${ms}ms 안에 안 왔다`))
    })
    try {
      return await Promise.race([job, timer])
    } finally {
      ctl.abort()
    }
  }

  private push(e: SessionEvent): void {
    this.events.push(e)
    this.wake?.()
  }
}
