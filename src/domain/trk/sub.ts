// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-TRK-RECEIVE 구독 입구 표 · 연:RULE-SUB-READY-PROC · 연:RULE-SUB-LAYER-PROC · SDK:RULE-MOD-AREA-MIRROR domain/trk(SUB 는 TRK 로 접힌다) · model: claude-opus-5-5
import * as SUB from '../gen/sub_client.js'
import * as UB from '../gen/sub_binding.js'
import { Fault, fromFailure, closedFault } from '../../platform/fault.js'
import type { RoomCore } from '../room/core.js'

/** 입구 표의 입구 — 위 결합(sub_binding)의 ENTRY 열쇠 그대로 */
export type SubEntry = keyof typeof UB.ENTRY
type Args<K extends SubEntry> = (typeof UB.ENTRY)[K] extends (s: SUB.St, ...a: infer A) => unknown ? A : never

/** SUBSCRIBE_LAYER 대상 하나 — 생략한 칸은 안 바꾼다 */
export interface LayerTarget {
  readonly track_id: string
  readonly spatial?: number
  readonly temporal?: number
  readonly paused?: boolean
  readonly priority?: number
}

interface Waiter { resolve: () => void; reject: (f: Fault) => void }

/**
 * 방 하나의 구독 — 위가 지은 구독 상태기 하나(방마다 · READY 는 방 단위).
 * 절차는 위가 정한다 — 여기는 입구 표 · 효과 표 · 보낼 것(READY · SUBSCRIBE_LAYER) · 이음매(sdp.rebuild) 집행만.
 */
export class Subscription {
  st: SUB.St = SUB.initial()
  private readyFault: Fault | null = null
  private queue = new Map<string, LayerTarget>()
  private waiters: Waiter[] = []

  constructor(private readonly room: RoomCore) {}

  /** 입구 하나 — 위 결합 ENTRY 를 지나 한 걸음 · plan() 의 목록대로 직접 한다 */
  enter<K extends SubEntry>(name: K, cause: string, args: Args<K>): void {
    const f = UB.ENTRY[name] as unknown as (s: SUB.St, ...a: Args<K>) => SUB.Step
    const prev = this.st
    const plan = UB.plan(f(this.st, ...args))
    this.st = plan.state
    this.room.record('SUB', this.room.id, prev.ready, this.st.ready, plan.label, cause)
    for (const tx of plan.send) {
      if (tx.ws === 'READY') this.sendReady()
      else if (tx.ws === 'SUBSCRIBE_LAYER') this.flushLayers()
    }
    for (const sm of plan.seams) if (sm.fx === 'sdp.rebuild') this.room.link?.renego()
    for (const e of plan.events) if (e === 'error') this.room.events.emit('error', this.readyFault ?? new Fault({ code: 5003, name: 'READY_FAILED' }))
  }

  /** READY — 그 협상에 쓴 배정표의 차례를 싣는다(연:RULE-SUB-READY-PROC) · 연결 상태기가 직접 내기도 한다 */
  sendReady(): void {
    const arev = this.room.link?.sdpArev ?? 0
    this.room.request('READY', { room_id: this.room.id, arev }).then((r) => {
      if (this.room.closed) return
      this.readyFault = r.ok ? null : fromFailure(r.body)
      this.enter('readyRes', r.ok ? 'READY.res' : 'READY.fail', [{ part: r.ok ? 'res' : 'fail' }])
    }, () => undefined)
  }

  /** 받을 레이어 상한 하나를 싣고 입구 layer — 범위는 부르는 쪽(RemoteTrack)이 이미 잘랐다 · 내 요청이라 실패는 reject */
  setLayer(t: LayerTarget): Promise<void> {
    const cur = this.queue.get(t.track_id) ?? { track_id: t.track_id }
    this.queue.set(t.track_id, { ...cur, ...t })
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.enter('layer', 'app', [])
    })
  }

  private flushLayers(): void {
    const targets = [...this.queue.values()]
    this.queue.clear()
    const waiters = this.waiters.splice(0)
    if (!targets.length) { for (const w of waiters) w.resolve(); return }
    this.room.request('SUBSCRIBE_LAYER', { room_id: this.room.id, targets }).then((r) => {
      if (!this.room.closed) this.enter('layerRes', r.ok ? 'SUBSCRIBE_LAYER.res' : 'SUBSCRIBE_LAYER.fail', [])
      const f = r.ok ? null : fromFailure(r.body)
      for (const w of waiters) { if (f) w.reject(f); else w.resolve() }
    }, (e: unknown) => {
      const f = e instanceof Fault ? e : closedFault('TRANSPORT')
      for (const w of waiters) w.reject(f)
    })
  }
}
