// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-AFF-SPEAKING-ROOM · SDK:RULE-MOD-AREA-MIRROR domain/aff · model: claude-opus-5-5
// ★옛 domain/session.ts 의 소속 부분을 그대로 옮겼다(재설계 없음 — AFF 는 제 차례에 다시 짓는다).
import * as AFF from '../gen/aff_client.js'
import * as AB from '../gen/aff_binding.js'
import type { AffiliationRes } from '../../internal/wire/ws.js'
import type { Signaling, Reply } from '../../internal/ses/signaling.js'
import type { Emitter } from '../../platform/emitter.js'
import type { Logger } from '../../platform/log.js'
import { Fault, fromFailure, closedFault, stateFault } from '../../platform/fault.js'
import type { RoomCore } from '../room/core.js'

export interface AffEvents extends Record<string, unknown[]> {
  speakingRoom: [string | null]
  speakingRoomFailed: [Fault]
}

/** 소속이 쓰는 클라이언트 객체의 몫 — 세션 영역을 부르지 않고(may_use 밖) 쓰는 것만 이름으로 받는다 */
export interface AffHost {
  readonly sig: Pick<Signaling, 'request'>
  readonly events: Emitter<AffEvents>
  readonly log: Logger
  untilActive(): Promise<void>
  record(layer: string, key: string, from: string, to: string, label: string, cause: string): void
  impossible(layer: string, key: string, from: string, entry: string): void
}

interface Waiter { resolve: () => void; reject: (f: Fault) => void }

/** 클라이언트 객체 하나의 소속(발언 방) — 위가 지은 소속 상태기 하나 */
export class AffCore {
  st: AFF.St = AFF.initial()
  private waiter: Waiter | null = null
  private move: { from: string | null; to: string | null } = { from: null, to: null }
  private fault: Fault | null = null

  constructor(private readonly host: AffHost, private readonly rooms: ReadonlyMap<string, RoomCore>) {}

  get speakingRoom(): string | null { return this.st.pub === 'NONE' ? null : this.st.pub }

  /** 발언 방 고르기 — pub_select / pub_deselect 만(SDK:IMPL-AFF-SPEAKING-ROOM) */
  async setSpeakingRoom(roomId: string | null): Promise<void> {
    await this.host.untilActive()
    if (roomId === this.speakingRoom) return
    while (this.waiter) await new Promise<void>((r) => setTimeout(r, 20))
    if (roomId !== null) {
      const room = this.rooms.get(roomId)
      if (!room || room.st.rs !== 'JOINED') throw stateFault('STATE_NOT_JOINED', { room: roomId })
    }
    const p = new Promise<void>((resolve, reject) => { this.waiter = { resolve, reject } })
    const cur = this.speakingRoom
    if (roomId === null) {
      this.move = { from: cur, to: null }
      this.step('deselect', AFF.deselect(this.st), 'app')
    } else {
      const same = cur === null || this.rooms.get(cur)?.sfuId === this.rooms.get(roomId)?.sfuId
      this.move = { from: cur, to: roomId }
      this.step('select', AFF.select(this.st, roomId, same), 'app')
    }
    if (!this.waiter) return
    return p
  }

  step(entry: string, step: AFF.Step | null, cause: string): void {
    if (!step) {
      this.host.impossible('AFF', 'client', this.st.wait, entry)
      const w = this.waiter; this.waiter = null; w?.resolve()
      return
    }
    const prev = this.st
    const plan = AB.plan(step)
    this.st = plan.state
    this.host.record('AFF', 'client', `${prev.wait}:${prev.pub}`, `${this.st.wait}:${this.st.pub}`, plan.label, cause)
    for (const tx of plan.send) this.send(tx)
    for (const sm of plan.seams) {
      if (sm.fx === 'floor.pub_away') {
        const from = prev.pub !== 'NONE' ? prev.pub : this.move.from
        if (from) this.rooms.get(from)?.floor.pubAway()
      } else if (sm.fx === 'floor.pub_select') {
        if (this.st.pub !== 'NONE') this.rooms.get(this.st.pub)?.floor.pubSelect()
      }
    }
    for (const f of step.fx) {
      if (f === 'app.affiliation') {
        this.host.events.emit('speakingRoom', this.speakingRoom)
        if (this.st.wait === 'NONE') { const w = this.waiter; this.waiter = null; w?.resolve() }
      } else if (f === 'app.aff_failed') {
        const fault = this.fault ?? new Fault({ code: 5003, name: 'INTERNAL_ERROR' })
        this.fault = null
        this.host.events.emit('speakingRoomFailed', fault)
        const w = this.waiter; this.waiter = null; w?.reject(fault)
      }
    }
    if (this.st.wait === 'NONE' && this.waiter && step.fx.length === 0) { const w = this.waiter; this.waiter = null; w.resolve() }
  }

  private send(tx: AFF.Tx): void {
    const body: Record<string, unknown> = {}
    if (tx.pub_select !== undefined) body['pub_select'] = tx.pub_select
    if (tx.pub_deselect !== undefined) body['pub_deselect'] = tx.pub_deselect
    const asked = tx.pub_select ?? tx.pub_deselect ?? ''
    const server = this.rooms.get(asked)?.sfuId ?? null
    this.host.sig.request('AFFILIATION', body).then((r) => this.reply(r, server), () => {
      this.fault = closedFault('TRANSPORT')
      this.step('res', AFF.res(this.st, false, 'NONE', false, false), 'AFFILIATION.closed')
    })
  }

  private reply(r: Reply, server: string | null): void {
    if (!r.ok) {
      this.fault = fromFailure(r.body)
      this.step('res', AFF.res(this.st, false, 'NONE', false, false), `AFFILIATION.${this.fault.code}`)
      return
    }
    const b = r.body as AffiliationRes
    if (b.pub_room !== null && !b.sub_rooms.includes(b.pub_room)) {
      this.host.log.error('pub_room ⊄ sub_rooms 응답 — 반영하지 않는다(서버 결함)', { pub_room: b.pub_room, sub_rooms: b.sub_rooms })
      this.fault = new Fault({ code: 5003, name: 'AFFILIATION_INCONSISTENT', category: 'server' })
      this.step('res', AFF.res(this.st, false, 'NONE', false, false), 'AFFILIATION.bad')
      return
    }
    const onPub = this.st.pub !== 'NONE' && this.rooms.get(this.st.pub)?.sfuId === server
    const onWant = this.st.want !== 'NONE' && this.rooms.get(this.st.want)?.sfuId === server
    this.step('res', AFF.res(this.st, true, b.pub_room ?? 'NONE', onPub, onWant), 'AFFILIATION.res')
  }
}
