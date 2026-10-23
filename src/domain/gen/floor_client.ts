// ★생성 파일 — gen/floor_client.mts 가 원천(context/spec/protocol · areas/flr/behavior/client.ts)에서 짓는다. 손으로 고치지 않는다.
// IR sha256 67967e270560c2c4 · 3GPP TS 24.380 §6.2.4 floor participant. 같은 원천의 검증 모형 out/floor/Floor.tla 와 실행 기록 재생으로 견준다(tools/replay_client.mts).
// 집행은 부르는 쪽 몫이다 — out(DC 로 보낼 것) · ack(ACK 으로 답할 것) · fx(마이크 · 화면 · 앱 알림) · start(다시 걸 타이머). armed() 밖의 타이머는 멈춘다.
/* eslint-disable */

export type CState = 'NOPERM' | 'PREQ' | 'PERM' | 'PREL' | 'QUEUED'
export type CSub = 'WAIT' | 'QUERY' | 'GRANTED'
export type Fx = 'mic.close' | 'mic.open' | 'media.render' | 'app.floor_unreliable' | 'app.floor_reliable' | 'app.speaker' | 'app.speaker_none' | 'app.granted' | 'app.denied' | 'app.queued' | 'app.revoked' | 'app.granted_queued' | 'app.request_timeout' | 'app.queue_timeout' | 'app.grant_expired'
export type TimerName = 'T101' | 'T100' | 'T104' | 'T132'

/** 클라 상태 — 원천 Cl(areas/flr/model/state.ts) */
export interface Cl {
  /** 클라 상태(6.2.4) */
  readonly cs: CState
  /** queued 세부 */
  readonly sub: CSub
  /** 사용자가 말하려 한다 */
  readonly want: boolean
  /** T101(REQUEST 재전송) 횟수 */
  readonly c101: number
  /** T100(RELEASE 재전송) 횟수 */
  readonly c100: number
  /** T104(순번 질의 재전송) 횟수 */
  readonly c104: number
  /** 누름 횟수 — 검사 상한(MaxPress)용 */
  readonly presses: number
  /** 요청에 실은 우선순위 */
  readonly prio: number
  /** 허가된 시간(초) */
  readonly grant: number
  /** 이 방이 발행 방인가(전환 응답을 받았다) */
  readonly isPub: boolean
  /** 반이중 발행 트랙을 발행했나 */
  readonly hasHalf: boolean
  /** 방을 나갔다 */
  readonly left: boolean
  /** 화자 표시 — 화면에 보이는 화자(내가 말하는 중이면 없음) */
  readonly shown: string | null
  /** 화자 표시에 마지막으로 쓴 TAKEN · IDLE 의 일련번호(DEV-FLR-SEQ-DISPLAY) */
  readonly seen: number
}
export const initial = (): Cl => ({ cs: 'NOPERM', sub: 'WAIT', want: false, c101: 0, c100: 0, c104: 0, presses: 0, prio: 0, grant: 0, isPub: false, hasHalf: false, left: false, shown: null, seen: 0 })

/** 서버 → 클라 메시지(wire 이름 · 방 칸은 입구가 거른다 · ack = 머리의 A 비트 — 서야 ACK 으로 답한다) */
export type Rx =
  | { t: 'TAKEN'; ack?: boolean; speaker: string; seq: number }
  | { t: 'IDLE'; ack?: boolean; prev?: string; seq: number }
  | { t: 'GRANTED'; ack?: boolean; priority: number; duration: number; seq: number }
  | { t: 'DENY'; ack?: boolean; cause: number; reason?: string }
  | { t: 'QINFO'; ack?: boolean; info: { position: number; priority: number } }
  | { t: 'REVOKE'; ack?: boolean; cause: number; reason?: string }
/** 클라 → 서버 메시지(이 상태기가 내는 것) */
export type Tx =
  | { t: 'REQUEST'; priority?: number }
  | { t: 'RELEASE' }
  | { t: 'QPOS_REQ' }
export interface Ack { readonly of: 'TAKEN' | 'GRANTED' | 'DENY'; readonly seq?: number }

/** 한 걸음의 결과 — label 은 원천의 동작 라벨(연동규격서 FLR.C.…) */
export interface Step { readonly s: Cl; readonly label: string; readonly out: readonly Tx[]; readonly ack: readonly Ack[]; readonly fx: readonly Fx[]; readonly start: readonly TimerName[] }

/** 원장 — 타이머(ms) · 재전송 횟수 · 일련번호 폭 */
export const TIMER_MS: Record<TimerName, number> = { T101: 500, T100: 500, T104: 500, T132: 2000 }
export const COUNTS = { C101: 3, C100: 3, C104: 3 } as const
export const SEQ_WRAP = 65536

const cap = (n: keyof typeof COUNTS): number => COUNTS[n]
/** 일련번호 a 가 b 보다 새것인가(감김 고려 — 원문 8.2.3.10 · DEV-FLR-SEQ-DISPLAY) */
export const newer = (a: number, b: number): boolean => a !== b && ((a - b + SEQ_WRAP) % SEQ_WRAP) < SEQ_WRAP / 2
const done = (prev: Cl, s: Cl, label: string, out: Tx[], ack: Ack[], fx: Fx[], start: TimerName[]): Step => {
  for (const t of armed(s)) if (!armed(prev).includes(t) && !start.includes(t)) start.push(t)
  return { s, label, out, ack, fx, start }
}

/** 지금 돌아야 하는 타이머 — 원천 timer(…).armed */
export function armed(s: Cl): TimerName[] {
  const on: TimerName[] = []
  if (s.cs === 'PREQ') on.push('T101')
  if (s.cs === 'PREL') on.push('T100')
  if (s.cs === 'QUEUED' && s.sub === 'QUERY') on.push('T104')
  if (s.cs === 'QUEUED' && s.sub === 'GRANTED') on.push('T132')
  return on
}

/** 원천 절차 → 입구 이름 — 다른 영역의 이음매가 부르는 입구를 찾을 때(위 IR seams 의 react 는 절차 이름이다) */
export const PROC_ENTRY = { CPress: 'press', CRelease: 'release', CIntent: 'intent', CQpos: 'queuePosition', CRtpTx: 'rtpTx', CRtpRx: 'rtpRx', CRegHalf: 'registerHalf', CPubSel: 'pubSelect', CAway: 'pubAway', CLeave: 'leave', CDown: 'down', CDcDown: 'dcDown', CDcUp: 'dcUp' } as const

/** 누름 */
export function press(s: Cl, p: number): Step {
  if (s.cs === 'NOPERM') {
    return done(s, { ...s, cs: 'PREQ', want: true, presses: s.presses + 1, prio: p, c101: 1 }, 'FLR.C.NOPERM.press', [{ t: 'REQUEST', priority: p }], [], [], ['T101'])
  }
  return done(s, s, 'FLR.C.any.press_drop', [], [], [], [])
}

/** 뗌 — 받는 상태 밖이면 null(사건이 없던 것) */
export function release(s: Cl): Step | null {
  if (!(s.cs === 'PREQ' || s.cs === 'PERM' || s.cs === 'QUEUED')) return null
  if (s.cs === 'PREQ') {
    return done(s, { ...s, cs: 'PREL', want: false, c100: 1 }, 'FLR.C.PREQ.release', [{ t: 'RELEASE' }], [], [], ['T100'])
  }
  if (s.cs === 'PERM') {
    return done(s, { ...s, cs: 'PREL', want: false, c100: 1 }, 'FLR.C.PERM.release', [{ t: 'RELEASE' }], [], ['mic.close'], ['T100'])
  }
  return done(s, { ...s, cs: 'PREL', want: false, c100: 1 }, 'FLR.C.QUEUED.release', [{ t: 'RELEASE' }], [], [], ['T100'])
}

/** 승계 허가 뒤 발언 의지 표시 — 받는 상태 밖이면 null(사건이 없던 것) */
export function intent(s: Cl): Step | null {
  if (!(s.cs === 'QUEUED' && s.sub === 'GRANTED')) return null
  return done(s, { ...s, cs: 'PERM', shown: null }, 'FLR.C.QUEUED.intent', [], [], ['mic.open'], [])
}

/** 앱이 순번을 묻는다 — 받는 상태 밖이면 null(사건이 없던 것) */
export function queuePosition(s: Cl): Step | null {
  if (!(s.cs === 'QUEUED' && s.sub === 'WAIT')) return null
  return done(s, { ...s, sub: 'QUERY', c104: 1 }, 'FLR.C.QUEUED.qpos', [{ t: 'QPOS_REQ' }], [], [], ['T104'])
}

/** 보낸다 */
export function rtpTx(s: Cl): Step {
  return done(s, s, 'FLR.C.PERM.rtp_tx', [], [], [], [])
}

/** 남의 목소리가 닿는다 */
export function rtpRx(s: Cl): Step {
  if (s.cs === 'NOPERM') {
    return done(s, s, 'FLR.C.NOPERM.rtp_rx', [], [], ['media.render'], [])
  }
  if (s.cs === 'PREQ') {
    return done(s, s, 'FLR.C.PREQ.rtp_rx', [], [], ['media.render'], [])
  }
  if (s.cs === 'PERM') {
    return done(s, s, 'FLR.C.PERM.rtp_rx', [], [], ['media.render'], [])
  }
  if (s.cs === 'PREL') {
    return done(s, s, 'FLR.C.PREL.rtp_rx', [], [], ['media.render'], [])
  }
  return done(s, s, 'FLR.C.QUEUED.rtp_rx', [], [], ['media.render'], [])
}

/** WS PUBLISH_TRACKS{duplex:half} */
export function registerHalf(s: Cl): Step {
  return done(s, { ...s, hasHalf: true }, 'FLR.C.any.reg_half', [], [], [], [])
}

/** WS AFFILIATION{pub_select} */
export function pubSelect(s: Cl): Step {
  return done(s, { ...s, isPub: true }, 'FLR.C.any.pub_select', [], [], [], [])
}

/** 발행 방을 떠난다 */
export function pubAway(s: Cl): Step {
  return done(s, { ...s, cs: 'NOPERM', want: false, isPub: false }, 'FLR.C.any.pub_away', [], [], ['mic.close'], [])
}

/** WS ROOM_LEAVE — 방을 떠난다 */
export function leave(s: Cl): Step {
  return done(s, { ...s, cs: 'NOPERM', want: false, isPub: false, shown: null, left: true }, 'FLR.C.any.leave', [], [], ['mic.close'], [])
}

/** 재구축으로 그 방 발언권을 내린다(세션 전체 · 그 서버) */
export function down(s: Cl): Step {
  return done(s, { ...s, cs: 'NOPERM', want: false, isPub: false, hasHalf: false, shown: null, seen: 0 }, 'FLR.C.any.down', [], [], ['mic.close'], [])
}

/** DC 만 끊김 */
export function dcDown(s: Cl): Step {
  return done(s, s, 'FLR.C.any.dc_down', [], [], ['app.floor_unreliable'], [])
}

/** DC 다시 열림 */
export function dcUp(s: Cl): Step {
  return done(s, s, 'FLR.C.any.dc_reopen', [], [], ['app.floor_reliable'], [])
}

/** 타이머 만료 — 돌고 있지 않은 타이머면 null(부르는 쪽이 멈췄어야 한다) */
export function expire(s: Cl, t: TimerName): Step | null {
  if (!armed(s).includes(t)) return null
  switch (t) {
    case 'T101': {
      if (s.c101 < cap('C101')) {
        return done(s, { ...s, c101: s.c101 + 1 }, 'FLR.C.PREQ.T101', [{ t: 'REQUEST', priority: s.prio }], [], [], [])
      }
      return done(s, { ...s, cs: 'NOPERM' }, 'FLR.C.PREQ.T101_exhaust', [], [], ['app.request_timeout'], [])
    }
    case 'T100': {
      if (s.c100 < cap('C100')) {
        return done(s, { ...s, c100: s.c100 + 1 }, 'FLR.C.PREL.T100', [{ t: 'RELEASE' }], [], [], [])
      }
      return done(s, { ...s, cs: 'NOPERM' }, 'FLR.C.PREL.T100_exhaust', [], [], [], [])
    }
    case 'T104': {
      if (s.c104 < cap('C104')) {
        return done(s, { ...s, c104: s.c104 + 1 }, 'FLR.C.QUEUED.T104', [{ t: 'QPOS_REQ' }], [], [], [])
      }
      return done(s, { ...s, cs: 'PREL', c100: 1 }, 'FLR.C.QUEUED.T104_exhaust', [{ t: 'RELEASE' }], [], ['app.queue_timeout'], ['T100'])
    }
    case 'T132': {
      return done(s, { ...s, cs: 'NOPERM', want: false }, 'FLR.C.QUEUED.T132', [{ t: 'RELEASE' }], [], ['app.grant_expired'], [])
    }
  }
}

/** 서버 → 클라 사건 — 상태 × 사건 표(원문 6.2.4) · 표에 없는 칸은 other(6.2.4.1) */
export function receive(s: Cl, m: Rx): Step {
  switch (s.cs) {
    case 'NOPERM':
      switch (m.t) {
        case 'TAKEN': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, shown: m.speaker, seen: m.seq }, 'FLR.C.NOPERM.rx_TAKEN', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], ['app.speaker'], [])
          }
          return done(s, s, 'FLR.C.NOPERM.rx_TAKEN_stale', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], [], [])
        }
        case 'IDLE': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, shown: null, seen: m.seq }, 'FLR.C.NOPERM.rx_IDLE', [], [], ['app.speaker_none'], [])
          }
          return done(s, s, 'FLR.C.NOPERM.rx_IDLE_stale', [], [], [], [])
        }
        default:
          return done(s, s, 'FLR.C.NOPERM.rx_other', [], [], [], [])
      }
      break
    case 'PREQ':
      switch (m.t) {
        case 'GRANTED': {
          return done(s, { ...s, cs: 'PERM', grant: m.duration, shown: null, seen: newer(m.seq, s.seen) ? m.seq : s.seen }, 'FLR.C.PREQ.rx_GRANTED', [], [...(m.ack ? [{ of: 'GRANTED' as const, seq: m.seq }] : [])], ['app.granted', 'mic.open'], [])
        }
        case 'DENY': {
          return done(s, { ...s, cs: 'NOPERM', want: false }, 'FLR.C.PREQ.rx_DENY', [], [...(m.ack ? [{ of: 'DENY' as const }] : [])], ['app.denied'], [])
        }
        case 'QINFO': {
          return done(s, { ...s, cs: 'QUEUED', sub: 'WAIT' }, 'FLR.C.PREQ.rx_QINFO', [], [], ['app.queued'], [])
        }
        case 'TAKEN': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, shown: m.speaker, seen: m.seq }, 'FLR.C.PREQ.rx_TAKEN', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], ['app.speaker'], [])
          }
          return done(s, s, 'FLR.C.PREQ.rx_TAKEN_stale', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], [], [])
        }
        case 'IDLE': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, shown: null, seen: m.seq }, 'FLR.C.PREQ.rx_IDLE', [], [], ['app.speaker_none'], [])
          }
          return done(s, s, 'FLR.C.PREQ.rx_IDLE_stale', [], [], [], [])
        }
        default:
          return done(s, s, 'FLR.C.PREQ.rx_other', [], [], [], [])
      }
      break
    case 'PERM':
      switch (m.t) {
        case 'REVOKE': {
          return done(s, { ...s, cs: 'PREL', want: false, c100: 1 }, 'FLR.C.PERM.rx_REVOKE', [{ t: 'RELEASE' }], [], ['mic.close', 'app.revoked'], ['T100'])
        }
        case 'GRANTED': {
          return done(s, { ...s, grant: m.duration, seen: newer(m.seq, s.seen) ? m.seq : s.seen }, 'FLR.C.PERM.rx_GRANTED', [], [...(m.ack ? [{ of: 'GRANTED' as const, seq: m.seq }] : [])], [], [])
        }
        case 'IDLE': {
          return done(s, s, 'FLR.C.PERM.rx_IDLE', [], [], [], [])
        }
        case 'TAKEN': {
          return done(s, s, 'FLR.C.PERM.rx_TAKEN', [], [], [], [])
        }
        default:
          return done(s, s, 'FLR.C.PERM.rx_other', [], [], [], [])
      }
      break
    case 'PREL':
      switch (m.t) {
        case 'IDLE': {
          return done(s, { ...s, cs: 'NOPERM', shown: null, seen: m.seq }, 'FLR.C.PREL.rx_IDLE', [], [], ['app.speaker_none'], [])
        }
        case 'TAKEN': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, cs: 'NOPERM', shown: m.speaker, seen: m.seq }, 'FLR.C.PREL.rx_TAKEN', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], ['app.speaker'], [])
          }
          return done(s, s, 'FLR.C.PREL.rx_TAKEN_seen', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], [], [])
        }
        case 'REVOKE': {
          return done(s, s, 'FLR.C.PREL.rx_REVOKE', [], [], ['app.revoked'], [])
        }
        case 'GRANTED': {
          return done(s, { ...s, seen: newer(m.seq, s.seen) ? m.seq : s.seen }, 'FLR.C.PREL.rx_GRANTED', [], [...(m.ack ? [{ of: 'GRANTED' as const, seq: m.seq }] : [])], [], [])
        }
        default:
          return done(s, s, 'FLR.C.PREL.rx_other', [], [], [], [])
      }
      break
    case 'QUEUED':
      switch (m.t) {
        case 'TAKEN': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, shown: m.speaker, seen: m.seq }, 'FLR.C.QUEUED.rx_TAKEN', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], ['app.speaker'], [])
          }
          return done(s, s, 'FLR.C.QUEUED.rx_TAKEN_stale', [], [...(m.ack ? [{ of: 'TAKEN' as const, seq: m.seq }] : [])], [], [])
        }
        case 'GRANTED': {
          if (s.sub !== 'GRANTED') {
            return done(s, { ...s, sub: 'GRANTED', grant: m.duration, shown: null, seen: newer(m.seq, s.seen) ? m.seq : s.seen }, 'FLR.C.QUEUED.rx_GRANTED', [], [...(m.ack ? [{ of: 'GRANTED' as const, seq: m.seq }] : [])], ['app.granted_queued'], [])
          }
          return done(s, { ...s, seen: newer(m.seq, s.seen) ? m.seq : s.seen }, 'FLR.C.QUEUED.rx_GRANTED_again', [], [...(m.ack ? [{ of: 'GRANTED' as const, seq: m.seq }] : [])], [], [])
        }
        case 'DENY': {
          return done(s, { ...s, cs: 'NOPERM', want: false }, 'FLR.C.QUEUED.rx_DENY', [], [...(m.ack ? [{ of: 'DENY' as const }] : [])], ['app.denied'], [])
        }
        case 'IDLE': {
          if (newer(m.seq, s.seen)) {
            return done(s, { ...s, cs: 'NOPERM', shown: null, seen: m.seq }, 'FLR.C.QUEUED.rx_IDLE', [], [], ['app.speaker_none'], [])
          }
          return done(s, s, 'FLR.C.QUEUED.rx_IDLE_stale', [], [], [], [])
        }
        case 'QINFO': {
          if (s.sub === 'QUERY') {
            return done(s, { ...s, sub: 'WAIT' }, 'FLR.C.QUEUED.rx_QINFO_answer', [], [], ['app.queued'], [])
          }
          return done(s, s, 'FLR.C.QUEUED.rx_QINFO', [], [], ['app.queued'], [])
        }
        default:
          return done(s, s, 'FLR.C.QUEUED.rx_other', [], [], [], [])
      }
      break
  }
  throw new Error('닿지 않는 칸')
}
