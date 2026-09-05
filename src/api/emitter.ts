// author: kodeholic (powered by Claude)
// SDK§2-2 — 같은 방의 이벤트는 서버 도착 순서다. 핸들러 안의 API 호출은 다음 tick 에 돈다.
import { Emitter } from './types.js'

type AnyEvents = Record<string, (...args: never[]) => void>

export class Bus<E extends AnyEvents> implements Emitter<E> {
  private readonly listeners = new Map<keyof E, Set<{ fn: E[keyof E]; once: boolean }>>()

  on<K extends keyof E>(event: K, fn: E[K]): this {
    this.bucket(event).add({ fn: fn as E[keyof E], once: false })
    return this
  }

  once<K extends keyof E>(event: K, fn: E[K]): this {
    this.bucket(event).add({ fn: fn as E[keyof E], once: true })
    return this
  }

  off<K extends keyof E>(event: K, fn: E[K]): this {
    const set = this.listeners.get(event)
    if (set) for (const e of [...set]) if (e.fn === fn) set.delete(e)
    return this
  }

  /** 한 핸들러가 던져도 나머지는 부른다 — 앱 버그가 SDK 흐름을 끊지 않는다. */
  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const e of [...set]) {
      if (e.once) set.delete(e)
      try {
        ;(e.fn as unknown as (...a: unknown[]) => void)(...args)
      } catch {
        continue
      }
    }
  }

  private bucket<K extends keyof E>(event: K): Set<{ fn: E[keyof E]; once: boolean }> {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    return set
  }
}
