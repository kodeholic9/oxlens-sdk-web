// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SES-CLOCK · 연:RULE-SES-BACKOFF-LADDER · 연:RULE-SES-TIMERS-CONN · 연:SES.C.RESUMING.window_passed · model: claude-opus-5-5
import * as SES from '../gen/session_client.js'
import { Timer, now } from '../../platform/clock.js'
import type { Core, Entry } from './core.js'

/**
 * 세션 시계 — 위 세션 상태기가 걸라고 한 타이머 · 끊긴 시각 · 재개 창.
 * 값은 위 원장 그대로(시한 · 사다리 · 안정 관찰) · 하트비트 주기와 재개 창은 위 상태가 보관한 BIND 응답값이다.
 * 숨은 탭에서도 돈다 — 브라우저는 1초로 정렬할 뿐 세우지 않는다.
 */
export class SesClock {
  readonly timers = new Map<SES.TimerName, Timer>()
  private readonly window: Timer
  private droppedAt = 0

  constructor(private readonly core: Core, wakeDetectMs: number) {
    for (const t of ['TBind', 'TReq', 'THb', 'Backoff', 'TStable'] as const) this.timers.set(t, new Timer(wakeDetectMs))
    this.window = new Timer(wakeDetectMs)
  }

  /** 한 걸음 뒤 — 새로 걸라고 한 것을 걸고 armed() 밖은 멈춘다 · 끊긴 시각을 적고 재개 창을 잰다 */
  follow(entry: Entry, prev: SES.St, start: readonly SES.TimerName[]): void {
    const armed = SES.armed(this.core.ses)
    for (const [name, t] of this.timers) {
      if (!armed.includes(name)) { t.stop(); continue }
      if (start.includes(name) || !t.armed) t.start(this.ms(name), (f) => this.fire(name, f.woke))
    }
    // 끊긴 시각 = 서버에 살아 있던(하트비트가 돌던) 세션의 소켓이 끊긴 때 — 이어받으러 다시 붙는 동안의 끊김은 창을 새로 열지 않는다
    if (entry === 'drop' && prev.hb) this.droppedAt = now()
    this.late()
  }

  /** 타이머 값 — 위 원장 · 위 상태가 보관한 하트비트 주기 · 사다리 칸값(+ 지터) */
  ms(name: SES.TimerName): number {
    const s = this.core.ses
    if (name === 'THb') return s.hbMs || SES.TIMER_MS.THb || 10000
    if (name === 'Backoff') {
      const i = Math.min(s.tries, SES.LADDER.waits.length - 1)
      const base = SES.LADDER.waits[i] ?? 7000
      const jitter = s.tries >= SES.LADDER.jitterFrom - 1 ? Math.floor(Math.random() * SES.LADDER.jitterMs) : 0
      return base + jitter
    }
    return SES.TIMER_MS[name] ?? 10000
  }

  /** 깨어남은 사건이다 — 시한(TBind · TReq · TStable)은 세지 않고 처음부터 다시 잰다 · 하트비트 · 백오프는 그대로 넣는다 */
  private fire(name: SES.TimerName, woke: boolean): void {
    if (woke && name !== 'THb' && name !== 'Backoff') {
      this.core.record('SES', 'session', this.core.ses.cs, this.core.ses.cs, `SDK.wake.${name}`, 'wake')
      this.timers.get(name)?.start(this.ms(name), (f) => this.fire(name, f.woke))
      return
    }
    this.core.expired(name, woke ? 'wake' : 'timer')
  }

  /** 끊긴 시각부터의 경과가 보관한 재개 창을 넘으면 입구 late */
  private late(): void {
    const s = this.core.ses
    if (s.cs !== 'RESUMING' || s.late) { this.window.stop(); return }
    if (this.window.armed) return
    const win = s.winMs || 60000
    const left = Math.max(0, win - (now() - this.droppedAt))
    this.window.start(left, () => {
      if (now() - this.droppedAt < win) { this.late(); return }
      this.core.enter('late', 'clock', [])
    })
  }

  stop(): void {
    for (const t of this.timers.values()) t.stop()
    this.window.stop()
  }
}
