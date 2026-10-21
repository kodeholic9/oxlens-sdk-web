// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-ERR-TYPE · SDK:RULE-ERR-REJECT-OR-EVENT · model: claude-opus-5-5
import { Fault, type Category } from '../platform/fault.js'

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

/** 요청 API — 실패는 OxLensError 로 reject */
export async function wrap<T>(p: Promise<T>): Promise<T> {
  try { return await p } catch (e) { throw toError(e) }
}
