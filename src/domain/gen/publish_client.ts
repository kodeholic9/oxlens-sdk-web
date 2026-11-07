// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/pub/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 2483d3bca9e87f67 · 영역 PUB 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type PubSt = 'IDLE' | 'STAGED' | 'REGISTERED' | 'SENDING'
export type Part = 'req' | 'res' | 'fail' | 'body'
export type PubAction = 'add' | 'remove'
export type Duplex = 'full' | 'half'
export type Fx = 'app.duplex' | 'app.duplex_failed' | 'app.publish_failed' | 'app.publishing' | 'app.revoked' | 'track.attach' | 'track.detach' | 'transceiver.inactive'
export type SeamFx = 'link.pub_lost' | 'sdp.rebuild'
export type TimerName = never

/** 클라 상태 — 원천 PUB K */
export interface St {
  /** ★이 트랙이 붙은 미디어 서버 · 발행한 방 — 앱이 트랙을 만들 때 정하는 개체 신원(0 = 모형의 개체 하나 · 202610/20261013a 축 B) */
  readonly sfu: number
  /** undefined */
  readonly room: number
  /** 발행 상태(§[RULE-PUB-STATES]) */
  readonly ps: PubSt
  /** 앱이 켜 두려 한다(카메라 · 마이크를 켰다) */
  readonly want: boolean
  /** 반이중 트랙이다 — 발언권을 쥔 동안에만 SENDING(§[RULE-PUB-STATES]). TRACK_SET{duplex} 응답이 바꾼다(RULE-PUB-SET-PROC · 202611/20261102e) */
  readonly half: boolean
  /** 발행 협상이 진행 중이다(브라우저 — §[PUB.C.IDLE.on] · §[PUB.C.STAGED.nego_ok]) */
  readonly nego: boolean
  /** ★서버를 건너는 발행 방 전환으로 옛 서버에서 내렸다 — 발행 방이 서면 그 서버에서 다시 켠다(RULE-AFF-SWITCH-TRACKS 서버 건너 행 · 202611/20261102e) */
  readonly mv: boolean
  /** TRACK_SET{duplex} 응답을 기다린다 — 응답 전엔 게이트 · 반이중 여부를 바꾸지 않는다(RULE-PUB-SET-PROC · 202611/20261102e) */
  readonly dset: boolean
  /** ★TRACK_SET{duplex} 응답을 기다리는 사이 발행한 방을 잃었다 — 남길지(반이중) 내릴지(전이중)를 그 응답이 정한다(PUB.C.any.room_gone_pending · 202611/20261104a G) */
  readonly lost: boolean
  /** 기다리는 PUBLISH_TRACKS{add} 요청의 pid(0 = 없다) — 그 요청의 응답만 적용한다(LINK req 와 같은 꼴 · 202611/20261104a) */
  readonly req: number
  /** 마지막으로 매긴 add 요청 pid */
  readonly rid: number
}
export const initial = (): St => ({ sfu: 0, room: 0, ps: 'IDLE', want: false, half: false, nego: false, mv: false, dset: false, lost: false, req: 0, rid: 0 })

/** 이 상태기가 내는 것 */
export type Tx =
  | { readonly ws: 'PUBLISH_TRACKS'; readonly part: 'req'; readonly action: 'add' | 'remove'; readonly duplex?: 'half' | 'full' }
  | { readonly ws: 'TRACK_SET'; readonly part: 'req'; readonly duplex: Duplex }
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'link.pub_lost': { to: 'LINK', react: ['CPubLost'] },
  'sdp.rebuild': { to: 'LINK', react: ['CRenego'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {
  nego: ['LINK:pub.nego_ok', 'LINK:pub.nego_fail'],
  revoked: ['TRK:pub.revoked'],
  reregister: ['LINK:pub.reregister_server', 'SES:pub.reregister_all'],
  floorOpen: ['FLR:mic.open'],
  floorClose: ['FLR:mic.close'],
  resumeCheck: ['SES:pub.resume_check'],
  dropServer: ['LINK:pub.drop_server'],
  roomGone: ['ROOM:pub.room_gone', 'ROOM:pub.room_left'],
  moveOut: ['AFF:pub.move_out'],
  moveIn: ['AFF:pub.move_in'],
} as const
/** 읽는 것 — 판단이 다른 영역 상태를 읽는 인자(부르는 쪽이 넣는다 · 무엇을 읽는지는 위가 정한다) */
export const READS = {
  'moveOut.here': ['AFF.pub', 'ROOM.sfu'],
} as const

/** 원장 — 타이머(ms) · 횟수 */
export const TIMER_MS: Partial<Record<TimerName, number>> = {  }
export const COUNTS = {  } as const

const done = (prev: St, s: St, label: string, out: Tx[], fx: Fx[], seams: Seam[], start: TimerName[]): Step => {
  for (const t of armed(s)) if (!armed(prev).includes(t) && !start.includes(t)) start.push(t)
  return { s, label, out, fx, seams, start }
}

/** 지금 돌아야 하는 타이머 — 원천 timer(…).armed */
export function armed(s: St): TimerName[] {
  const on: TimerName[] = []
  return on
}

/** 앱이 카메라 · 마이크를 켰다(§[PUB.C.IDLE.on]) (앱: 앱이 카메라 · 마이크를 켰다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function on(s: St): Step | null {
  if (!(s.ps === 'IDLE')) return null
  if (s.mv) {
    return done(s, { ...s, want: true }, 'PUB.C.IDLE.on_moving', [], [], [], [])
  }
  return done(s, { ...s, ps: 'STAGED', want: true, nego: true }, 'PUB.C.IDLE.on', [], [], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }], [])
}

/** 발행 협상이 끝났다(§[PUB.C.STAGED.nego_ok]) — 받는 상태 밖이면 null(사건이 없던 것) */
export function nego(s: St, ok: boolean): Step | null {
  if (!(s.ps === 'STAGED' && s.nego)) return null
  if (ok && !s.want) {
    return done(s, { ...s, ps: 'IDLE', nego: false }, 'PUB.C.STAGED.nego_ok_unwanted', [], [], [], [])
  }
  if (ok) {
    return done(s, { ...s, nego: false, rid: s.rid + 1, req: s.rid + 1 }, 'PUB.C.STAGED.nego_ok', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'add', duplex: s.half ? 'half' : 'full' }], [], [], [])
  }
  return done(s, { ...s, ps: 'IDLE', nego: false }, 'PUB.C.STAGED.nego_fail', [], ['app.publish_failed'], [], [])
}

/** PUBLISH_TRACKS 응답을 받았다(§[PUB.C.STAGED.pub_ok] · §[RULE-PUB-REMOVE-FORM]) (받음: PUBLISH_TRACKS) */
export function pubRes(s: St, m: { readonly action: PubAction; readonly code: number; readonly part: Part; readonly pid: number }): Step {
  if (s.ps !== 'STAGED' || s.nego || (m.part === 'res' && m.action === 'remove') || m.code === 3005 || m.pid !== s.req) {
    return done(s, s, 'PUB.C.any.pub_res_other', [], [], [], [])
  }
  if (m.part === 'res' && !s.want) {
    return done(s, { ...s, ps: 'IDLE' }, 'PUB.C.STAGED.pub_ok_unwanted', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], [], [], [])
  }
  if (m.part === 'res') {
    return done(s, { ...s, ps: 'REGISTERED' }, 'PUB.C.STAGED.pub_ok', [], [], [], [])
  }
  return done(s, { ...s, ps: 'IDLE' }, 'PUB.C.STAGED.pub_fail', [], ['app.publish_failed'], [], [])
}

/** RTP 를 시작했다 — 실제 트랙을 트랜시버에 붙였다(§[PUB.C.REGISTERED]) (바깥: 실제 트랙을 트랜시버에 붙였다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function attach(s: St, ok: boolean): Step | null {
  if (!(s.ps === 'REGISTERED')) return null
  if (ok && s.half) {
    return done(s, s, 'PUB.C.REGISTERED.attach_ok_half', [], ['app.publishing'], [], [])
  }
  if (ok) {
    return done(s, { ...s, ps: 'SENDING' }, 'PUB.C.REGISTERED.attach_ok', [], ['track.attach', 'app.publishing'], [], [])
  }
  return done(s, { ...s, ps: 'IDLE' }, 'PUB.C.REGISTERED.attach_fail', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], ['app.publish_failed'], [], [])
}

/** 앱이 껐다(§[RULE-PUB-OFF]) (앱: 앱이 껐다) */
export function off(s: St): Step {
  if (s.ps === 'SENDING') {
    return done(s, { ...s, ps: 'IDLE', want: false }, 'PUB.C.SENDING.off', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], ['track.detach'], [], [])
  }
  if (s.ps === 'REGISTERED') {
    return done(s, { ...s, ps: 'IDLE', want: false }, 'PUB.C.REGISTERED.off', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], [], [], [])
  }
  if (s.ps === 'STAGED') {
    return done(s, { ...s, want: false }, 'PUB.C.STAGED.off', [], [], [], [])
  }
  return done(s, { ...s, want: false }, 'PUB.C.IDLE.off', [], [], [], [])
}

/** 내 track_id 의 TRACK_EVENT{remove} — 서버가 내 발행을 지웠다(§[RULE-PUB-REVOKED]) */
export function revoked(s: St, m: {  }): Step {
  if (s.ps === 'SENDING') {
    return done(s, { ...s, ps: 'IDLE' }, 'PUB.C.SENDING.revoked', [], ['track.detach', 'transceiver.inactive', 'app.revoked'], [], [])
  }
  if (s.ps === 'REGISTERED') {
    return done(s, { ...s, ps: 'IDLE' }, 'PUB.C.REGISTERED.revoked', [], ['track.detach', 'transceiver.inactive', 'app.revoked'], [], [])
  }
  return done(s, s, 'PUB.C.any.revoked_other', [], [], [], [])
}

/** 그 서버 재구축 — 다시 발행한다(RULE-LINK-RECOVERY-REBUILD · 절차는 §[PUB.C.IDLE.on]) */
export function reregister(s: St): Step {
  if (s.mv) {
    return done(s, s, 'PUB.C.any.reregister_moving', [], [], [], [])
  }
  if (s.want) {
    return done(s, { ...s, ps: 'STAGED', nego: true }, 'PUB.C.any.reregister', [], [], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }], [])
  }
  return done(s, { ...s, ps: 'IDLE', nego: false }, 'PUB.C.any.reregister_off', [], [], [], [])
}

/** 발언권을 얻었다 — 반이중 트랙이 보내기 시작한다(§[RULE-PUB-STATES]) */
export function floorOpen(s: St): Step {
  if (s.half && s.ps === 'REGISTERED') {
    return done(s, { ...s, ps: 'SENDING' }, 'PUB.C.REGISTERED.floor_open', [], ['track.attach'], [], [])
  }
  return done(s, s, 'PUB.C.any.floor_open_other', [], [], [], [])
}

/** 발언권을 놓았다 · 잃었다 — 반이중 트랙이 보내기를 멈춘다(§[RULE-PUB-STATES]) */
export function floorClose(s: St): Step {
  if (s.half && s.ps === 'SENDING') {
    return done(s, { ...s, ps: 'REGISTERED' }, 'PUB.C.SENDING.floor_close', [], ['track.detach'], [], [])
  }
  return done(s, s, 'PUB.C.any.floor_close_other', [], [], [], [])
}

/** RESUME 성공 — 응답의 publications[] 에 내 발행이 있나(listed) · 있으면 서버가 아는 반이중 여부(shalf — 그 항목의 duplex)를 본다(RULE-SES-RES-RESUME-OK 2 ③ · 4 · RULE-TRN-REQ-ABANDON 의 TRACK_SET 행) · 끊긴 동안 사라진 요청 · 응답도 이것으로 잡는다 */
export function resumeCheck(s: St, listed: boolean, shalf: boolean): Step {
  if (s.lost && (s.ps === 'REGISTERED' || s.ps === 'SENDING') && !listed) {
    return done(s, { ...s, lost: false, ps: 'IDLE', nego: false }, 'PUB.C.any.resume_lost_drop', [], ['track.detach'], [], [])
  }
  if (s.lost && !s.dset && (s.ps === 'REGISTERED' || s.ps === 'SENDING')) {
    return done(s, { ...s, lost: false, half: shalf, ps: shalf ? 'REGISTERED' : s.ps }, 'PUB.C.any.resume_lost_keep', [], ['track.detach', 'app.duplex'], [], [])
  }
  if ((s.ps === 'REGISTERED' || s.ps === 'SENDING') && !listed) {
    return done(s, s, 'PUB.C.any.resume_unlisted', [], [], [{ fx: 'link.pub_lost', to: 'LINK', at: 'sameServer' }], [])
  }
  if ((s.ps === 'REGISTERED' || s.ps === 'SENDING') && shalf && !s.half) {
    return done(s, { ...s, half: true, ps: 'REGISTERED' }, 'PUB.C.any.resume_half', [], ['track.detach', 'app.duplex'], [], [])
  }
  if ((s.ps === 'REGISTERED' || s.ps === 'SENDING') && !shalf && s.half) {
    return done(s, { ...s, half: false, ps: 'SENDING' }, 'PUB.C.any.resume_full', [], ['track.attach', 'app.duplex'], [], [])
  }
  if (s.ps === 'STAGED' && !s.nego) {
    return done(s, s, 'PUB.C.STAGED.resume_pending', [], [], [], [])
  }
  if ((s.ps === 'IDLE' || (s.ps === 'STAGED' && s.nego)) && listed) {
    return done(s, s, 'PUB.C.any.resume_orphan', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], [], [], [])
  }
  return done(s, s, 'PUB.C.any.resume_listed', [], [], [], [])
}

/** 그 서버 연결이 닫혔다 — 서버가 Peer 와 함께 발행 트랙을 풀었다(RULE-ROOM-LEAVE-RES 2) */
export function dropServer(s: St): Step {
  if (s.ps === 'STAGED') {
    return done(s, { ...s, ps: 'IDLE', nego: false }, 'PUB.C.STAGED.drop_server', [], ['app.publish_failed'], [], [])
  }
  return done(s, { ...s, ps: 'IDLE', nego: false }, 'PUB.C.any.drop_server', [], [], [], [])
}

/** 발행한 방을 잃었다(퇴장 · 강퇴 · 방 닫힘 · 스냅샷에 없는 방) — 서버가 그 방의 전이중 발행을 정리했다(원칙 ③) · self = 클라가 떠나기 시작했다(pub.room_left — 서버는 먼저 보낸 요청을 처리한 뒤 떠남을 처리한다) · 아니면 서버가 먼저 정리했고 클라가 나중에 안다 */
export function roomGone(s: St, self: boolean): Step {
  if (self && s.dset && (s.ps === 'REGISTERED' || s.ps === 'SENDING')) {
    return done(s, { ...s, lost: true }, 'PUB.C.any.room_gone_pending', [], [], [], [])
  }
  if (!self && s.dset && (s.ps === 'REGISTERED' || s.ps === 'SENDING')) {
    return done(s, { ...s, lost: true }, 'PUB.C.any.room_gone_kicked_pending', [], [], [], [])
  }
  if (!s.half && (s.ps === 'REGISTERED' || s.ps === 'SENDING')) {
    return done(s, { ...s, ps: 'IDLE', nego: false, lost: false }, 'PUB.C.any.room_gone', [], ['track.detach'], [], [])
  }
  if (!s.half && s.ps === 'STAGED') {
    return done(s, { ...s, ps: 'IDLE', nego: false }, 'PUB.C.STAGED.room_gone', [], ['app.publish_failed'], [], [])
  }
  return done(s, { ...s, lost: false }, 'PUB.C.any.room_gone_other', [], [], [], [])
}

/** 서버를 건너는 전환 ① — 옛 서버의 내 발행 트랙을 내린다(PUBLISH_TRACKS{remove}) · 읽는 것: here = AFF.pub · ROOM.sfu */
export function moveOut(s: St, here: boolean): Step {
  if (!here) {
    return done(s, s, 'PUB.C.any.move_out_other', [], [], [], [])
  }
  if (s.ps === 'SENDING') {
    return done(s, { ...s, ps: 'IDLE', mv: true }, 'PUB.C.SENDING.move_out', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], ['track.detach'], [], [])
  }
  if (s.ps === 'REGISTERED') {
    return done(s, { ...s, ps: 'IDLE', mv: true }, 'PUB.C.REGISTERED.move_out', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], [], [], [])
  }
  if (s.ps === 'STAGED' && !s.nego) {
    return done(s, { ...s, ps: 'IDLE', mv: true }, 'PUB.C.STAGED.move_out_sent', [{ ws: 'PUBLISH_TRACKS', part: 'req', action: 'remove' }], [], [], [])
  }
  if (s.ps === 'STAGED') {
    return done(s, { ...s, ps: 'IDLE', nego: false, mv: true }, 'PUB.C.STAGED.move_out_nego', [], [], [], [])
  }
  return done(s, { ...s, mv: s.want }, 'PUB.C.IDLE.move_out', [], [], [], [])
}

/** 서버를 건너는 전환 ② · ③ — 발행 방이 섰다 · 내린 트랙을 그 서버에서 다시 켠다(처음 켤 때와 같은 절차 — §[PUB.C.IDLE.on] · 그 서버엔 내 업링크가 없어 재협상한다 §[RULE-PUB-2PC-1PC]) */
export function moveIn(s: St): Step {
  if (s.mv && s.want) {
    return done(s, { ...s, mv: false, ps: 'STAGED', nego: true }, 'PUB.C.any.move_in', [], [], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }], [])
  }
  if (s.mv) {
    return done(s, { ...s, mv: false }, 'PUB.C.any.move_in_off', [], [], [], [])
  }
  return done(s, s, 'PUB.C.any.move_in_other', [], [], [], [])
}

/** 응답 없이 버려진 발행 · 전환 요청 — 상태를 맞추고 앱에 알린다(§[RULE-TRN-REQ-ABANDON]) · remove 는 응답을 기다리지 않으니 버릴 것이 없다 (바깥: 이 트랙의 발행 · 전환 요청이 기한(T-req)을 넘겼다 — 응답 없이 버린다(운반 · RULE-TRN-REQ-LIFE 5)) — 받는 상태 밖이면 null(사건이 없던 것) */
export function reqExpired(s: St): Step | null {
  if (!((s.ps === 'STAGED' && !s.nego) || s.dset)) return null
  if (s.ps === 'STAGED' && !s.nego) {
    return done(s, { ...s, ps: 'IDLE', req: 0 }, 'PUB.C.STAGED.expired', [], ['app.publish_failed'], [], [])
  }
  if (s.lost) {
    return done(s, { ...s, dset: false }, 'PUB.C.any.expired_lost', [], ['app.duplex_failed'], [], [])
  }
  return done(s, { ...s, dset: false, lost: false }, 'PUB.C.any.expired_set', [], ['app.duplex_failed'], [], [])
}

/** 무전 ↔ 회의 전환을 보낸다(TRACK_SET{duplex} — 이 경로로만 · RULE-PUB-SET-PROC) · 응답 전엔 아무것도 바꾸지 않는다 (앱: 앱이 트랙을 반이중 · 전이중으로 바꾸려 한다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function setDuplex(s: St, d: Duplex): Step | null {
  if (!((s.ps === 'REGISTERED' || s.ps === 'SENDING') && !s.dset && !s.lost)) return null
  return done(s, { ...s, dset: true }, 'PUB.C.any.set_duplex', [{ ws: 'TRACK_SET', part: 'req', duplex: d }], [], [], [])
}

/** TRACK_SET{duplex} 응답을 받았다 — 적용됐으면 게이트 · 반이중 여부를 바꾼다(RULE-PUB-SET-PROC) (받음: TRACK_SET) */
export function setDuplexRes(s: St, m: { readonly code: number; readonly duplex: Duplex; readonly noop: boolean; readonly part: Part }): Step {
  if (!s.dset) {
    return done(s, s, 'PUB.C.any.set_res_other', [], [], [], [])
  }
  if (s.ps !== 'REGISTERED' && s.ps !== 'SENDING') {
    return done(s, { ...s, dset: false, lost: false }, 'PUB.C.any.set_res_gone', [], ['app.duplex_failed'], [], [])
  }
  if (s.lost && ((m.part === 'res' && m.duplex === 'full') || (m.part !== 'res' && (!s.half || m.code === 3005)))) {
    return done(s, { ...s, dset: false, lost: false, ps: 'IDLE', nego: false }, 'PUB.C.any.set_lost_drop', [], ['track.detach', 'app.duplex_failed'], [], [])
  }
  if (m.part !== 'res') {
    return done(s, { ...s, dset: false, lost: false }, 'PUB.C.any.set_fail', [], ['app.duplex_failed'], [], [])
  }
  if (m.noop && (m.duplex === 'half') === s.half) {
    return done(s, { ...s, dset: false, lost: false }, 'PUB.C.any.set_noop', [], ['app.duplex'], [], [])
  }
  if (m.duplex === 'half' && s.ps === 'SENDING') {
    return done(s, { ...s, dset: false, lost: false, half: true, ps: 'REGISTERED' }, 'PUB.C.SENDING.set_half', [], ['track.detach', 'app.duplex'], [], [])
  }
  if (m.duplex === 'half' && s.ps === 'REGISTERED') {
    return done(s, { ...s, dset: false, lost: false, half: true }, 'PUB.C.REGISTERED.set_half', [], ['app.duplex'], [], [])
  }
  if (s.half && s.ps === 'REGISTERED') {
    return done(s, { ...s, dset: false, lost: false, half: false, ps: 'SENDING' }, 'PUB.C.REGISTERED.set_full', [], ['track.attach', 'app.duplex'], [], [])
  }
  return done(s, { ...s, dset: false, lost: false, half: false }, 'PUB.C.any.set_full', [], ['app.duplex'], [], [])
}
