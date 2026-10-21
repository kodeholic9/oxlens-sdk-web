// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-ERR-TYPE · SDK:RULE-ERR-DEVICE · 연:RULE-ERR-UNKNOWN-BY-LEAD · model: claude-opus-5-5

export type Category = 'bug' | 'auth' | 'state' | 'limit' | 'server' | 'device' | 'negotiation' | 'closed'

/** 아래 층이 올리는 실패 사실 — 표면 오류형은 api 가 이것으로 짓는다(SDK:RULE-MOD-BOUNDARY) */
export class Fault {
  readonly code: number
  readonly name: string
  readonly permanent: boolean
  readonly category: Category
  readonly message: string
  readonly details: Record<string, unknown> | undefined
  readonly cause: unknown

  constructor(a: { code: number; name: string; permanent?: boolean; category?: Category; message?: string; details?: Record<string, unknown> | undefined; cause?: unknown }) {
    this.code = a.code
    this.name = a.name
    this.category = a.category ?? categoryOf(a.code)
    this.permanent = a.permanent ?? (this.category === 'bug')
    this.message = a.message ?? a.name
    this.details = a.details
    this.cause = a.cause
  }
}

/** 앞자리가 무엇을 고쳐야 하나다(연:RULE-ERR-UNKNOWN-BY-LEAD) */
export function categoryOf(code: number): Category {
  if (code >= 1000 && code < 2000) return 'bug'
  if (code >= 2000 && code < 3000) return 'auth'
  if (code >= 3000 && code < 4000) return 'state'
  if (code >= 4000 && code < 5000) return 'limit'
  if (code >= 5000 && code < 6000) return 'server'
  return 'bug'
}

/** wire 의 Failure body 를 그대로 나른다 — 코드를 바꾸거나 합치지 않는다(SDK:IMPL-ERR-TYPE) */
export function fromFailure(body: unknown): Fault {
  const b = (body ?? {}) as { code?: unknown; name?: unknown; permanent?: unknown; message?: unknown; details?: unknown }
  const code = typeof b.code === 'number' ? b.code : 5003
  const name = typeof b.name === 'string' ? b.name : 'UNKNOWN'
  const a: { code: number; name: string; permanent?: boolean; message?: string; details?: Record<string, unknown> } = { code, name }
  if (typeof b.permanent === 'boolean') a.permanent = b.permanent
  if (typeof b.message === 'string') a.message = b.message
  if (b.details && typeof b.details === 'object') a.details = b.details as Record<string, unknown>
  return new Fault(a)
}

export function stateFault(name: string, details?: Record<string, unknown>): Fault {
  return new Fault({ code: 0, name, category: 'state', permanent: false, details })
}

export function closedFault(name = 'CLOSED'): Fault {
  return new Fault({ code: 0, name, category: 'closed', permanent: false })
}

export function negotiationFault(stage: string, cause?: unknown): Fault {
  return new Fault({ code: 0, name: `NEGOTIATION_${stage}`, category: 'negotiation', permanent: true, cause })
}

export function bugFault(name: string, cause?: unknown): Fault {
  return new Fault({ code: 0, name, category: 'bug', permanent: true, cause })
}
