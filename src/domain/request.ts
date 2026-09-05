// author: kodeholic (powered by Claude)
// 연§7-0-1 — 실패 응답을 어떻게 다루나. 앞자리로 가르고, 재시도는 사다리의 둘째~넷째 칸이다.
// ★첫 칸(0ms)은 재접속 것이라 요청 재시도에 쓰지 않는다.
import { Clock } from '../platform/clock.js'
import { RequestFailed, Signaling } from '../internal/signaling.js'

export const RETRY_MS: readonly number[] = [300, 1200, 2700]

/** 연§10-2 — 1xxx 는 클라 버그다. permanent 는 다시 보내도 같다. */
export function retryable(e: unknown): boolean {
  if (!(e instanceof RequestFailed)) return false
  if (e.failure.code < 2000) return false
  return (e.failure as { permanent?: boolean }).permanent !== true
}

/**
 * 세 번까지 다시 보내고, 그래도 안 되면 마지막 실패를 그대로 올린다.
 * ★사건별 절차가 있는 코드는 그것이 이긴다 — noRetry 로 넘긴다(연§7-5-3·§7-5-5).
 */
export async function request(
  sig: Signaling, clock: Clock, op: number, body?: unknown, noRetry: readonly number[] = [],
): Promise<Record<string, unknown>> {
  let last: unknown
  for (let i = 0; i <= RETRY_MS.length; i += 1) {
    try {
      return await sig.request(op, body)
    } catch (e) {
      last = e
      const settled = e instanceof RequestFailed && noRetry.includes(e.failure.code)
      if (i === RETRY_MS.length || settled || !retryable(e)) break
      await clock.sleep(RETRY_MS[i]!)
    }
  }
  throw last
}
