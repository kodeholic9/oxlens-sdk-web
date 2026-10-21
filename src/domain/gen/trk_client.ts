// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/trk/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 1812dea47fd2095f · 영역 TRK 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type TrackId = 'A' | 'B' | 'S'
export type TrackAction = 'add' | 'remove'
export type Layer = 'NONE' | 'ACTIVE' | 'RESTING'
export type Fx = 'app.track_state' | 'app.tracks'
export type SeamFx = 'pub.revoked'
export type TimerName = never

/** 클라 상태 — 원천 TRK K */
export interface St {
  /** 트랙 층 — 받은 항목으로 통째 교체한다 */
  readonly lay: Readonly<Record<TrackId, Layer>>
  /** 트랙 층의 muted — TRACK_STATE 와 항목 교체가 고친다 */
  readonly muted: Readonly<Record<TrackId, boolean>>
}
export const initial = (): St => ({ lay: {A: 'NONE', B: 'NONE', S: 'ACTIVE'}, muted: {A: false, B: false, S: false} })

/** 이 상태기가 내는 것 */
export type Tx =
  never
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'pub.revoked': { to: 'PUB', react: ['CRevoked'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {
  snapshot: ['ROOM:trk.snapshot'],
  storeDrop: ['ROOM:store.drop'],
} as const
/** 읽는 것 — 판단이 다른 영역 상태를 읽는 인자(부르는 쪽이 넣는다 · 무엇을 읽는지는 위가 정한다) */
export const READS = {

} as const

/** 원장 — 타이머(ms) · 횟수 */
export const TIMER_MS: Partial<Record<TimerName, number>> = {  }
export const COUNTS = {  } as const
const recEq = <K extends string, V>(a: Readonly<Record<K, V>>, b: Readonly<Record<K, V>>): boolean => (Object.keys(a) as K[]).every((k) => a[k] === b[k])

const done = (prev: St, s: St, label: string, out: Tx[], fx: Fx[], seams: Seam[], start: TimerName[]): Step => {
  for (const t of armed(s)) if (!armed(prev).includes(t) && !start.includes(t)) start.push(t)
  return { s, label, out, fx, seams, start }
}

/** 지금 돌아야 하는 타이머 — 원천 timer(…).armed */
export function armed(s: St): TimerName[] {
  const on: TimerName[] = []
  return on
}

/** TRACK_EVENT 를 받았다 — 트랙 목록(보기용)을 고친다(RULE-TRK-STORE-UPDATE · 키 = track_id) · mine = 내 track_id(version 은 ROOM 이 본다 — 낡은 델타는 ROOM 이 버린다 · RULE-TRK-TRACK-EVENT-PROC) · ★배정표는 건드리지 않는다 (받음: TRACK_EVENT) */
export function trackEvent(s: St, m: { readonly action: TrackAction; readonly tracks: { readonly active: boolean; readonly muted: boolean; readonly track_id: TrackId } }, mine: boolean): Step {
  if (mine && m.action === 'remove') {
    return done(s, s, 'TRK.C.any.mine_removed', [], [], [{ fx: 'pub.revoked', to: 'PUB', at: 'sameRoom' }], [])
  }
  if (mine) {
    return done(s, s, 'TRK.C.any.mine_other', [], [], [], [])
  }
  if (m.action === 'remove') {
    return done(s, { ...s, lay: { ...s.lay, [m.tracks.track_id]: 'NONE' }, muted: { ...s.muted, [m.tracks.track_id]: false } }, 'TRK.C.any.remove', [], ['app.tracks'], [], [])
  }
  return done(s, { ...s, lay: { ...s.lay, [m.tracks.track_id]: m.tracks.active ? 'ACTIVE' : 'RESTING' }, muted: { ...s.muted, [m.tracks.track_id]: m.tracks.muted } }, 'TRK.C.any.track_event', [], ['app.tracks'], [], [])
}

/** TRACK_STATE 를 받았다 — track_id 가 식별 키(RULE-TRK-TRACK-STATE-PROC) · muted 는 트랙 층이라 보관본의 그 값이 바뀐다(아직 구독하지 않은 트랙도 · RULE-TRK-TRACK-STATE-TO-ALL) (받음: TRACK_STATE) */
export function trackState(s: St, m: { readonly muted: boolean; readonly track_id: TrackId }): Step {
  return done(s, { ...s, muted: { ...s.muted, [m.track_id]: m.muted } }, 'TRK.C.any.track_state', [], ['app.track_state'], [], [])
}

/** 스냅샷(입장 응답 · RESUME · GET)의 tracks 를 받았다 — 그 방 트랙 목록 전부다(보기용 · RULE-TRK-FOUR-PATHS · RULE-TRK-PER-PATH) · ★배정표는 실려 오지 않는다(입장 응답 · RESUME 의 표는 MLINE_EVENT 와 같은 길로 받는다) */
export function snapshot(s: St, sLay: Readonly<Record<TrackId, Layer>>, sMuted: Readonly<Record<TrackId, boolean>>): Step {
  if (!recEq(sLay, s.lay) || !recEq(sMuted, s.muted)) {
    return done(s, { ...s, lay: sLay, muted: sMuted }, 'TRK.C.any.snapshot', [], ['app.tracks'], [], [])
  }
  return done(s, s, 'TRK.C.any.snapshot_same', [], [], [], [])
}

/** 그 방을 떠났다 · 내렸다 — 그 방 트랙 목록 보관본을 버린다(RULE-ROOM-LEAVE-RES) · 배정표는 연결의 것이라 서버가 새 표(MLINE_EVENT)로 고친다 */
export function storeDrop(s: St): Step {
  return done(s, { ...s, lay: { A: 'NONE', B: 'NONE', S: 'NONE' }, muted: { A: false, B: false, S: false } }, 'TRK.C.any.store_drop', [], [], [], [])
}
