// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE domain/store 배정 층 · 연:SUB.type.MlineTable · SDK:RULE-MOD-AREA-MIRROR domain/link · model: claude-opus-5-5
// ★옛 domain/store.ts 의 배정 층을 그대로 옮겼다 — 표는 연결의 것이다(그 서버의 방 전부가 한 표를 쓴다 · LINK 는 제 차례에 다시 짓는다).
import type { MlineTable, MlineEntry } from '../../internal/wire/ws.js'

/** 배정 층 — 서버마다 배정표 하나(arev 가 보관값보다 클 때만 갈아 끼운다) */
export class TableStore {
  sfuId = ''
  arev = 0
  mlines: MlineEntry[] = []

  /** SDP 재료의 지문 — 줄이 늘거나 줄의 튜플이 바뀌면 달라진다(track_id · room_id 는 재료가 아니다) */
  static materials(rows: readonly MlineEntry[]): number {
    let h = 2166136261
    const sorted = [...rows].sort((a, b) => Number(a.mid) - Number(b.mid))
    for (const r of sorted) {
      const s = `${r.mid}|${r.kind}|${r.pt}|${r.codec}|${r.fmtp ?? ''}|${r.rtx_pt ?? ''}|${r.ssrc}|${r.rtx_ssrc ?? ''}|${r.stream_id};`
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    }
    return (h & 0x7fffffff) | 1
  }

  /** 트랙 → mid 사상 — 연결 상태기의 표 사본 재료 */
  static midOf(t: MlineTable | { mlines: readonly MlineEntry[] }): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of t.mlines) if (r.track_id) out[r.track_id] = Number(r.mid)
    return out
  }

  accept(t: MlineTable): void {
    this.sfuId = t.sfu_id
    this.arev = t.arev
    this.mlines = [...t.mlines]
  }

  rowOf(trackId: string): MlineEntry | undefined {
    return this.mlines.find((r) => r.track_id === trackId)
  }
}
