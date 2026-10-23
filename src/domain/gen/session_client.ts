// ★생성 파일 — gen/axis_client.mts 가 원천(context/spec/protocol · areas/ses/behavior)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 67967e270560c2c4 · 영역 SES 클라 상태기. 같은 원천의 검증 모형과 한 뿌리다.
// 집행은 부르는 쪽 몫이다 — out(보낼 것) · fx(이 영역의 효과 — 앱 알림 등) · seams(다른 영역 입구로 — 받는 곳은 위가 정했다) · start(새로 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type Conn = 'DISCONNECTED' | 'CONNECTING' | 'ACTIVE' | 'RESUMING'
export type Sock = 'CLOSED' | 'OPENING' | 'OPEN'
export type Wait = 'NONE' | 'BIND' | 'RESUME'
export type Token = 'NONE' | 'VALID' | 'EXPIRED' | 'FORGED'
export type PcMode = '1pc' | '2pc'
export type Part = 'req' | 'res' | 'fail' | 'body'
export type Fx = 'app.bug' | 'app.connected' | 'app.disconnected' | 'app.need_token' | 'app.rebuilt' | 'app.resumed'
export type SeamFx = 'floor.down_all' | 'media.close_all' | 'media.repair' | 'pub.reregister_all' | 'pub.resume_check' | 'rooms.close_all' | 'rooms.down_all' | 'rooms.rejoin' | 'rooms.snapshot'
export type TimerName = 'TBind' | 'TReq' | 'THb' | 'Backoff' | 'TStable'

/** 클라 상태 — 원천 SES K */
export interface St {
  /** 연결 상태(§[RULE-SES-CONN-DIAGRAM]) */
  readonly cs: Conn
  /** 소켓 */
  readonly sock: Sock
  /** 기다리는 응답 */
  readonly wait: Wait
  /** 보관한 session_id — 0 이면 없다(BIND 응답이 준다 · §[SES.C.CONNECTING.bind_ok]) */
  readonly sid: number
  /** 이 소켓의 BIND 에 실은 session_id — 응답과 견준다(§[RULE-SES-RES-BIND-RES]) */
  readonly sent: number
  /** 끊긴 순간부터의 경과가 resume_window_ms 를 넘었다(§[RULE-SES-RES-OPEN] 2 · §[RULE-SES-BACKOFF-LADDER]) */
  readonly late: boolean
  /** 백오프 횟수(§[RULE-SES-BACKOFF-LADDER]) */
  readonly tries: number
  /** 하트비트가 돈다(§[SES.C.CONNECTING.bind_ok] 3) */
  readonly hb: boolean
  /** 보관한 하트비트 주기(ms) — BIND 응답의 `heartbeat_interval`(§[SES.C.CONNECTING.bind_ok] 1) · 0 이면 아직 없다 */
  readonly hbMs: number
  /** 보관한 재개 창(ms) — BIND 응답의 `resume_window_ms` · 끊긴 뒤 경과를 이것과 견준다(§[RULE-SES-RES-OPEN] 2) */
  readonly winMs: number
  /** 앱이 준 토큰 */
  readonly token: Token
  /** BIND 에 싣는 연결 모드 — ★브라우저 능력이라 클라가 안다 · 고르는 법은 원문이 정하지 않는다(RULE-LINK-SDP-1PC-MODE · 모르면 2pc) */
  readonly pcAsk: PcMode
  /** ★세션 확정 연결 모드 — BIND 응답의 에코(RULE-SES-PC-MODE-SESSION) · 세션 안에서 바뀌지 않는다 · ROOM 이 사본 없이 읽는다(RULE-ROOM-JOIN-PC-MODE-CHECK) */
  readonly pcm: PcMode
}
export const initial = (): St => ({ cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE', sid: 0, sent: 0, late: false, tries: 0, hb: false, hbMs: 0, winMs: 0, token: 'VALID', pcAsk: '2pc', pcm: '2pc' })

/** 이 상태기가 내는 것 */
export type Tx =
  | { readonly ws: 'BIND'; readonly part: 'req'; readonly token: Token; readonly pc_mode: PcMode; readonly session_id?: number }
  | { readonly ws: 'RESUME'; readonly part: 'req' }
  | { readonly ws: 'LEAVE'; readonly part: 'req' }
  | { readonly ws: 'HEARTBEAT'; readonly part: 'req' }
/** 다른 영역으로 — 받는 영역(to) · 받는 개체(at: all = 그 영역 개체 전부 · self = 같은 개체 · sameServer · sameRoom) */
export interface Seam { readonly fx: SeamFx; readonly to: string; readonly at: string }
/** 한 걸음의 결과 — label 은 원천의 동작 라벨 */
export interface Step { readonly s: St; readonly label: string; readonly out: readonly Tx[]; readonly fx: readonly Fx[]; readonly seams: readonly Seam[]; readonly start: readonly TimerName[] }

/** 이음매 — 이 영역이 내는 건너가는 효과와 그것을 받는 입구(위가 정한다 · IR seams) */
export const SEAMS = {
  'floor.down_all': { to: 'FLR', react: ['CDown'] },
  'media.close_all': { to: 'LINK', react: ['CCloseAll'] },
  'media.repair': { to: 'LINK', react: ['CRepair'] },
  'pub.reregister_all': { to: 'PUB', react: ['CReregister'] },
  'pub.resume_check': { to: 'PUB', react: ['CResumeCheck'] },
  'rooms.close_all': { to: 'ROOM', react: ['CCloseAll'] },
  'rooms.down_all': { to: 'ROOM', react: ['CDownAll'] },
  'rooms.rejoin': { to: 'ROOM', react: ['CRejoin'] },
  'rooms.snapshot': { to: 'ROOM', react: ['CResumeSnap'] },
} as const
/** 이음매가 부르는 입구 — 다른 영역(또는 이 영역)의 효과가 부른다 · 부르는 곳은 위가 정했다(아래가 넣는 사건이 아니다) */
export const REACTS = {

} as const
/** 읽는 것 — 판단이 다른 영역 상태를 읽는 인자(부르는 쪽이 넣는다 · 무엇을 읽는지는 위가 정한다) */
export const READS = {
  'bindRes.marked': ['ROOM.rejoin'],
  'resumeRes.dead': ['LINK.assoc', 'LINK.ice'],
  'drop.carry': ['ROOM.rs', 'PUB.ps'],
} as const

/** 원장 — 타이머(ms) · 횟수 · 사다리 */
export const TIMER_MS: Partial<Record<TimerName, number>> = { TBind: 10000, TReq: 30000, THb: 10000, TStable: 10000 }
export const COUNTS = { CBackoff: 10 } as const
export const LADDER = { name: 'Backoff', waits: [0, 300, 1200, 2700, 4800, 7000, 7000, 7000, 7000, 7000], jitterFrom: 3, jitterMs: 1000 } as const
const cap = (n: keyof typeof COUNTS): number => COUNTS[n]

const done = (prev: St, s: St, label: string, out: Tx[], fx: Fx[], seams: Seam[], start: TimerName[]): Step => {
  for (const t of armed(s)) if (!armed(prev).includes(t) && !start.includes(t)) start.push(t)
  return { s, label, out, fx, seams, start }
}

/** 지금 돌아야 하는 타이머 — 원천 timer(…).armed */
export function armed(s: St): TimerName[] {
  const on: TimerName[] = []
  if (s.wait === 'BIND') on.push('TBind')
  if (s.wait === 'RESUME') on.push('TReq')
  if (s.hb && s.sock === 'OPEN') on.push('THb')
  if ((s.cs === 'CONNECTING' || s.cs === 'RESUMING') && s.sock === 'CLOSED') on.push('Backoff')
  if (s.cs === 'ACTIVE' && s.tries > 0) on.push('TStable')
  return on
}

/** 앱이 접속을 요청했다(§[RULE-SES-DISC-CONNECT]) (앱: 앱이 접속을 요청했다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function connect(s: St): Step | null {
  if (!(s.cs === 'DISCONNECTED')) return null
  if (s.token === 'NONE') {
    return done(s, s, 'SES.C.DISCONNECTED.connect_no_token', [], ['app.need_token'], [], [])
  }
  return done(s, { ...s, cs: 'CONNECTING', sock: 'OPENING', tries: 0, late: false }, 'SES.C.DISCONNECTED.connect', [], [], [], [])
}

/** 앱이 새 토큰을 줬다(§[RULE-SES-CONN-BIND-FAIL] 2 · §[RULE-SES-RES-BIND-RES] 1 의 요구에 답한다) (앱: 앱이 새 토큰을 줬다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function newToken(s: St): Step | null {
  if (!(s.cs === 'DISCONNECTED' && s.token !== 'VALID')) return null
  return done(s, { ...s, token: 'VALID' }, 'SES.C.DISCONNECTED.new_token', [], [], [], [])
}

/** 소켓이 열렸다(§[SES.C.CONNECTING.open] · §[RULE-SES-RES-OPEN]) (바깥: 소켓이 열렸다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function sockOpen(s: St): Step | null {
  if (!(s.cs === 'CONNECTING' || s.cs === 'RESUMING')) return null
  if (s.cs === 'CONNECTING') {
    return done(s, { ...s, sock: 'OPEN', wait: 'BIND', sent: 0 }, 'SES.C.CONNECTING.open', [{ ws: 'BIND', part: 'req', token: s.token, pc_mode: s.pcAsk }], [], [], [])
  }
  if (s.late) {
    return done(s, { ...s, sock: 'OPEN', wait: 'BIND', sent: 0 }, 'SES.C.RESUMING.open_late', [{ ws: 'BIND', part: 'req', token: s.token, pc_mode: s.pcAsk }], [], [], [])
  }
  return done(s, { ...s, sock: 'OPEN', wait: 'BIND', sent: s.sid }, 'SES.C.RESUMING.open', [{ ws: 'BIND', part: 'req', token: s.token, session_id: s.sid, pc_mode: s.pcAsk }], [], [], [])
}

/** BIND 응답을 받았다(§[SES.C.CONNECTING.bind_ok] · §[RULE-SES-CONN-BIND-FAIL] · §[RULE-SES-RES-BIND-RES]) (받음: BIND) — 받는 상태 밖이면 null(사건이 없던 것) · 읽는 것: marked = ROOM.rejoin */
export function bindRes(s: St, m: { readonly code: number; readonly heartbeat_interval: number; readonly part: Part; readonly pc_mode: PcMode; readonly resume_window_ms: number; readonly session_id: number }, marked: boolean): Step | null {
  if (!(s.cs === 'CONNECTING' || s.cs === 'RESUMING')) return null
  if (s.cs === 'CONNECTING' && m.part === 'res' && marked) {
    return done(s, { ...s, sid: m.session_id, hbMs: m.heartbeat_interval, winMs: m.resume_window_ms, pcm: m.pc_mode, wait: 'NONE', hb: true, cs: 'ACTIVE' }, 'SES.C.CONNECTING.bind_ok_rebuild', [], ['app.rebuilt'], [{ fx: 'rooms.rejoin', to: 'ROOM', at: 'all' }, { fx: 'pub.reregister_all', to: 'PUB', at: 'all' }], [])
  }
  if (s.cs === 'CONNECTING' && m.part === 'res') {
    return done(s, { ...s, sid: m.session_id, hbMs: m.heartbeat_interval, winMs: m.resume_window_ms, pcm: m.pc_mode, wait: 'NONE', hb: true, cs: 'ACTIVE' }, 'SES.C.CONNECTING.bind_ok', [], ['app.connected'], [], [])
  }
  if (s.cs === 'CONNECTING' && m.code === 2002) {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE' }, 'SES.C.CONNECTING.bind_2002', [], [], [{ fx: 'rooms.close_all', to: 'ROOM', at: 'all' }], [])
  }
  if (s.cs === 'CONNECTING' && m.code === 2003) {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE', token: 'NONE' }, 'SES.C.CONNECTING.bind_2003', [], ['app.need_token'], [], [])
  }
  if (s.cs === 'CONNECTING' && m.code < 2000) {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE' }, 'SES.C.CONNECTING.bind_1xxx', [], ['app.bug'], [{ fx: 'rooms.close_all', to: 'ROOM', at: 'all' }], [])
  }
  if (s.cs === 'CONNECTING') {
    return done(s, { ...s, sock: 'CLOSED', wait: 'NONE' }, 'SES.C.CONNECTING.bind_fail', [], [], [], [])
  }
  if (m.code === 2003) {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE', token: 'NONE' }, 'SES.C.RESUMING.bind_2003', [], ['app.need_token'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.down_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
  }
  if (m.code === 2002) {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE' }, 'SES.C.RESUMING.bind_2002', [], [], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.close_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
  }
  if (m.part === 'fail') {
    return done(s, { ...s, sock: 'CLOSED', wait: 'NONE' }, 'SES.C.RESUMING.bind_fail', [], [], [], [])
  }
  if (s.sent !== 0 && m.session_id === s.sent) {
    return done(s, { ...s, sid: m.session_id, hbMs: m.heartbeat_interval, winMs: m.resume_window_ms, pcm: m.pc_mode, hb: true, wait: 'RESUME' }, 'SES.C.RESUMING.bind_same', [{ ws: 'RESUME', part: 'req' }], [], [], [])
  }
  return done(s, { ...s, sid: m.session_id, hbMs: m.heartbeat_interval, winMs: m.resume_window_ms, pcm: m.pc_mode, hb: true, wait: 'NONE', cs: 'ACTIVE', late: false }, 'SES.C.RESUMING.bind_new', [], ['app.rebuilt'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.down_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }, { fx: 'rooms.rejoin', to: 'ROOM', at: 'all' }, { fx: 'pub.reregister_all', to: 'PUB', at: 'all' }], [])
}

/** RESUME 응답을 받았다(§[RULE-SES-RES-RESUME-OK] · §[RULE-SES-REBUILD]) (받음: RESUME) — 받는 상태 밖이면 null(사건이 없던 것) · 읽는 것: dead = LINK.assoc · LINK.ice */
export function resumeRes(s: St, m: { readonly part: Part }, dead: boolean): Step | null {
  if (!(s.cs === 'RESUMING')) return null
  if (m.part === 'res' && dead) {
    return done(s, { ...s, cs: 'ACTIVE', wait: 'NONE', late: false }, 'SES.C.RESUMING.resume_ok_repair', [], ['app.resumed'], [{ fx: 'rooms.snapshot', to: 'ROOM', at: 'all' }, { fx: 'pub.resume_check', to: 'PUB', at: 'all' }, { fx: 'media.repair', to: 'LINK', at: 'all' }], [])
  }
  if (m.part === 'res') {
    return done(s, { ...s, cs: 'ACTIVE', wait: 'NONE', late: false }, 'SES.C.RESUMING.resume_ok', [], ['app.resumed'], [{ fx: 'rooms.snapshot', to: 'ROOM', at: 'all' }, { fx: 'pub.resume_check', to: 'PUB', at: 'all' }], [])
  }
  return done(s, { ...s, wait: 'NONE', cs: 'ACTIVE', late: false }, 'SES.C.RESUMING.resume_2008', [], ['app.rebuilt'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.down_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }, { fx: 'rooms.rejoin', to: 'ROOM', at: 'all' }, { fx: 'pub.reregister_all', to: 'PUB', at: 'all' }], [])
}

/** 소켓이 끊겼다 — c 는 LEAVE 사유(0 = LEAVE 없이 끊겼다 · §[SES.C.any]) (바깥: 소켓이 끊겼다) · 읽는 것: carry = ROOM.rs · PUB.ps */
export function drop(s: St, c: number, carry: boolean): Step {
  if (c === 1008 || c === 4006 || c === 4007 || c === 2010) {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE', hb: false }, 'SES.C.any.drop_final', [], ['app.disconnected'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.close_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
  }
  if (c === 2009 || c === 5004) {
    return done(s, { ...s, cs: 'CONNECTING', sock: 'CLOSED', wait: 'NONE', hb: false, sid: 0, late: false }, 'SES.C.any.drop_reclaimed', [], [], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.down_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
  }
  if (carry) {
    return done(s, { ...s, cs: 'RESUMING', sock: 'CLOSED', wait: 'NONE', hb: false, late: s.cs === 'ACTIVE' || s.wait === 'RESUME' ? false : s.late }, 'SES.C.any.drop_carry', [], [], [], [])
  }
  return done(s, { ...s, cs: 'CONNECTING', sock: 'CLOSED', wait: 'NONE', hb: false }, 'SES.C.any.drop', [], [], [], [])
}

/** 끊긴 순간부터의 경과가 resume_window_ms 를 넘었다(클라 시계 · §[RULE-SES-BACKOFF-LADDER]) (바깥: 끊긴 뒤 경과가 재개 창을 넘었다(클라 시계)) — 받는 상태 밖이면 null(사건이 없던 것) */
export function late(s: St): Step | null {
  if (!(s.cs === 'RESUMING' && !s.late)) return null
  return done(s, { ...s, late: true }, 'SES.C.RESUMING.window_passed', [], [], [], [])
}

/** 앱이 연결을 끊는다(RULE-SES-LEAVE-PROC) (앱: 앱이 연결을 끊는다) — 받는 상태 밖이면 null(사건이 없던 것) */
export function disconnect(s: St): Step | null {
  if (!(s.cs !== 'DISCONNECTED')) return null
  if (s.cs === 'ACTIVE') {
    return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE', hb: false }, 'SES.C.ACTIVE.disconnect', [{ ws: 'LEAVE', part: 'req' }], ['app.disconnected'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.close_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
  }
  return done(s, { ...s, cs: 'DISCONNECTED', sock: 'CLOSED', wait: 'NONE', hb: false }, 'SES.C.any.disconnect', [], ['app.disconnected'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.close_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
}

/** 토큰이 만료됐다(시간이 흘렀다) (바깥: 토큰이 만료됐다(시간)) */
export function tokenAged(s: St): Step {
  return done(s, { ...s, token: 'EXPIRED' }, 'SES.C.any.token_expired', [], [], [], [])
}

/** 타이머 만료 — 돌고 있지 않은 타이머면 null(부르는 쪽이 멈췄어야 한다) */
export function expire(s: St, t: TimerName): Step | null {
  if (!armed(s).includes(t)) return null
  switch (t) {
    case 'TBind': {
      return done(s, { ...s, sock: 'CLOSED', wait: 'NONE' }, 'SES.C.any.TBind', [], [], [], [])
    }
    case 'TReq': {
      return done(s, { ...s, sock: 'CLOSED', wait: 'NONE', hb: false }, 'SES.C.any.TReq', [], [], [], [])
    }
    case 'THb': {
      return done(s, s, 'SES.C.any.THb', [{ ws: 'HEARTBEAT', part: 'req' }], [], [], [])
    }
    case 'Backoff': {
      if (s.tries < cap('CBackoff')) {
        return done(s, { ...s, sock: 'OPENING', tries: s.tries + 1 }, 'SES.C.any.Backoff', [], [], [], [])
      }
      if (s.cs === 'RESUMING') {
        return done(s, { ...s, cs: 'DISCONNECTED' }, 'SES.C.RESUMING.Backoff_exhaust', [], ['app.disconnected'], [{ fx: 'floor.down_all', to: 'FLR', at: 'all' }, { fx: 'rooms.close_all', to: 'ROOM', at: 'all' }, { fx: 'media.close_all', to: 'LINK', at: 'all' }], [])
      }
      return done(s, { ...s, cs: 'DISCONNECTED' }, 'SES.C.CONNECTING.Backoff_exhaust', [], ['app.disconnected'], [{ fx: 'rooms.close_all', to: 'ROOM', at: 'all' }], [])
    }
    case 'TStable': {
      return done(s, { ...s, tries: 0 }, 'SES.C.any.TStable', [], [], [], [])
    }
  }
}
