// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/room/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 1812dea47fd2095f · 영역 ROOM 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type RoomSt = 'NONE' | 'JOINING' | 'JOINED' | 'LEAVING'
export type PcMode = '1pc' | '2pc'
export type Part = 'req' | 'res' | 'fail' | 'body'
export type RoomEv = 'affiliation' | 'sync_required'
export type Fx = 'app.bug' | 'app.join_failed' | 'app.joined' | 'app.left' | 'app.members' | 'app.room_gone' | 'http.abandon' | 'ws.abandon'
export type SeamFx = 'aff.leave' | 'floor.leave' | 'link.epoch_changed' | 'link.room_left' | 'link.table' | 'pub.room_gone' | 'ready.tracks' | 'room.sub_rooms' | 'sdp.rebuild' | 'store.drop' | 'sub.drop' | 'trk.snapshot'
export type TimerName = never

/** 클라 상태 — 원천 ROOM K */
export interface St {
  /** ★그 방이 붙은 미디어 서버 — 입장 응답 server_config.sfu_id(0 = 아직) · 같은 방의 SUB · TRK · FLR 은 사본 없이 이것으로 서버를 안다(202610/20261013a 축 B) */
  readonly sfu: number
  /** 방 상태(§[RULE-ROOM-STATES]) */
  readonly rs: RoomSt
  /** 보관본의 version.seq — 이 번호의 내용을 들고 있다(§[RULE-ROOM-VERSION-CLIENT-RULES]) */
  readonly cseq: number
  /** 보관본의 version.epoch — 이 기동의 내용이다(0 = 보관본 없음 · 규칙 1) */
  readonly cepoch: number
  /** 그 방 재동기(GET /rooms)가 진행 중이다(§[RULE-ROOM-TIMERS-MEDIA] 재동기 in-flight) */
  readonly rsync: boolean
  /** 재동기 중에 버린 델타의 가장 큰 seq — 응답이 이보다 낮으면 따라잡지 못한 것이다(DEV-ROOM-INFLIGHT-AHEAD) */
  readonly ahead: number
  /** 4009 를 받아 retry_after_ms 를 기다린다(§[ROOM.C.JOINING] 6) */
  readonly retry: boolean
  /** 입장 요청이 나가 있는 동안 앱이 나가려 했다 — 응답을 기다렸다가 성공이면 ROOM_LEAVE 를 보낸다(DEV-ROOM-LEAVE-WHILE-JOINING) */
  readonly quit: boolean
  /** 재구축이 다시 들어갈 방이다 — 내릴 때 들어가 있었거나 들어가려던 방(DEV-ROOM-REJOIN-LIST · 원칙 ①) */
  readonly rejoin: boolean
}
export const initial = (): St => ({ sfu: 0, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false, quit: false, rejoin: false })

/** 이 상태기가 내는 것 */
export type Tx =
  | { readonly ws: 'ROOM_JOIN'; readonly part: 'req' }
  | { readonly ws: 'ROOM_LEAVE'; readonly part: 'req' }
  | { readonly ws: 'GET_ROOM'; readonly part: 'req'; readonly tracks: number }
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'aff.leave': { to: 'AFF', react: ['CLeft'] },
  'floor.leave': { to: 'FLR', react: ['CLeave'] },
  'link.epoch_changed': { to: 'LINK', react: ['CEpochChanged'] },
  'link.room_left': { to: 'LINK', react: ['CRoomLeft'] },
  'link.table': { to: 'LINK', react: ['CTableCarried'] },
  'pub.room_gone': { to: 'PUB', react: ['CRoomGone'] },
  'ready.tracks': { to: 'SUB', react: ['CReady'] },
  'room.sub_rooms': { to: 'ROOM', react: ['CSubRooms'] },
  'sdp.rebuild': { to: 'LINK', react: ['CRenego'] },
  'store.drop': { to: 'TRK', react: ['CStoreDrop'] },
  'sub.drop': { to: 'SUB', react: ['CDropRoom'] },
  'trk.snapshot': { to: 'TRK', react: ['CSnapshot'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {
  subRooms: ['ROOM:room.sub_rooms'],
  downAll: ['SES:rooms.down_all', 'LINK:store.drop_server'],
  closeAll: ['SES:rooms.close_all'],
  rejoin: ['SES:rooms.rejoin', 'LINK:rooms.rejoin_server'],
  resumeSnap: ['SES:rooms.snapshot'],
} as const
/** 읽는 것 — 판단이 다른 영역 상태를 읽는 인자(부르는 쪽이 넣는다 · 무엇을 읽는지는 위가 정한다) */
export const READS = {
  'joinRes.pcm': ['SES.pcm'],
} as const

/** 원장 — 타이머(ms) · 횟수 */
export const TIMER_MS: Partial<Record<TimerName, number>> = {  }
export const COUNTS = { BundleCap: 128, ClientMlines: 32, Sub1pc: 96, Sub2pc: 128, DispatchCh: 20, SlotBudget: 40, FullAudio: 25, FullVideo: 25, MaxRooms: 100 } as const

const done = (prev: St, s: St, label: string, out: Tx[], fx: Fx[], seams: Seam[], start: TimerName[]): Step => {
  for (const t of armed(s)) if (!armed(prev).includes(t) && !start.includes(t)) start.push(t)
  return { s, label, out, fx, seams, start }
}

/** 지금 돌아야 하는 타이머 — 원천 timer(…).armed */
export function armed(s: St): TimerName[] {
  const on: TimerName[] = []
  return on
}

/** 앱이 방에 들어가려 한다(§[ROOM.C.NONE.join]) (앱: 앱이 방에 들어가려 한다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function join(s: St): Step | null {
  if (!(s.rs === 'NONE')) return null
  return done(s, { ...s, rs: 'JOINING', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false, quit: false }, 'ROOM.C.NONE.join', [{ ws: 'ROOM_JOIN', part: 'req' }], [], [], [])
}

/** ROOM_JOIN 응답을 받았다(§[ROOM.C.JOINING.join_ok] · §[ROOM.C.JOINING]) (받음: ROOM_JOIN) — 받는 상태 밖이면 null(사건이 없던 것) · 읽는 것: pcm = SES.pcm */
export function joinRes(s: St, m: { readonly code: number; readonly part: Part; readonly server_config: { readonly pc_mode: PcMode; readonly sfu_id: number }; readonly version: { readonly epoch: number; readonly seq: number } }, pcm: PcMode): Step | null {
  if (!(s.rs === 'JOINING')) return null
  if (m.part === 'res' && s.quit) {
    return done(s, { ...s, rs: 'LEAVING', quit: false }, 'ROOM.C.JOINING.join_ok_quit', [{ ws: 'ROOM_LEAVE', part: 'req' }], [], [], [])
  }
  if (m.part !== 'res' && s.quit && m.code >= 2000) {
    return done(s, { ...s, rs: 'NONE', quit: false, retry: false }, 'ROOM.C.JOINING.join_fail_quit', [], ['app.left'], [], [])
  }
  if (m.part === 'res' && m.server_config.pc_mode !== pcm) {
    return done(s, { ...s, rs: 'LEAVING' }, 'ROOM.C.JOINING.join_pc_mismatch', [{ ws: 'ROOM_LEAVE', part: 'req' }], ['app.join_failed'], [], [])
  }
  if (m.part === 'res') {
    return done(s, { ...s, rs: 'JOINED', cseq: m.version.seq, cepoch: m.version.epoch, sfu: m.server_config.sfu_id }, 'ROOM.C.JOINING.join_ok', [], ['app.joined'], [{ fx: 'trk.snapshot', to: 'TRK', at: 'self' }, { fx: 'link.table', to: 'LINK', at: 'sameServer' }, { fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }, { fx: 'ready.tracks', to: 'SUB', at: 'self' }, { fx: 'room.sub_rooms', to: 'ROOM', at: 'sameServer' }], [])
  }
  if (m.code === 4009) {
    return done(s, { ...s, retry: true }, 'ROOM.C.JOINING.join_4009', [], [], [], [])
  }
  if (m.code < 2000) {
    return done(s, { ...s, rs: 'NONE' }, 'ROOM.C.JOINING.join_1xxx', [], ['app.bug'], [], [])
  }
  return done(s, { ...s, rs: 'NONE' }, 'ROOM.C.JOINING.join_fail', [], ['app.join_failed'], [], [])
}

/** 4009 의 retry_after_ms 하한이 지났다(서버가 준 값 — 원장 시한이 아니다) (바깥: 4009 의 retry_after_ms 하한이 지났다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function retryDue(s: St): Step | null {
  if (!(s.rs === 'JOINING' && s.retry)) return null
  return done(s, { ...s, retry: false }, 'ROOM.C.JOINING.retry_join', [{ ws: 'ROOM_JOIN', part: 'req' }], [], [], [])
}

/** 앱이 나가려 한다(§[ROOM.C.JOINED.leave]) · JOINING 이면 4009 대기를 멈춘다 (앱: 앱이 방을 나가려 한다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function leave(s: St): Step | null {
  if (!(s.rs === 'JOINED' || (s.rs === 'JOINING' && !s.quit))) return null
  if (s.rs === 'JOINING' && s.retry) {
    return done(s, { ...s, rs: 'NONE', retry: false }, 'ROOM.C.JOINING.app_leave', [], [], [], [])
  }
  if (s.rs === 'JOINING') {
    return done(s, { ...s, quit: true }, 'ROOM.C.JOINING.app_leave_wait', [], [], [], [])
  }
  return done(s, { ...s, rs: 'LEAVING', rsync: false, ahead: 0 }, 'ROOM.C.JOINED.leave', [{ ws: 'ROOM_LEAVE', part: 'req' }], ['http.abandon'], [{ fx: 'floor.leave', to: 'FLR', at: 'self' }, { fx: 'aff.leave', to: 'AFF', at: 'self' }, { fx: 'sub.drop', to: 'SUB', at: 'self' }, { fx: 'pub.room_gone', to: 'PUB', at: 'sameRoom' }], [])
}

/** ROOM_LEAVE 응답을 받았다(§[RULE-ROOM-LEAVE-RES]) (받음: ROOM_LEAVE) */
export function leaveRes(s: St, m: { readonly part: Part }): Step {
  if (s.rs !== 'LEAVING') {
    return done(s, s, 'ROOM.C.any.leave_res_stale', [], [], [], [])
  }
  if (m.part === 'res') {
    return done(s, { ...s, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false }, 'ROOM.C.LEAVING.leave_ok', [], ['app.left'], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }, { fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'link.room_left', to: 'LINK', at: 'sameServer' }], [])
  }
  return done(s, { ...s, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false }, 'ROOM.C.LEAVING.leave_fail', [], ['app.left'], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }, { fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'link.room_left', to: 'LINK', at: 'sameServer' }], [])
}

/** version 을 실은 통지를 받았다 — ACK · 판정(§[RULE-ROOM-VERSION-CLIENT-RULES] 규칙 3~5) · 반영(§[RULE-ROOM-NOTE-ORDER]) (받음: PARTICIPANT_EVENT · PARTICIPANT_STATE · TRACK_EVENT · TRACK_STATE) */
export function delta(s: St, m: { readonly version: { readonly epoch: number; readonly seq: number } }, bare: boolean): Step {
  if (s.rs !== 'JOINED') {
    return done(s, s, 'ROOM.C.any.delta_not_joined', [], [], [], [])
  }
  if (bare) {
    return done(s, s, 'ROOM.C.JOINED.delta_bare', [], ['app.members'], [], [])
  }
  if (m.version.epoch !== s.cepoch) {
    return done(s, s, 'ROOM.C.JOINED.delta_epoch', [], [], [{ fx: 'link.epoch_changed', to: 'LINK', at: 'sameServer' }], [])
  }
  if (m.version.seq <= s.cseq) {
    return done(s, s, 'ROOM.C.JOINED.delta_old', [], [], [], [])
  }
  if (m.version.seq === s.cseq + 1) {
    return done(s, { ...s, cseq: m.version.seq }, 'ROOM.C.JOINED.delta_apply', [], ['app.members'], [], [])
  }
  if (s.rsync) {
    return done(s, { ...s, ahead: m.version.seq > s.ahead ? m.version.seq : s.ahead }, 'ROOM.C.JOINED.delta_gap_inflight', [], [], [], [])
  }
  return done(s, { ...s, rsync: true }, 'ROOM.C.JOINED.delta_gap', [{ ws: 'GET_ROOM', part: 'req', tracks: 1 }], [], [], [])
}

/** ROOM_EVENT 를 받았다 — version 없음 · 견주지 않는다(§[RULE-ROOM-NOTE-ORDER] · §[RULE-ROOM-VERSION-CLIENT-RULES] 종결) (받음: ROOM_EVENT) */
export function roomEvent(s: St, m: { readonly type: RoomEv }): Step {
  if (s.rs !== 'JOINED') {
    return done(s, s, 'ROOM.C.any.room_event_not_joined', [], [], [], [])
  }
  if (m.type === 'affiliation') {
    return done(s, { ...s, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false, ahead: 0 }, 'ROOM.C.JOINED.kicked', [], ['http.abandon', 'app.room_gone'], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }, { fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'floor.leave', to: 'FLR', at: 'self' }, { fx: 'aff.leave', to: 'AFF', at: 'self' }, { fx: 'sub.drop', to: 'SUB', at: 'self' }, { fx: 'link.room_left', to: 'LINK', at: 'sameServer' }, { fx: 'pub.room_gone', to: 'PUB', at: 'sameRoom' }], [])
  }
  if (s.rsync) {
    return done(s, s, 'ROOM.C.JOINED.sync_required_inflight', [], [], [], [])
  }
  return done(s, { ...s, rsync: true }, 'ROOM.C.JOINED.sync_required', [{ ws: 'GET_ROOM', part: 'req', tracks: 1 }], [], [], [])
}

/** GET /rooms/{room_id}?tracks=1 응답을 받았다(§[ROOM.C.JOINED] 3 · §[ROOM.http.GET_ROOM] · §[RULE-ROOM-VERSION-CLIENT-RULES] 규칙 2) (받음: GET_ROOM) */
export function snapshot(s: St, m: { readonly version: { readonly epoch: number; readonly seq: number } }): Step {
  if (s.rs !== 'JOINED' || !s.rsync) {
    return done(s, s, 'ROOM.C.any.snapshot_stale', [], [], [], [])
  }
  if (m.version.epoch !== s.cepoch) {
    return done(s, { ...s, rsync: false, ahead: 0 }, 'ROOM.C.JOINED.snapshot_epoch', [], [], [{ fx: 'link.epoch_changed', to: 'LINK', at: 'sameServer' }], [])
  }
  if (m.version.seq < s.ahead) {
    return done(s, { ...s, cseq: m.version.seq > s.cseq ? m.version.seq : s.cseq, ahead: 0 }, 'ROOM.C.JOINED.snapshot_short', [{ ws: 'GET_ROOM', part: 'req', tracks: 1 }], [], [], [])
  }
  if (m.version.seq < s.cseq) {
    return done(s, { ...s, rsync: false, ahead: 0 }, 'ROOM.C.JOINED.snapshot_behind', [], [], [], [])
  }
  return done(s, { ...s, cseq: m.version.seq, rsync: false, ahead: 0 }, 'ROOM.C.JOINED.snapshot', [], [], [{ fx: 'trk.snapshot', to: 'TRK', at: 'self' }, { fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }, { fx: 'ready.tracks', to: 'SUB', at: 'self' }], [])
}

/** 같은 서버 방의 입장 응답이 왔다 — 응답 affiliation.sub_rooms 가 그 서버의 진실이다(RULE-ROOM-JOIN-PROC) · listed = 이 방이 그 목록에 있다 */
export function subRooms(s: St, listed: boolean): Step {
  if (s.rs === 'JOINED' && !listed) {
    return done(s, { ...s, rs: 'JOINING', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false }, 'ROOM.C.JOINED.not_in_sub_rooms', [{ ws: 'ROOM_JOIN', part: 'req' }], ['http.abandon'], [{ fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'floor.leave', to: 'FLR', at: 'self' }, { fx: 'aff.leave', to: 'AFF', at: 'self' }, { fx: 'sub.drop', to: 'SUB', at: 'self' }, { fx: 'pub.room_gone', to: 'PUB', at: 'sameRoom' }], [])
  }
  return done(s, s, 'ROOM.C.any.sub_rooms_ok', [], [], [], [])
}

/** 재구축으로 방을 내린다 — 세션 전체면 전부 · 그 서버면 그 서버 방(§[RULE-SES-REBUILD] 2 · RULE-LINK-RECOVERY-REBUILD) */
export function downAll(s: St): Step {
  return done(s, { ...s, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false, rejoin: s.rs === 'JOINED' || (s.rs === 'JOINING' && !s.quit) }, 'ROOM.C.any.down', [], ['http.abandon', 'ws.abandon'], [{ fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'aff.leave', to: 'AFF', at: 'self' }, { fx: 'sub.drop', to: 'SUB', at: 'self' }], [])
}

/** 세션이 끝났다 — 방을 전부 내리고 다시 들어갈 방 표시를 지운다(DEV-SES-FRESH-REJOIN · 앱이 다시 들어간다) */
export function closeAll(s: St): Step {
  return done(s, { ...s, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false, rejoin: false }, 'ROOM.C.any.close_all', [], ['http.abandon', 'ws.abandon'], [{ fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'aff.leave', to: 'AFF', at: 'self' }, { fx: 'sub.drop', to: 'SUB', at: 'self' }], [])
}

/** 재구축 — 내렸던 방에 다시 들어간다(§[RULE-SES-REBUILD] 3 · RULE-LINK-RECOVERY-REBUILD) — 받는 상태 밖이면 null(사건이 없던 것) */
export function rejoin(s: St): Step | null {
  if (!(s.rs === 'NONE' && s.rejoin)) return null
  return done(s, { ...s, rs: 'JOINING', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false, rejoin: false }, 'ROOM.C.NONE.rejoin', [{ ws: 'ROOM_JOIN', part: 'req' }], [], [], [])
}

/** RESUME 성공 — 응답 스냅샷으로 방 보관본을 다시 맞춘다(§[RULE-SES-RES-RESUME-OK] 1 · 2 ②) — 받는 상태 밖이면 null(사건이 없던 것) */
export function resumeSnap(s: St, present: boolean, seq: number, epoch: number): Step | null {
  if (!(s.rs === 'JOINED')) return null
  if (!present) {
    return done(s, { ...s, rs: 'NONE', cseq: 0, cepoch: 0, rsync: false, ahead: 0, retry: false }, 'ROOM.C.JOINED.resume_gone', [], ['http.abandon', 'app.room_gone'], [{ fx: 'store.drop', to: 'TRK', at: 'self' }, { fx: 'floor.leave', to: 'FLR', at: 'self' }, { fx: 'aff.leave', to: 'AFF', at: 'self' }, { fx: 'sub.drop', to: 'SUB', at: 'self' }, { fx: 'link.room_left', to: 'LINK', at: 'sameServer' }, { fx: 'pub.room_gone', to: 'PUB', at: 'sameRoom' }], [])
  }
  if (epoch !== s.cepoch) {
    return done(s, s, 'ROOM.C.JOINED.resume_epoch', [], [], [{ fx: 'link.epoch_changed', to: 'LINK', at: 'sameServer' }], [])
  }
  return done(s, { ...s, cseq: seq }, 'ROOM.C.JOINED.resume_snapshot', [], [], [{ fx: 'trk.snapshot', to: 'TRK', at: 'self' }, { fx: 'link.table', to: 'LINK', at: 'sameServer' }], [])
}
