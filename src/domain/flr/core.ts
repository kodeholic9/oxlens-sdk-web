// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-FLR-BUTTON · SDK:IMPL-FLR-EXPOSE · SDK:IMPL-FLR-TRUST · SDK:RULE-FLR-MIC-POWER · SDK:RULE-FLR-ROOM-SWITCH · SDK:RULE-FLR-RECOVERY · SDK:RULE-MOD-AREA-MIRROR domain/flr · model: claude-opus-5-5
// 옛 domain/floor.ts 를 옮겨 왔다.
import * as FLR from '../gen/floor_client.js'
import * as PB from '../gen/ptt_binding.js'
import { Timers, Revoke } from '../../internal/wire/floor_consts.js'
import * as Mbcp from '../../internal/flr/mbcp.js'
import { Emitter } from '../../platform/emitter.js'
import { Timer, sleep, wall } from '../../platform/clock.js'
import { Fault, closedFault } from '../../platform/fault.js'
import type { Logger } from '../../platform/log.js'
import type { RoomCore } from '../room/core.js'
import type { MediaRegistry } from '../pub/registry.js'
import type { AffCore } from '../aff/core.js'

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

/** 사건별 편의 이벤트 — state 와 같은 순간 */
export type Extra = 'granted' | 'denied' | 'revoked' | 'queued' | 'released'

export interface FloorEvents extends Record<string, unknown[]> {
  state: [PttState]
  granted: [PttState]
  denied: [PttState]
  revoked: [PttState]
  queued: [PttState]
  released: [PttState]
  speaker: [{ userId: string | null; trackIds: string[] }]
}

/** 입구 표의 입구 — 위 결합(ptt_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof PB.ENTRY
type Args<K extends Entry> = (typeof PB.ENTRY)[K] extends (s: FLR.Cl, ...a: infer A) => unknown ? A : never

/** 발언권이 쓰는 SDK 기본값 — 타이머의 깨어남 문턱 */
export interface FlrSettings { readonly wakeDetectMs: number }

const PHASE: Record<FLR.CState, Phase> = { NOPERM: 'no_permission', PREQ: 'pending_request', PERM: 'has_permission', PREL: 'pending_release', QUEUED: 'queued' }
/** arming 의 DC 열림 · 연결 복구 기다림을 다시 보는 간격 — 시한은 없다(연결 복구가 판정한다) */
const ARM_POLL_MS = 50

/**
 * 방마다 발언권 하나 — 위가 지은 발언권 클라 상태기 하나.
 * 절차 · 보낼 것 · 타이머 · 효과는 위가 정한다 — 여기는 입구 표(어느 SDK 사건이 어느 입구를) · 효과 표(위 효과를 어느 표면으로) · 이음매 집행만.
 * 발언권은 세션 · 연결 · 트랙 영역을 부르지 않는다(may_use = AFF · PUB · ROOM) — DC 송신 · 연결 단계 · 슬롯 트랙 · 기록은 방이 내준다.
 */
export class FloorCore {
  st: FLR.Cl = FLR.initial()
  readonly events = new Emitter<FloorEvents>()
  priority = 0
  input: 'hold' | 'toggle' = 'hold'
  private readonly timers = new Map<FLR.TimerName, Timer>()
  /** 회수 사유 2(상한) 뒤 재요청 차단(연:RULE-FLR-TIMERS T9) — 끝나면 canRequest 가 바뀐다 */
  private readonly t9: Timer
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
  private talkingSince: number | undefined
  private remainingSec: number | undefined
  private grantedPrio: number | undefined
  private queuePos: number | undefined
  /** 지금 넣는 서버 사건 — 효과 덧붙임(lastDeny · queue · lastRevoke)이 그 내용을 읽는다 */
  private lastRx: Mbcp.FloorRx | null = null
  /** hold 승계 — 승계 허가 걸음이 끝난 뒤 입구 intent */
  private intentOwed = false
  private lastKey = ''
  private speakerKey = ''
  private lastSpeaker: string | null | undefined
  private disposed = false

  constructor(private readonly room: RoomCore, private readonly media: MediaRegistry, private readonly aff: AffCore, cfg: FlrSettings, private readonly log: Logger) {
    for (const t of ['T101', 'T100', 'T104', 'T132'] as const) this.timers.set(t, new Timer(cfg.wakeDetectMs))
    this.t9 = new Timer(cfg.wakeDetectMs)
  }

  get phase(): Phase {
    if (this.st.cs === 'NOPERM' && !this.media.hasHalfMic(this.room.sfuId)) return 'off'
    return PHASE[this.st.cs]
  }

  get acceptPending(): boolean { return this.st.cs === 'QUEUED' && this.st.sub === 'GRANTED' }

  get canRequest(): boolean {
    const p = this.phase
    return this.room.st.rs === 'JOINED' && this.trusted && this.room.permission.floorRequest && (p === 'off' || p === 'no_permission') && !this.t9.armed && !this.room.rebuilding && !this.arming
  }

  get mic(): 'hot' | 'hot_standby' | 'cold' {
    if (this.st.cs === 'PERM' || this.st.cs === 'PREL') return 'hot'
    return this.media.halfMicCold(this.room.sfuId) ? 'cold' : 'hot_standby'
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

  /** 바뀔 때마다 state 하나(같은 값은 다시 내지 않는다) · 사건별 편의 이벤트는 그 뒤에 같은 값으로 */
  surface(extras: readonly Extra[] = []): void {
    const s = this.snapshot()
    const key = JSON.stringify({ ...s, lastError: s.lastError?.name })
    if (key !== this.lastKey) {
      this.lastKey = key
      this.events.emit('state', s)
    }
    for (const e of extras) this.events.emit(e, s)
  }

  // ── 버튼 계약(SDK:IMPL-FLR-BUTTON) ────────────────────────────────────

  /** 발언 의지 — 접수에 resolve(arming 에 들어갔거나 입구에 닿았다) · 허가는 granted */
  async press(o: { source?: PressSource } = {}): Promise<void> {
    if (this.disposed || this.room.sessionClosed) throw closedFault('CLOSED')
    this.held = true
    this.source = o.source ?? 'user'
    if (this.acceptPending && this.input === 'toggle') { this.enter('intent', 'press', []); return }
    // arming 중 다시 누름 — 앞의 release 가 건 취소를 되살린다(버튼은 눌려 있다 · 연:RULE-FLR-PROC-PRESS)
    if (this.arming) { this.cancel = false; return }
    if (this.st.cs !== 'NOPERM') { this.enter('press', 'press', [this.priority]); return }
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
      await this.media.ensureHalfMic(this.room.id)
      if (this.stopIfCancelled()) return
      this.stage('select')
      if (this.aff.speakingRoom !== this.room.id) await this.aff.setSpeakingRoom(this.room.id)
      if (this.stopIfCancelled()) return
      for (;;) {
        if (this.disposed || this.room.closed) throw closedFault('CLOSED')
        const path = this.room.floorPath()
        if (path === 'open') break
        this.stage(path)
        await sleep(ARM_POLL_MS)
        if (this.stopIfCancelled()) return
      }
      await this.media.warmHalf(this.room.sfuId)
      if (this.stopIfCancelled()) return
      this.arming = false
      this.armingStage = undefined
      this.enter('press', 'press', [this.priority])
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

  /** arming 중 release — 진행 중인 단계는 끝내고(절반 상태 금지) 누름을 넣지 않는다 */
  private stopIfCancelled(): boolean {
    if (!this.cancel) return false
    this.arming = false
    this.armingStage = undefined
    this.cancel = false
    this.lastEnd = 'released'
    this.surface(['released'])
    return true
  }

  /** 발언 끝 · 대기 철회 · 허가 전에 뗌 — 입구에 닿으면 resolve(확인은 state) */
  async release(): Promise<void> {
    this.held = false
    if (this.arming) { this.cancel = true; return }
    this.enter('release', 'release', [], { quiet: true, end: 'released' })
  }

  // ── 위 이음매 · SDK 사건이 부르는 입구(입구 표) ──────────────────────────

  /** 재동기 때 대기 중이면 한 번(앱 API 없음) */
  queuePosition(): void { this.enter('queuePosition', 'resync', [], { quiet: true }) }
  registerHalf(): void { this.enter('registerHalf', 'pub', []) }
  pubSelect(): void { this.enter('pubSelect', 'aff', []) }
  pubAway(): void { this.enter('pubAway', 'aff', [], { end: this.holding('moved') }) }
  leave(): void { this.enter('leave', 'room', [], { end: this.holding('left') }) }
  join(): void { this.enter('join', 'room', []) }
  down(): void { this.enter('down', 'rebuild', [], { end: this.holding('rebuilt') }) }
  dcDown(): void { this.enter('dcDown', 'link', []) }
  dcUp(): void { this.enter('dcUp', 'link', []) }
  rtpTx(): void { this.enter('rtpTx', 'gate', []) }
  rtpRx(): void { this.enter('rtpRx', 'media', []) }
  receive(rx: Mbcp.FloorRx): void {
    this.lastRx = rx
    this.enter('receive', `rx.${rx.t}`, [rx])
    this.lastRx = null
  }

  /** 들고 있던 발언권 · 대기를 잃으면 끝난 이유(lastEnd) — 들고 있지 않았으면 그대로 */
  private holding(e: LastEnd): LastEnd | undefined { return this.st.cs !== 'NOPERM' ? e : undefined }

  /** 그 서버 연결 상태가 바뀌었다 — canRequest · trusted 표시를 다시 잰다 */
  linkChanged(): void { this.surface() }

  /** 받는 트랙 목록이 바뀌었다 — 화자의 슬롯 트랙이 늦게 오면 speaker 를 다시 낸다 */
  speakerTracks(): void {
    if (this.st.shown !== null || this.lastSpeaker !== undefined) this.emitSpeaker()
  }

  private emitSpeaker(): void {
    const ids = this.room.slotTrackIds()
    const key = `${this.st.shown}|${ids.join(',')}`
    if (key === this.speakerKey) return
    this.speakerKey = key
    this.lastSpeaker = this.st.shown
    this.events.emit('speaker', { userId: this.st.shown, trackIds: ids })
  }

  // ── 입구 표 — 위 결합 ENTRY 를 지나 한 걸음 ─────────────────────────────

  /** 입구 하나 — 위가 안 받으면(null) 받지 않는 사건으로 적는다 · quiet 면 사건이 없던 것으로 둔다 · end 는 받았을 때의 끝난 이유 · 받았는지를 돌려준다 */
  enter<K extends Entry>(name: K, cause: string, args: Args<K>, o: { quiet?: boolean; end?: LastEnd | undefined } = {}): boolean {
    if (this.disposed) return false
    const f = PB.ENTRY[name] as unknown as (s: FLR.Cl, ...a: Args<K>) => FLR.Step | null
    const step = f(this.st, ...args)
    if (!step) {
      if (!o.quiet) this.room.impossible('FLR', this.room.id, this.st.cs, name)
      return false
    }
    if (o.end) this.lastEnd = o.end
    this.step(step, cause)
    return true
  }

  /** 한 걸음의 집행 — plan() 이 돌려준 목록대로(보낼 것 · ACK · 타이머 · 효과) 직접 한다 */
  private step(step: FLR.Step, cause: string): void {
    const prev = this.st
    const plan = PB.plan(step)
    this.st = plan.state
    this.room.record('FLR', this.room.id, prev.cs, this.st.cs, plan.label, cause)
    for (const tx of plan.send) this.send(tx)
    for (const a of plan.ack) this.room.sendFloor(Mbcp.ack(this.room.id, a.of))
    this.timersFollow(plan.timers)
    const extras: Extra[] = []
    for (const f of step.fx) this.effect(f, extras)
    if (this.st.cs === 'NOPERM' && prev.cs !== 'NOPERM' && this.lastEnd === 'released' && extras.length === 0) extras.push('released')
    if (this.st.cs !== 'PERM' && this.st.cs !== 'QUEUED') this.remainingSec = undefined
    this.surface(extras)
    if (this.intentOwed) {
      this.intentOwed = false
      if (this.held && this.input === 'hold') this.enter('intent', 'hold', [])
    }
  }

  private send(tx: FLR.Tx): void {
    const id = this.room.id
    const bytes = tx.t === 'REQUEST' ? Mbcp.request(id, tx.priority ?? 0) : tx.t === 'RELEASE' ? Mbcp.release(id) : Mbcp.queuePosRequest(id)
    if (!this.room.sendFloor(bytes)) this.log.debug(`DC 로 ${tx.t} 를 못 보냈다 — 위 타이머가 다시 보낸다`, { room: id })
  }

  // ── 효과 표 — 낼 표면 · 할 동작 · 이음매는 결합(effect)이 정한다 · 덧붙임만 여기 ──

  private effect(f: FLR.Fx, extras: Extra[]): void {
    const e = PB.effect(f)
    if (e.seam) { this.gate(f); return }
    if (e.action === 'playback.render') { this.room.renderVoice(); return }
    switch (f) {
      case 'app.granted':
      case 'app.granted_queued':
        this.remainingSec = this.st.grant
        this.grantedPrio = this.st.prio
        this.lastEnd = undefined
        if (f === 'app.granted_queued') this.intentOwed = true
        break
      case 'app.denied': {
        const rx = this.lastRx
        if (rx && rx.t === 'DENY') this.lastDeny = rx.reason !== undefined ? { cause: rx.cause, text: rx.reason } : { cause: rx.cause }
        this.lastEnd = 'denied'
        break
      }
      case 'app.queued': {
        const rx = this.lastRx
        if (rx && rx.t === 'QINFO') this.queuePos = rx.info.position
        break
      }
      case 'app.revoked': {
        const rx = this.lastRx
        if (rx && rx.t === 'REVOKE') {
          this.lastRevoke = rx.reason !== undefined ? { cause: rx.cause, text: rx.reason } : { cause: rx.cause }
          if (rx.cause === Revoke.TOO_LONG) this.t9.start(Timers.T9_MS, () => this.surface())
        }
        this.lastEnd = 'revoked'
        break
      }
      case 'app.request_timeout':
      case 'app.queue_timeout': this.lastEnd = 'no_response'; break
      case 'app.grant_expired': this.lastEnd = 't132_expired'; break
      case 'app.floor_unreliable': this.trusted = false; break
      case 'app.floor_reliable': this.trusted = true; break
      default: break
    }
    if (e.event === 'speaker') this.emitSpeaker()
    else if (e.event && e.event !== 'state') extras.push(e.event)
  }

  /** 위 이음매 FLR → PUB — 반이중 게이트(발행 입구 floorOpen · floorClose) */
  private gate(f: FLR.Fx): void {
    if (f === 'mic.open') { this.talkingSince = wall(); this.media.floorOpen(this.room.sfuId) }
    else if (f === 'mic.close') { this.talkingSince = undefined; this.media.floorClose(this.room.sfuId) }
    else throw new Error(`이음매 표에 없는 위 이음매: ${f}`)
  }

  /** 위 상태기가 걸라고 한 타이머만 돈다 — 그 밖은 멈춘다(armed) · 만료는 입구 expire */
  private timersFollow(start: readonly FLR.TimerName[]): void {
    const armed = FLR.armed(this.st)
    for (const [name, t] of this.timers) {
      if (!armed.includes(name)) { t.stop(); continue }
      if (start.includes(name) || !t.armed) t.start(FLR.TIMER_MS[name], () => this.enter('expire', 'timer', [name]))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.timers.values()) t.stop()
    this.t9.stop()
  }
}
