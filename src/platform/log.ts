// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-DIAG-LOG · SDK:RULE-DIAG-EVENTS · SDK:IMPL-LINK-PROJECTION 출입구 하나 · 연:DEV-TRN-SESSION-SECRET · model: claude-opus-5-5
import { Emitter } from './emitter.js'
import { wall } from './clock.js'

export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error'
const RANK: Record<Level, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }

export interface LogEntry {
  readonly ts: number
  readonly level: Level
  readonly ns: string
  readonly msg: string
  readonly data?: unknown
}

/** 전이 기록 — 기록 없이 바뀌는 상태가 없다(SDK:IMPL-LINK-PROJECTION 출입구 하나 · SDK:RULE-DIAG-EVENTS transition) */
export interface Transition {
  readonly ts: number
  readonly layer: string
  readonly key: string
  readonly from: string
  readonly to: string
  readonly cause: string
  readonly label: string
  readonly rung?: number
  readonly attempt?: number
}

/** 링 버퍼 크기 — probe 에는 싣지 않는다(SDK:RULE-DIAG-LOG) */
export const RING = 500

/** 로그 원장 — 네임스페이스는 모듈 이름 · wire 를 쓸 때는 wire 어휘 그대로 · 전이 기록의 출입구(진단은 층 자체가 자리 — 영역마다 원장을 받아 쓴다) */
export class LogBook {
  readonly events = new Emitter<{ log: [LogEntry]; transition: [Transition] }>()
  private readonly ring: LogEntry[] = []
  private floor: Level = 'info'

  setLevel(l: Level): void { this.floor = l }

  entries(): readonly LogEntry[] { return this.ring }

  write(level: Level, ns: string, msg: string, data?: unknown): void {
    const e: LogEntry = data === undefined ? { ts: wall(), level, ns, msg } : { ts: wall(), level, ns, msg, data: redact(data) }
    this.ring.push(e)
    if (this.ring.length > RING) this.ring.shift()
    if (RANK[level] < RANK[this.floor]) return
    this.events.emit('log', e)
    if (RANK[level] >= RANK.warn && typeof console !== 'undefined') console[level === 'error' ? 'error' : 'warn'](`[${ns}] ${msg}`, e.data ?? '')
  }

  scope(ns: string): Logger { return new Logger(this, ns) }

  /** 전이 하나 — transition 이벤트 · 로그(받지 않는 사건은 warn) */
  record(layer: string, key: string, from: string, to: string, label: string, cause: string, extra?: { rung?: number; attempt?: number }): void {
    const t: Transition = { ts: wall(), layer, key, from, to, cause, label, ...(extra ?? {}) }
    this.events.emit('transition', t)
    this.write(cause === 'impossible' ? 'warn' : 'debug', layer.toLowerCase(), `${key} ${from}→${to} ${label}`, cause === 'impossible' ? t : undefined)
  }

  /** 받지 않는 사건 — 조용히 무시하지 않는다(SDK:IMPL-LINK-PROJECTION 받지 않는 사건) */
  impossible(layer: string, key: string, from: string, entry: string): void {
    this.record(layer, key, from, from, entry, 'impossible')
  }
}

export class Logger {
  constructor(private readonly book: LogBook, readonly ns: string) {}
  trace(msg: string, data?: unknown): void { this.book.write('trace', this.ns, msg, data) }
  debug(msg: string, data?: unknown): void { this.book.write('debug', this.ns, msg, data) }
  info(msg: string, data?: unknown): void { this.book.write('info', this.ns, msg, data) }
  warn(msg: string, data?: unknown): void { this.book.write('warn', this.ns, msg, data) }
  error(msg: string, data?: unknown): void { this.book.write('error', this.ns, msg, data) }
}

const SECRET = new Set(['token', 'session_id', 'sessionId', 'Authorization', 'X-OxLens-Session', 'ice_pwd', 'publish_pwd', 'subscribe_pwd', 'pwd'])

/** 자격(토큰 · session_id · 세션 헤더 · ICE 암호)은 로그에 남기지 않는다 */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET.has(k) ? '***' : redact(x, depth + 1)
  return out
}
