// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SES-CLOCK · 연:RULE-LINK-RECOVERY-WAKE · SDK:RULE-PLAT-WEB · model: claude-opus-5-5

/** 단조 시계(ms) — 시한 · 경과는 이것으로 잰다 */
export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 벽시계(ms) — 기록 · 표면 시각 */
export function wall(): number {
  return Date.now()
}

export interface Fired {
  /** 예정 시각보다 늦은 만큼(ms) */
  readonly lateMs: number
  /** 늦음이 깨어남 문턱을 넘었다 — 시한 초과로 세지 않고 처음부터 다시 판정한다 */
  readonly woke: boolean
}

/**
 * 한 번 도는 시계 — 만료마다 예정 대비 지연을 재 깨어남을 가른다(SDK:IMPL-SES-CLOCK 깨어남은 사건이다).
 * 숨은 탭에서도 돈다 — 브라우저는 1초로 정렬할 뿐 세우지 않는다(SDK:RULE-PLAT-WEB).
 */
export class Timer {
  private handle: ReturnType<typeof setTimeout> | null = null
  private due = 0

  constructor(private readonly wakeDetectMs: number) {}

  get armed(): boolean { return this.handle !== null }

  start(ms: number, fire: (f: Fired) => void): void {
    this.stop()
    this.due = now() + ms
    this.handle = setTimeout(() => {
      this.handle = null
      const lateMs = Math.max(0, now() - this.due)
      fire({ lateMs, woke: lateMs > this.wakeDetectMs })
    }, Math.max(0, ms))
  }

  stop(): void {
    if (this.handle !== null) clearTimeout(this.handle)
    this.handle = null
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

/** 다음 tick — 핸들러 안에서 부른 API 는 다음 tick 에 나간다(SDK:RULE-API-ASYNC 재진입 금지) */
export function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
