// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/sub/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 1812dea47fd2095f · 영역 SUB 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type SubReady = 'NONE' | 'WANT' | 'SENT' | 'OK'
export type Part = 'req' | 'res' | 'fail' | 'body'
export type Fx = 'app.bug'
export type SeamFx = 'sdp.rebuild'
export type TimerName = never

/** 클라 상태 — 원천 SUB K */
export interface St {
  /** 그 방의 READY(RULE-SUB-READY-PROC — 방 단위) */
  readonly ready: SubReady
}
export const initial = (): St => ({ ready: 'NONE' })

/** 이 상태기가 내는 것 */
export type Tx =
  | { readonly ws: 'READY'; readonly part: 'req' }
  | { readonly ws: 'SUBSCRIBE_LAYER'; readonly part: 'req' }
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'sdp.rebuild': { to: 'LINK', react: ['CRenego'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {
  ready: ['ROOM:ready.tracks'],
  negoOk: ['LINK:sub.nego_ok'],
  negoFail: ['LINK:sub.nego_fail'],
  tableChanged: ['LINK:sub.table_changed'],
  tableRebound: ['LINK:sub.table_rebound'],
  dropRoom: ['ROOM:sub.drop'],
} as const
/** 읽는 것 — 판단이 다른 영역 상태를 읽는 인자(부르는 쪽이 넣는다 · 무엇을 읽는지는 위가 정한다) */
export const READS = {

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

/** 그 방에 READY 를 보낼 때가 됐다 — 입장 · 스냅샷 반영 뒤(RULE-SUB-READY-PROC) */
export function ready(s: St): Step {
  return done(s, { ...s, ready: 'WANT' }, 'SUB.C.any.ready_want', [], [], [], [])
}

/** 그 서버 재협상이 끝났다 — 이번에 바뀐 방마다 READY(RULE-TRK-TRACK-EVENT-PROC) */
export function negoOk(s: St): Step {
  if (s.ready === 'WANT') {
    return done(s, { ...s, ready: 'SENT' }, 'SUB.C.WANT.nego_ok', [{ ws: 'READY', part: 'req' }], [], [], [])
  }
  return done(s, s, 'SUB.C.any.nego_ok_other', [], [], [], [])
}

/** 협상이 실패했다 — READY 를 보내지 않는다(RULE-SUB-READY-PROC) */
export function negoFail(s: St): Step {
  if (s.ready === 'WANT') {
    return done(s, { ...s, ready: 'NONE' }, 'SUB.C.WANT.nego_fail', [], [], [], [])
  }
  return done(s, s, 'SUB.C.any.nego_fail_other', [], [], [], [])
}

/** READY 응답을 받았다(RULE-SUB-READY-FAIL) (받음: READY) */
export function readyRes(s: St, m: { readonly part: Part }): Step {
  if (s.ready !== 'SENT') {
    return done(s, s, 'SUB.C.any.ready_res_old', [], [], [], [])
  }
  if (m.part === 'res') {
    return done(s, { ...s, ready: 'OK' }, 'SUB.C.SENT.ready_ok', [], [], [], [])
  }
  return done(s, { ...s, ready: 'NONE' }, 'SUB.C.SENT.ready_fail', [], ['app.bug'], [], [])
}

/** 그 서버의 배정표가 바뀌었다(MLINE_EVENT · 입장 응답 · RESUME) — 구독 SDP 를 그 표만으로 다시 짓고 협상이 끝나면 READY{arev}(RULE-SUB-TABLE-PROC) */
export function tableChanged(s: St): Step {
  return done(s, { ...s, ready: 'WANT' }, 'SUB.C.any.table_changed', [], [], [{ fx: 'sdp.rebuild', to: 'LINK', at: 'sameServer' }], [])
}

/** 그 서버의 배정표에서 줄은 그대로이고 실린 트랙만 바뀌었다(재배정 · 빈 줄 · 다시 채움 — RULE-SUB-FILL) — SDP 를 다시 짓지 않고 READY{arev}(RULE-SUB-TABLE-PROC) */
export function tableRebound(s: St): Step {
  if (s.ready === 'WANT') {
    return done(s, s, 'SUB.C.WANT.table_rebound', [], [], [], [])
  }
  if (s.ready === 'NONE') {
    return done(s, s, 'SUB.C.NONE.table_rebound', [], [], [], [])
  }
  return done(s, { ...s, ready: 'SENT' }, 'SUB.C.any.table_rebound', [{ ws: 'READY', part: 'req' }], [], [], [])
}

/** SUBSCRIBE_LAYER 를 보낸다 — 지정이 아니라 상한 · 생략한 필드는 안 바꾼다(RULE-SUB-LAYER-PROC) (앱: 앱이 받을 레이어 상한을 고른다) */
export function layer(s: St): Step {
  return done(s, s, 'SUB.C.any.layer', [{ ws: 'SUBSCRIBE_LAYER', part: 'req' }], [], [], [])
}

/** SUBSCRIBE_LAYER 응답 — 대상별 실패는 조용히 건너뛴다(RULE-SUB-LAYER-FAIL) (받음: SUBSCRIBE_LAYER) */
export function layerRes(s: St): Step {
  return done(s, s, 'SUB.C.any.layer_res', [], [], [], [])
}

/** 그 방을 떠났다 · 잃었다 — 그 방의 구독을 버린다 */
export function dropRoom(s: St): Step {
  return done(s, { ...s, ready: 'NONE' }, 'SUB.C.any.drop', [], [], [], [])
}
