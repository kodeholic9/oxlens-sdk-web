// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-API-ASYNC · SDK:IMPL-DOC-EXPOSE-MAP · model: claude-opus-5-5

type Fn = (...a: unknown[]) => void

/** 앱 핸들러를 부르는 중인 깊이 — 핸들러 안에서 부른 API 는 다음 tick 에 나간다(SDK:RULE-API-ASYNC 재진입 금지) */
let depth = 0
export function inHandler(): boolean { return depth > 0 }

/** on/off/once — 앱 핸들러를 사건 주인이 직접 부른다. 한 핸들러가 던져도 다음 핸들러는 불린다 */
export class Emitter<M extends Record<string, unknown[]>> {
  private readonly table = new Map<keyof M, Set<Fn>>()

  on<K extends keyof M>(name: K, fn: (...a: M[K]) => void): () => void {
    let set = this.table.get(name)
    if (!set) { set = new Set(); this.table.set(name, set) }
    set.add(fn as unknown as Fn)
    return () => this.off(name, fn)
  }

  off<K extends keyof M>(name: K, fn?: (...a: M[K]) => void): void {
    if (!fn) { this.table.delete(name); return }
    this.table.get(name)?.delete(fn as unknown as Fn)
  }

  once<K extends keyof M>(name: K, fn: (...a: M[K]) => void): () => void {
    const wrap = (...a: M[K]): void => { this.off(name, wrap); fn(...a) }
    return this.on(name, wrap)
  }

  emit<K extends keyof M>(name: K, ...a: M[K]): void {
    const set = this.table.get(name)
    if (!set) return
    depth++
    try {
      for (const fn of [...set]) {
        try { fn(...a) } catch (e) { reportHandlerError(String(name), e) }
      }
    } finally { depth-- }
  }

  clear(): void { this.table.clear() }
}

function reportHandlerError(name: string, e: unknown): void {
  queueMicrotask(() => { throw e instanceof Error ? e : new Error(`핸들러 ${name}: ${String(e)}`) })
}
