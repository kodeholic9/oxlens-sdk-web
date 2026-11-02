// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-ERR-TYPE · SDK:RULE-ERR-REJECT-OR-EVENT · model: claude-opus-5-5
import { Fault, type Category } from '../platform/fault.js'
import { inHandler } from '../platform/emitter.js'
import { nextTick } from '../platform/clock.js'

/** 표면 오류형 — wire 코드는 그대로 나른다 · wire 가 아닌 실패는 code 0 + name */
export class OxLensError extends Error {
  readonly code: number
  override readonly name: string
  readonly permanent: boolean
  readonly category: Category
  readonly details?: Record<string, unknown>
  override readonly cause?: unknown

  constructor(f: Fault) {
    super(f.message)
    this.code = f.code
    this.name = f.name
    this.permanent = f.permanent
    this.category = f.category
    if (f.details !== undefined) this.details = f.details
    if (f.cause !== undefined) this.cause = f.cause
  }
}

const SEEN = new WeakMap<Fault, OxLensError>()

/** 아래 층의 실패 사실 → 표면 오류형 — 같은 사실은 같은 오류 객체 */
export function toError(e: unknown): OxLensError {
  if (e instanceof OxLensError) return e
  if (e instanceof Fault) {
    let x = SEEN.get(e)
    if (!x) { x = new OxLensError(e); SEEN.set(e, x) }
    return x
  }
  return new OxLensError(new Fault({ code: 0, name: 'BUG', category: 'bug', permanent: true, message: String(e), cause: e }))
}

/** 앱 조작 API — 이벤트 핸들러 안에서 불렸으면 다음 tick 에 나간다(SDK:RULE-API-ASYNC 재진입 금지) · 밖이면 곧바로 · 실패는 OxLensError */
export function act<T>(fn: () => Promise<T>): Promise<T> {
  return wrap(inHandler() ? nextTick().then(fn) : fn())
}

/** 요청 API — 실패는 OxLensError 로 reject */
export async function wrap<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) { throw toError(e) }
}
