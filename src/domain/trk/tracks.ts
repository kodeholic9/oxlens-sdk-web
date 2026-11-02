// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-TRK-RECEIVE · SDK:RULE-TRK-STORE · SDK:IMPL-MOD-TABLE domain/store 트랙 층 · SDK:RULE-MOD-AREA-MIRROR domain/trk · model: claude-opus-5-5
// ★옛 domain/rooms.ts 의 트랙 상태기 · 구독 상태기(SUB 는 TRK 로 접힌다) 부분과 옛 domain/store.ts 의 트랙 층을 그대로 옮겼다(재설계 없음 — TRK 는 제 차례에 다시 짓는다).
import * as SUB from '../gen/sub_client.js'
import * as UB from '../gen/sub_binding.js'
import * as TRK from '../gen/trk_client.js'
import * as TB from '../gen/trk_binding.js'
import type { TrackEntry, TrackEventBody, TrackStateBody } from '../../internal/wire/ws.js'
import { Fault, fromFailure } from '../../platform/fault.js'
import type { RoomCore } from '../room/core.js'
import { RemoteCore } from './remote.js'

type Layer = { track_id: string; spatial?: number; temporal?: number; paused?: boolean; priority?: number }

/** 방 하나의 받는 쪽 — 트랙 층(보기용) · 트랙 상태기 · 구독 상태기 · 받는 트랙 핸들 · 수신 오디오 */
export class RoomTracks {
  st: TRK.St = { lay: {} as TRK.St['lay'], muted: {} as TRK.St['muted'] }
  sub: SUB.St = SUB.initial()
  readonly entries = new Map<string, TrackEntry>()
  readonly remotes = new Map<string, RemoteCore>()
  private readyFault: Fault | null = null
  private layerQueue = new Map<string, Layer>()
  private layerWaiters: (() => void)[] = []
  private audioMuted = false
  private audioVolume = 1

  constructor(private readonly room: RoomCore) {}

  private get core(): RoomCore['core'] { return this.room.core }

  // ── 트랙 상태기 ──────────────────────────────────────────────────────

  /** 방이 받아들인 보관본의 트랙 목록 — 통째로 갈아 끼운다 */
  reset(list: readonly TrackEntry[]): void {
    this.entries.clear()
    for (const t of list) this.entries.set(t.track_id, t)
  }

  /** 위 이음매 trk.snapshot */
  snapshot(): void {
    const lay: Record<string, TRK.Layer> = {}
    const muted: Record<string, boolean> = {}
    const me = this.core.userId
    for (const t of this.entries.values()) {
      if (t.type === 'individual' && t.user_id === me) continue
      lay[t.track_id] = t.active === false ? 'RESTING' : 'ACTIVE'
      muted[t.track_id] = t.muted ?? false
    }
    this.step('snapshot', TRK.snapshot(this.st, lay as unknown as TRK.St['lay'], muted as unknown as TRK.St['muted']), 'snapshot')
  }

  /** 위 이음매 store.drop */
  storeDrop(cause: string): void {
    this.step('storeDrop', TRK.storeDrop(this.st), cause)
    this.entries.clear()
    this.syncRemotes()
  }

  step(entry: string, step: TRK.Step | null, cause: string, key?: string): void {
    if (!step) { this.core.impossible('TRK', this.room.id, '-', entry); return }
    const plan = TB.plan(step)
    this.st = plan.state
    this.core.record('TRK', key ? `${this.room.id}/${key}` : this.room.id, '-', '-', plan.label, cause)
    for (const sm of plan.seams) if (sm.fx === 'pub.revoked' && key) this.core.media.byTrackId(key)?.revoked()
    for (const f of step.fx) {
      const e = TB.effect(f).event
      if (e === 'track') this.syncRemotes()
      else if (e === 'muted' && key) this.remotes.get(key)?.setMuted(this.entries.get(key)?.muted ?? false)
    }
  }

  /** 위 이음매 trk.delta — 방 상태기가 받은 트랙 통지만 여기 닿는다(version 판정은 방 상태기 한 곳 · SDK:RULE-TRK-STORE) */
  delta(op: string, body: Record<string, unknown>): void {
    if (op === 'TRACK_EVENT') {
      const b = body as unknown as TrackEventBody
      for (const t of b.tracks) {
        const mine = this.core.media.ownsTrack(t.track_id)
        const step = TRK.trackEvent(this.st, { t: 'TRACK_EVENT', action: b.action, tracks: { active: t.active ?? true, muted: t.muted ?? false, track_id: t.track_id as TRK.TrackId } }, mine)
        if (!mine) {
          if (b.action === 'remove') this.entries.delete(t.track_id)
          else this.entries.set(t.track_id, t)
        }
        this.step('trackEvent', step, op, t.track_id)
      }
    } else if (op === 'TRACK_STATE') {
      const b = body as unknown as TrackStateBody
      const cur = this.entries.get(b.track_id)
      if (cur) this.entries.set(b.track_id, { ...cur, muted: b.muted })
      this.step('trackState', TRK.trackState(this.st, { t: 'TRACK_STATE', muted: b.muted, track_id: b.track_id as TRK.TrackId }), op, b.track_id)
    }
  }

  /** 보관본과 핸들을 맞춘다 — 장착 가능하면 track · 줄이 없으면 trackUnreachable · 빠지면 ended · 교체는 같은 핸들의 active */
  syncRemotes(): void {
    if (this.room.closed) return
    const me = this.core.userId
    const link = this.room.link
    for (const [id, r] of [...this.remotes]) {
      if (!this.entries.has(id)) { this.remotes.delete(id); r.end() }
    }
    for (const t of this.entries.values()) {
      if (t.type === 'individual' && t.user_id === me) continue
      let r = this.remotes.get(t.track_id)
      if (!r) { r = new RemoteCore(this.core, this.room, t); this.remotes.set(t.track_id, r) }
      else r.update(t)
      const row = link?.table.rowOf(t.track_id)
      const rx = row ? link?.peer?.receiverOf(row.mid) ?? null : null
      r.bind(row ?? null, rx)
    }
    this.room.floor.speakerTracks()
  }

  /** 방이 닫혔다 — 핸들을 전부 끝낸다 */
  endAll(): void {
    for (const r of this.remotes.values()) r.end()
    this.remotes.clear()
  }

  // ── 구독 상태기 ──────────────────────────────────────────────────────

  /** 위 이음매 ready.tracks */
  ready(cause: string): void { this.subStep('ready', SUB.ready(this.sub), cause) }

  /** 위 이음매 sub.drop */
  dropSub(cause: string): void { this.subStep('dropRoom', SUB.dropRoom(this.sub), cause) }

  subStep(entry: string, step: SUB.Step, cause: string): void {
    const prev = this.sub
    const plan = UB.plan(step)
    this.sub = plan.state
    this.core.record('SUB', this.room.id, prev.ready, this.sub.ready, plan.label, cause)
    for (const tx of plan.send) {
      if (tx.ws === 'READY') this.sendReady()
      else if (tx.ws === 'SUBSCRIBE_LAYER') this.flushLayers()
    }
    for (const sm of plan.seams) if (sm.fx === 'sdp.rebuild') this.room.link?.renego()
    for (const f of step.fx) if (UB.effect(f).event === 'error') this.room.events.emit('error', this.readyFault ?? new Fault({ code: 5003, name: 'READY_FAILED' }))
    void entry
  }

  sendReady(): void {
    const arev = this.room.link?.sdpArev ?? 0
    this.core.sig.request('READY', { room_id: this.room.id, arev }).then((r) => {
      this.readyFault = r.ok ? null : fromFailure(r.body)
      this.subStep('readyRes', SUB.readyRes(this.sub, { part: r.ok ? 'res' : 'fail' }), 'READY.res')
    }, () => undefined)
  }

  /** 받을 레이어 상한 — 생략한 필드는 안 바꾼다(연:RULE-SUB-LAYER-PROC) */
  setLayer(trackId: string, v: { spatial?: number; temporal?: number; paused?: boolean; priority?: number }): Promise<void> {
    const cur = this.layerQueue.get(trackId) ?? { track_id: trackId }
    this.layerQueue.set(trackId, { ...cur, ...v })
    return new Promise((resolve) => {
      this.layerWaiters.push(resolve)
      this.subStep('layer', SUB.layer(this.sub), 'app')
    })
  }

  private flushLayers(): void {
    const targets = [...this.layerQueue.values()]
    this.layerQueue.clear()
    const waiters = this.layerWaiters.splice(0)
    if (!targets.length) { for (const w of waiters) w(); return }
    this.core.sig.request('SUBSCRIBE_LAYER', { room_id: this.room.id, targets }).then(() => {
      this.subStep('layerRes', SUB.layerRes(this.sub), 'SUBSCRIBE_LAYER.res')
      for (const w of waiters) w()
    }, () => { for (const w of waiters) w() })
  }

  // ── 수신 오디오 — SDK 가 재생한다(SDK:IMPL-TRK-RECEIVE room.audio) ──

  get audio(): { muted: boolean; volume: number } { return { muted: this.audioMuted, volume: this.audioVolume } }

  setAudioMuted(m: boolean): void { this.audioMuted = m; for (const r of this.remotes.values()) r.applyPlayback() }
  setAudioVolume(v: number): void { this.audioVolume = Math.max(0, Math.min(1, v)); for (const r of this.remotes.values()) r.applyPlayback() }
}
