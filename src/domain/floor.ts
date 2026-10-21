// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-FLR-BUTTON · SDK:IMPL-FLR-EXPOSE · SDK:IMPL-FLR-TRUST · SDK:RULE-FLR-MIC-POWER · SDK:RULE-FLR-ROOM-SWITCH · SDK:RULE-FLR-RECOVERY · SDK:IMPL-MOD-TABLE domain/floor · model: claude-opus-5-5
import * as FLR from './gen/floor_client.js'
import * as PB from './gen/ptt_binding.js'
import { Timers, Revoke } from '../internal/wire/floor_consts.js'
import * as Mbcp from '../internal/mbcp.js'
import { Emitter } from '../platform/emitter.js'
import { Timer, now, wall } from '../platform/clock.js'
import { Fault, closedFault } from '../platform/fault.js'
import type { Core } from './session.js'
import type { RoomCore } from './rooms.js'

export type Phase = 'off' | 'no_permission' | 'pending_request' | 'has_permission' | 'pending_release' | 'queued'
export type LastEnd = 'released' | 'revoked' | 'denied' | 't132_expired' | 'no_response' | 'moved' | 'left' | 'rebuilt' | 'arm_failed'
export type ArmingStage = 'register' | 'select' | 'transport' | 'recovering'
export type PressSource = 'user' | 'accessory' | 'app'

export interface PttState {
  readonly phase: Phase
  readonly remainingSec?: number
  readonly priority?: number
  readonly queue?: { readonly position: number }
  readonly acceptPending: boolean
  readonly talkingSince?: number
  readonly lastDeny?: { readonly cause: number; readonly text?: string }
  readonly lastRevoke?: { readonly cause: number; readonly text?: string }
  readonly canRequest: boolean
  readonly source?: PressSource
  readonly lastEnd?: LastEnd
  readonly trusted: boolean
  readonly arming: boolean
  readonly armingStage?: ArmingStage
  readonly lastError?: Fault
  readonly mic: 'hot' | 'hot_standby' | 'cold'
}

export interface FloorEvents extends Record<string, unknown[]> {
  state: [PttState]
  granted: [PttState]
  denied: [PttState]
  revoked: [PttState]
  queued: [PttState]
  released: [PttState]
  speaker: [{ userId: string | null; trackIds: string[] }]
}

const PHASE: Record<FLR.CState, Phase> = { NOPERM: 'no_permission', PREQ: 'pending_request', PERM: 'has_permission', PREL: 'pending_release', QUEUED: 'queued' }

/** 방마다 발언권 하나 — 절차 · 보낼 것 · 타이머 · 효과는 위가 지은 클라 상태기 그대로, SDK 는 입구 · 효과 표만 */
export class FloorCore {
  st: FLR.Cl = FLR.initial()
  readonly events = new Emitter<FloorEvents>()
  priority = 0
  input: 'hold' | 'toggle' = 'hold'
  private readonly timers = new Map<FLR.TimerName, Timer>()
  private held = false
  private arming = false
  private armingStage: ArmingStage | undefined
  private cancel = false
  private source: PressSource | undefined
  private lastEnd: LastEnd | undefined
  private lastDeny: { cause: number; text?: string } | undefined
  private lastRevoke: { cause: number; text?: string } | undefined
  private lastError: Fault | undefined
  private trusted = true
  private t9Until = 0
  private talkingSince: number | undefined
  private remainingSec: number | undefined
  private grantedPrio: number | undefined
  private queuePos: number | undefined
  private lastKey = ''
  private disposed = false

  constructor(private readonly core: Core, private readonly room: RoomCore) {
    for (const t of ['T101', 'T100', 'T104', 'T132'] as const) this.timers.set(t, new Timer(core.cfg.wakeDetectMs))
  }

  get phase(): Phase {
    if (this.st.cs === 'NOPERM' && !this.core.media.hasHalfMic(this.room.sfuId)) return 'off'
    return PHASE[this.st.cs]
  }

  get acceptPending(): boolean { return this.st.cs === 'QUEUED' && this.st.sub === 'GRANTED' }

  get canRequest(): boolean {
    const p = this.phase
    return this.room.st.rs === 'JOINED' && this.trusted && this.room.permission.floorRequest && (p === 'off' || p === 'no_permission') && now() >= this.t9Until && !this.room.rebuilding && !this.arming
  }

  get mic(): 'hot' | 'hot_standby' | 'cold' {
    if (this.st.cs === 'PERM' || this.st.cs === 'PREL') return 'hot'
    return this.core.media.halfMicCold(this.room.sfuId) ? 'cold' : 'hot_standby'
  }

  snapshot(): PttState {
    const s: { -readonly [K in keyof PttState]: PttState[K] } = { phase: this.phase, acceptPending: this.acceptPending, canRequest: this.canRequest, trusted: this.trusted, arming: this.arming, mic: this.mic }
    if (this.remainingSec !== undefined && (this.st.cs === 'PERM' || this.acceptPending)) s.remainingSec = this.remainingSec
    if (this.grantedPrio !== undefined && this.st.cs === 'PERM') s.priority = this.grantedPrio
    if (this.st.cs === 'QUEUED' && this.queuePos !== undefined) s.queue = { position: this.queuePos }
    if (this.talkingSince !== undefined && this.st.cs === 'PERM') s.talkingSince = this.talkingSince
    if (this.lastDeny) s.lastDeny = this.lastDeny
    if (this.lastRevoke) s.lastRevoke = this.lastRevoke
    if (this.source) s.source = this.source
    if (this.lastEnd) s.lastEnd = this.lastEnd
    if (this.arming && this.armingStage) s.armingStage = this.armingStage
    if (this.lastError) s.lastError = this.lastError
    return s
  }

  /** 바뀔 때마다 state */
  surface(extra?: 'granted' | 'denied' | 'revoked' | 'queued' | 'released'): void {
    const s = this.snapshot()
    const key = JSON.stringify({ ...s, lastError: s.lastError?.name })
    if (key !== this.lastKey || extra) {
      this.lastKey = key
      this.events.emit('state', s)
      if (extra) this.events.emit(extra, s)
    }
  }

  // ── 버튼 계약(SDK:IMPL-FLR-BUTTON) ────────────────────────────────────

  /** 발언 의지 — 접수에 resolve(arming 에 들어갔거나 입구에 닿았다) · 허가는 granted */
  async press(o: { source?: PressSource } = {}): Promise<void> {
    if (this.disposed || this.core.ses.cs === 'DISCONNECTED') throw closedFault('CLOSED')
    this.held = true
    this.source = o.source ?? 'user'
    if (this.acceptPending && this.input === 'toggle') { this.flrStep('intent', FLR.intent(this.st), 'press'); return }
    if (this.arming) return
    if (this.st.cs !== 'NOPERM') { this.flrStep('press', FLR.press(this.st, this.priority), 'press'); return }
    this.arming = true
    this.cancel = false
    this.lastError = undefined
    this.surface()
    void this.arm()
  }

  /** arming — 반이중 발행 → 발언 방 → DC 열림 · 연결 복구 대기 → 입구 press(시한 없음 · 단계 차례는 위가 정한다) */
  private async arm(): Promise<void> {
    try {
      this.stage('register')
      await this.core.media.ensureHalfMic(this.room)
      if (this.stopIfCancelled()) return
      this.stage('select')
      if (this.core.speakingRoom !== this.room.id) await this.core.setSpeakingRoom(this.room.id)
      if (this.stopIfCancelled()) return
      for (;;) {
        const link = this.room.link
        if (this.disposed || this.room.closed) throw closedFault('CLOSED')
        if (!link || link.state !== 'up') this.stage(link && link.everUp ? 'recovering' : 'transport')
        else if (!link.peer?.dcOpen) this.stage('transport')
        else break
        await new Promise((r) => setTimeout(r, 50))
        if (this.stopIfCancelled()) return
      }
      if (this.stopIfCancelled()) return
      await this.core.media.warmHalf(this.room)
      this.arming = false
      this.armingStage = undefined
      if (!this.held && this.input === 'hold') { this.lastEnd = 'released'; this.surface('released'); return }
      this.flrStep('press', FLR.press(this.st, this.priority), 'press')
    } catch (e) {
      this.arming = false
      this.armingStage = undefined
      this.lastEnd = 'arm_failed'
      this.lastError = e instanceof Fault ? e : new Fault({ code: 0, name: 'ARM_FAILED', category: 'bug', cause: e })
      this.surface()
    }
  }

  private stage(s: ArmingStage): void {
    if (this.armingStage === s) return
    this.armingStage = s
    this.surface()
  }

  private stopIfCancelled(): boolean {
    if (!this.cancel) return false
    this.arming = false
    this.armingStage = undefined
    this.cancel = false
    this.lastEnd = 'released'
    this.surface('released')
    return true
  }

  /** 발언 끝 · 대기 철회 · 허가 전에 뗌 — 입구에 닿으면 resolve(확인은 state) */
  async release(): Promise<void> {
    this.held = false
    if (this.arming) { this.cancel = true; return }
    const step = FLR.release(this.st)
    if (step) { this.lastEnd = 'released'; this.flrStep('release', step, 'release') }
  }

  queuePosition(): void {
    const step = FLR.queuePosition(this.st)
    if (step) this.flrStep('queuePosition', step, 'resync')
  }

  // ── 위 이음매가 부르는 입구 ──────────────────────────────────────────

  registerHalf(): void { this.flrStep('registerHalf', FLR.registerHalf(this.st), 'pub') }
  pubSelect(): void { this.flrStep('pubSelect', FLR.pubSelect(this.st), 'aff') }
  pubAway(): void { this.endIfHolding('moved'); this.flrStep('pubAway', FLR.pubAway(this.st), 'aff') }
  leave(): void { this.endIfHolding('left'); this.flrStep('leave', FLR.leave(this.st), 'room') }
  down(): void { this.endIfHolding('rebuilt'); this.flrStep('down', FLR.down(this.st), 'rebuild') }
  dcDown(): void { this.flrStep('dcDown', FLR.dcDown(this.st), 'link') }
  dcUp(): void { this.flrStep('dcUp', FLR.dcUp(this.st), 'link') }
  rtpTx(): void { this.flrStep('rtpTx', FLR.rtpTx(this.st), 'gate') }
  rtpRx(): void { this.flrStep('rtpRx', FLR.rtpRx(this.st), 'media') }
  receive(rx: Mbcp.FloorRx): void { this.lastRx = rx; this.flrStep('receive', FLR.receive(this.st, rx), `rx.${rx.t}`) }

  private endIfHolding(e: LastEnd): void {
    if (this.st.cs !== 'NOPERM') this.lastEnd = e
  }

  linkChanged(): void { this.surface() }

  speakerTracks(): void {
    if (this.st.shown !== null || this.lastSpeaker !== undefined) this.emitSpeaker()
  }

  private lastSpeaker: string | null | undefined

  private emitSpeaker(): void {
    const ids = [...this.room.remotes.values()].filter((r) => r.type === 'slot' && r.row !== null).map((r) => r.id)
    const key = `${this.st.shown}|${ids.join(',')}`
    if (key === this.speakerKey) return
    this.speakerKey = key
    this.lastSpeaker = this.st.shown
    this.events.emit('speaker', { userId: this.st.shown, trackIds: ids })
  }

  private speakerKey = ''

  // ── 출입구 ────────────────────────────────────────────────────────────

  flrStep(entry: string, step: FLR.Step | null, cause: string): void {
    if (this.disposed) return
    if (!step) { this.core.impossible('FLR', this.room.id, this.st.cs, entry); return }
    const prev = this.st
    const plan = PB.plan(step)
    this.st = plan.state
    this.core.record('FLR', this.room.id, prev.cs, this.st.cs, plan.label, cause)
    const link = this.room.link
    for (const tx of plan.send) {
      const bytes = tx.t === 'REQUEST' ? Mbcp.request(this.room.id, tx.priority ?? 0) : tx.t === 'RELEASE' ? Mbcp.release(this.room.id) : Mbcp.queuePosRequest(this.room.id)
      if (!link?.peer?.sendDc(bytes)) this.core.log.debug(`DC 로 ${tx.t} 를 못 보냈다 — 위 타이머가 다시 보낸다`, { room: this.room.id })
    }
    for (const a of plan.ack) link?.peer?.sendDc(Mbcp.ack(this.room.id, a.of, a.seq))
    this.timersFollow(plan.timers)
    let extra: 'granted' | 'denied' | 'revoked' | 'queued' | 'released' | undefined
    for (const f of step.fx) {
      const e = PB.effect(f)
      if (f === 'mic.open') { this.talkingSince = wall(); this.core.media.floorOpen(this.room) }
      else if (f === 'mic.close') { this.talkingSince = undefined; this.core.media.floorClose(this.room) }
      else if (f === 'media.render') { for (const r of this.room.remotes.values()) if (r.type === 'slot') r.applyPlayback() }
      else if (f === 'app.granted' || f === 'app.granted_queued') {
        this.remainingSec = this.st.grant
        this.grantedPrio = this.st.prio
        this.lastEnd = undefined
        extra = 'granted'
        if (f === 'app.granted_queued' && this.input === 'hold' && this.held) queueMicrotask(() => this.flrStep('intent', FLR.intent(this.st), 'hold'))
      } else if (f === 'app.denied') {
        const rx = this.lastRx
        if (rx && rx.t === 'DENY') this.lastDeny = rx.reason !== undefined ? { cause: rx.cause, text: rx.reason } : { cause: rx.cause }
        this.lastEnd = 'denied'
        extra = 'denied'
      } else if (f === 'app.queued') {
        const rx = this.lastRx
        if (rx && rx.t === 'QINFO') this.queuePos = rx.info.position
        extra = 'queued'
      } else if (f === 'app.revoked') {
        const rx = this.lastRx
        if (rx && rx.t === 'REVOKE') {
          this.lastRevoke = rx.reason !== undefined ? { cause: rx.cause, text: rx.reason } : { cause: rx.cause }
          if (rx.cause === Revoke.TOO_LONG) this.t9Until = now() + Timers.T9_MS
        }
        this.lastEnd = 'revoked'
        extra = 'revoked'
      } else if (f === 'app.speaker' || f === 'app.speaker_none') this.emitSpeaker()
      else if (f === 'app.request_timeout' || f === 'app.queue_timeout') this.lastEnd = 'no_response'
      else if (f === 'app.grant_expired') this.lastEnd = 't132_expired'
      else if (f === 'app.floor_unreliable') this.trusted = false
      else if (f === 'app.floor_reliable') this.trusted = true
      void e
    }
    if (this.st.cs === 'NOPERM' && prev.cs !== 'NOPERM' && this.lastEnd === 'released' && !extra) extra = 'released'
    if (this.st.cs !== 'PERM') { if (this.st.cs !== 'QUEUED') this.remainingSec = undefined }
    this.surface(extra)
  }

  private lastRx: Mbcp.FloorRx | null = null

  private timersFollow(start: readonly FLR.TimerName[]): void {
    const armed = FLR.armed(this.st)
    for (const [name, t] of this.timers) {
      if (!armed.includes(name)) { t.stop(); continue }
      if (start.includes(name) || !t.armed) t.start(FLR.TIMER_MS[name], () => this.flrStep(`expire.${name}`, FLR.expire(this.st, name), 'timer'))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.timers.values()) t.stop()
  }
}
