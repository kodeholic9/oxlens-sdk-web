// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE internal/probe · SDK:IMPL-DIAG-PROBE · SDK:RULE-DIAG-STATS · SDK:RULE-DIAG-QUALITY · 연:AUX.op.TASK · model: claude-opus-5-5

type Row = Record<string, unknown> & { type: string; id: string }

function rows(r: RTCStatsReport): Row[] {
  const out: Row[] = []
  r.forEach((v) => out.push(v as Row))
  return out
}

const PICK_OUT = ['ssrc', 'kind', 'mid', 'rid', 'packetsSent', 'bytesSent', 'framesEncoded', 'framesSent', 'frameWidth', 'frameHeight', 'framesPerSecond', 'qualityLimitationReason', 'retransmittedPacketsSent', 'nackCount', 'pliCount', 'targetBitrate', 'active'] as const
const PICK_IN = ['ssrc', 'kind', 'mid', 'packetsReceived', 'packetsLost', 'bytesReceived', 'jitter', 'framesDecoded', 'framesReceived', 'framesDropped', 'frameWidth', 'frameHeight', 'freezeCount', 'pliCount', 'nackCount', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'concealedSamples', 'totalSamplesReceived', 'lastPacketReceivedTimestamp'] as const

function pick(r: Row, keys: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of keys) if (r[k] !== undefined) o[k] = r[k]
  return o
}

/** 자기 쪽 값을 그대로 — 가공 · 평균 금지(SDK:RULE-DIAG-STATS) */
export function outbound(reports: RTCStatsReport[]): Record<string, unknown>[] {
  return reports.flatMap((r) => rows(r).filter((x) => x.type === 'outbound-rtp').map((x) => pick(x, PICK_OUT)))
}

export function inbound(reports: RTCStatsReport[]): Record<string, unknown>[] {
  return reports.flatMap((r) => rows(r).filter((x) => x.type === 'inbound-rtp').map((x) => pick(x, PICK_IN)))
}

export interface NetSample {
  readonly rttMs: number | null
  readonly lost: number
  readonly received: number
  readonly outgoingBps: number | null
}

/** 선택된 후보 쌍 · 수신 손실 — RTT · 추정 대역 */
export function network(reports: RTCStatsReport[]): NetSample {
  let rtt: number | null = null
  let bps: number | null = null
  let lost = 0
  let received = 0
  for (const r of reports) {
    const all = rows(r)
    const tp = all.find((x) => x.type === 'transport')
    const selId = tp ? String(tp['selectedCandidatePairId'] ?? '') : ''
    const pair = all.find((x) => x.type === 'candidate-pair' && (x.id === selId || x['nominated'] === true) && x['state'] === 'succeeded')
    if (pair) {
      const t = pair['currentRoundTripTime']
      if (typeof t === 'number') rtt = Math.max(rtt ?? 0, t * 1000)
      const o = pair['availableOutgoingBitrate']
      if (typeof o === 'number') bps = o
    }
    for (const x of all) {
      if (x.type !== 'inbound-rtp') continue
      lost += typeof x['packetsLost'] === 'number' ? (x['packetsLost'] as number) : 0
      received += typeof x['packetsReceived'] === 'number' ? (x['packetsReceived'] as number) : 0
    }
  }
  return { rttMs: rtt, lost, received, outgoingBps: bps }
}

export type Quality = 'excellent' | 'good' | 'poor' | 'lost'

/** 4단 — 문턱은 정책서 SDK 기본값 quality · 여러 서버면 최악값(SDK:RULE-DIAG-QUALITY) */
export function grade(prev: NetSample | null, cur: NetSample, alive: boolean, th: { excellent: { lossPct: number; rttMs: number }; good: { lossPct: number; rttMs: number } }): Quality {
  if (!alive) return 'lost'
  const dl = prev ? Math.max(0, cur.lost - prev.lost) : 0
  const dr = prev ? Math.max(0, cur.received - prev.received) : 0
  const loss = dr + dl > 0 ? (dl / (dr + dl)) * 100 : 0
  const rtt = cur.rttMs ?? 0
  if (loss < th.excellent.lossPct && rtt < th.excellent.rttMs) return 'excellent'
  if (loss < th.good.lossPct && rtt < th.good.rttMs) return 'good'
  return 'poor'
}

const ORDER: Record<Quality, number> = { excellent: 0, good: 1, poor: 2, lost: 3 }
export function worst(a: Quality, b: Quality): Quality { return ORDER[a] >= ORDER[b] ? a : b }

/** 송신 트랙의 media-source totalAudioEnergy — silence 판정 재료(SDK:IMPL-PUB-API LocalTrack.on('silence')) */
export function audioEnergy(r: RTCStatsReport): number | null {
  for (const x of rows(r)) if (x.type === 'media-source' && x['kind'] === 'audio' && typeof x['totalAudioEnergy'] === 'number') return x['totalAudioEnergy'] as number
  return null
}

/** 첫 디코딩 프레임 판정 재료 — 수신 framesDecoded · totalSamplesReceived */
export function decoded(r: RTCStatsReport): number {
  for (const x of rows(r)) {
    if (x.type !== 'inbound-rtp') continue
    if (typeof x['framesDecoded'] === 'number') return x['framesDecoded'] as number
    if (typeof x['totalSamplesReceived'] === 'number') return x['totalSamplesReceived'] as number
  }
  return 0
}
