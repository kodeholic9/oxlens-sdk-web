// author: kodeholic (powered by Claude)
// floor 원천 · 3GPP TS 24.380 §6.2.4 — 방마다의 발언권 클라 상태기.
//
// 판정은 여기, 집행은 밖이다 — 보낼 것과 알릴 것을 값으로 돌려주고 DC 송신·게이트는 주인이 한다.
// 절이 없는 칸의 메시지는 버리고 상태를 유지한다(6.2.4.1). ACK 은 절차가 있는 칸에서만 보낸다.
import { Message, Tlv, Type, byte, str, text, u8, u16 } from '../internal/mbcp.js'

export type Phase = 'off' | 'no_permission' | 'pending_request' | 'has_permission' | 'pending_release' | 'queued'
export type EndCause =
  | 'released' | 'revoked' | 'denied' | 't1_reclaimed' | 't132_expired'
  | 'no_response' | 'moved' | 'left' | 'rebuilt'

export const T101_MS = 500
export const C101 = 3
export const T100_MS = 500
export const C100 = 3
export const T104_MS = 500
export const C104 = 3
export const T132_MS = 2_000

export type Signal =
  | { readonly kind: 'phase' }
  | { readonly kind: 'granted' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'released' }
  | { readonly kind: 'speaker'; readonly userId: string | null }

export interface Outcome {
  readonly send: readonly Message[]
  readonly signals: readonly Signal[]
  /** true = 마이크를 연다, false = 닫는다, undefined = 그대로. */
  readonly gate?: boolean
}

type Sub = 'wait' | 'query' | 'granted'

class Step {
  readonly send: Message[] = []
  readonly signals: Signal[] = []
  gate: boolean | undefined
  out(): Outcome {
    return { send: this.send, signals: this.signals, ...(this.gate === undefined ? {} : { gate: this.gate }) }
  }
}

export class FloorRoom {
  phase: Phase = 'off'
  priority = 0
  remainingSec: number | undefined
  grantedPriority: number | undefined
  queue: { position: number; priority: number } | undefined
  lastDeny: { cause: number; text?: string } | undefined
  lastRevoke: { cause: number; text?: string } | undefined
  lastEnd: EndCause | undefined
  trusted = true
  speaker: string | null = null
  talkingSince: number | undefined

  private sub: Sub = 'wait'
  private want = false
  private c101 = 0
  private c100 = 0
  private c104 = 0
  private t101Due = 0
  private t100Due = 0
  private t104Due = 0
  private t132Due = 0

  constructor(readonly roomId: string, readonly me: string, public input: 'hold' | 'toggle' = 'hold') {}

  get acceptPending(): boolean {
    return this.phase === 'queued' && this.sub === 'granted'
  }

  get canRequest(): boolean {
    return this.trusted && (this.phase === 'off' || this.phase === 'no_permission')
  }

  /** 반이중 발행 트랙이 섰다 — 그 전의 요청은 서버가 DENY(5) 로 답한다. */
  armed(): Outcome {
    if (this.phase !== 'off') return new Step().out()
    this.phase = 'no_permission'
    const s = new Step()
    s.signals.push({ kind: 'phase' })
    return s.out()
  }

  /** 6.2.4.3.5 — has no permission 에서만 요청이 나간다. toggle 의 승계 허가 창에서는 의지 표시(6.2.4.9.12)다. */
  press(now: number): Outcome {
    const s = new Step()
    if (this.acceptPending) {
      this.want = true
      this.toPermission(s, now)
      return s.out()
    }
    if (this.phase !== 'no_permission' && this.phase !== 'off') return s.out()
    this.phase = 'pending_request'
    this.want = true
    this.c101 = 1
    this.t101Due = now + T101_MS
    s.send.push(this.request())
    s.signals.push({ kind: 'phase' })
    return s.out()
  }

  /** 6.2.4.4.8 · 6.2.4.5.3 · 6.2.4.9.6 — 뗌 · 허가 전에 뗌 · 대기 철회는 모두 pending Release 로 간다. */
  release(now: number): Outcome {
    const s = new Step()
    if (this.phase !== 'pending_request' && this.phase !== 'has_permission' && this.phase !== 'queued') return s.out()
    if (this.phase === 'has_permission') s.gate = false
    this.toPendingRelease(s, now)
    return s.out()
  }

  /** 6.2.4.9.9 — 앱이 순번을 묻는다. queued 이고 승계 허가 전일 때만이다. */
  queuePosition(now: number): Outcome {
    const s = new Step()
    if (this.phase !== 'queued' || this.sub !== 'wait') return s.out()
    this.sub = 'query'
    this.c104 = 1
    this.t104Due = now + T104_MS
    s.send.push(this.bare(Type.QueuePosRequest))
    return s.out()
  }

  receive(msg: Message, now: number): Outcome {
    const room = text(msg, Tlv.Room)
    const s = new Step()
    if (room !== undefined && room !== this.roomId) return s.out()
    switch (this.phase) {
      case 'off':
      case 'no_permission': this.inNoPermission(msg, s); break
      case 'pending_request': this.inPendingRequest(msg, s, now); break
      case 'has_permission': this.inPermission(msg, s, now); break
      case 'pending_release': this.inPendingRelease(msg, s); break
      case 'queued': this.inQueued(msg, s, now); break
    }
    return s.out()
  }

  tick(now: number): Outcome {
    const s = new Step()
    if (this.phase === 'pending_request' && now >= this.t101Due) {
      if (this.c101 < C101) {
        this.c101 += 1
        this.t101Due = now + T101_MS
        s.send.push(this.request())
      } else {
        this.settle('no_response', s)
      }
    } else if (this.phase === 'pending_release' && now >= this.t100Due) {
      if (this.c100 < C100) {
        this.c100 += 1
        this.t100Due = now + T100_MS
        s.send.push(this.bare(Type.Release))
      } else {
        this.settle('released', s)
      }
    } else if (this.phase === 'queued' && this.sub === 'query' && now >= this.t104Due) {
      if (this.c104 < C104) {
        this.c104 += 1
        this.t104Due = now + T104_MS
        s.send.push(this.bare(Type.QueuePosRequest))
      } else {
        this.lastEnd = 'no_response'
        this.toPendingRelease(s, now)
      }
    } else if (this.acceptPending && now >= this.t132Due) {
      s.send.push(this.bare(Type.Release))
      this.want = false
      this.settle('t132_expired', s)
    }
    return s.out()
  }

  /** DC 만 끊겼다 — 상태는 그대로이고 이 표시를 믿을 수 없을 뿐이다(DEV-DC-DOWN). */
  setTrusted(on: boolean): Outcome {
    const s = new Step()
    if (this.trusted === on) return s.out()
    this.trusted = on
    s.signals.push({ kind: 'phase' })
    return s.out()
  }

  /** 발행 방 이탈 · 퇴장 · 재구축 — 응답 뒤 has no permission 으로 내리고 타이머를 멈춘다(DEV-PUB-AWAY). */
  reset(cause: EndCause): Outcome {
    const s = new Step()
    if (this.phase === 'off') return s.out()
    if (this.phase === 'has_permission') s.gate = false
    this.want = false
    this.settle(cause, s)
    this.speaker = null
    s.signals.push({ kind: 'speaker', userId: null })
    return s.out()
  }

  private inNoPermission(msg: Message, s: Step): void {
    if (msg.type === Type.Taken) this.showSpeaker(text(msg, Tlv.Speaker) ?? null, s)
    else if (msg.type === Type.Idle) this.showSpeaker(null, s)
  }

  private inPendingRequest(msg: Message, s: Step, now: number): void {
    switch (msg.type) {
      case Type.Granted:
        this.ack(msg, s)
        this.takeGrant(msg)
        this.toPermission(s, now)
        s.signals.push({ kind: 'granted' })
        return
      case Type.Deny:
        this.ack(msg, s)
        this.denied(msg, s)
        return
      case Type.QueueInfo:
        this.phase = 'queued'
        this.sub = 'wait'
        this.takeQueue(msg)
        s.signals.push({ kind: 'queued' }, { kind: 'phase' })
        return
      case Type.Taken:
        this.showSpeaker(text(msg, Tlv.Speaker) ?? null, s)
        return
    }
  }

  private inPermission(msg: Message, s: Step, now: number): void {
    switch (msg.type) {
      case Type.Revoke:
        this.lastRevoke = this.cause(msg)
        s.gate = false
        s.signals.push({ kind: 'revoked' })
        this.lastEnd = 'revoked'
        this.toPendingRelease(s, now)
        return
      case Type.Granted:
        this.ack(msg, s)
        this.takeGrant(msg)
        s.signals.push({ kind: 'phase' })
        return
    }
  }

  private inPendingRelease(msg: Message, s: Step): void {
    switch (msg.type) {
      case Type.Idle:
        this.showSpeaker(null, s)
        this.settle(this.lastEnd === 'revoked' ? 'revoked' : 'released', s)
        return
      case Type.Taken:
        this.showSpeaker(text(msg, Tlv.Speaker) ?? null, s)
        this.settle(this.lastEnd === 'revoked' ? 'revoked' : 'released', s)
        return
      case Type.Revoke:
        this.lastRevoke = this.cause(msg)
        s.signals.push({ kind: 'revoked' })
        return
      case Type.Granted:
        this.ack(msg, s)
        return
    }
  }

  private inQueued(msg: Message, s: Step, now: number): void {
    switch (msg.type) {
      case Type.Taken:
        this.showSpeaker(text(msg, Tlv.Speaker) ?? null, s)
        return
      case Type.Granted:
        this.ack(msg, s)
        this.takeGrant(msg)
        if (this.sub !== 'granted') {
          this.sub = 'granted'
          this.t132Due = now + T132_MS
          s.signals.push({ kind: 'granted' }, { kind: 'phase' })
          if (this.input === 'hold' && this.want) this.toPermission(s, now)
        } else {
          this.t132Due = now + T132_MS
        }
        return
      case Type.Deny:
        this.ack(msg, s)
        this.denied(msg, s)
        return
      case Type.Idle:
        this.showSpeaker(null, s)
        this.settle('released', s)
        return
      case Type.QueueInfo:
        this.takeQueue(msg)
        if (this.sub === 'query') this.sub = 'wait'
        s.signals.push({ kind: 'queued' })
        return
    }
  }

  private toPermission(s: Step, now: number): void {
    this.phase = 'has_permission'
    this.sub = 'wait'
    this.queue = undefined
    this.talkingSince = now
    s.gate = true
    s.signals.push({ kind: 'phase' })
  }

  private toPendingRelease(s: Step, now: number): void {
    this.phase = 'pending_release'
    this.sub = 'wait'
    this.want = false
    this.queue = undefined
    this.talkingSince = undefined
    this.c100 = 1
    this.t100Due = now + T100_MS
    s.send.push(this.bare(Type.Release))
    s.signals.push({ kind: 'phase' })
  }

  private settle(cause: EndCause, s: Step): void {
    const wasPermission = this.phase === 'has_permission'
    this.phase = 'no_permission'
    this.sub = 'wait'
    this.queue = undefined
    this.talkingSince = undefined
    this.remainingSec = undefined
    this.lastEnd = cause
    if (wasPermission) s.gate = false
    if (cause === 'released' || cause === 't132_expired') s.signals.push({ kind: 'released' })
    s.signals.push({ kind: 'phase' })
  }

  private denied(msg: Message, s: Step): void {
    this.lastDeny = this.cause(msg)
    this.want = false
    s.signals.push({ kind: 'denied' })
    this.settle('denied', s)
  }

  private showSpeaker(who: string | null, s: Step): void {
    if (this.speaker === who) return
    this.speaker = who
    s.signals.push({ kind: 'speaker', userId: who })
  }

  private takeGrant(msg: Message): void {
    const d = u16(msg, Tlv.Duration)
    const p = u8(msg, Tlv.Priority)
    if (d !== undefined) this.remainingSec = d
    if (p !== undefined) this.grantedPriority = p
  }

  private takeQueue(msg: Message): void {
    const q = msg.fields.find((f) => f.id === Tlv.QueueInfo)?.value
    if (q !== undefined && q.length >= 2) this.queue = { position: q[0]!, priority: q[1]! }
  }

  private cause(msg: Message): { cause: number; text?: string } {
    const t = text(msg, Tlv.CauseText)
    return { cause: u8(msg, Tlv.Cause) ?? 255, ...(t === undefined ? {} : { text: t }) }
  }

  private ack(msg: Message, s: Step): void {
    if (!msg.ack) return
    s.send.push({ type: Type.Ack, ack: false, fields: [byte(Tlv.AckType, msg.type), str(Tlv.Room, this.roomId)] })
  }

  private request(): Message {
    return { type: Type.Request, ack: false, fields: [byte(Tlv.Priority, this.priority), str(Tlv.Room, this.roomId)] }
  }

  private bare(type: number): Message {
    return { type, ack: false, fields: [str(Tlv.Room, this.roomId)] }
  }
}
