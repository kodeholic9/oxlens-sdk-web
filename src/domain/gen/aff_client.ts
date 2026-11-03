// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/aff/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 457239814ea9aa5e · 영역 AFF 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type AffWait = 'NONE' | 'SELECT' | 'DESELECT' | 'JOIN'
export type RoomSt = 'NONE' | 'JOINING' | 'JOINED' | 'LEAVING'
export type Fx = 'app.aff_failed' | 'app.affiliation'
export type SeamFx = 'floor.pub_away' | 'floor.pub_select' | 'pub.move_in' | 'pub.move_out'
export type TimerName = never

/** 클라 상태 — 원천 AFF K */
export interface St {
  /** 세션의 발행 방 — 방 하나 또는 없음(응답이 그렇게 말했다 — 직접 고치지 않는다 · RULE-AFF-PROC) */
  readonly pub: string
  /** 기다리는 응답 — 요청은 한 번에 하나(서버를 건너면 옛 서버 해제 → 응답 → 새 서버 선택 · RULE-AFF-SWITCH-TRACKS) */
  readonly wait: AffWait
  /** 옮겨 갈 방 — 서버를 건너는 전환에서 옛 서버 해제 응답을 기다리는 동안 */
  readonly want: string
  /** 서버를 건너는 전환의 옛 발행 방 — 새 서버 선택이 실패하면 되돌아갈 곳(RULE-AFF-SWITCH-TRACKS ③ · 202611/20261102e) */
  readonly from: string
  /** 재구축으로 내린 발행 방 — 다시 들어간 뒤 pub_select 로 되찾는다(RULE-LINK-RECOVERY-REBUILD · 202611/20261102e) */
  readonly back: string
}
export const initial = (): St => ({ pub: 'NONE', wait: 'NONE', want: 'NONE', from: 'NONE', back: 'NONE' })

/** 이 상태기가 내는 것 */
export type Tx =
  | { readonly ws: 'AFFILIATION'; readonly part: 'req'; readonly pub_select?: string; readonly pub_deselect?: string }
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'floor.pub_away': { to: 'FLR', react: ['CAway'] },
  'floor.pub_select': { to: 'FLR', react: ['CPubSel'] },
  'pub.move_in': { to: 'PUB', react: ['CMoveIn'] },
  'pub.move_out': { to: 'PUB', react: ['CMoveOut'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {
  implicit: ['ROOM:aff.implicit'],
  left: ['ROOM:aff.leave'],
  down: ['ROOM:aff.down'],
  joinFailed: ['ROOM:aff.join_failed'],
} as const
/** 읽는 것 — 판단이 다른 영역 상태를 읽는 인자(부르는 쪽이 넣는다 · 무엇을 읽는지는 위가 정한다) */
export const READS = {
  'res.pIn': ['ROOM.rs'],
  'implicit.pIn': ['ROOM.rs'],
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

/** 방 r 을 발행 방으로(§[RULE-AFF-CHANGE-PROC] — 같은 서버면 요청 하나 · 서버를 건너면 옛 서버 해제 먼저 · RULE-AFF-SWITCH-TRACKS) (앱: 앱이 이 방에서 말하려 한다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function select(s: St, r: string, same: boolean): Step | null {
  if (!(s.wait === 'NONE' && s.pub !== r)) return null
  if (s.pub === 'NONE') {
    return done(s, { ...s, wait: 'SELECT', want: r, back: 'NONE' }, 'AFF.C.NOPUB.select', [{ ws: 'AFFILIATION', part: 'req', pub_select: r }], [], [], [])
  }
  if (same) {
    return done(s, { ...s, wait: 'SELECT', want: r, back: 'NONE' }, 'AFF.C.PUB.switch_same', [{ ws: 'AFFILIATION', part: 'req', pub_deselect: s.pub, pub_select: r }], [], [], [])
  }
  return done(s, { ...s, wait: 'DESELECT', want: r, from: s.pub }, 'AFF.C.PUB.switch_cross', [{ ws: 'AFFILIATION', part: 'req', pub_deselect: s.pub }], [], [{ fx: 'pub.move_out', to: 'PUB', at: 'all' }], [])
}

/** 발행 방을 뺀다(§[RULE-AFF-CHANGE-PROC]) (앱: 앱이 발행을 그만둔다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function deselect(s: St): Step | null {
  if (!(s.wait === 'NONE' && s.pub !== 'NONE')) return null
  return done(s, { ...s, wait: 'DESELECT', want: 'NONE', back: 'NONE' }, 'AFF.C.PUB.deselect', [{ ws: 'AFFILIATION', part: 'req', pub_deselect: s.pub }], [], [], [])
}

/** AFFILIATION 응답 — ok = 성공 응답 · p = 응답한 서버가 아는 발행 방(그 서버의 방 하나 또는 없음 — 부분 목록) · onPub · onWant = 응답한 서버가 지금 발행 방 · 옮겨 갈 방의 서버다(§[RULE-AFF-CHANGE-PROC] 3 · 4) (받음: AFFILIATION) · 읽는 것: pIn = ROOM.rs */
export function res(s: St, ok: boolean, p: string, onPub: boolean, onWant: boolean, pIn: boolean): Step {
  if (!ok && s.wait === 'SELECT' && s.from !== 'NONE') {
    return done(s, { ...s, want: s.from, from: 'NONE' }, 'AFF.C.PUB.switch_back', [{ ws: 'AFFILIATION', part: 'req', pub_select: s.from }], ['app.aff_failed'], [], [])
  }
  if (!ok && s.wait === 'DESELECT' && s.want !== 'NONE') {
    return done(s, { ...s, wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.PUB.switch_out_fail', [], ['app.aff_failed'], [{ fx: 'pub.move_in', to: 'PUB', at: 'all' }], [])
  }
  if (!ok) {
    return done(s, { ...s, wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.any.fail', [], ['app.aff_failed'], [], [])
  }
  if (p !== 'NONE' && !pIn && s.from !== 'NONE') {
    return done(s, { ...s, wait: 'SELECT', want: s.from, from: 'NONE' }, 'AFF.C.PUB.res_gone_back', [{ ws: 'AFFILIATION', part: 'req', pub_select: s.from }], ['app.aff_failed'], [], [])
  }
  if (p !== 'NONE' && !pIn) {
    return done(s, { ...s, pub: 'NONE', wait: 'NONE', want: 'NONE' }, 'AFF.C.any.res_gone', [], ['app.affiliation', 'app.aff_failed'], [{ fx: 'floor.pub_away', to: 'FLR', at: 'room' }], [])
  }
  if (s.wait === 'DESELECT' && s.want !== 'NONE' && !onWant && p === 'NONE') {
    return done(s, { ...s, pub: 'NONE', wait: 'SELECT' }, 'AFF.C.PUB.switch_in', [{ ws: 'AFFILIATION', part: 'req', pub_select: s.want }], ['app.affiliation'], [{ fx: 'floor.pub_away', to: 'FLR', at: 'room' }], [])
  }
  if (s.wait === 'DESELECT' && s.want !== 'NONE' && !onWant) {
    return done(s, { ...s, wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.PUB.switch_stuck', [], ['app.aff_failed'], [{ fx: 'pub.move_in', to: 'PUB', at: 'all' }], [])
  }
  if (s.wait === 'SELECT' && s.from !== 'NONE' && p !== s.want) {
    return done(s, { ...s, want: s.from, from: 'NONE' }, 'AFF.C.PUB.switch_in_skipped', [{ ws: 'AFFILIATION', part: 'req', pub_select: s.from }], ['app.aff_failed'], [], [])
  }
  if (p !== 'NONE' && s.pub === 'NONE') {
    return done(s, { ...s, pub: p, wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.NOPUB.res_pub', [], ['app.affiliation'], [{ fx: 'floor.pub_select', to: 'FLR', at: 'room' }, { fx: 'pub.move_in', to: 'PUB', at: 'all' }], [])
  }
  if (p !== 'NONE' && s.pub !== p) {
    return done(s, { ...s, pub: p, wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.PUB.res_moved', [], ['app.affiliation'], [{ fx: 'floor.pub_away', to: 'FLR', at: 'room' }, { fx: 'floor.pub_select', to: 'FLR', at: 'room' }], [])
  }
  if (p === 'NONE' && onPub && s.pub !== 'NONE') {
    return done(s, { ...s, pub: 'NONE', wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.PUB.res_away', [], ['app.affiliation'], [{ fx: 'floor.pub_away', to: 'FLR', at: 'room' }], [])
  }
  return done(s, { ...s, wait: 'NONE', want: 'NONE', from: 'NONE' }, 'AFF.C.any.res_same', [], [], [], [])
}

/** select:true 입장을 보낸다 — 입장이 곁들여 발행 방을 바꾸므로 ★소속 전환이 떠 있는 것과 같다(RULE-ROOM-JOIN-START 2 · 그 응답이 올 때까지 다른 전환을 막는다) (앱: 앱이 이 방에서 말하려고 들어간다(select:true 입장)) — 받는 상태 밖이면 null(사건이 없던 것) */
export function joinSelect(s: St, r: string): Step | null {
  if (!(s.wait === 'NONE' && s.pub === 'NONE')) return null
  return done(s, { ...s, wait: 'JOIN', want: r, back: 'NONE' }, 'AFF.C.NOPUB.join_select', [], [], [], [])
}

/** 입장 응답의 affiliation — 입장이 곁들여 바꾼 발행 방(RULE-AFF-CAUSE-USER · cause 없음) · r = 그 입장의 방 · sel = 그 입장 요청이 select:true 였다(응답은 pid 로 제 요청과 짝지어진다 — RULE-TRN-ONE-REPLY) · p = 그 응답이 말한 발행 방(그 서버의 방 하나 또는 없음 — 부분 목록) · onPub = 지금 발행 방이 그 응답을 낸 서버의 방 · 읽는 것: pIn = ROOM.rs */
export function implicit(s: St, r: string, sel: boolean, p: string, onPub: boolean, pIn: boolean): Step {
  if (s.back !== 'NONE' && s.back === r && p === r) {
    return done(s, { ...s, pub: p, back: 'NONE' }, 'AFF.C.any.implicit_back_held', [], [], [{ fx: 'floor.pub_select', to: 'FLR', at: 'room' }], [])
  }
  if (s.back !== 'NONE' && s.back === r && s.wait === 'NONE') {
    return done(s, { ...s, back: 'NONE', wait: 'SELECT', want: r }, 'AFF.C.any.implicit_back', [{ ws: 'AFFILIATION', part: 'req', pub_select: r }], [], [], [])
  }
  if (s.back !== 'NONE' && s.back === r) {
    return done(s, { ...s, back: 'NONE' }, 'AFF.C.any.implicit_back_busy', [], ['app.affiliation'], [], [])
  }
  if (sel && s.wait === 'JOIN' && s.want === r && p === r) {
    return done(s, { ...s, pub: p, wait: 'NONE', want: 'NONE' }, 'AFF.C.any.implicit_joined', [], ['app.affiliation'], [{ fx: 'floor.pub_select', to: 'FLR', at: 'room' }], [])
  }
  if (sel && s.wait === 'JOIN' && s.want === r) {
    return done(s, { ...s, wait: 'NONE', want: 'NONE' }, 'AFF.C.any.implicit_join_unselected', [], ['app.aff_failed'], [], [])
  }
  if (s.wait !== 'NONE') {
    return done(s, s, 'AFF.C.any.implicit_busy', [], [], [], [])
  }
  if (p !== 'NONE' && !pIn) {
    return done(s, s, 'AFF.C.any.implicit_gone', [], [], [], [])
  }
  if (p !== 'NONE' && s.pub !== p) {
    return done(s, { ...s, pub: p }, 'AFF.C.any.implicit_pub', [], ['app.affiliation'], [{ fx: 'floor.pub_away', to: 'FLR', at: 'room' }, { fx: 'floor.pub_select', to: 'FLR', at: 'room' }], [])
  }
  if (p === 'NONE' && onPub && s.pub !== 'NONE') {
    return done(s, { ...s, pub: 'NONE' }, 'AFF.C.any.implicit_away', [], ['app.affiliation'], [{ fx: 'floor.pub_away', to: 'FLR', at: 'room' }], [])
  }
  return done(s, s, 'AFF.C.any.implicit_same', [], [], [], [])
}

/** 듣던 방 r 을 떠났다 — 그 방이 발행 방이면 발행도 함께 풀린다(RULE-AFF-PROC 끝 항) */
export function left(s: St, r: string): Step {
  if (s.pub !== 'NONE' && s.pub === r) {
    return done(s, { ...s, pub: 'NONE', from: s.from === r ? 'NONE' : s.from }, 'AFF.C.any.left', [], ['app.affiliation'], [], [])
  }
  if (s.back !== 'NONE' && s.back === r) {
    return done(s, { ...s, back: 'NONE' }, 'AFF.C.any.left_back', [], ['app.affiliation'], [], [])
  }
  if (s.from !== 'NONE' && s.from === r) {
    return done(s, { ...s, from: 'NONE' }, 'AFF.C.any.left_from', [], [], [], [])
  }
  if (s.wait === 'JOIN' && s.want === r) {
    return done(s, { ...s, wait: 'NONE', want: 'NONE' }, 'AFF.C.any.left_join', [], ['app.aff_failed'], [], [])
  }
  if (s.want !== 'NONE' && s.want === r) {
    return done(s, { ...s, want: 'NONE' }, 'AFF.C.any.left_want', [], [], [], [])
  }
  return done(s, s, 'AFF.C.any.left_other', [], [], [], [])
}

/** 재구축이 방 r 을 내렸다 — 다시 들어간다(RULE-LINK-RECOVERY-REBUILD · RULE-SES-REBUILD) · 떠남과 달리 발행 방은 다시 들어간 뒤 되찾는다 */
export function down(s: St, r: string): Step {
  if (s.pub !== 'NONE' && s.pub === r) {
    return done(s, { ...s, pub: 'NONE', back: r }, 'AFF.C.any.down', [], [], [], [])
  }
  if (s.wait === 'JOIN' && s.want === r) {
    return done(s, { ...s, wait: 'NONE', want: 'NONE', back: r }, 'AFF.C.any.down_join', [], [], [], [])
  }
  if (s.want !== 'NONE' && s.want === r) {
    return done(s, { ...s, want: 'NONE' }, 'AFF.C.any.down_want', [], [], [], [])
  }
  return done(s, s, 'AFF.C.any.down_other', [], [], [], [])
}

/** 방 r 입장이 실패했다(응답이 실패 · 응답의 pc_mode 불일치로 되돌림) — select:true 입장이 건 기다림이면 푼다(소속 요청의 실패 응답이 AFF.C.any.fail 로 푸는 것과 같은 꼴) */
export function joinFailed(s: St, r: string): Step {
  if (s.back !== 'NONE' && s.back === r) {
    return done(s, { ...s, back: 'NONE' }, 'AFF.C.any.join_failed_back', [], ['app.affiliation'], [], [])
  }
  if (s.wait === 'JOIN' && s.want === r) {
    return done(s, { ...s, wait: 'NONE', want: 'NONE' }, 'AFF.C.any.join_failed', [], ['app.aff_failed'], [], [])
  }
  return done(s, s, 'AFF.C.any.join_failed_other', [], [], [], [])
}
