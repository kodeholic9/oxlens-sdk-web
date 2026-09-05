// author: kodeholic (powered by Claude)
// SDK§10-1 — 시계는 주입받는다. 1층이 실시간을 기다리지 않고 타이머를 결정적으로 판정한다.

export interface Clock {
  now(): number
  /** signal 이 끊기면 즉시 깬다. 깨어난 이유는 부르는 쪽이 signal 로 판별한다. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const t = setTimeout(done, ms)
      function done(): void {
        clearTimeout(t)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    }),
}
