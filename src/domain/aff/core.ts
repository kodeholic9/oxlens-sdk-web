// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-AFF-SPEAKING-ROOM · SDK:RULE-MOD-AREA-MIRROR domain/aff · model: claude-opus-5-5
import * as AFF from '../gen/aff_client.js'
import * as AB from '../gen/aff_binding.js'
import type { Affiliation, AffiliationRes } from '../../internal/wire/ws.js'
import { Emitter } from '../../platform/emitter.js'
import type { Logger } from '../../platform/log.js'
import { Fault, fromFailure, closedFault, stateFault } from '../../platform/fault.js'
import type { RoomTable } from '../room/table.js'

export interface AffEvents extends Record<string, unknown[]> {
  speakingRoom: [string | null]
  speakingRoomFailed: [Fault]
}

/** 입구 표의 입구 — 위 결합(aff_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof AB.ENTRY
type Args<K extends Entry> = (typeof AB.ENTRY)[K] extends (s: AFF.St, ...a: infer A) => unknown ? A : never
type Reply = Awaited<ReturnType<RoomTable['request']>>

interface Waiter { resolve: () => void; reject: (f: Fault) => void }

const NONE = 'NONE'

/**
 * 클라이언트 객체 하나의 소속(발언 방) — 위가 지은 소속 클라 상태기 하나.
 * 절차는 위가 정한다 — 여기는 입구 표(어느 SDK 사건 · 어느 이음매가 어느 입구를) · 효과 표(위 효과를 어느 표면으로) · 이음매 집행만.
 * 소속은 세션 영역을 부르지 않는다(may_use = FLR · PUB · ROOM) — 요청 · 기록 · 접속 기다림 · 발행 무리는 소속을 든 방 목록(RoomTable)이 내주고, 이벤트는 소속이 직접 낸다.
 */
export class AffCore {
  st: AFF.St = AFF.initial()
  readonly events = new Emitter<AffEvents>()
  /** 기다리는 setSpeakingRoom() 하나 — 전환은 한 번에 하나다(위 상태 wait) */
  private waiter: Waiter | null = null
  /** 떠 있는 전환이 끝나기를 기다리는 setSpeakingRoom() 들 */
  private idlers: (() => void)[] = []
  /** 지금 넣는 사건이 실어 온 실패 응답 — 위가 app.aff_failed 를 내면 이것으로 알린다 · 없으면 STATE_AFF_ABANDONED(SDK:IMPL-AFF-SPEAKING-ROOM 효과 표 — 사유는 입구로 정한다) */
  private carried: Fault | null = null

  constructor(private readonly rooms: RoomTable, private readonly log: Logger) {}

  /** 지금 발언 방 — 재구축이 내린 방을 되찾는 동안(위 상태 back)은 그 방을 그대로 보인다(SDK:IMPL-AFF-SPEAKING-ROOM 입구 down) */
  get speakingRoom(): string | null { return this.st.pub !== NONE ? this.st.pub : this.st.back !== NONE ? this.st.back : null }

  // ── 앱 조작 ──────────────────────────────────────────────────────────

  /** 발언 방 고르기 · 빼기 — 입구 select · deselect(SDK:IMPL-AFF-SPEAKING-ROOM) · 떠 있는 전환은 끝나기를 기다린다 */
  async setSpeakingRoom(roomId: string | null): Promise<void> {
    await this.rooms.untilActive()
    while (this.st.wait !== NONE) await new Promise<void>((r) => this.idlers.push(r))
    if (roomId === this.speakingRoom) return
    if (roomId !== null) {
      const room = this.rooms.get(roomId)
      if (!room || room.st.rs !== 'JOINED') throw stateFault('STATE_NOT_JOINED', { room: roomId })
    }
    const p = new Promise<void>((resolve, reject) => { this.waiter = { resolve, reject } })
    const took = roomId === null ? this.enter('deselect', 'app', []) : this.enter('select', 'app', [roomId, this.sameServer(this.st.pub, roomId)])
    if (!took) this.settle()
    return p
  }

  // ── 위 이음매 · 입장이 부르는 입구 ─────────────────────────────────────

  /** select:true 로 들어가나 — 입구 joinSelect(talk 입장) · 4009 되풀이는 앞 입장이 건 기다림을 그대로 잇는다 */
  joinSelect(roomId: string, talk: boolean): boolean {
    if (this.st.wait === 'JOIN' && this.st.want === roomId) return true
    return talk && this.enter('joinSelect', 'app', [roomId], true)
  }

  /** 이음매 aff.leave — 듣던 방을 떠났다 */
  left(roomId: string, cause: string): void { this.enter('left', cause, [roomId]) }

  /** 이음매 aff.down — 재구축이 그 방을 내렸다(다시 들어간다) */
  down(roomId: string, cause: string): void { this.enter('down', cause, [roomId]) }

  /** 이음매 aff.join_failed — 그 방 입장이 실패했다 */
  joinFailed(roomId: string, fault: Fault | null, cause: string): void { this.enter('joinFailed', cause, [roomId], false, fault) }

  /** 이음매 aff.implicit — 입장 응답의 affiliation · p 는 그 방이 응답의 sub_rooms 에 있을 때만 · onPub = 지금 발언 방이 그 응답을 낸 서버의 방 · 읽는 값 pIn */
  implicit(roomId: string, sel: boolean, a: Affiliation | undefined, sfuId: string | null, cause: string): void {
    const p = a && a.pub_room !== null && a.sub_rooms.includes(a.pub_room) ? a.pub_room : NONE
    this.enter('implicit', cause, [roomId, sel, p, this.onServer(this.st.pub, sfuId), this.joined(p)])
  }

  // ── 입구 표 — 위 결합 ENTRY 를 지나 한 걸음 ─────────────────────────────

  /** 입구 하나 — 위가 안 받으면(null) 받지 않는 사건으로 적는다 · quiet 면 사건이 없던 것으로 둔다 · 받았는지를 돌려준다 */
  private enter<K extends Entry>(name: K, cause: string, args: Args<K>, quiet = false, fault: Fault | null = null): boolean {
    const f = AB.ENTRY[name] as unknown as (s: AFF.St, ...a: Args<K>) => AFF.Step | null
    const step = f(this.st, ...args)
    if (!step) {
      if (!quiet) this.rooms.impossible('AFF', 'client', show(this.st), name)
      return false
    }
    this.carried = fault
    this.step(step, cause)
    this.carried = null
    return true
  }

  /** 한 걸음의 집행 — plan() 이 돌려준 목록대로(보낼 것 · 이음매 · 이벤트) 직접 한다 */
  private step(step: AFF.Step, cause: string): void {
    const prev = this.st
    const plan = AB.plan(step)
    this.st = plan.state
    this.rooms.record('AFF', 'client', show(prev), show(this.st), plan.label, cause)
    for (const tx of plan.send) this.send(tx)
    for (const sm of plan.seams) this.seam(sm.fx, prev)
    for (const e of plan.events) this.emit(e)
    if (this.st.wait === NONE) this.settle()
  }

  /** 전환이 끝났다 — 기다리던 setSpeakingRoom() resolve(실패는 효과가 먼저 reject 했다) · 뒤에 줄 선 전환을 깨운다 */
  private settle(): void {
    const w = this.waiter; this.waiter = null
    w?.resolve()
    for (const r of this.idlers.splice(0)) r()
  }

  // ── 보낼 것 · 받은 응답 ───────────────────────────────────────────────

  private send(tx: AFF.Tx): void {
    const body: Record<string, unknown> = {}
    // 방 칸마다 그 방 지금 입장의 join_id(연:RULE-ROOM-JOIN-ID)
    if (tx.pub_deselect !== undefined) { body['pub_deselect'] = tx.pub_deselect; const j = this.rooms.get(tx.pub_deselect)?.joinId; if (j) body['pub_deselect_join_id'] = j }
    if (tx.pub_select !== undefined) { body['pub_select'] = tx.pub_select; const j = this.rooms.get(tx.pub_select)?.joinId; if (j) body['pub_select_join_id'] = j }
    // 응답할 서버 — 고르는 방의 서버(같은 서버 전환이면 빼는 방과 같다) · 빼기만이면 빼는 방의 서버
    const server = this.rooms.get(tx.pub_select ?? tx.pub_deselect ?? '')?.sfuId ?? null
    // 기한 초과도 응답 실패와 같이 — 서버 값은 이어지는 RESUME 스냅샷의 소속이 준다(연:RULE-TRN-REQ-ABANDON)
    this.rooms.request('AFFILIATION', body).then((r) => this.reply(r, server), (e: unknown) => {
      this.enter('res', 'AFFILIATION.closed', [false, NONE, false, false, false], false, e instanceof Fault ? e : closedFault('TRANSPORT'))
    })
  }

  /** 소속 응답 — 입구 res · pub_room ⊆ sub_rooms 를 깬 응답은 반영하지 않는다(server 실패) */
  private reply(r: Reply, server: string | null): void {
    if (!r.ok) {
      const f = fromFailure(r.body)
      this.enter('res', `AFFILIATION.${f.code}`, [false, NONE, false, false, false], false, f)
      return
    }
    const b = r.body as AffiliationRes
    if (b.pub_room !== null && !b.sub_rooms.includes(b.pub_room)) {
      this.log.error('pub_room ⊄ sub_rooms 응답 — 반영하지 않는다(서버 결함)', { pub_room: b.pub_room, sub_rooms: b.sub_rooms })
      this.enter('res', 'AFFILIATION.bad', [false, NONE, false, false, false], false, new Fault({ code: 5003, name: 'AFFILIATION_INCONSISTENT', category: 'server' }))
      return
    }
    const p = b.pub_room ?? NONE
    this.enter('res', 'AFFILIATION.res', [true, p, this.onServer(this.st.pub, server), this.onServer(this.st.want, server), this.joined(p)])
  }

  // ── 이음매 — 받는 곳은 위가 정했다(발언권: 옛 발언 방 · 새 발언 방 · 발행: 내 트랙 전부) ─────────

  private seam(fx: AFF.SeamFx, prev: AFF.St): void {
    switch (fx) {
      case 'floor.pub_away': if (prev.pub !== NONE) this.rooms.get(prev.pub)?.floor.pubAway(); break
      case 'floor.pub_select': if (this.st.pub !== NONE) this.rooms.get(this.st.pub)?.floor.pubSelect(); break
      // 서버를 건너는 전환 ① — 읽는 값 here = 트랙의 서버가 떠나는 발행 방(옛 상태 pub)의 서버다(연:RULE-AFF-SWITCH-TRACKS)
      case 'pub.move_out': this.rooms.media.moveOut(prev.pub === NONE ? null : this.rooms.get(prev.pub)?.sfuId ?? null); break
      // ② · ③ — 발행 방이 섰다(새 방 · 되돌린 옛 방) · 서버를 그 방의 서버로 다시 읽는 것은 발행 몫(SDK:IMPL-PUB-API LocalTrack.server)
      case 'pub.move_in': this.rooms.media.moveIn(this.st.pub === NONE ? null : this.st.pub); break
      default: {
        const missing: never = fx
        throw new Error(`이음매 표에 없는 위 이음매: ${String(missing)}`)
      }
    }
  }

  // ── 효과 표 — 낼 표면은 결합(effect)이 정한다 · 덧붙임만 여기 ─────────

  private emit(e: AB.AffEvent): void {
    switch (e) {
      case 'speakingRoom': this.events.emit('speakingRoom', this.speakingRoom); return
      case 'speakingRoomFailed': {
        // 입장(joinSelect)이 건 기다림이면 기다리는 setSpeakingRoom() 이 없다 — 이벤트만 · 실패 응답이 아니면(떠남 · 재구축 · 건너뜀 · 떠난 방) STATE_AFF_ABANDONED
        const f = this.carried ?? stateFault('STATE_AFF_ABANDONED')
        const w = this.waiter; this.waiter = null
        this.events.emit('speakingRoomFailed', f)
        w?.reject(f)
        return
      }
      default: {
        const missing: never = e
        throw new Error(`효과 표에 없는 이벤트: ${String(missing)}`)
      }
    }
  }

  // ── 읽는 값 ──────────────────────────────────────────────────────────

  /** 읽는 값 pIn — 방 r 에 지금 들어가 있다(그 방 핸들 state:'joined' · 연:AFF READS ROOM.rs) */
  private joined(r: string): boolean { return r !== NONE && this.rooms.get(r)?.st.rs === 'JOINED' }

  /** 방 a 와 방 b 가 같은 서버다(a 가 없으면 아니다) */
  private sameServer(a: string, b: string): boolean {
    return a !== NONE && this.onServer(a, this.rooms.get(b)?.sfuId ?? null)
  }

  /** 방 r 이 서버 sfuId 의 방이다 */
  private onServer(r: string, sfuId: string | null): boolean {
    return r !== NONE && sfuId !== null && this.rooms.get(r)?.sfuId === sfuId
  }
}

const show = (s: AFF.St): string => `${s.wait}:${s.pub}${s.from !== NONE ? `<${s.from}` : ''}${s.back !== NONE ? `^${s.back}` : ''}`
