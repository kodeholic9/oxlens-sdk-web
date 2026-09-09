export type Quality = 'excellent' | 'good' | 'poor' | 'lost'

export const STATS_INTERVAL_MS = 5_000
export const EXCELLENT = { lossPct: 2.0, rttMs: 150 } as const
export const GOOD = { lossPct: 5.0, rttMs: 400 } as const

export interface StatsSample {
  readonly lossPct: number
  readonly rttMs: number
}

type Row = Record<string, unknown>
type Report = ReadonlyMap<string, Row>

const RANK: readonly Quality[] = ['excellent', 'good', 'poor', 'lost']

export function grade(sample: StatsSample | null, dead: boolean): Quality {
  if (dead) return 'lost'
  if (sample === null) return 'good'
  if (sample.lossPct < EXCELLENT.lossPct && sample.rttMs < EXCELLENT.rttMs) return 'excellent'
  if (sample.lossPct < GOOD.lossPct && sample.rttMs < GOOD.rttMs) return 'good'
  return 'poor'
}

export function worst(grades: readonly Quality[]): Quality {
  const first = grades[0]
  if (first === undefined) return 'good'
  let out: Quality = first
  for (const q of grades) if (RANK.indexOf(q) > RANK.indexOf(out)) out = q
  return out
}

interface Counters {
  readonly received: number
  readonly lost: number
}

export class StatsMeter {
  private prev: Counters | null = null

  sample(reports: readonly Report[]): StatsSample | null {
    let pairRtt: number | null = null
    let remoteRtt: number | null = null
    let received = 0
    let lost = 0
    let fraction = 0
    let seen = false
    for (const report of reports) {
      for (const row of report.values()) {
        if (row.type === 'candidate-pair') {
          if (row.state !== 'succeeded' || row.nominated === false) continue
          const rtt = num(row.currentRoundTripTime)
          if (rtt === null) continue
          pairRtt = Math.max(pairRtt ?? 0, rtt * 1000)
          seen = true
        } else if (row.type === 'inbound-rtp') {
          received += num(row.packetsReceived) ?? 0
          lost += num(row.packetsLost) ?? 0
          seen = true
        } else if (row.type === 'remote-inbound-rtp') {
          const f = num(row.fractionLost)
          if (f !== null) fraction = Math.max(fraction, f * 100)
          const rtt = num(row.roundTripTime)
          if (rtt !== null) remoteRtt = Math.max(remoteRtt ?? 0, rtt * 1000)
          seen = true
        }
      }
    }
    if (!seen) return null
    const base = this.prev ?? { received: 0, lost: 0 }
    this.prev = { received, lost }
    const dReceived = Math.max(0, received - base.received)
    const dLost = Math.max(0, lost - base.lost)
    const inbound = dReceived + dLost === 0 ? 0 : (dLost / (dReceived + dLost)) * 100
    return { lossPct: Math.max(inbound, fraction), rttMs: pairRtt ?? remoteRtt ?? 0 }
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
