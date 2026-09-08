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
  /** 연§9-10 규칙 2 — 끊김은 계수가 멎는 것으로도, 디코더가 얼어붙는 것으로도 드러난다. */
  readonly freezeCount?: number | null
  readonly pauseCount?: number | null
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

export interface Sample {
  readonly at: number
  readonly stat: TrackStat | undefined
}

/**
 * 연§9-10 규칙 2 — 재협상 창을 촘촘히 훑는다. 두 스냅샷의 차분으로는 ★창 안의 끊김을 못 본다.
 * `during` 은 표본 몇 개가 지난 뒤 한 번 친다 — 사건과 관측이 같은 시간축에 있어야 한다.
 */
export async function watch(
  p: Participant, pick: (t: TrackStat) => boolean,
  opts: { samples: number; gapMs: number; fireAt: number; during: () => Promise<unknown> },
): Promise<Sample[]> {
  const out: Sample[] = []
  let fired: Promise<unknown> | null = null
  for (let i = 0; i < opts.samples; i += 1) {
    const stats = await p.call<TrackStat[]>('trackStats')
    out.push({ at: Date.now(), stat: stats.find(pick) })
    if (i === opts.fireAt) fired = opts.during()
    await new Promise((r) => setTimeout(r, opts.gapMs))
  }
  if (fired) await fired
  return out
}

/** 표본 사이에 ★한 번이라도 멎은 자리. 없으면 빈 배열이다. */
export function stalls(samples: readonly Sample[]): { i: number; packets: number }[] {
  const out: { i: number; packets: number }[] = []
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]?.stat?.packets ?? null
    const b = samples[i]?.stat?.packets ?? null
    if (a === null || b === null) { out.push({ i, packets: -1 }); continue }
    if (b - a <= 0) out.push({ i, packets: b - a })
  }
  return out
}
