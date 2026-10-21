// ★생성 파일 — gen/ws.py 가 IR(ws) 에서 짓는다. 손으로 고치지 않는다. 배선하지 않는다(대조용).
// 원천: context/spec/protocol/areas/*/model.ts

/** op 번호 — 이름은 원천의 op 이름 그대로 */
export const Op = {
  AFFILIATION: 0x0401,
  MESSAGE: 0x0501,
  TASK: 0x0601,
  ICE_RESTART: 0x0305,
  LINK_EVENT: 0x0706,
  MLINE_EVENT: 0x0707,
  PUBLISH_TRACKS: 0x0301,
  TRACK_SET: 0x0304,
  ROOM_JOIN: 0x0201,
  ROOM_LEAVE: 0x0202,
  PARTICIPANT_EVENT: 0x0701,
  PARTICIPANT_STATE: 0x0705,
  ROOM_EVENT: 0x0704,
  BIND: 0x0101,
  RESUME: 0x0102,
  HEARTBEAT: 0x0103,
  LEAVE: 0x0104,
  READY: 0x0302,
  SUBSCRIBE_LAYER: 0x0303,
  TRACK_EVENT: 0x0702,
  TRACK_STATE: 0x0703,
} as const
export type OpName = keyof typeof Op

/** 흐름 제어 우선순위 단(0 복구 · 1 세션·방·미디어 · 2 데이터 · 3 진단) */
export const Lane: Readonly<Record<OpName, 0 | 1 | 2 | 3>> = {
  AFFILIATION: 1,
  MESSAGE: 2,
  TASK: 3,
  ICE_RESTART: 1,
  LINK_EVENT: 1,
  MLINE_EVENT: 1,
  PUBLISH_TRACKS: 1,
  TRACK_SET: 1,
  ROOM_JOIN: 1,
  ROOM_LEAVE: 1,
  PARTICIPANT_EVENT: 1,
  PARTICIPANT_STATE: 1,
  ROOM_EVENT: 1,
  BIND: 1,
  RESUME: 1,
  HEARTBEAT: 1,
  LEAVE: 1,
  READY: 1,
  SUBSCRIBE_LAYER: 1,
  TRACK_EVENT: 1,
  TRACK_STATE: 1,
}

/** 윈도우 밖에서 오가는 op */
export const OutsideWindow: readonly OpName[] = ['HEARTBEAT']
export const OutsideQueue: readonly OpName[] = ['LEAVE']   // 큐를 거치지 않는다 — 곧바로 나가고 남은 큐는 버린다(RULE-SES-LEAVE-PROC)

/** 응답 갈래 — response 응답 있음 · none 응답 없음 · ack 통지(빈 body 의 01) */
export const Reply: Readonly<Record<OpName, 'response' | 'none' | 'ack'>> = {
  AFFILIATION: 'response',
  MESSAGE: 'response',
  TASK: 'response',
  ICE_RESTART: 'response',
  LINK_EVENT: 'ack',
  MLINE_EVENT: 'ack',
  PUBLISH_TRACKS: 'response',
  TRACK_SET: 'response',
  ROOM_JOIN: 'response',
  ROOM_LEAVE: 'response',
  PARTICIPANT_EVENT: 'ack',
  PARTICIPANT_STATE: 'ack',
  ROOM_EVENT: 'ack',
  BIND: 'response',
  RESUME: 'response',
  HEARTBEAT: 'response',
  LEAVE: 'none',
  READY: 'response',
  SUBSCRIBE_LAYER: 'response',
  TRACK_EVENT: 'ack',
  TRACK_STATE: 'ack',
}

/** 오류 코드 — 번호 · 이름 · permanent(null = 답할 것이 없다 · LEAVE 사유) · 폐기 번호는 싣지 않는다 */
export const Code = {
  UNKNOWN_OP: { code: 1001, permanent: true },
  INVALID_PAYLOAD: { code: 1002, permanent: true },
  MISSING_FIELD: { code: 1003, permanent: true },
  VERSION_MISMATCH: { code: 1004, permanent: true },
  CODEC_REQUIRED: { code: 1005, permanent: true },
  CODEC_MISMATCH: { code: 1006, permanent: true },
  FIELD_CONFLICT: { code: 1007, permanent: true },
  PROTOCOL_ERROR: { code: 1008, permanent: true },
  NOT_BOUND: { code: 2001, permanent: false },
  TOKEN_INVALID: { code: 2002, permanent: true },
  TOKEN_EXPIRED: { code: 2003, permanent: false },
  INVALID_API_KEY: { code: 2004, permanent: true },
  CLAIM_NOT_ALLOWED: { code: 2005, permanent: true },
  NOT_AUTHORIZED: { code: 2006, permanent: true },
  SESSION_NOT_FOUND: { code: 2008, permanent: false },
  SESSION_REVOKED: { code: 2009, permanent: null },
  DUPLICATE_SESSION: { code: 2010, permanent: null },
  ROOM_NOT_FOUND: { code: 3001, permanent: false },
  NOT_IN_ROOM: { code: 3002, permanent: false },
  ROOM_NOT_EMPTY: { code: 3004, permanent: false },
  TRACK_NOT_FOUND: { code: 3005, permanent: false },
  TRACK_OP_UNSUPPORTED: { code: 3006, permanent: true },
  SSRC_COLLISION: { code: 3008, permanent: true },
  PRECONDITION_FAILED: { code: 3009, permanent: false },
  PEER_NOT_FOUND: { code: 3010, permanent: false },
  NOT_PUB_ROOM: { code: 3011, permanent: false },
  ROOM_FULL: { code: 4001, permanent: false },
  TRACK_LIMIT: { code: 4002, permanent: false },
  QUOTA_EXCEEDED: { code: 4003, permanent: false },
  LISTEN_LIMIT: { code: 4004, permanent: false },
  MID_LIMIT: { code: 4005, permanent: false },
  FLOW_TIMEOUT: { code: 4006, permanent: null },
  FLOW_OVERFLOW: { code: 4007, permanent: null },
  HEARTBEAT_TIMEOUT: { code: 4008, permanent: null },
  OVERLOADED: { code: 4009, permanent: false },
  SFU_UNAVAILABLE: { code: 5001, permanent: false },
  SFU_ERROR: { code: 5002, permanent: false },
  INTERNAL_ERROR: { code: 5003, permanent: false },
  SERVER_SHUTDOWN: { code: 5004, permanent: null },
} as const
export const RetiredCodes: readonly number[] = [2007, 3003, 3007]

/** HTTP 접속점 — 메서드 · {base} 아래 경로 · 성공 상태 */
export const Endpoint = {
  LIST_ROOMS: { method: 'GET', path: '/rooms', status: 200 },
  CREATE_ROOM: { method: 'POST', path: '/rooms', status: 201 },
  GET_ROOM: { method: 'GET', path: '/rooms/{room_id}', status: 200 },
  TOKEN: { method: 'POST', path: '/auth/token', status: 200 },
} as const

/** AFF.type.Affiliation — 어느 방을 구독하고 어디로 발행하나 (§[AFF.type.Affiliation]) */
export interface Affiliation {
  readonly sub_rooms: string[]
  readonly pub_room: string | null
}

/** AUX.type.ProbeResult — `type:"probe"` 의 `result` (§[AUX.op.TASK]) */
export interface ProbeResult {
  readonly error?: string
  readonly pub_tracks?: unknown[]
  readonly sub_tracks?: unknown[]
  readonly env?: unknown
  readonly devices?: unknown[]
  readonly permissions?: unknown
  readonly state?: unknown
  readonly network?: unknown
}

/** ERR.type.Failure — 실패 응답 body (§[ERR.type.Failure]) */
export interface Failure {
  readonly code: number
  readonly name: string
  readonly permanent: boolean
  readonly message?: string
  readonly details?: unknown
}

/** LINK.type.ServerConfig — 미디어를 붙이는 재료 (§[LINK.type.ServerConfig]) */
export interface ServerConfig {
  readonly sfu_id: string
  readonly pc_mode: "1pc" | "2pc"
  readonly ice: { readonly ip: string; readonly port: number; readonly publish_ufrag: string; readonly publish_pwd: string; readonly subscribe_ufrag: string; readonly subscribe_pwd: string; readonly tcp_port?: number }
  readonly dtls: { readonly fingerprint: string; readonly setup: "passive" }
  readonly codecs: CodecPolicy[]
  readonly codecs_sub?: CodecPolicy[]
  readonly extmap: ExtMap[]
  readonly max_bitrate_bps: number
}

/** LINK.type.CodecPolicy — 코덱 정책 (§[LINK.type.ServerConfig]) */
export interface CodecPolicy {
  readonly kind: "audio" | "video"
  readonly name: string
  readonly rtcp_fb: string[]
}

/** LINK.type.ExtMap — 확장 헤더 번호 (§[LINK.type.ServerConfig]) */
export interface ExtMap {
  readonly id: number
  readonly uri: string
}

/** PUB.type.Publication — 발행 층 (§[SES.op]) */
export interface Publication {
  readonly track_id: string
  readonly room_id: string
  readonly kind: "audio" | "video"
  readonly duplex: "full" | "half"
  readonly codec: string | null
  readonly fmtp?: string
  readonly simulcast: boolean
}

/** PUB.type.PublishTrack — `tracks[]` 원소 (§[RULE-PUB-REMOVE-FORM]) */
export interface PublishTrack {
  readonly kind: "audio" | "video"
  readonly ssrc: number
  readonly mid: string
  readonly codec?: string
  readonly fmtp?: string
  readonly pt: number
  readonly rtx_pt?: number
  readonly rtx_ssrc?: number
  readonly source?: "camera" | "screen"
  readonly duplex?: "full" | "half"
  readonly simulcast?: boolean
}

/** ROOM.type.MediaCodecs — 그 방의 미디어 코덱 (§[RULE-ROOM-MEDIA-CODECS]) */
export interface MediaCodecs {
  readonly audio?: string
  readonly video?: string
}

/** ROOM.type.RoomSummary — 방 목록의 한 줄 (§[ROOM.http.LIST_ROOMS]) */
export interface RoomSummary {
  readonly room_id: string
  readonly name: string
  readonly capacity: number
  readonly user_count: number
  readonly created_at: number
  readonly rec: boolean
}

/** ROOM.type.MemberInfo — `MemberInfo` (§[ROOM.type.MemberInfo]) */
export interface MemberInfo {
  readonly user_id: string
  readonly role?: number
  readonly select: boolean
  readonly participant_type: 0 | 1 | 2
  readonly metadata?: unknown
  readonly permission?: Permission
}

/** ROOM.type.Permission — 권한 비트 (§[ROOM.type.MemberInfo]) */
export interface Permission {
  readonly publish_audio: boolean
  readonly publish_video: boolean
  readonly publish_screen: boolean
  readonly floor_request: boolean
}

/** ROOM.type.RoomSnapshot — 방 스냅샷 (§[SES.op]) */
export interface RoomSnapshot {
  readonly participants: MemberInfo[]
  readonly me: MemberInfo
  readonly tracks: TrackEntry[]
  readonly version: Version
}

/** ROOM.type.Version — 무엇이 최신인가 (§[ROOM.type.Version]) */
export interface Version {
  readonly epoch: string
  readonly seq: number
}

/** SUB.type.MlineEntry — 배정표의 줄 — 구독 m-line 하나 (§[SUB.type.MlineTable]) */
export interface MlineEntry {
  readonly mid: string
  readonly kind: "audio" | "video"
  readonly pt: number
  readonly codec: string
  readonly fmtp?: string
  readonly rtx_pt?: number
  readonly track_id?: string
  readonly room_id?: string
  readonly ssrc: number
  readonly rtx_ssrc?: number
  readonly stream_id: string
}

/** SUB.type.MlineTable — 구독 m-line 배정표 (§[SUB.type.MlineTable]) */
export interface MlineTable {
  readonly sfu_id: string
  readonly arev: number
  readonly mlines: MlineEntry[]
}

/** TRK.type.TrackEntry — 받을 트랙 하나 (§[TRK.type.TrackEntry]) */
export interface TrackEntry {
  readonly type: "individual" | "slot"
  readonly room_id: string
  readonly track_id: string
  readonly kind: "audio" | "video"
  readonly codec?: string
  readonly fmtp?: string
  readonly user_id?: string
  readonly source?: "camera" | "screen"
  readonly active?: boolean
  readonly muted?: boolean
  readonly simulcast?: boolean
  readonly scalability?: string
}

/** ROOM.http.LIST_ROOMS.res — GET /rooms 방 목록 */
export interface ListRoomsRes {
  readonly rooms: RoomSummary[]
  readonly total: number
}

/** ROOM.http.CREATE_ROOM.req — POST /rooms 방 생성 */
export interface CreateRoomReq {
  readonly room_id?: string
  readonly name: string
  readonly capacity?: number
  readonly unused_ttl_secs?: number
  readonly departure_ttl_secs?: number
  readonly media_codecs?: MediaCodecs
}

/** ROOM.http.CREATE_ROOM.res — POST /rooms 방 생성 */
export interface CreateRoomRes {
  readonly room_id: string
  readonly name: string
  readonly capacity: number
  readonly created_at: number
  readonly media_codecs: MediaCodecs
}

/** ROOM.http.GET_ROOM.params — GET /rooms/{room_id} 방 상세 */
export interface GetRoomParams {
  readonly room_id: string
}

/** ROOM.http.GET_ROOM.query — GET /rooms/{room_id} 방 상세 */
export interface GetRoomQuery {
  readonly tracks?: 0 | 1
}

/** ROOM.http.GET_ROOM.res — GET /rooms/{room_id} 방 상세 */
export interface GetRoomRes {
  readonly room_id: string
  readonly name: string
  readonly capacity: number
  readonly user_count: number
  readonly participants: MemberInfo[]
  readonly me?: MemberInfo
  readonly created_at: number
  readonly media_codecs: MediaCodecs
  readonly version: Version
  readonly tracks?: TrackEntry[]
}

/** SES.http.TOKEN.req — POST /auth/token 토큰 발급 */
export interface TokenReq {
  readonly api_key: string
  readonly api_secret: string
  readonly user_id: string
  readonly participant_type?: 0 | 1 | 2
  readonly hidden?: boolean
  readonly metadata?: unknown
  readonly permission?: Permission
}

/** SES.http.TOKEN.res — POST /auth/token 토큰 발급 */
export interface TokenRes {
  readonly token: string
  readonly expires_in: number
}

/** AFF.op.AFFILIATION.req — 0x0401 어디로 발행할까 */
export interface AffiliationReq {
  readonly pub_select?: string
  readonly pub_deselect?: string
  readonly change_id?: string
}

/** AFF.op.AFFILIATION.res — 0x0401 어디로 발행할까 */
export interface AffiliationRes {
  readonly sub_rooms: string[]
  readonly pub_room: string | null
  readonly cause: "user"
  readonly change_id?: string
}

/** AUX.op.MESSAGE.req — 0x0501 문자 */
export interface MessageReq {
  readonly room_id: string
  readonly content: string
}

/** AUX.op.MESSAGE.res — 0x0501 문자 */
export interface MessageRes {
  readonly msg_id: string
}

/** AUX.op.MESSAGE.body — 0x0501 문자 */
export interface MessageBody {
  readonly room_id: string
  readonly user_id: string
  readonly content: string
}

/** AUX.op.TASK.req — 0x0601 시켜서 하고 보고한다 */
export type TaskReq =
  | { readonly phase: "request"; readonly req_id: number; readonly type: "probe"; readonly params: unknown }
  | { readonly phase: "report"; readonly req_id: number; readonly type: "probe"; readonly result: ProbeResult }

/** AUX.op.TASK.res — 0x0601 시켜서 하고 보고한다 */
export type TaskRes = Record<string, never>

/** LINK.op.ICE_RESTART.req — 0x0305 그 서버 연결을 다시 뚫는다 */
export interface IceRestartReq {
  readonly sfu_id: string
}

/** LINK.op.ICE_RESTART.res — 0x0305 그 서버 연결을 다시 뚫는다 */
export interface IceRestartRes {
  readonly publish: { readonly ufrag: string; readonly pwd: string }
  readonly subscribe?: { readonly ufrag: string; readonly pwd: string }
}

/** LINK.op.LINK_EVENT.body — 0x0706 그 서버 연결이 흔들린다 */
export interface LinkEventBody {
  readonly type: "suspect"
  readonly sfu_id: string
  readonly ufrag: string
}

/** LINK.op.MLINE_EVENT.body — 0x0707 구독 m-line 배정표가 **바뀌었다** */
export interface MlineEventBody {
  readonly table: MlineTable
}

/** PUB.op.PUBLISH_TRACKS.req — 0x0301 보낼 트랙 발행 */
export type PublishTracksReq =
  | { readonly action?: "add" | "remove"; readonly room_id: string; readonly tracks: PublishTrack[]; readonly twcc_extmap_id?: number; readonly rid_extmap_id?: number; readonly repair_rid_extmap_id?: number; readonly mid_extmap_id?: number; readonly audio_level_extmap_id?: number }
  | { readonly action: "remove"; readonly room_id: string; readonly track_ids: string[] }

/** PUB.op.PUBLISH_TRACKS.res — 0x0301 보낼 트랙 발행 */
export type PublishTracksRes =
  | { readonly action: "add"; readonly tracks: { readonly mid: string; readonly track_id: string }[] }
  | { readonly action: "remove" }

/** PUB.op.TRACK_SET.req — 0x0304 트랙 상태 바꾸기 */
export interface TrackSetReq {
  readonly room_id: string
  readonly track_id?: string
  readonly ssrc?: number
  readonly muted?: boolean
  readonly duplex?: "full" | "half"
}

/** PUB.op.TRACK_SET.res — 0x0304 트랙 상태 바꾸기 */
export interface TrackSetRes {
  readonly ssrc: number
  readonly muted?: boolean
  readonly duplex?: "full" | "half"
  readonly noop?: boolean
}

/** ROOM.op.ROOM_JOIN.req — 0x0201 방 입장 */
export interface RoomJoinReq {
  readonly room_id: string
  readonly role?: number
  readonly select?: boolean
  readonly extmap?: ExtMap[]
  readonly codecs?: ({ readonly kind: "audio" | "video"; readonly pt: number; readonly name: string; readonly fmtp?: string; readonly rtx_pt?: number })[]
}

/** ROOM.op.ROOM_JOIN.res — 0x0201 방 입장 */
export interface RoomJoinRes {
  readonly room_id: string
  readonly participants: MemberInfo[]
  readonly me: MemberInfo
  readonly affiliation: Affiliation
  readonly server_config: ServerConfig
  readonly tracks: TrackEntry[]
  readonly version: Version
  readonly media_codecs: MediaCodecs
  readonly mline_table: MlineTable
}

/** ROOM.op.ROOM_LEAVE.req — 0x0202 방 퇴장 */
export interface RoomLeaveReq {
  readonly room_id: string
}

/** ROOM.op.ROOM_LEAVE.res — 0x0202 방 퇴장 */
export interface RoomLeaveRes {
  readonly room_id: string
  readonly affiliation: Affiliation
}

/** ROOM.op.PARTICIPANT_EVENT.body — 0x0701 누가 들고났다 */
export interface ParticipantEventBody {
  readonly type: "joined" | "left"
  readonly room_id: string
  readonly user_id: string
  readonly role?: number
  readonly select?: boolean
  readonly participant_type?: 0 | 1 | 2
  readonly metadata?: unknown
  readonly permission?: Permission
  readonly version: Version
}

/** ROOM.op.PARTICIPANT_STATE.body — 0x0705 참가자 **속성**이 바뀌었다 */
export interface ParticipantStateBody {
  readonly type: "permission"
  readonly user_id: string
  readonly room_id: string
  readonly version?: Version
  readonly permission: Permission
}

/** ROOM.op.ROOM_EVENT.body — 0x0704 나와 방의 관계·정합성 */
export type RoomEventBody =
  | { readonly type: "affiliation"; readonly room_id: string; readonly affiliation: Affiliation; readonly cause: "kick" | "room_closed" }
  | { readonly type: "sync_required"; readonly room_id: string; readonly reason: string }

/** SES.op.BIND.req — 0x0101 접속한다 */
export interface BindReq {
  readonly token: string
  readonly session_id?: string
  readonly client_ver?: number
  readonly pc_mode?: "1pc" | "2pc"
}

/** SES.op.BIND.res — 0x0101 접속한다 */
export interface BindRes {
  readonly user_id: string
  readonly server_ver: number
  readonly heartbeat_interval: number
  readonly session_id: string
  readonly resume_window_ms: number
  readonly pc_mode: "1pc" | "2pc"
}

/** SES.op.RESUME.req — 0x0102 시그널만 끊겼다 다시 붙었다 */
export type ResumeReq = Record<string, never>

/** SES.op.RESUME.res — 0x0102 시그널만 끊겼다 다시 붙었다 */
export interface ResumeRes {
  readonly snapshot: Record<string, RoomSnapshot>
  readonly publications: Publication[]
  readonly mline_tables: MlineTable[]
}

/** SES.op.HEARTBEAT.req — 0x0103 하트비트 */
export type HeartbeatReq = Record<string, never>

/** SES.op.HEARTBEAT.res — 0x0103 하트비트 */
export type HeartbeatRes = Record<string, never>

/** SES.op.LEAVE.req — 0x0104 끝낸다 */
export type LeaveReq = Record<string, never>

/** SES.op.LEAVE.body — 0x0104 끝낸다 */
export interface LeaveBody {
  readonly code: number
  readonly name: string
  readonly message?: string
  readonly details?: unknown
}

/** SUB.op.READY.req — 0x0302 준비 됐다 */
export interface ReadyReq {
  readonly room_id: string
  readonly arev: number
}

/** SUB.op.READY.res — 0x0302 준비 됐다 */
export type ReadyRes = Record<string, never>

/** SUB.op.SUBSCRIBE_LAYER.req — 0x0303 받을 레이어 고르기 */
export interface SubscribeLayerReq {
  readonly room_id: string
  readonly targets: { readonly track_id: string; readonly spatial?: number; readonly temporal?: number; readonly paused?: boolean; readonly priority?: number }[]
}

/** SUB.op.SUBSCRIBE_LAYER.res — 0x0303 받을 레이어 고르기 */
export type SubscribeLayerRes = Record<string, never>

/** TRK.op.TRACK_EVENT.body — 0x0702 받을 트랙이 **생기거나 없어졌다** */
export interface TrackEventBody {
  readonly action: "add" | "remove"
  readonly room_id: string
  readonly tracks: TrackEntry[]
  readonly version: Version
}

/** TRK.op.TRACK_STATE.body — 0x0703 트랙 **속성**이 바뀌었다 */
export interface TrackStateBody {
  readonly type: "muted"
  readonly user_id: string
  readonly track_id: string
  readonly kind: "audio" | "video"
  readonly room_id: string
  readonly version: Version
  readonly muted: boolean
}
