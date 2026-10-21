// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE domain/store · 연:TRK.type.TrackEntry 세 층 · 연:SUB.type.MlineTable · 연:ROOM.type.MemberInfo · SDK:RULE-ROOM-PERMISSION-BITS · model: claude-opus-5-5
import type { MemberInfo, Permission as WirePermission, TrackEntry, MlineTable, MlineEntry, MediaCodecs } from '../internal/wire/ws.js'

export type ParticipantType = 'user' | 'recorder' | 'bot'

export interface Permission {
  readonly publishAudio: boolean
  readonly publishVideo: boolean
  readonly publishScreen: boolean
  readonly floorRequest: boolean
}

export const ALL_TRUE: Permission = { publishAudio: true, publishVideo: true, publishScreen: true, floorRequest: true }

export interface Participant {
  readonly userId: string
  readonly role: number
  readonly mode: 'listen' | 'talk'
  readonly participantType: ParticipantType
  readonly metadata?: unknown
  readonly permission?: Permission
}

/** 기본값은 안 싣는다 — 없으면 넷 다 true(연:ROOM.type.MemberInfo) */
export function permissionOf(p: WirePermission | undefined): Permission {
  if (!p) return ALL_TRUE
  return { publishAudio: p.publish_audio, publishVideo: p.publish_video, publishScreen: p.publish_screen, floorRequest: p.floor_request }
}

const TYPES: readonly ParticipantType[] = ['user', 'recorder', 'bot']

export function participantOf(m: MemberInfo): Participant {
  const p: { userId: string; role: number; mode: 'listen' | 'talk'; participantType: ParticipantType; metadata?: unknown; permission?: Permission } = {
    userId: m.user_id,
    role: m.role ?? 255,
    mode: m.select ? 'talk' : 'listen',
    participantType: TYPES[m.participant_type] ?? 'user',
  }
  if (m.metadata !== undefined) p.metadata = m.metadata
  if (m.permission) p.permission = permissionOf(m.permission)
  return p
}

/** 방 보관본 — 명단 · 내 권한 · 트랙 층(보기용) · 방 미디어 코덱 */
export class RoomStore {
  readonly members = new Map<string, Participant>()
  readonly tracks = new Map<string, TrackEntry>()
  permission: Permission = ALL_TRUE
  mediaCodecs: MediaCodecs = {}

  resetMembers(list: readonly MemberInfo[], me: MemberInfo | undefined): void {
    this.members.clear()
    for (const m of list) this.members.set(m.user_id, participantOf(m))
    if (me) this.permission = permissionOf(me.permission)
  }

  resetTracks(list: readonly TrackEntry[]): void {
    this.tracks.clear()
    for (const t of list) this.tracks.set(t.track_id, t)
  }

  clear(): void {
    this.members.clear()
    this.tracks.clear()
  }
}

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
