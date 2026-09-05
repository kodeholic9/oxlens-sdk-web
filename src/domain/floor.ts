// author: kodeholic (powered by Claude)
// 연§7-7 · §11-5 · §8-4 — 방마다의 발언권 상태기. 3GPP TS 24.380 의 이름 그대로다.
//
// ★판정은 여기, 집행은 밖이다 — 상태기는 보낼 것과 알릴 것을 값으로 돌려주고
// DC 송신·게이트 열기는 주인이 한다. 그래야 1층이 시계만 돌려 전이를 전량 잰다.
import { Message, Tlv, Type, byte, short, str, text, u16, u8 } from '../internal/mbcp.js'

/** 연§2-5 — 여섯. off 는 이 서버에 반이중 마이크가 아직 없다는 뜻이다. */
export type Phase = 'off' | 'no_permission' | 'pending_request' | 'has_permission' | 'pending_release' | 'queued'
/** SDK§5-3 — 표면의 어휘 그대로다. 여기서 다른 말을 쓰면 위층이 번역을 해야 한다. */
export type EndCause =
  | 'released' | 'revoked' | 'denied' | 't1_reclaimed' | 't132_expired'
  | 'no_response' | 'moved' | 'left' | 'rebuilt'

/** 연§8-4 — 값의 정본은 그 절이다. 이름은 원문 것을 그대로 쓴다. */
export const T101_MS = 500
export const C101 = 3
export const T100_MS = 500
export const C100 = 3
export const T104_MS = 500
export const C104 = 3
export const T132_MS = 2_000
export const T_QUEUEPOS_MS = 30_000
/** 연§8-4 T3 — 회수 뒤 마이크는 껐는데 소리는 나가는 창이다. */
export const T3_MS = 3_000

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

const NONE: Outcome = { send: [], signals: [] }

interface Retry {
  readonly msg: Message
  readonly intervalMs: number
  left: number
  dueAt: number
}

export class FloorRoom {
  phase: Phase = 'off'
  priority = 0
  durationSec = 0
  remainingSec: number | undefined
  grantedPriority: number | undefined
  queue: { position: number; size: number } | undefined
  lastDeny: { cause: number; text?: string } | undefined
  lastRevoke: { cause: number; text?: string } | undefined
  lastEnd: EndCause | undefined
  /** 연§7-7-8 — DC 가 끊기면 이 표시를 믿을 수 없다. 미디어 지표로는 안 잡힌다. */
  trusted = true
  /** 연§7-7-6 4 — 회수 뒤 T3 동안 내 RTP 가 계속 흐른다. */
  draining = false
  /** 연§8-4 T132 — 큐 승계 GRANTED 를 받고 의지 표시를 기다리는 창. */
  acceptPending = false
  speaker: string | null = null
  talkingSince: number | undefined

  private lastSeq = -1
  private retry: Retry | null = null
  private t132Due = 0
  private queuePosDue = 0
  private drainDue = 0

  constructor(readonly roomId: string, readonly me: string, private readonly input: 'hold' | 'toggle' = 'hold') {}

  /** 연§2-6 — 새 요청을 낼 수 있는가. 버튼 활성 판정의 재료다. */
  get canRequest(): boolean {
    return this.trusted && (this.phase === 'off' || this.phase === 'no_permission')
  }

  /** 이 서버에 반이중 마이크가 섰다(연§2-5 off → no_permission). */
  armed(): Outcome {
    if (this.phase !== 'off') return NONE
    this.phase = 'no_permission'
    return { send: [], signals: [{ kind: 'phase' }] }
  }

  /** 연§7-7-1 — 발언 의지. queued 에서 T132 안이면 새 요청이 아니라 수락이다. */
  press(now: number): Outcome {
    if (this.phase === 'queued' && this.acceptPending) return this.accept(now)
    if (this.phase === 'pending_request' || this.phase === 'queued') return NONE

    const msg: Message = {
      type: Type.Request, ack: false,
      fields: [
        byte(Tlv.Priority, this.priority),
        ...(this.durationSec > 0 ? [short(Tlv.Duration, this.durationSec)] : []),
        str(Tlv.Room, this.roomId),
      ],
    }
    this.phase = 'pending_request'
    this.arm(msg, T101_MS, C101, now)
    return { send: [msg], signals: [{ kind: 'phase' }] }
  }

  /**
   * 연§7-7-1-1 · §7-7-2-3 — 발언 끝 · 허가 전에 뗌 · 대기 철회.
   * ★큐 철회는 확인 사건이 없어 표시가 즉시 내려간다.
   */
  release(now: number): Outcome {
    if (this.phase === 'no_permission' || this.phase === 'off') return NONE
    const msg: Message = { type: Type.Release, ack: false, fields: [str(Tlv.Room, this.roomId)] }

    if (this.phase === 'queued') {
      this.settle('released')
      return { send: [msg], signals: [{ kind: 'released' }, { kind: 'phase' }], gate: false }
    }
    this.phase = 'pending_release'
    this.arm(msg, T100_MS, C100, now)
    return { send: [msg], signals: [{ kind: 'phase' }], gate: false }
  }

  /** 연§11-5 — A 비트가 선 메시지에는 반드시 ACK 을 보낸다. 대상 방을 에코한다. */
  receive(msg: Message, now: number): Outcome {
    const room = text(msg, Tlv.Room)
    if (room !== undefined && room !== this.roomId) return NONE

    const send: Message[] = []
    if (msg.ack) {
      send.push({
        type: Type.Ack, ack: false,
        fields: [byte(Tlv.AckType, msg.type), str(Tlv.Room, this.roomId)],
      })
    }
    const out = this.apply(msg, now)
    return { send: [...send, ...out.send], signals: out.signals, ...(out.gate === undefined ? {} : { gate: out.gate }) }
  }

  /** 시계가 흘렀다 — 재전송·T132·큐 폴링·배수 창을 한 자리에서 본다. */
  tick(now: number): Outcome {
    const send: Message[] = []
    const signals: Signal[] = []
    let gate: boolean | undefined

    if (this.retry && now >= this.retry.dueAt) {
      if (this.retry.left > 0) {
        this.retry.left -= 1
        this.retry.dueAt = now + this.retry.intervalMs
        send.push(this.retry.msg)
      } else {
        this.retry = null
        // 연§8-4 C101·C100 — 소진하면 포기하고 has no permission 으로 간다.
        this.settle('no_response')
        signals.push({ kind: 'phase' })
        gate = false
      }
    }

    if (this.acceptPending && now >= this.t132Due) {
      // 연§8-4 T132 — 의지 표시가 없었다. 우리가 RELEASE 를 보내고 못 쓴다고 알린다.
      this.acceptPending = false
      send.push({ type: Type.Release, ack: false, fields: [str(Tlv.Room, this.roomId)] })
      this.settle('t132_expired')
      signals.push({ kind: 'phase' })
      gate = false
    }

    if (this.phase === 'queued' && now >= this.queuePosDue) {
      this.queuePosDue = now + T_QUEUEPOS_MS
      send.push({ type: Type.QueuePosRequest, ack: false, fields: [str(Tlv.Room, this.roomId)] })
    }

    if (this.draining && now >= this.drainDue) {
      this.draining = false
      signals.push({ kind: 'phase' })
      gate = false
    }

    return { send, signals, ...(gate === undefined ? {} : { gate }) }
  }

  /** 연§7-7-8 — DC 가 끊겼다. 표시를 믿을 수 없다고 알린다. */
  setTrusted(on: boolean): Outcome {
    if (this.trusted === on) return NONE
    this.trusted = on
    return { send: [], signals: [{ kind: 'phase' }] }
  }

  /** 미디어가 죽거나 세션이 재구축됐다 — 등록은 남아도 허가는 없다(SDK§10-4). */
  reset(cause: EndCause): Outcome {
    if (this.phase === 'off') return NONE
    this.settle(cause)
    this.speaker = null
    return { send: [], signals: [{ kind: 'phase' }, { kind: 'speaker', userId: null }], gate: false }
  }

  private apply(msg: Message, now: number): Outcome {
    switch (msg.type) {
      case Type.Granted: return this.onGranted(msg, now)
      case Type.Deny: return this.onDeny(msg)
      case Type.Taken: return this.onTaken(msg)
      case Type.Idle: return this.onIdle(msg)
      case Type.Revoke: return this.onRevoke(msg, now)
      case Type.QueueInfo: return this.onQueueInfo(msg, now)
      default: return NONE
    }
  }

  private onGranted(msg: Message, now: number): Outcome {
    this.retry = null
    this.remainingSec = u16(msg, Tlv.Duration)
    this.grantedPriority = u8(msg, Tlv.Priority)
    this.queue = undefined

    // 연§7-7-2 — 큐에서 승계된 허가는 의지 표시를 기다린다(T132).
    if (this.phase === 'queued') {
      if (this.input === 'toggle') {
        this.acceptPending = true
        this.t132Due = now + T132_MS
        return { send: [], signals: [{ kind: 'phase' }] }
      }
      // hold 는 버튼이 눌린 채인 것이 곧 표시라 즉시 발언이다.
      return this.accept(now)
    }
    this.phase = 'has_permission'
    this.talkingSince = now
    this.lastEnd = undefined
    return { send: [], signals: [{ kind: 'granted' }, { kind: 'phase' }], gate: true }
  }

  private accept(now: number): Outcome {
    this.acceptPending = false
    this.phase = 'has_permission'
    this.talkingSince = now
    this.lastEnd = undefined
    return { send: [], signals: [{ kind: 'granted' }, { kind: 'phase' }], gate: true }
  }

  private onDeny(msg: Message): Outcome {
    this.retry = null
    const cause = u8(msg, Tlv.Cause) ?? 255
    const why = text(msg, Tlv.CauseText)
    this.lastDeny = { cause, ...(why === undefined ? {} : { text: why }) }
    this.settle('denied')
    return { send: [], signals: [{ kind: 'denied' }, { kind: 'phase' }], gate: false }
  }

  /** 연§11-3 — TAKEN·IDLE 은 seq 를 싣는다. DC 가 ordered:false 라 이것이 순서의 유일한 장치다. */
  private onTaken(msg: Message): Outcome {
    if (!this.fresh(msg)) return NONE
    const who = text(msg, Tlv.Speaker) ?? null
    this.speaker = who
    const signals: Signal[] = [{ kind: 'speaker', userId: who }]
    if (who === this.me) return { send: [], signals }
    // 연§8-4 T100 — 반환의 결과물이 곧 확인이다. 내가 화자가 아닌 TAKEN 도 그것이다.
    if (this.phase === 'pending_release') {
      this.retry = null
      this.settle('released')
      signals.push({ kind: 'released' }, { kind: 'phase' })
      return { send: [], signals, gate: false }
    }
    // 연§7-7-7 3 — 말하는 중에 남이 화자가 됐다. 서버가 T1 로 회수한 것이다.
    if (this.phase === 'has_permission') {
      this.settle('t1_reclaimed')
      signals.push({ kind: 'released' }, { kind: 'phase' })
      return { send: [], signals, gate: false }
    }
    return { send: [], signals }
  }

  private onIdle(msg: Message): Outcome {
    if (!this.fresh(msg)) return NONE
    this.speaker = null
    const signals: Signal[] = [{ kind: 'speaker', userId: null }]
    if (this.phase === 'pending_release') {
      this.retry = null
      this.settle('released')
      signals.push({ kind: 'released' }, { kind: 'phase' })
      return { send: [], signals, gate: false }
    }
    // 연§7-7-7 3 — 말하는 중에 방이 비었다. 내 허가가 이미 끝난 것이다.
    if (this.phase === 'has_permission') {
      this.settle('t1_reclaimed')
      signals.push({ kind: 'released' }, { kind: 'phase' })
      return { send: [], signals, gate: false }
    }
    return { send: [], signals }
  }

  private onRevoke(msg: Message, now: number): Outcome {
    const cause = u8(msg, Tlv.Cause) ?? 255
    const why = text(msg, Tlv.CauseText)
    this.lastRevoke = { cause, ...(why === undefined ? {} : { text: why }) }
    this.retry = null
    this.settle('revoked')
    // 연§8-4 T3 — 회수를 보내고도 그동안 내 RTP 가 흐른다. 마이크는 지금 닫는다.
    this.draining = true
    this.drainDue = now + T3_MS
    return {
      send: [{ type: Type.Release, ack: false, fields: [str(Tlv.Room, this.roomId)] }],
      signals: [{ kind: 'revoked' }, { kind: 'phase' }],
      gate: false,
    }
  }

  private onQueueInfo(msg: Message, now: number): Outcome {
    this.retry = null
    const info = msg.fields.find((f) => f.id === Tlv.QueueInfo)?.value
    const size = u8(msg, Tlv.QueueSize) ?? 0
    this.queue = { position: info?.[0] ?? 0, size }
    this.grantedPriority = info?.[1]
    const first = this.phase !== 'queued'
    this.phase = 'queued'
    this.queuePosDue = now + T_QUEUEPOS_MS
    return { send: [], signals: first ? [{ kind: 'queued' }, { kind: 'phase' }] : [{ kind: 'phase' }] }
  }

  /** 연§11-3 id 8 — 되감긴 것은 버린다. 안 보면 화자 표시가 되감긴다. */
  private fresh(msg: Message): boolean {
    const seq = u16(msg, Tlv.Seq)
    if (seq === undefined) return true
    if (this.lastSeq >= 0 && seq <= this.lastSeq) return false
    this.lastSeq = seq
    return true
  }

  private arm(msg: Message, intervalMs: number, count: number, now: number): void {
    this.retry = { msg, intervalMs, left: count, dueAt: now + intervalMs }
  }

  private settle(cause: EndCause): void {
    this.phase = 'no_permission'
    this.retry = null
    this.acceptPending = false
    this.draining = false
    this.queue = undefined
    this.remainingSec = undefined
    this.talkingSince = undefined
    this.lastEnd = cause
  }
}
