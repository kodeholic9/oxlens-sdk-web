// author: kodeholic (powered by Claude)
// ★판정은 절대값이 아니라 차분이다 — 트랙이 붙은 것과 흐르는 것은 다르다.
// 스냅샷 사이는 2초 이상 둔다(계수 갱신 눈금).
import { Participant } from './scope.js'

export const SAMPLE_GAP_MS = 2_500

export interface TrackStat {
  readonly id: string
  readonly roomId: string
  readonly kind: 'audio' | 'video'
  readonly active: boolean
  readonly muted: boolean
  readonly readyState: string
  readonly packets: number | null
  readonly bytes: number | null
  readonly framesDecoded: number | null
  readonly videoWidth?: number
  readonly currentTime?: number
}

export interface Flow {
  readonly packets: number
  readonly bytes: number
  readonly frames: number
}

/** 그 트랙이 이 창 동안 실제로 받은 양. 트랙이 없으면 null 이다(0 과 구별한다). */
export async function flowOf(
  p: Participant, pick: (t: TrackStat) => boolean, gapMs = SAMPLE_GAP_MS,
): Promise<Flow | null> {
  const first = (await p.call<TrackStat[]>('trackStats')).find(pick)
  if (!first) return null
  await new Promise((r) => setTimeout(r, gapMs))
  const second = (await p.call<TrackStat[]>('trackStats')).find(pick)
  if (!second) return null
  return {
    packets: (second.packets ?? 0) - (first.packets ?? 0),
    bytes: (second.bytes ?? 0) - (first.bytes ?? 0),
    frames: (second.framesDecoded ?? 0) - (first.framesDecoded ?? 0),
  }
}
