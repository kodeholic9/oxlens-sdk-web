// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-MOD-BOUNDARY · SDK:RULE-MOD-EVENT-ORDER · model: claude-opus-5-5

/**
 * 받은 차례 그대로 꺼내는 통 — 아래 층은 사실을 넣기만 하고 소유한 위 층이 직접 꺼낸다(콜백 주입 없음).
 * 꺼내는 쪽 하나가 차례대로 처리하므로 시그널링이 받은 순서 = 처리 순서다.
 */
export class Queue<T> {
  private readonly items: T[] = []
  private waiter: ((v: T | null) => void) | null = null
  private ended = false

  push(v: T): void {
    if (this.ended) return
    const w = this.waiter
    if (w) { this.waiter = null; w(v); return }
    this.items.push(v)
  }

  /** 다음 것 — 통이 닫혔으면 null */
  next(): Promise<T | null> {
    const v = this.items.shift()
    if (v !== undefined) return Promise.resolve(v)
    if (this.ended) return Promise.resolve(null)
    return new Promise((r) => { this.waiter = r })
  }

  end(): void {
    this.ended = true
    const w = this.waiter
    this.waiter = null
    if (w) w(null)
  }
}
