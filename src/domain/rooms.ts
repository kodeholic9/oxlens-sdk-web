// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-ROOM-API · SDK:RULE-ROOM-PERMISSION-BITS · SDK:RULE-ROOM-RESYNC · SDK:IMPL-TRK-RECEIVE · SDK:RULE-TRK-STORE · SDK:RULE-MOD-EVENT-ORDER · SDK:IMPL-MOD-TABLE domain/rooms · model: claude-opus-5-5
import * as ROOM from './gen/room_client.js'
import * as RB from './gen/room_binding.js'
import * as SUB from './gen/sub_client.js'
import * as UB from './gen/sub_binding.js'
import * as TRK from './gen/trk_client.js'
import * as TB from './gen/trk_binding.js'
import * as AFF from './gen/aff_client.js'
import type { RoomJoinRes, MemberInfo, ParticipantStateBody, ParticipantEventBody, TrackEventBody, TrackStateBody, GetRoomRes, RoomSnapshot, Version } from '../internal/wire/ws.js'
import type { Reply } from '../internal/signaling.js'
import { Emitter } from '../platform/emitter.js'
import { Fault, fromFailure, closedFault, negotiationFault } from '../platform/fault.js'
import { sleep } from '../platform/clock.js'
import type { Core } from './session.js'
import { RoomStore, participantOf, permissionOf, ALL_TRUE, type Participant, type Permission } from './store.js'
import { FloorCore } from './floor.js'
import { RemoteCore, type RemoteInfo } from './remote.js'
import { LinkCore } from './links.js'

export interface JoinOptions {
  readonly mode?: 'listen' | 'talk'
  readonly role?: number
}

export type RoomState = 'joining' | 'joined' | 'leaving' | 'closed'

export interface RoomEvents extends Record<string, unknown[]> {
  joined: []
  joinFailed: [Fault]
  left: []
  forced: [{ cause: string }]
  participants: [Participant[]]
  permission: [{ userId: string; permission: Permission; mine: boolean }]
  resync: []
  message: [{ userId: string; content: string }]
  error: [Fault]
  track: [RemoteCore]
  trackUnreachable: [RemoteInfo]
  state: [RoomState]
}

/** 재시도 사다리 둘째~넷째 칸(연:RULE-ERR-CLIENT-FAIL-DEFAULT 4) */
const RETRY = [300, 1200, 2700]
const NO_RETRY = new Set([3001, 4001, 4004, 4005])
/** 첫 협상이 끝내 안 오면 이만큼 뒤 resolve 한다(협상 실패는 room.error 로 따로 온다) */
const JOIN_SETTLE_MS = 10_000

/** 방 하나 — 위 방 상태기 · 구독 상태기 · 트랙 상태기를 방마다 하나씩 돌린다 */
export class RoomCore {
  st: ROOM.St = ROOM.initial()
  sub: SUB.St = SUB.initial()
  trk: TRK.St = { lay: {} as TRK.St['lay'], muted: {} as TRK.St['muted'] }
  readonly store = new RoomStore()
  readonly events = new Emitter<RoomEvents>()
  readonly remotes = new Map<string, RemoteCore>()
  readonly floor: FloorCore
  readonly mode: 'listen' | 'talk'
  readonly role: number
  sfuId: string | null = null
  closed = false
  rebuilding = false
  /** 입장은 됐고 그 입장이 부른 첫 협상을 기다린다 — 초기 트랙이 장착 가능해야 join() 이 resolve 한다(SDK:RULE-API-ASYNC 재진입 금지) */
  joinPending = false
  private joinWaiter: { resolve: (r: RoomCore) => void; reject: (f: Fault) => void } | null = null
  private leaveWaiter: (() => void) | null = null
  private lastJoin: RoomJoinRes | null = null
  private lastFault: Fault | null = null
  private reqEpoch = 0
  private syncEpoch = 0
  private retries = 0
  private audioMuted = false
  private audioVolume = 1

  constructor(readonly core: Core, readonly id: string, opts: JoinOptions) {
    this.mode = opts.mode ?? 'listen'
    this.role = opts.role ?? 255
    this.floor = new FloorCore(core, this)
  }

  get state(): RoomState {
    if (this.closed) return 'closed'
    if (this.st.rs === 'JOINED') return 'joined'
    if (this.st.rs === 'LEAVING') return 'leaving'
    return 'joining'
  }

  get link(): LinkCore | undefined { return this.core.linkFor(this.sfuId) }

  joined(): Promise<RoomCore> {
    if (this.st.rs === 'JOINED') return Promise.resolve(this)
    return new Promise((resolve, reject) => {
      const prev = this.joinWaiter
      this.joinWaiter = { resolve: (r) => { prev?.resolve(r); resolve(r) }, reject: (f) => { prev?.reject(f); reject(f) } }
    })
  }

  start(): Promise<RoomCore> {
    const p = this.joined()
    void this.beginJoin()
    return p
  }

  /** 발언 방이 다른 서버에 있으면 talk 입장 전에 옛 서버 발언 방부터 내린다(연:RULE-ROOM-JOIN-START 2) — 차례는 소속 상태기가 정한다 */
  private async beginJoin(): Promise<void> {
    const step = ROOM.join(this.st)
    this.roomStep('join', step, 'app')
  }

  rejoin(): void {
    this.rebuilding = true
    this.roomStep('rejoin', ROOM.rejoin(this.st), 'rebuild')
  }

  // ── 방 상태기 ────────────────────────────────────────────────────────

  roomStep(entry: string, step: ROOM.Step | null, cause: string): void {
    if (!step) { this.core.impossible('ROOM', this.id, this.st.rs, entry); return }
    const prev = this.st
    const plan = RB.plan(step)
    this.st = plan.state
    this.core.record('ROOM', this.id, prev.rs, this.st.rs, plan.label, cause)
    for (const a of plan.actions) {
      if (a === 'resync.abandon') this.syncEpoch++
      else if (a === 'request.abandon') this.reqEpoch++
    }
    for (const tx of plan.send) this.roomSend(tx)
    for (const sm of plan.seams) this.roomSeam(sm.fx, plan.label)
    for (const f of step.fx) this.roomEffect(f, plan.label)
    if (this.leaveWaiter && this.st.rs === 'NONE' && !this.st.rejoin && !this.closed) {
      const w = this.leaveWaiter; this.leaveWaiter = null
      this.finishClose()
      w()
      this.events.emit('left')
    }
    if (prev.rs !== this.st.rs) this.events.emit('state', this.state)
  }

  private roomSend(tx: ROOM.Tx): void {
    if (tx.ws === 'ROOM_JOIN') void this.sendJoin()
    else if (tx.ws === 'ROOM_LEAVE') {
      const ep = this.reqEpoch
      this.core.sig.request('ROOM_LEAVE', { room_id: this.id }).then((r) => {
        if (ep !== this.reqEpoch) return
        this.leaveReply(r)
      }, () => { if (ep === this.reqEpoch) this.roomStep('leaveRes', ROOM.leaveRes(this.st, { part: 'fail' }), 'ROOM_LEAVE.closed') })
    } else if (tx.ws === 'GET_ROOM') void this.resync()
  }

  /** 1pc 면 입장마다 새 연결로 번호표를 만든다(연:RULE-ROOM-JOIN-START 3) */
  private async sendJoin(): Promise<void> {
    const ep = this.reqEpoch
    const body: Record<string, unknown> = { room_id: this.id, role: this.role, select: this.mode === 'talk' }
    let fresh: LinkCore | null = null
    if (this.core.ses.pcm === '1pc') {
      fresh = LinkCore.candidate(this.core)
      try {
        const tags = await fresh.peer!.first1pc()
        body['codecs'] = tags.codecs
        body['extmap'] = tags.extmap
      } catch (e) {
        fresh.peer?.close()
        this.lastFault = negotiationFault('OFFER', e)
        this.roomStep('joinRes', ROOM.joinRes(this.st, { code: 1002, part: 'fail', server_config: { pc_mode: this.core.ses.pcm, sfu_id: 0 }, version: { epoch: 0, seq: 0 } }, this.core.ses.pcm), 'ROOM_JOIN.offer_fail')
        return
      }
    }
    let r: Reply
    try { r = await this.core.sig.request('ROOM_JOIN', body) } catch {
      fresh?.peer?.close()
      return
    }
    if (ep !== this.reqEpoch) { fresh?.peer?.close(); return }
    await this.joinReply(r, fresh)
  }

  private async joinReply(r: Reply, fresh: LinkCore | null): Promise<void> {
    const pcm = this.core.ses.pcm
    if (!r.ok) {
      fresh?.peer?.close()
      const f = fromFailure(r.body)
      this.lastFault = f
      if (!f.permanent && !NO_RETRY.has(f.code) && f.code !== 4009 && f.code >= 2000 && this.retries < RETRY.length) {
        const wait = RETRY[this.retries++]!
        await sleep(wait)
        if (this.st.rs === 'JOINING' && !this.st.quit) { void this.sendJoin(); return }
      }
      this.roomStep('joinRes', ROOM.joinRes(this.st, { code: f.code, part: 'fail', server_config: { pc_mode: pcm, sfu_id: 0 }, version: { epoch: 0, seq: 0 } }, pcm), `ROOM_JOIN.${f.code}`)
      if (this.st.retry) {
        const after = Number((f.details ?? {})['retry_after_ms'] ?? 1000)
        setTimeout(() => this.roomStep('retryDue', ROOM.retryDue(this.st), 'clock'), Math.max(0, after))
      }
      return
    }
    const b = r.body as RoomJoinRes
    this.retries = 0
    const sc = b.server_config
    if (this.st.rs === 'JOINING' && !this.st.quit && sc.pc_mode === pcm) {
      this.lastJoin = b
      this.sfuId = sc.sfu_id
      this.store.resetMembers(b.participants, b.me)
      this.store.resetTracks(b.tracks)
      this.store.mediaCodecs = b.media_codecs ?? {}
      await LinkCore.adopt(this.core, sc, fresh)
    } else fresh?.peer?.close()
    const m = { code: 0, part: 'res' as const, server_config: { pc_mode: sc.pc_mode, sfu_id: this.core.epochs.id(sc.sfu_id) }, version: { epoch: this.core.epochs.id(b.version.epoch), seq: b.version.seq } }
    this.roomStep('joinRes', ROOM.joinRes(this.st, m, pcm), 'ROOM_JOIN.res')
    if (this.st.rs === 'JOINED') this.core.affImplicit(b.affiliation, this.sfuId, 'ROOM_JOIN.res')
    this.lastJoin = null
  }

  private leaveReply(r: Reply): void {
    if (!r.ok) {
      const f = fromFailure(r.body)
      if (f.code !== 3001 && f.code !== 3002) this.events.emit('error', f)
    }
    this.roomStep('leaveRes', ROOM.leaveRes(this.st, { part: r.ok ? 'res' : 'fail' }), r.ok ? 'ROOM_LEAVE.res' : 'ROOM_LEAVE.fail')
  }

  leave(): Promise<void> {
    if (this.closed || this.st.rs === 'NONE') { this.finishClose(); return Promise.resolve() }
    const p = new Promise<void>((resolve) => { const prev = this.leaveWaiter; this.leaveWaiter = () => { prev?.(); resolve() } })
    this.joinPending = false
    this.roomStep('leave', ROOM.leave(this.st), 'app')
    return p
  }

  private roomSeam(fx: ROOM.SeamFx, label: string): void {
    const core = this.core
    const link = this.link
    switch (fx) {
      case 'trk.snapshot': this.trkSnapshot(); break
      case 'link.table': {
        const t = this.lastJoin?.mline_table
        if (t && link) link.tableCarried(t)
        else link?.flushPendingTable()
        break
      }
      case 'sdp.rebuild': link?.renego(); break
      case 'ready.tracks': this.subStep('ready', SUB.ready(this.sub), label); break
      case 'room.sub_rooms': {
        const listed = this.lastJoin?.affiliation.sub_rooms ?? []
        for (const other of core.roomsOn(this.sfuId)) if (other !== this) other.roomStep('subRooms', ROOM.subRooms(other.st, listed.includes(other.id)), 'ROOM_JOIN.sub_rooms')
        break
      }
      case 'aff.leave': core.affStep('left', AFF.left(core.aff, this.id), label); break
      case 'floor.leave': this.floor.leave(); break
      case 'sub.drop': this.subStep('dropRoom', SUB.dropRoom(this.sub), label); break
      case 'pub.room_gone': for (const l of core.media.inRoom(this.id)) l.roomGone(); break
      case 'store.drop': this.trkStep('storeDrop', TRK.storeDrop(this.trk), label); this.store.tracks.clear(); this.syncRemotes(); break
      case 'link.room_left': {
        const last = core.roomsOn(this.sfuId).every((r) => r === this || r.st.rs === 'NONE')
        link?.roomLeft(last)
        break
      }
      case 'link.epoch_changed': link?.epochChanged(); break
    }
  }

  private roomEffect(f: ROOM.Fx, label: string): void {
    const e = RB.effect(f).event
    if (e === 'joined') {
      this.rebuilding = false
      this.joinPending = true
      setTimeout(() => this.finishJoin(), JOIN_SETTLE_MS)
      this.events.emit('joined')
      this.emitParticipants()
    } else if (e === 'joinFailed') {
      const f2 = label === 'ROOM.C.JOINING.join_pc_mismatch' ? negotiationFault('PC_MODE') : this.lastFault ?? new Fault({ code: 5003, name: 'INTERNAL_ERROR' })
      const w = this.joinWaiter; this.joinWaiter = null
      if (this.rebuilding) this.events.emit('error', f2)
      w?.reject(f2)
      this.events.emit('joinFailed', f2)
      if (label !== 'ROOM.C.JOINING.join_pc_mismatch') this.finishClose()
    } else if (e === 'left') {
      const w = this.leaveWaiter; this.leaveWaiter = null
      const jw = this.joinWaiter; this.joinWaiter = null
      jw?.reject(closedFault('LEFT'))
      this.finishClose()
      w?.()
      this.events.emit('left')
    } else if (e === 'participants') {
      this.emitParticipants()
    } else if (e === 'forced') {
      this.finishClose()
      this.events.emit('forced', { cause: this.forcedCause })
    }
  }

  private forcedCause = 'missing'

  /** 그 입장의 첫 협상이 끝났다 — join() resolve · 초기 track 이벤트는 다음 tick */
  finishJoin(): void {
    if (!this.joinPending) return
    this.joinPending = false
    const w = this.joinWaiter; this.joinWaiter = null
    if (this.st.rs === 'JOINED') w?.resolve(this)
    setTimeout(() => this.syncRemotes(), 0)
  }

  private finishClose(): void {
    if (this.closed) return
    this.closed = true
    for (const r of this.remotes.values()) r.end()
    this.remotes.clear()
    this.floor.dispose()
    this.core.dropRoom(this)
    this.events.emit('state', 'closed')
  }

  private emitParticipants(): void {
    this.events.emit('participants', [...this.store.members.values()])
  }

  downAll(): void {
    this.roomStep('downAll', ROOM.downAll(this.st), 'rebuild')
    this.rebuilding = this.st.rejoin
  }

  closeAll(): void {
    this.roomStep('closeAll', ROOM.closeAll(this.st), 'session')
    this.finishClose()
  }

  resumeSnap(s: RoomSnapshot | null): void {
    if (this.st.rs !== 'JOINED') return
    if (s) {
      this.store.resetMembers(s.participants, s.me)
      this.store.resetTracks(s.tracks)
    } else this.forcedCause = 'missing'
    this.roomStep('resumeSnap', ROOM.resumeSnap(this.st, s !== null, s?.version.seq ?? 0, s ? this.core.epochs.id(s.version.epoch) : 0), 'RESUME.snapshot')
    if (s) this.emitParticipants()
  }

  /** 통지 — ACK 은 시그널링이 이미 했다 · version 견주기는 위 방 상태기(SDK:IMPL-MOD-TABLE domain/store 단일 진입) */
  delta(op: string, body: Record<string, unknown>): void {
    const v = body['version'] as Version | undefined
    const bare = op === 'PARTICIPANT_STATE' && v === undefined
    const m = { version: { epoch: v ? this.core.epochs.id(v.epoch) : this.st.cepoch, seq: v?.seq ?? 0 } }
    const step = ROOM.delta(this.st, m, bare)
    const applied = step.label === 'ROOM.C.JOINED.delta_apply' || step.label === 'ROOM.C.JOINED.delta_bare'
    if (applied) this.applyContent(op, body)
    this.roomStep('delta', step, op)
    if (applied) this.afterContent(op, body)
  }

  private permChanges: { userId: string; permission: Permission; mine: boolean }[] = []

  private applyContent(op: string, body: Record<string, unknown>): void {
    const me = this.core.userId
    if (op === 'PARTICIPANT_EVENT') {
      const b = body as unknown as ParticipantEventBody
      if (b.type === 'joined') {
        const mi: MemberInfo = { user_id: b.user_id, select: b.select ?? false, participant_type: b.participant_type ?? 0, ...(b.role !== undefined ? { role: b.role } : {}), ...(b.metadata !== undefined ? { metadata: b.metadata } : {}), ...(b.permission ? { permission: b.permission } : {}) }
        this.store.members.set(b.user_id, participantOf(mi))
      } else this.store.members.delete(b.user_id)
    } else if (op === 'PARTICIPANT_STATE') {
      const b = body as unknown as ParticipantStateBody
      const perm = permissionOf(b.permission)
      const mine = b.user_id === me
      if (mine) this.store.permission = perm
      const cur = this.store.members.get(b.user_id)
      if (cur) this.store.members.set(b.user_id, { ...cur, permission: perm })
      this.permChanges.push({ userId: b.user_id, permission: perm, mine })
    } else if (op === 'TRACK_EVENT') {
      const b = body as unknown as TrackEventBody
      for (const t of b.tracks) {
        const mine = this.core.media.ownsTrack(t.track_id)
        const step = TRK.trackEvent(this.trk, { action: b.action, tracks: { active: t.active ?? true, muted: t.muted ?? false, track_id: t.track_id as TRK.TrackId } }, mine)
        if (!mine) {
          if (b.action === 'remove') this.store.tracks.delete(t.track_id)
          else this.store.tracks.set(t.track_id, t)
        }
        this.trkStep('trackEvent', step, op, t.track_id)
      }
    } else if (op === 'TRACK_STATE') {
      const b = body as unknown as TrackStateBody
      const cur = this.store.tracks.get(b.track_id)
      if (cur) this.store.tracks.set(b.track_id, { ...cur, muted: b.muted })
      this.trkStep('trackState', TRK.trackState(this.trk, { muted: b.muted, track_id: b.track_id as TRK.TrackId }), op, b.track_id)
    }
  }

  private afterContent(op: string, _body: Record<string, unknown>): void {
    if (op === 'PARTICIPANT_STATE') {
      for (const c of this.permChanges.splice(0)) {
        this.events.emit('permission', c)
        if (c.mine) this.core.media.permissionChanged(this)
      }
      this.floor.surface()
    }
  }

  roomEvent(body: Record<string, unknown>): void {
    const type = body['type'] === 'affiliation' ? 'affiliation' : 'sync_required'
    if (type === 'affiliation') this.forcedCause = String(body['cause'] ?? 'kick')
    this.roomStep('roomEvent', ROOM.roomEvent(this.st, { type }), `ROOM_EVENT.${type}`)
  }

  /** 재동기 — HTTP(세션 헤더) · 실패는 사다리 칸 간격으로 다시(던지는 개수 · 간격은 구현 몫 — SDK:RULE-ROOM-RESYNC) */
  private async resync(): Promise<void> {
    const ep = this.syncEpoch
    for (let i = 0; ; i++) {
      try {
        const res = (await this.core.http('GET', `/rooms/${encodeURIComponent(this.id)}?tracks=1`)) as GetRoomRes
        if (ep !== this.syncEpoch || this.closed) return
        this.applySnapshot(res)
        return
      } catch (e) {
        if (ep !== this.syncEpoch || this.closed) return
        const f = e instanceof Fault ? e : new Fault({ code: 5003, name: 'RESYNC_FAILED', cause: e })
        if (i === 2) this.events.emit('error', f)
        await sleep(RETRY[Math.min(i, RETRY.length - 1)]!)
        if (ep !== this.syncEpoch || this.closed) return
      }
    }
  }

  private applySnapshot(res: GetRoomRes): void {
    const step = ROOM.snapshot(this.st, { version: { epoch: this.core.epochs.id(res.version.epoch), seq: res.version.seq } })
    if (step.label === 'ROOM.C.JOINED.snapshot') {
      this.store.resetMembers(res.participants, res.me)
      this.store.resetTracks(res.tracks ?? [])
    }
    this.roomStep('snapshot', step, 'GET_ROOM.res')
    if (step.label === 'ROOM.C.JOINED.snapshot') {
      this.emitParticipants()
      this.events.emit('resync')
      if (this.floor.st.cs === 'QUEUED') this.floor.queuePosition()
    }
  }

  // ── 트랙 상태기 ──────────────────────────────────────────────────────

  private trkSnapshot(): void {
    const lay: Record<string, TRK.Layer> = {}
    const muted: Record<string, boolean> = {}
    const me = this.core.userId
    for (const t of this.store.tracks.values()) {
      if (t.type === 'individual' && t.user_id === me) continue
      lay[t.track_id] = t.active === false ? 'RESTING' : 'ACTIVE'
      muted[t.track_id] = t.muted ?? false
    }
    this.trkStep('snapshot', TRK.snapshot(this.trk, lay as unknown as TRK.St['lay'], muted as unknown as TRK.St['muted']), 'snapshot')
  }

  private trkStep(entry: string, step: TRK.Step, cause: string, key?: string): void {
    const plan = TB.plan(step)
    this.trk = plan.state
    this.core.record('TRK', key ? `${this.id}/${key}` : this.id, '-', '-', plan.label, cause)
    for (const sm of plan.seams) if (sm.fx === 'pub.revoked' && key) this.core.media.byTrackId(key)?.revoked()
    for (const f of step.fx) {
      const e = TB.effect(f).event
      if (e === 'track') this.syncRemotes()
      else if (e === 'muted' && key) this.remotes.get(key)?.setMuted(this.store.tracks.get(key)?.muted ?? false)
    }
    void entry
  }

  /** 보관본과 핸들을 맞춘다 — 장착 가능하면 track · 줄이 없으면 trackUnreachable · 빠지면 ended · 교체는 같은 핸들의 active */
  syncRemotes(): void {
    if (this.closed) return
    const me = this.core.userId
    const link = this.link
    for (const [id, r] of [...this.remotes]) {
      if (!this.store.tracks.has(id)) { this.remotes.delete(id); r.end() }
    }
    for (const t of this.store.tracks.values()) {
      if (t.type === 'individual' && t.user_id === me) continue
      let r = this.remotes.get(t.track_id)
      if (!r) { r = new RemoteCore(this.core, this, t); this.remotes.set(t.track_id, r) }
      else r.update(t)
      const row = link?.table.rowOf(t.track_id)
      const rx = row ? link?.peer?.receiverOf(row.mid) ?? null : null
      r.bind(row ?? null, rx)
    }
    this.floor.speakerTracks()
  }

  // ── 구독 상태기 ──────────────────────────────────────────────────────

  subStep(entry: string, step: SUB.Step, cause: string): void {
    const prev = this.sub
    const plan = UB.plan(step)
    this.sub = plan.state
    this.core.record('SUB', this.id, prev.ready, this.sub.ready, plan.label, cause)
    for (const tx of plan.send) {
      if (tx.ws === 'READY') this.sendReady()
      else if (tx.ws === 'SUBSCRIBE_LAYER') this.flushLayers()
    }
    for (const sm of plan.seams) if (sm.fx === 'sdp.rebuild') this.link?.renego()
    for (const f of step.fx) if (UB.effect(f).event === 'error') this.events.emit('error', this.readyFault ?? new Fault({ code: 5003, name: 'READY_FAILED' }))
    void entry
  }

  private readyFault: Fault | null = null

  sendReady(): void {
    const arev = this.link?.sdpArev ?? 0
    this.core.sig.request('READY', { room_id: this.id, arev }).then((r) => {
      this.readyFault = r.ok ? null : fromFailure(r.body)
      this.subStep('readyRes', SUB.readyRes(this.sub, { part: r.ok ? 'res' : 'fail' }), 'READY.res')
    }, () => undefined)
  }

  private layerQueue = new Map<string, { track_id: string; spatial?: number; temporal?: number; paused?: boolean; priority?: number }>()

  /** 받을 레이어 상한 — 생략한 필드는 안 바꾼다(연:RULE-SUB-LAYER-PROC) */
  setLayer(trackId: string, v: { spatial?: number; temporal?: number; paused?: boolean; priority?: number }): Promise<void> {
    const cur = this.layerQueue.get(trackId) ?? { track_id: trackId }
    this.layerQueue.set(trackId, { ...cur, ...v })
    return new Promise((resolve) => {
      this.layerWaiters.push(resolve)
      this.subStep('layer', SUB.layer(this.sub), 'app')
    })
  }

  private layerWaiters: (() => void)[] = []

  private flushLayers(): void {
    const targets = [...this.layerQueue.values()]
    this.layerQueue.clear()
    const waiters = this.layerWaiters.splice(0)
    if (!targets.length) { for (const w of waiters) w(); return }
    this.core.sig.request('SUBSCRIBE_LAYER', { room_id: this.id, targets }).then(() => {
      this.subStep('layerRes', SUB.layerRes(this.sub), 'SUBSCRIBE_LAYER.res')
      for (const w of waiters) w()
    }, () => { for (const w of waiters) w() })
  }

  // ── 수신 오디오 — SDK 가 재생한다(SDK:IMPL-TRK-RECEIVE room.audio) ──

  get audio(): { muted: boolean; volume: number } { return { muted: this.audioMuted, volume: this.audioVolume } }

  setAudioMuted(m: boolean): void { this.audioMuted = m; for (const r of this.remotes.values()) r.applyPlayback() }
  setAudioVolume(v: number): void { this.audioVolume = Math.max(0, Math.min(1, v)); for (const r of this.remotes.values()) r.applyPlayback() }

  get permission(): Permission { return this.store.permission ?? ALL_TRUE }
}
