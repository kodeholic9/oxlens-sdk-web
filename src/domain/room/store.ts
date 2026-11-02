// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-MOD-TABLE domain/store 명단 · 연:ROOM.type.MemberInfo · SDK:RULE-ROOM-PERMISSION-BITS · SDK:RULE-MOD-AREA-MIRROR domain/room · model: claude-opus-5-5
// ★옛 domain/store.ts 의 명단 부분 — 트랙 층은 domain/trk(RoomTracks) · 배정 층은 domain/link(TableStore)로 갈랐다.
import type { MemberInfo, Permission as WirePermission, MediaCodecs, ParticipantEventBody, ParticipantStateBody } from '../../internal/wire/ws.js'

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

export interface PermissionChange {
  readonly userId: string
  readonly permission: Permission
  readonly mine: boolean
}

/** 기본값은 안 싣는다 — 없으면 넷 다 true(연:ROOM.type.MemberInfo) */
export function permissionOf(p: WirePermission | undefined): Permission {
  if (!p) return ALL_TRUE
  return { publishAudio: p.publish_audio, publishVideo: p.publish_video, publishScreen: p.publish_screen, floorRequest: p.floor_request }
}

const TYPES: readonly ParticipantType[] = ['user', 'recorder', 'bot']

/** 남의 비트도 늘 채운다 — 안 실렸으면 넷 다 true(지령대가 「누가 말할 수 있나」를 그리는 재료 · SDK:RULE-ROOM-PERMISSION-BITS) */
export function participantOf(m: MemberInfo): Participant {
  const p: { userId: string; role: number; mode: 'listen' | 'talk'; participantType: ParticipantType; metadata?: unknown; permission: Permission } = {
    userId: m.user_id,
    role: m.role ?? 255,
    mode: m.select ? 'talk' : 'listen',
    participantType: TYPES[m.participant_type] ?? 'user',
    permission: permissionOf(m.permission),
  }
  if (m.metadata !== undefined) p.metadata = m.metadata
  return p
}

/** 방 보관본의 명단 — 명단 · 내 권한(출처는 me) · 방 미디어 코덱 */
export class RoomStore {
  readonly members = new Map<string, Participant>()
  permission: Permission = ALL_TRUE
  mediaCodecs: MediaCodecs = {}

  /** 보관본을 통째로 — 입장 응답 · 재동기 응답 · 이어받기 스냅샷(연:DEV-ROOM-ME-APART 내 권한은 me 에서) */
  reset(list: readonly MemberInfo[], me: MemberInfo | undefined): void {
    this.members.clear()
    for (const m of list) this.members.set(m.user_id, participantOf(m))
    if (me) this.permission = permissionOf(me.permission)
  }

  /** 위가 반영하라고 한 명단 · 권한 통지(효과 app.members) — 바뀐 권한을 돌려준다 */
  apply(op: string, body: Record<string, unknown>, me: string | null): PermissionChange[] {
    if (op === 'PARTICIPANT_EVENT') {
      const b = body as unknown as ParticipantEventBody
      if (b.type === 'joined') {
        const mi: MemberInfo = { user_id: b.user_id, select: b.select ?? false, participant_type: b.participant_type ?? 0, ...(b.role !== undefined ? { role: b.role } : {}), ...(b.metadata !== undefined ? { metadata: b.metadata } : {}), ...(b.permission ? { permission: b.permission } : {}) }
        this.members.set(b.user_id, participantOf(mi))
      } else this.members.delete(b.user_id)
      return []
    }
    if (op === 'PARTICIPANT_STATE') {
      const b = body as unknown as ParticipantStateBody
      const permission = permissionOf(b.permission)
      const mine = b.user_id === me
      if (mine) this.permission = permission
      const cur = this.members.get(b.user_id)
      if (cur) this.members.set(b.user_id, { ...cur, permission })
      return [{ userId: b.user_id, permission, mine }]
    }
    return []
  }
}
