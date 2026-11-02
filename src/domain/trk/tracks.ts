// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-TRK-RECEIVE · SDK:RULE-TRK-STORE · SDK:IMPL-MOD-TABLE domain/store 트랙 층 · SDK:RULE-MOD-BINDING-VALUES 트랙 자리 · SDK:RULE-MOD-AREA-MIRROR domain/trk · model: claude-opus-5-5
import * as TRK from '../gen/trk_client.js'
import * as TB from '../gen/trk_binding.js'
import type { TrackEntry, TrackEventBody, TrackStateBody } from '../../internal/wire/ws.js'
import type { Logger } from '../../platform/log.js'
import type { Settings } from '../defaults.js'
import type { MediaRegistry } from '../pub/registry.js'
import type { RoomCore } from '../room/core.js'
import { RemoteCore } from './remote.js'
import { Subscription } from './sub.js'
import type { Playback } from './playback.js'

/** 입구 표의 입구 — 위 결합(trk_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof TB.ENTRY
type Args<K extends Entry> = (typeof TB.ENTRY)[K] extends (s: TRK.St, ...a: infer A) => unknown ? A : never

/** 받는 쪽이 읽는 createClient 설정(정책:sdk) */
export type TrkSettings = Pick<Settings, 'adaptiveStream' | 'adaptiveStreamSettleMs' | 'wakeDetectMs'>

/** 트랙 자리 — 생성 코드의 키 형은 모형 자리라 실제 track_id 로 넓혀 부른다(SDK:RULE-MOD-BINDING-VALUES) */
const at = (id: string): TRK.TrackId => id as TRK.TrackId

/** 내 개인 트랙 — 받을 트랙이 아니다 */
const own = (t: TrackEntry, me: string | null): boolean => t.type === 'individual' && t.user_id === me

/**
 * 방 하나의 받는 쪽 — 위가 지은 트랙 상태기 하나(방마다) · 구독(SUB 를 접는다) · 받는 트랙 핸들 · 수신 오디오.
 * 절차는 위가 정한다 — 보관본(entries)은 위 상태(lay)를 따라 고치고, 핸들은 보관본 · 배정표 줄 · 수신 트랜시버로 맞춘다.
 * 세션 영역은 부르지 않는다 — 방(ROOM)이 내주는 것(기록 · 요청 · 통지) · 연결(LINK)의 표 · 발행(PUB)만 쓴다(tools/sdk_deps.json may_use).
 */
export class RoomTracks {
  st: TRK.St = { lay: {}, muted: {} } as unknown as TRK.St
  readonly entries = new Map<string, TrackEntry>()
  readonly remotes = new Map<string, RemoteCore>()
  readonly sub: Subscription
  private audioMuted = false
  private audioVolume = 1

  constructor(readonly room: RoomCore, readonly media: MediaRegistry, readonly playback: Playback, readonly cfg: TrkSettings, readonly log: Logger) {
    this.sub = new Subscription(room)
  }

  // ── 입구 표 — 위 결합 ENTRY 를 지나 한 걸음 ─────────────────────────────

  /** 입구 하나 — 위가 안 받으면(null) 받지 않는 사건으로 적는다 · 받았으면 집행 목록을 돌려준다 */
  private enter<K extends Entry>(name: K, cause: string, args: Args<K>, key?: string): TB.Plan | null {
    const f = TB.ENTRY[name] as unknown as (s: TRK.St, ...a: Args<K>) => TRK.Step | null
    const where = key ? `${this.room.id}/${key}` : this.room.id
    const step = f(this.st, ...args)
    if (!step) { this.room.impossible('TRK', where, '-', name); return null }
    const plan = TB.plan(step)
    this.st = plan.state
    this.room.record('TRK', where, '-', '-', plan.label, cause)
    return plan
  }

  /** 한 걸음의 집행 — 이음매 · 이벤트를 plan 의 목록대로. 항목 하나의 걸음이면 그 항목을 위 상태대로 보관본에 */
  private run(plan: TB.Plan, key?: string, item?: TrackEntry): void {
    for (const sm of plan.seams) if (sm.fx === 'pub.revoked' && key) this.media.byTrackId(key)?.revoked()
    for (const e of plan.events) {
      if (e === 'track') {
        if (key && item) {
          if (this.st.lay[at(key)] === 'NONE') this.entries.delete(key)
          else this.entries.set(key, item)
        }
        this.syncRemotes()
      } else if (e === 'muted' && key) {
        const m = this.st.muted[at(key)] ?? false
        const cur = this.entries.get(key)
        if (cur) this.entries.set(key, { ...cur, muted: m })
        this.remotes.get(key)?.setMuted(m)
      }
    }
  }

  // ── 위 이음매가 부르는 입구(ROOM trk.delta · trk.snapshot · store.drop) ──

  /** trk.delta — 방 상태기가 받아들인 트랙 통지만 닿는다(version 판정은 방 상태기 한 곳 · SDK:RULE-TRK-STORE) */
  delta(op: string, body: Record<string, unknown>): void {
    if (op === 'TRACK_EVENT') {
      const b = body as unknown as TrackEventBody
      for (const t of b.tracks) {
        const mine = this.media.ownsTrack(t.track_id)
        const m = { t: 'TRACK_EVENT' as const, action: b.action, tracks: { active: t.active ?? true, muted: t.muted ?? false, track_id: at(t.track_id) } }
        const plan = this.enter('trackEvent', op, [m, mine], t.track_id)
        if (plan) this.run(plan, t.track_id, t)
      }
    } else if (op === 'TRACK_STATE') {
      const b = body as unknown as TrackStateBody
      const plan = this.enter('trackState', op, [{ t: 'TRACK_STATE', muted: b.muted, track_id: at(b.track_id) }], b.track_id)
      if (plan) this.run(plan, b.track_id)
    }
  }

  /** trk.snapshot — 방이 받아들인 보관본의 그 방 트랙 전부(입장 응답 · 이어받기 · 재동기) · list 가 없으면 지금 보관본 그대로 */
  snapshot(list: readonly TrackEntry[] | null, cause: string): void {
    if (list) {
      this.entries.clear()
      for (const t of list) this.entries.set(t.track_id, t)
    }
    const lay: Record<string, TRK.Layer> = {}
    const muted: Record<string, boolean> = {}
    const me = this.room.selfId
    for (const t of this.entries.values()) {
      if (own(t, me)) continue
      lay[t.track_id] = t.active === false ? 'RESTING' : 'ACTIVE'
      muted[t.track_id] = t.muted ?? false
    }
    const plan = this.enter('snapshot', cause, [lay as TRK.St['lay'], muted as TRK.St['muted']])
    if (plan) this.run(plan)
  }

  /** store.drop — 그 방을 떠났다 · 내렸다: 보관본을 버린다 · 그 보관본으로 지은 핸들도 끝난다 */
  storeDrop(cause: string): void {
    const plan = this.enter('storeDrop', cause, [])
    this.entries.clear()
    if (plan) this.run(plan)
    this.syncRemotes()
  }

  // ── 받는 트랙 핸들 ─────────────────────────────────────────────────────

  /** 보관본과 핸들을 맞춘다 — 장착 가능하면 track · 줄이 없으면 trackUnreachable · 빠지면 ended · 교체는 같은 핸들의 active */
  syncRemotes(): void {
    if (this.room.closed) return
    const me = this.room.selfId
    const link = this.room.link
    for (const [id, r] of [...this.remotes]) {
      if (!this.entries.has(id)) { this.remotes.delete(id); r.end() }
    }
    for (const t of this.entries.values()) {
      if (own(t, me)) continue
      const row = link?.table.rowOf(t.track_id) ?? null
      let r = this.remotes.get(t.track_id)
      // 줄을 잃어 끝난 핸들 — 줄이 다시 오면 새 핸들(SDK:IMPL-TRK-RECEIVE trackUnreachable)
      if (r?.ended) { if (!row) continue; this.remotes.delete(t.track_id); r = undefined }
      if (!r) { r = new RemoteCore(this, t); this.remotes.set(t.track_id, r) }
      else r.update(t)
      r.bind(row, row ? link?.peer?.receiverOf(row.mid) ?? null : null)
    }
    this.room.tracksChanged()
  }

  /** 방이 닫혔다 — 핸들을 전부 끝낸다 */
  endAll(): void {
    for (const r of this.remotes.values()) r.end()
    this.remotes.clear()
  }

  // ── 수신 오디오 — SDK 가 재생한다(SDK:IMPL-TRK-RECEIVE room.audio) ──

  get audio(): { muted: boolean; volume: number } { return { muted: this.audioMuted, volume: this.audioVolume } }

  setAudioMuted(m: boolean): void { this.audioMuted = m; for (const r of this.remotes.values()) r.applyPlayback() }
  setAudioVolume(v: number): void { this.audioVolume = Math.max(0, Math.min(1, v)); for (const r of this.remotes.values()) r.applyPlayback() }
}
