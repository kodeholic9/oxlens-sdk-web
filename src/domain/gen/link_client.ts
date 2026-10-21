// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/link/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 1812dea47fd2095f · 영역 LINK 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type LinkSt = 'OK' | 'WAIT' | 'CHECK' | 'RESTART' | 'APPLY' | 'REOPEN' | 'REBUILD' | 'NONE'
export type Ice = 'OK' | 'DISC' | 'FAILED'
export type RebuildCause = 'NONE' | 'RESTART_3XXX' | 'ASSOC' | 'DC_EXHAUST' | 'EPOCH' | 'PUB_LOST'
export type MTrack = 'A' | 'B' | 'Sa' | 'Sb'
export type Part = 'req' | 'res' | 'fail' | 'body'
export type Reopen = 'ok' | 'fail' | 'exhausted'
export type Fx = 'app.link_blocked' | 'app.link_ok' | 'app.link_rebuilding' | 'app.link_reviving' | 'app.link_shaky' | 'conn.close' | 'dc.reopen' | 'sdp.restart'
export type SeamFx = 'floor.dc_down' | 'floor.dc_up' | 'floor.down_server' | 'pub.drop_server' | 'pub.nego_fail' | 'pub.nego_ok' | 'pub.reregister_server' | 'rooms.rejoin_server' | 'store.drop_server' | 'sub.nego_fail' | 'sub.nego_ok' | 'sub.table_changed' | 'sub.table_rebound'
export type TimerName = never

/** 클라 상태 — 원천 LINK K */
export interface St {
  /** 복구 단계 */
  readonly ls: LinkSt
  /** ICE 층의 브라우저 사실 */
  readonly ice: Ice
  /** SCTP 연관 · DTLS 가 살아 있다 */
  readonly assoc: boolean
  /** DC 채널이 열려 있다 */
  readonly dc: boolean
  /** 적용한 ICE 자격의 세대(ufrag) */
  readonly gen: number
  /** ICE_RESTART 응답이 준 새 세대 — 재협상으로 적용 중 */
  readonly pgen: number
  /** 지금 기다리는 ICE_RESTART 요청의 pid(0 = 없다) — 그 요청의 응답만 적용한다(§[RULE-PUB-REMOVE-FORM]) */
  readonly req: number
  /** 마지막으로 매긴 요청 pid */
  readonly rid: number
  /** 끊긴 뒤 발언권을 다시 맞췄다(READY — §[RULE-LINK-RECOVERY-UNIT] 5) */
  readonly sync: boolean
  /** 재협상(구독 · 발행 SDP 다시 조립)이 진행 중이다(RULE-LINK-SDP-RENEGOTIATE) */
  readonly nego: boolean
  /** 협상 중에 방아쇠가 또 왔다 — 끝나면 한 번 더 조립한다(협상 큐 · 연달아 온 것은 한 번에 — RULE-LINK-SDP-RENEGOTIATE) */
  readonly dirty: boolean
  /** 이 연결이 한 번이라도 섰다(ICE 가 열렸다) — 막힌 망이면 서지 못한 채 되살리기가 되풀이된다(RULE-LINK-RECOVERY-NEVER-UP) */
  readonly everUp: boolean
  /** 재구축을 확정한 사건 */
  readonly cause: RebuildCause
  /** 배정표의 사본 — 그 트랙이 실린 줄의 mid(0 = 줄이 없다) · ★연결마다 하나(방 둘의 트랙이 한 표에) · MLINE_EVENT 와 입장 · RESUME 응답만 고친다(202610/20261017c · 20261018b) */
  readonly mid: Readonly<Record<MTrack, number>>
  /** 배정표의 줄 수 — 구독 SDP 의 m-line 들(줄은 지우지 않는다 · 줄이 늘 때만 SDP 가 바뀐다) */
  readonly rows: number
  /** 받은 배정표의 차례 번호(arev) — 이보다 큰 표만 받는다 */
  readonly arev: number
}
export const initial = (): St => ({ ls: 'OK', ice: 'OK', assoc: true, dc: true, gen: 1, pgen: 0, req: 0, rid: 0, sync: true, nego: false, dirty: false, everUp: true, cause: 'NONE', mid: {A: 0, B: 0, Sa: 1, Sb: 2}, rows: 2, arev: 0 })

/** 이 상태기가 내는 것 */
export type Tx =
  | { readonly ws: 'READY'; readonly part: 'req' }
  | { readonly ws: 'HEARTBEAT'; readonly part: 'req' }
  | { readonly ws: 'ICE_RESTART'; readonly part: 'req' }
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'floor.dc_down': { to: 'FLR', react: ['CDcDown'] },
  'floor.dc_up': { to: 'FLR', react: ['CDcUp'] },
  'floor.down_server': { to: 'FLR', react: ['CDown'] },
  'pub.drop_server': { to: 'PUB', react: ['CDropServer'] },
  'pub.nego_fail': { to: 'PUB', react: ['CNego'] },
  'pub.nego_ok': { to: 'PUB', react: ['CNego'] },
  'pub.reregister_server': { to: 'PUB', react: ['CReregister'] },
  'rooms.rejoin_server': { to: 'ROOM', react: ['CRejoin'] },
  'store.drop_server': { to: 'ROOM', react: ['CDownAll'] },
  'sub.nego_fail': { to: 'SUB', react: ['CNegoFail'] },
  'sub.nego_ok': { to: 'SUB', react: ['CNegoOk'] },
  'sub.table_changed': { to: 'SUB', react: ['CTableChanged'] },
  'sub.table_rebound': { to: 'SUB', react: ['CTableRebound'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {
  closeAll: ['SES:media.close_all'],
  roomLeft: ['ROOM:link.room_left'],
  repair: ['SES:media.repair'],
  epochChanged: ['ROOM:link.epoch_changed'],
  pubLost: ['PUB:link.pub_lost'],
  renego: ['ROOM:sdp.rebuild', 'PUB:sdp.rebuild', 'SUB:sdp.rebuild'],
  tableCarried: ['ROOM:link.table'],
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

/** ICE 가 disconnected 가 됐다(브라우저) (바깥: 브라우저 ICE 가 disconnected) */
export function iceDisc(s: St): Step {
  if (s.ls === 'OK') {
    return done(s, { ...s, ls: 'WAIT', sync: false, ice: 'DISC' }, 'LINK.C.OK.ice_disc', [], ['app.link_shaky'], [], [])
  }
  return done(s, { ...s, ice: 'DISC' }, 'LINK.C.any.ice_disc_absorbed', [], [], [], [])
}

/** ICE 가 스스로 회복했다(기다리는 동안) (바깥: 브라우저 ICE 가 스스로 회복했다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function iceBack(s: St): Step | null {
  if (!(s.ls === 'WAIT' && s.ice === 'DISC')) return null
  return done(s, { ...s, ls: 'OK', sync: true, ice: 'OK' }, 'LINK.C.WAIT.ice_back', [{ ws: 'READY', part: 'req' }], ['app.link_ok'], [], [])
}

/** disconnected 기다림이 끝나도 안 풀렸다 · 또는 failed 가 됐다 (바깥: disconnected 기다림이 끝났다 · failed) */
export function waitOver(s: St, failed: boolean): Step {
  if (s.ls === 'WAIT') {
    return done(s, { ...s, ls: 'CHECK', sync: false, ice: failed ? 'FAILED' : s.ice }, 'LINK.C.WAIT.wait_over', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
  }
  if (s.ls === 'OK') {
    return done(s, { ...s, ls: 'CHECK', sync: false, ice: failed ? 'FAILED' : s.ice }, 'LINK.C.OK.wait_over', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
  }
  return done(s, { ...s, ice: failed ? 'FAILED' : s.ice }, 'LINK.C.any.wait_over_absorbed', [], [], [], [])
}

/** LINK_EVENT{suspect} 를 받았다(§[RULE-ROOM-NOTIFY-VERSION-FOUR]) — 세대를 견준다 (받음: LINK_EVENT) */
export function linkEvent(s: St, m: { readonly ufrag: number }): Step {
  if (m.ufrag !== s.gen) {
    return done(s, s, 'LINK.C.any.link_event_stale', [], [], [], [])
  }
  if (s.ls === 'OK') {
    return done(s, { ...s, ls: 'CHECK', sync: false }, 'LINK.C.OK.link_event', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
  }
  return done(s, s, 'LINK.C.any.link_event_absorbed', [], [], [], [])
}

/** WS 점검의 HEARTBEAT 응답 — 무엇이든 받았다(WS 가 산다) (받음: HEARTBEAT) */
export function hbRes(s: St, m: {  }): Step {
  if (s.ls === 'CHECK') {
    return done(s, { ...s, ls: 'RESTART', rid: s.rid + 1, req: s.rid + 1 }, 'LINK.C.CHECK.ws_alive', [{ ws: 'ICE_RESTART', part: 'req' }], ['app.link_reviving'], [], [])
  }
  return done(s, s, 'LINK.C.any.hb_res', [], [], [], [])
}

/** ICE_RESTART 응답을 받았다(§[RULE-PUB-REMOVE-FORM]) — 앞자리 뜻으로 받는다(§[RULE-ERR-UNKNOWN-BY-LEAD]) (받음: ICE_RESTART) */
export function restartRes(s: St, m: { readonly code: number; readonly part: Part; readonly pid: number; readonly publish: { readonly ufrag: number } }): Step {
  if (s.ls !== 'RESTART' || m.pid !== s.req) {
    return done(s, s, 'LINK.C.any.restart_res_other', [], [], [], [])
  }
  if (m.part === 'res' && s.nego) {
    return done(s, { ...s, ls: 'APPLY', pgen: m.publish.ufrag, req: 0, dirty: true }, 'LINK.C.RESTART.restart_ok_queued', [], [], [], [])
  }
  if (m.part === 'res') {
    return done(s, { ...s, ls: 'APPLY', pgen: m.publish.ufrag, req: 0, nego: true }, 'LINK.C.RESTART.restart_ok', [], ['sdp.restart'], [], [])
  }
  if (m.code >= 3000 && m.code < 4000) {
    return done(s, { ...s, ls: 'REBUILD', cause: 'RESTART_3XXX', req: 0 }, 'LINK.C.RESTART.restart_3xxx', [], ['conn.close', 'app.link_rebuilding'], [{ fx: 'floor.down_server', to: 'FLR', at: 'sameServer' }, { fx: 'store.drop_server', to: 'ROOM', at: 'sameServer' }, { fx: 'rooms.rejoin_server', to: 'ROOM', at: 'sameServer' }, { fx: 'pub.reregister_server', to: 'PUB', at: 'sameServer' }], [])
  }
  return done(s, { ...s, ls: 'CHECK', req: 0 }, 'LINK.C.RESTART.restart_5xxx', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
}

/** 새 자격을 적용했는데 시한 안에 안 열렸다(적용 뒤 시한 만료 — 방아쇠) (바깥: 새 자격 적용 뒤 시한이 지났다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function applyTimeout(s: St): Step | null {
  if (!(s.ls === 'APPLY')) return null
  if (!s.everUp) {
    return done(s, { ...s, ls: 'CHECK', pgen: 0 }, 'LINK.C.APPLY.apply_timeout_blocked', [{ ws: 'HEARTBEAT', part: 'req' }], ['app.link_blocked'], [], [])
  }
  return done(s, { ...s, ls: 'CHECK', pgen: 0 }, 'LINK.C.APPLY.apply_timeout', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
}

/** 새 자격의 재협상이 끝나 ICE 가 섰다 — 새 자격을 실은 협상이 끝난 뒤다(협상 큐 — RULE-LINK-SDP-RENEGOTIATE) (바깥: 새 자격의 재협상이 끝나 ICE 가 섰다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function applied(s: St): Step | null {
  if (!(s.ls === 'APPLY' && !s.nego)) return null
  return done(s, { ...s, ls: 'OK', ice: 'OK', gen: s.pgen, pgen: 0, sync: true, everUp: true }, 'LINK.C.APPLY.applied', [{ ws: 'READY', part: 'req' }], ['app.link_ok'], [], [])
}

/** SCTP 연관이 사라졌다 · DTLS 가 닫혔다 (바깥: SCTP 연관 소멸 · DTLS 닫힘) */
export function assocLost(s: St): Step {
  if (s.ls === 'REBUILD') {
    return done(s, { ...s, assoc: false, dc: false }, 'LINK.C.REBUILD.assoc_lost_absorbed', [], [], [], [])
  }
  return done(s, { ...s, ls: 'REBUILD', cause: 'ASSOC', assoc: false, dc: false, sync: false, pgen: 0, req: 0 }, 'LINK.C.any.assoc_lost', [], ['conn.close', 'app.link_rebuilding'], [{ fx: 'floor.down_server', to: 'FLR', at: 'sameServer' }, { fx: 'store.drop_server', to: 'ROOM', at: 'sameServer' }, { fx: 'rooms.rejoin_server', to: 'ROOM', at: 'sameServer' }, { fx: 'pub.reregister_server', to: 'PUB', at: 'sameServer' }], [])
}

/** DC 채널만 닫혔다(연관은 산다) (바깥: DC 채널만 닫혔다) */
export function dcClosed(s: St): Step {
  if (s.ls === 'OK') {
    return done(s, { ...s, ls: 'REOPEN', dc: false, sync: false }, 'LINK.C.OK.dc_closed', [], ['dc.reopen'], [{ fx: 'floor.dc_down', to: 'FLR', at: 'sameServer' }], [])
  }
  return done(s, { ...s, dc: false }, 'LINK.C.any.dc_closed_absorbed', [], [], [{ fx: 'floor.dc_down', to: 'FLR', at: 'sameServer' }], [])
}

/** DC 다시 열기의 결과 (바깥: DC 다시 열기의 결과) — 받는 상태 밖이면 null(사건이 없던 것) */
export function reopened(s: St, r: Reopen): Step | null {
  if (!(s.ls === 'REOPEN')) return null
  if (r === 'ok') {
    return done(s, { ...s, ls: 'OK', dc: true, sync: true }, 'LINK.C.REOPEN.reopen_ok', [{ ws: 'READY', part: 'req' }], ['app.link_ok'], [{ fx: 'floor.dc_up', to: 'FLR', at: 'sameServer' }], [])
  }
  if (r === 'fail') {
    return done(s, s, 'LINK.C.REOPEN.reopen_retry', [], ['dc.reopen'], [], [])
  }
  return done(s, { ...s, ls: 'REBUILD', cause: 'DC_EXHAUST' }, 'LINK.C.REOPEN.reopen_exhaust', [], ['conn.close', 'app.link_rebuilding'], [{ fx: 'floor.down_server', to: 'FLR', at: 'sameServer' }, { fx: 'store.drop_server', to: 'ROOM', at: 'sameServer' }, { fx: 'rooms.rejoin_server', to: 'ROOM', at: 'sameServer' }, { fx: 'pub.reregister_server', to: 'PUB', at: 'sameServer' }], [])
}

/** 그 서버 재구축이 끝났다 — 새 연결 · 다시 입장 · 다시 발행(g = 새 연결의 세대 · stood = 새 연결의 ICE 가 열렸다) (받음: ROOM_JOIN) — 받는 상태 밖이면 null(사건이 없던 것) */
export function rebuilt(s: St, g: number, stood: boolean): Step | null {
  if (!(s.ls === 'REBUILD')) return null
  if (!stood) {
    return done(s, { ...s, ls: 'CHECK', ice: 'FAILED', everUp: false, assoc: true, gen: g, pgen: 0, sync: false, cause: 'NONE', nego: false, dirty: false }, 'LINK.C.REBUILD.rebuilt_unstood', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
  }
  return done(s, { ...s, ls: 'OK', ice: 'OK', assoc: true, dc: true, gen: g, pgen: 0, sync: true, cause: 'NONE', nego: false, dirty: false, everUp: true }, 'LINK.C.REBUILD.rebuilt', [], ['app.link_ok'], [], [])
}

/** 세션이 미디어 연결을 전부 닫는다(RULE-SES-REBUILD 2 · RULE-SES-ON-DROP 2·3) */
export function closeAll(s: St): Step {
  return done(s, { ...s, ls: 'NONE', dc: false, sync: false, nego: false, dirty: false, pgen: 0, req: 0 }, 'LINK.C.any.close_all', [], ['conn.close'], [{ fx: 'pub.drop_server', to: 'PUB', at: 'sameServer' }], [])
}

/** 그 서버의 방 하나를 떠났다 — last = 그 서버에 남은 방이 없다(RULE-ROOM-LEAVE-RES 2) */
export function roomLeft(s: St, last: boolean): Step {
  if (last) {
    return done(s, { ...s, ls: 'NONE', dc: false, sync: false, nego: false, dirty: false, pgen: 0, req: 0 }, 'LINK.C.any.last_room_left', [], ['conn.close'], [{ fx: 'pub.drop_server', to: 'PUB', at: 'sameServer' }], [])
  }
  return done(s, s, 'LINK.C.any.room_left', [], [], [], [])
}

/** RESUME 뒤 죽은 연결을 층별 판정대로 되살린다(RULE-SES-RES-RESUME-OK 4 · RULE-LINK-RECOVERY-UNIT — 처음부터 다시 판정) */
export function repair(s: St): Step {
  if (!s.assoc) {
    return done(s, { ...s, ls: 'REBUILD', cause: 'ASSOC', dc: false, sync: false, pgen: 0, req: 0 }, 'LINK.C.any.repair_rebuild', [], ['conn.close', 'app.link_rebuilding'], [{ fx: 'floor.down_server', to: 'FLR', at: 'sameServer' }, { fx: 'store.drop_server', to: 'ROOM', at: 'sameServer' }, { fx: 'rooms.rejoin_server', to: 'ROOM', at: 'sameServer' }, { fx: 'pub.reregister_server', to: 'PUB', at: 'sameServer' }], [])
  }
  if (s.ice !== 'OK') {
    return done(s, { ...s, ls: 'RESTART', rid: s.rid + 1, req: s.rid + 1 }, 'LINK.C.any.repair_restart', [{ ws: 'ICE_RESTART', part: 'req' }], ['app.link_reviving'], [], [])
  }
  return done(s, s, 'LINK.C.any.repair_ok', [], [], [], [])
}

/** 그 서버의 방 version.epoch 가 바뀌었다 — 서버가 재기동돼 그 연결을 모른다 · 그 서버만 재구축한다(RULE-SES-RES-RESUME-OK 4 · RULE-LINK-RECOVERY-UNIT) */
export function epochChanged(s: St): Step {
  if (s.ls === 'REBUILD') {
    return done(s, s, 'LINK.C.REBUILD.epoch_absorbed', [], [], [], [])
  }
  return done(s, { ...s, ls: 'REBUILD', cause: 'EPOCH', dc: false, sync: false, pgen: 0, req: 0 }, 'LINK.C.any.epoch_rebuild', [], ['conn.close', 'app.link_rebuilding'], [{ fx: 'floor.down_server', to: 'FLR', at: 'sameServer' }, { fx: 'store.drop_server', to: 'ROOM', at: 'sameServer' }, { fx: 'rooms.rejoin_server', to: 'ROOM', at: 'sameServer' }, { fx: 'pub.reregister_server', to: 'PUB', at: 'sameServer' }], [])
}

/** RESUME 응답에 내 발행이 없다 — 서버가 그 연결을 모른다 · 그 서버만 재구축한다(RULE-SES-RES-RESUME-OK 2 ③ · 4) */
export function pubLost(s: St): Step {
  if (s.ls === 'REBUILD') {
    return done(s, s, 'LINK.C.REBUILD.publost_absorbed', [], [], [], [])
  }
  return done(s, { ...s, ls: 'REBUILD', cause: 'PUB_LOST', dc: false, sync: false, pgen: 0, req: 0 }, 'LINK.C.any.publost_rebuild', [], ['conn.close', 'app.link_rebuilding'], [{ fx: 'floor.down_server', to: 'FLR', at: 'sameServer' }, { fx: 'store.drop_server', to: 'ROOM', at: 'sameServer' }, { fx: 'rooms.rejoin_server', to: 'ROOM', at: 'sameServer' }, { fx: 'pub.reregister_server', to: 'PUB', at: 'sameServer' }], [])
}

/** 구독 · 발행 SDP 를 다시 조립해 협상한다(RULE-LINK-SDP-RENEGOTIATE · 그 서버 전체 — RULE-TRK-TRACK-EVENT-PROC) */
export function renego(s: St): Step {
  if (s.nego) {
    return done(s, { ...s, dirty: true }, 'LINK.C.any.renego_queued', [], [], [], [])
  }
  return done(s, { ...s, nego: true }, 'LINK.C.any.renego', [], [], [], [])
}

/** 재협상이 끝났다 — ok = 성공 (바깥: 브라우저 협상(offer/answer)의 결과) */
export function negoRes(s: St, ok: boolean): Step {
  if (ok && s.dirty) {
    return done(s, { ...s, dirty: false }, 'LINK.C.any.nego_ok_next', [], [], [{ fx: 'sub.nego_ok', to: 'SUB', at: 'sameServer' }, { fx: 'pub.nego_ok', to: 'PUB', at: 'sameServer' }], [])
  }
  if (ok) {
    return done(s, { ...s, nego: false }, 'LINK.C.any.nego_ok', [], [], [{ fx: 'sub.nego_ok', to: 'SUB', at: 'sameServer' }, { fx: 'pub.nego_ok', to: 'PUB', at: 'sameServer' }], [])
  }
  if (s.dirty) {
    return done(s, { ...s, dirty: false }, 'LINK.C.any.nego_fail_next', [], [], [{ fx: 'sub.nego_fail', to: 'SUB', at: 'sameServer' }, { fx: 'pub.nego_fail', to: 'PUB', at: 'sameServer' }], [])
  }
  return done(s, { ...s, nego: false }, 'LINK.C.any.nego_fail', [], [], [{ fx: 'sub.nego_fail', to: 'SUB', at: 'sameServer' }, { fx: 'pub.nego_fail', to: 'PUB', at: 'sameServer' }], [])
}

/** MLINE_EVENT 를 받았다 — 그 서버 연결의 배정표 전체다(SUB.type.MlineTable) · 보관한 차례(arev)보다 크면 통째로 갈아 끼운다(RULE-SUB-TABLE-PROC) · ★표는 연결의 것이라 그 서버의 방 전부가 한 표를 쓴다 (받음: MLINE_EVENT) */
export function mlineEvent(s: St, m: { readonly table: { readonly arev: number; readonly mid: Readonly<Record<MTrack, number>>; readonly rows: number } }): Step {
  if (m.table.arev > s.arev && recEq(m.table.mid, s.mid) && m.table.rows === s.rows) {
    return done(s, { ...s, arev: m.table.arev }, 'LINK.C.any.table_same', [], [], [], [])
  }
  if (m.table.arev > s.arev && m.table.rows !== s.rows) {
    return done(s, { ...s, mid: m.table.mid, rows: m.table.rows, arev: m.table.arev }, 'LINK.C.any.table', [], [], [{ fx: 'sub.table_changed', to: 'SUB', at: 'sameServer' }], [])
  }
  if (m.table.arev > s.arev) {
    return done(s, { ...s, mid: m.table.mid, arev: m.table.arev }, 'LINK.C.any.table_rebound', [], [], [{ fx: 'sub.table_rebound', to: 'SUB', at: 'sameServer' }], [])
  }
  return done(s, s, 'LINK.C.any.table_old', [], [], [], [])
}

/** 입장 응답 · RESUME 응답이 실어 온 그 서버의 배정표 — MLINE_EVENT 와 같게 받는다(RULE-SUB-TABLE-PROC · 어느 길로 와도 새 arev 가 이긴다) */
export function tableCarried(s: St, tArev: number, tMid: Readonly<Record<MTrack, number>>, tRows: number): Step {
  if (tArev > s.arev && recEq(tMid, s.mid) && tRows === s.rows) {
    return done(s, { ...s, arev: tArev }, 'LINK.C.any.table_carried_same', [], [], [], [])
  }
  if (tArev > s.arev && tRows !== s.rows) {
    return done(s, { ...s, mid: tMid, rows: tRows, arev: tArev }, 'LINK.C.any.table_carried', [], [], [{ fx: 'sub.table_changed', to: 'SUB', at: 'sameServer' }], [])
  }
  if (tArev > s.arev) {
    return done(s, { ...s, mid: tMid, arev: tArev }, 'LINK.C.any.table_carried_rebound', [], [], [{ fx: 'sub.table_rebound', to: 'SUB', at: 'sameServer' }], [])
  }
  return done(s, s, 'LINK.C.any.table_carried_old', [], [], [], [])
}
