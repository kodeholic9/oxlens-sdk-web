// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-LINK-LAYERS · SDK:RULE-LINK-REBUILD · SDK:IMPL-LINK-PROJECTION · SDK:IMPL-MOD-TABLE PeerLink 복구 러너 · 연:RULE-LINK-RECOVERY-UNIT · model: claude-opus-5-5
import * as LINK from './gen/link_client.js'
import * as LB from './gen/link_binding.js'
import type { ServerConfig, MlineTable, IceRestartRes } from '../internal/wire/ws.js'
import { PeerLink } from '../internal/transport.js'
import * as Mbcp from '../internal/mbcp.js'
import { Timer, wall } from '../platform/clock.js'
import { Fault, fromFailure } from '../platform/fault.js'
import type { Core } from './session.js'
import { TableStore } from './store.js'

export type LinkState = 'connecting' | 'up' | 'wobbly' | 'restarting' | 'rebuilding' | 'closed'

export interface LinkInfo {
  readonly server: string
  readonly state: LinkState
  readonly rung: number
  readonly attempt: number
  readonly cause: string | null
  readonly since: number
}

/**
 * 서버마다 연결 상태기 하나 — 복구 러너(SDK:IMPL-MOD-TABLE PeerLink). 연결 묶음(PeerLink)은 재구축마다 갈아 끼우고 러너는 그대로다.
 * 층별 사실은 PeerLink 의 통에서 직접 꺼내 위 입구에 넣는다.
 */
export class LinkCore {
  st: LINK.St
  peer: PeerLink | null
  readonly table = new TableStore()
  sdpArev = 0
  blocked = false
  private negotiating = false
  private buildArev = 0
  private wobbly: Timer
  private applyTimer: Timer
  private reopenTimer: Timer
  private stableTimer: Timer
  private reopenTries = 0
  private restartCreds: { pub: { ufrag: string; pwd: string }; sub: { ufrag: string; pwd: string } | null } | null = null
  private readonly ufrags
  private rung = 0
  private attempt = 0
  private unstood = 0
  private since = wall()
  private lastState: LinkState = 'connecting'
  private cause: string | null = null
  private pendingCheck = false
  private pending: MlineTable | null = null
  private closedForApp = false

  private constructor(readonly core: Core, public sc: ServerConfig | null, peer: PeerLink | null) {
    this.peer = peer
    this.ufrags = core.epochs
    const w = core.cfg.wakeDetectMs
    this.wobbly = new Timer(w)
    this.applyTimer = new Timer(w)
    this.reopenTimer = new Timer(w)
    this.stableTimer = new Timer(w)
    this.st = { ...LINK.initial(), everUp: false, mid: {} as LINK.St['mid'], rows: 0, gen: sc ? this.gen(sc.ice.publish_ufrag) : 1 }
  }

  get server(): string { return this.sc?.sfu_id ?? '' }
  get everUp(): boolean { return this.st.everUp }

  /** 1pc 입장마다 새 연결 — 응답의 sfu_id 를 모르는 동안의 연결이다(연:RULE-ROOM-JOIN-NUMBER-TAGS) */
  static candidate(core: Core): LinkCore {
    return new LinkCore(core, null, new PeerLink('1pc', null, core.opusLine, core.book.scope('transport')))
  }

  /** 입장 응답 — 처음 붙는 서버면 연결을 세우고 · 이미 붙은 서버면 새 연결을 버린다 · 재구축 중이면 새 연결로 갈아 끼운다 */
  static async adopt(core: Core, sc: ServerConfig, fresh: LinkCore | null): Promise<LinkCore> {
    const have = core.links.get(sc.sfu_id)
    const stale = have && have.peer && have.sc && have.sc.ice.publish_ufrag !== sc.ice.publish_ufrag
    if (have && have.peer && !stale) {
      fresh?.peer?.close()
      return have
    }
    let peer: PeerLink
    if (sc.pc_mode === '1pc') {
      peer = fresh?.peer ?? new PeerLink('1pc', null, core.opusLine, core.book.scope('transport'))
      if (!fresh?.peer) await peer.first1pc()
      const r = await peer.complete1pc(sc)
      if (!r.ok) core.log.error('1pc 첫 협상 실패', { sfu: sc.sfu_id })
    } else {
      fresh?.peer?.close()
      peer = new PeerLink('2pc', sc, core.opusLine, core.book.scope('transport'))
      peer.open2pc(sc)
    }
    if (have) {
      have.peer?.close()
      have.peer = peer
      have.sc = sc
      have.adoptPeer()
      return have
    }
    const link = new LinkCore(core, sc, peer)
    core.links.set(sc.sfu_id, link)
    link.record('SDK.link_new', 'join')
    link.adoptPeer()
    return link
  }

  private gen(ufrag: string): number { return this.ufrags.id(`ufrag:${ufrag}`) }

  private adoptPeer(): void {
    const p = this.peer
    if (!p) return
    for (const l of this.core.media.on(this.server)) if (l.wantsSlot()) l.acquireSlot()
    void this.pumpFacts(p)
    this.core.emitLink(this.info())
  }

  private async pumpFacts(p: PeerLink): Promise<void> {
    for (;;) {
      const f = await p.facts.next()
      if (!f) break
      if (p !== this.peer) continue
      try { this.fact(f) } catch (e) { this.core.log.error('연결 사실 처리 실패', { err: String(e), stack: e instanceof Error ? e.stack : undefined }) }
    }
  }

  private record(label: string, cause: string): void {
    this.core.record('LINK', this.server, this.st.ls, this.st.ls, label, cause, { rung: this.rung, attempt: this.attempt })
  }

  // ── 층별 사실 → 위 입구(SDK:IMPL-LINK-PROJECTION 입구 표) ────────────

  /** 위 입구의 읽기 칸 `leaving`(연 LINK 사실 입구 reads ROOM.rs) — 그 서버 방이 전부 나가는 중이다(하나 이상 LEAVING · 나머지는 NONE).
   *  서버가 마지막 방 퇴장에 Peer 를 거두며 닫는 사실을 재구축 방아쇠로 받지 않게 위 상태기가 가른다(연:RULE-ROOM-LEAVE-RES 2). */
  private leavingAll(): boolean {
    const rooms = this.core.roomsOn(this.server)
    return rooms.some((r) => r.st.rs === 'LEAVING') && rooms.every((r) => r.st.rs === 'LEAVING' || r.st.rs === 'NONE')
  }

  private fact(f: import('../internal/transport.js').LinkFact): void {
    if (f.t === 'ice') {
      const s = f.state
      if (s === 'connected' || s === 'completed') {
        this.wobbly.stop()
        if (this.st.ls === 'WAIT') this.step('iceBack', LINK.iceBack(this.st), 'ice')
        else if (this.st.ls === 'APPLY' && !this.st.nego) this.step('applied', LINK.applied(this.st), 'ice')
        else if (this.st.ls === 'REBUILD') this.tryRebuilt()
        this.firstUp()
      } else if (s === 'disconnected') {
        this.step('iceDisc', LINK.iceDisc(this.st, this.leavingAll()), 'ice')
        if (this.st.ls === 'WAIT') this.wobbly.start(this.core.cfg.wobblyGraceMs, () => this.step('waitOver', LINK.waitOver(this.st, false, this.leavingAll()), 'grace'))
      } else if (s === 'failed') {
        this.wobbly.stop()
        if (this.st.ls === 'REBUILD') this.step('rebuilt', LINK.rebuilt(this.st, this.peerGen(), false), 'ice')
        else this.step('waitOver', LINK.waitOver(this.st, true, this.leavingAll()), 'ice')
      }
    } else if (f.t === 'dtls') {
      if (f.state === 'closed' || f.state === 'failed') this.step('assocLost', LINK.assocLost(this.st, this.leavingAll()), 'dtls')
    } else if (f.t === 'sctp') {
      if (f.state === 'closed') this.step('assocLost', LINK.assocLost(this.st, this.leavingAll()), 'sctp')
    } else if (f.t === 'dc') {
      if (f.open) {
        this.reopenTimer.stop()
        if (this.st.ls === 'REOPEN') { this.reopenTries = 0; this.step('reopened', LINK.reopened(this.st, 'ok'), 'dc') }
        this.firstUp()
        if (this.st.ls === 'REBUILD') this.tryRebuilt()
      } else {
        const sctp = this.peer?.sctpState
        if (this.st.ls === 'REOPEN') this.reopenOutcome(false)
        else if (sctp === 'connected') this.step('dcClosed', LINK.dcClosed(this.st, this.leavingAll()), 'dc')
        else this.step('assocLost', LINK.assocLost(this.st, this.leavingAll()), 'dc')
      }
    } else if (f.t === 'dcData') {
      const rx = Mbcp.parse(f.data)
      if (!rx) return
      const room = this.core.rooms.get(rx.room)
      if (room && room.sfuId === this.server) room.floor.receive(rx.rx)
    } else if (f.t === 'track') {
      for (const r of this.core.roomsOn(this.server)) r.syncRemotes()
    }
  }

  private peerGen(): number { return this.sc ? this.gen(this.sc.ice.publish_ufrag) : this.st.gen }

  /** 첫 수립 — 전 층이 처음 섰다(위 상태기가 서기 전의 connecting 이 끝난다) */
  private firstUp(): void {
    if (this.st.everUp || this.st.ls !== 'OK') return
    if (!this.peer || !this.peer.dcOpen || (this.peer.ice !== 'connected' && this.peer.ice !== 'completed')) return
    const prev = this.st
    this.st = { ...this.st, everUp: true }
    this.core.record('LINK', this.server, prev.ls, this.st.ls, 'SDK.first_up', 'ice+dc')
    this.unstood = 0
    this.surface()
    for (const r of this.core.roomsOn(this.server)) r.floor.linkChanged()
  }

  private tryRebuilt(): void {
    const p = this.peer
    if (!p || this.st.ls !== 'REBUILD') return
    if ((p.ice === 'connected' || p.ice === 'completed') && p.dcOpen) this.step('rebuilt', LINK.rebuilt(this.st, this.peerGen(), true), 'rebuild')
  }

  // ── 위 이음매가 부르는 입구 ──────────────────────────────────────────

  renego(): void { this.step('renego', LINK.renego(this.st), 'seam') }
  closeAll(): void { this.step('closeAll', LINK.closeAll(this.st), 'session') }
  repair(): void { this.step('repair', LINK.repair(this.st), 'resume') }
  epochChanged(): void { this.step('epochChanged', LINK.epochChanged(this.st), 'epoch') }
  pubLost(): void { this.step('pubLost', LINK.pubLost(this.st), 'resume') }
  roomLeft(last: boolean): void { this.step('roomLeft', LINK.roomLeft(this.st, last), 'leave') }

  /** 입장 응답 · 이어받기 응답이 실어 온 표 — MLINE_EVENT 와 같게 받는다(어느 길로 와도 새 arev 가 이긴다) */
  tableCarried(t: MlineTable): void {
    this.acceptTable(t, (mid, rows) => LINK.tableCarried(this.st, t.arev, mid, rows), 'tableCarried')
  }

  pendingTable(t: MlineTable): void { this.pending = t }
  flushPendingTable(): void {
    const t = this.pending
    this.pending = null
    if (t) this.tableCarried(t)
  }

  mlineEvent(t: MlineTable): void {
    this.acceptTable(t, (mid, rows) => LINK.mlineEvent(this.st, { table: { arev: t.arev, mid, rows } }), 'mlineEvent')
  }

  /** 배정표 — sfu_id 가 다르면 그 서버는 재구축 중이다 · 같으면 arev 가 클 때만 통째 교체(연:RULE-SUB-TABLE-PROC) */
  private acceptTable(t: MlineTable, entry: (mid: LINK.St['mid'], rows: number) => LINK.Step, name: string): void {
    if (this.sc && t.sfu_id !== this.sc.sfu_id) return
    const mid = TableStore.midOf(t) as unknown as LINK.St['mid']
    const rows = TableStore.materials(t.mlines)
    const step = entry(mid, rows)
    const fresh = step.label !== 'LINK.C.any.table_old' && step.label !== 'LINK.C.any.table_carried_old'
    if (fresh) {
      this.table.accept(t)
      this.peer?.setRows(this.table.mlines)
    }
    this.step(name, step, 'table')
    if (fresh) {
      if (!this.negotiating && (step.label.endsWith('_same') || step.label.endsWith('rebound'))) this.sdpArev = t.arev
      for (const r of this.core.roomsOn(this.server)) r.syncRemotes()
    }
  }

  linkEvent(ufrag: string): void {
    const sc = this.sc
    const cur = sc ? [sc.ice.publish_ufrag, sc.ice.subscribe_ufrag] : []
    const g = cur.includes(ufrag) ? this.st.gen : -1
    this.step('linkEvent', LINK.linkEvent(this.st, { ufrag: g }), 'LINK_EVENT')
  }

  /** 세션 층 복구가 끝났다 — 보류했던 WS 점검을 이어 간다(세션 층 복구 중 러너 전부 보류) */
  sessionBack(): void {
    if (this.pendingCheck) { this.pendingCheck = false; this.wsCheck() }
  }

  closeForApp(): void { this.closedForApp = true }

  // ── 출입구 ────────────────────────────────────────────────────────────

  step(entry: string, step: LINK.Step | null, cause: string): void {
    if (!step) { this.core.impossible('LINK', this.server, this.st.ls, entry); return }
    const prev = this.st
    const plan = LB.plan(step)
    this.st = plan.state
    this.core.record('LINK', this.server, prev.ls, this.st.ls, plan.label, cause, { rung: this.rung, attempt: this.attempt })
    for (const a of plan.actions) this.action(a)
    for (const tx of plan.send) this.send(tx)
    for (const sm of plan.seams) this.seam(sm.fx)
    if (this.st.ls === 'APPLY' && prev.ls !== 'APPLY') this.applyTimer.start(this.core.cfg.iceRestartTimeoutMs, () => this.step('applyTimeout', LINK.applyTimeout(this.st), 'timer'))
    if (this.st.ls !== 'APPLY') this.applyTimer.stop()
    if (this.st.ls === 'OK' && prev.ls !== 'OK' && prev.ls !== 'NONE') {
      this.stableTimer.start(this.core.cfg.recoveryStableMs, () => { this.rung = 0; this.attempt = 0 })
    } else if (this.st.ls !== 'OK') this.stableTimer.stop()
    for (const f of step.fx) if (f === 'app.link_blocked') this.blocked = true
    if (this.st.ls === 'OK' && this.st.everUp) this.blocked = false
    if (plan.events.length || prev.ls !== this.st.ls) this.surface()
    if (this.st.nego && !this.negotiating) void this.negotiate()
    if (this.st.ls === 'APPLY' && !this.st.nego && this.peer && (this.peer.ice === 'connected' || this.peer.ice === 'completed') && prev.nego) this.step('applied', LINK.applied(this.st), 'nego')
    if (this.st.ls === 'NONE' && prev.ls !== 'NONE') this.core.links.delete(this.server)
  }

  private action(a: LB.LinkAction): void {
    if (a === 'peer.close') {
      this.peer?.close()
      this.peer = null
      this.negotiating = false
      for (const l of this.core.media.on(this.server)) l.peerClosed()
    } else if (a === 'dc.reopen') {
      this.reopenTimer.start(this.core.cfg.dcReopen.intervalMs, () => {
        this.reopenTries++
        this.peer?.reopenDc()
        this.reopenTimer.start(this.core.cfg.dcReopen.intervalMs * 2, () => this.reopenOutcome(false))
      })
    } else if (a === 'sdp.restart') {
      const c = this.restartCreds
      if (c && this.peer) this.peer.restartWith(c.pub, c.sub)
    }
  }

  private reopenOutcome(ok: boolean): void {
    if (this.st.ls !== 'REOPEN') return
    if (ok) { this.step('reopened', LINK.reopened(this.st, 'ok'), 'dc'); return }
    this.step('reopened', LINK.reopened(this.st, this.reopenTries >= this.core.cfg.dcReopen.tries ? 'exhausted' : 'fail'), 'dc')
  }

  private send(tx: LINK.Tx): void {
    if (tx.ws === 'READY') {
      for (const r of this.core.roomsOn(this.server)) {
        r.sendReady()
        if (r.floor.st.cs === 'QUEUED') r.floor.queuePosition()
      }
    } else if (tx.ws === 'HEARTBEAT') {
      this.wsCheck()
    } else if (tx.ws === 'ICE_RESTART') {
      const id = this.st.req
      this.core.sig.request('ICE_RESTART', { sfu_id: this.server }).then((r) => {
        const b = (r.body ?? {}) as IceRestartRes & { code?: number }
        const code = r.ok ? 0 : fromFailure(r.body).code
        if (r.ok) this.restartCreds = { pub: b.publish, sub: b.subscribe ?? null }
        const m = { code, part: (r.ok ? 'res' : 'fail') as LINK.Part, pid: id, publish: { ufrag: r.ok ? this.gen(b.publish.ufrag) : 0 } }
        if (r.ok && this.sc) this.sc = { ...this.sc, ice: { ...this.sc.ice, publish_ufrag: b.publish.ufrag, publish_pwd: b.publish.pwd, ...(b.subscribe ? { subscribe_ufrag: b.subscribe.ufrag, subscribe_pwd: b.subscribe.pwd } : {}) } }
        this.step('restartRes', LINK.restartRes(this.st, m), r.ok ? 'ICE_RESTART.res' : `ICE_RESTART.${code}`)
      }, () => undefined)
    }
  }

  /** WS 점검 — 같은 치료를 다시 할 때의 간격은 사다리 칸값(정책:sdk.iceRestartBackoffMs) · 끝 칸 되풀이 · 상한 없음 */
  private wsCheck(): void {
    if (this.closedForApp) return
    if (this.core.ses.cs !== 'ACTIVE') { this.pendingCheck = true; return }
    const ladder = this.core.cfg.iceRestartBackoffMs
    const wait = this.attempt === 0 ? 0 : ladder[Math.min(this.rung, ladder.length - 1)] ?? 7000
    this.attempt++
    if (this.attempt > 1) this.rung = Math.min(this.rung + 1, ladder.length - 1)
    if (!this.st.everUp) { this.unstood++; if (this.unstood >= this.core.cfg.unreachableAfter) this.blocked = true }
    setTimeout(() => {
      if (this.st.ls !== 'CHECK') return
      void this.core.sig.probe(this.core.cfg.wsProbeTimeoutMs).then((alive) => {
        if (this.st.ls !== 'CHECK') return
        if (alive) this.step('hbRes', LINK.hbRes(this.st, {}), 'HEARTBEAT')
        else { this.core.log.warn('WS 점검 실패 — 소켓을 LEAVE 없이 닫는다'); this.core.sig.close() }
      })
    }, wait)
  }

  private seam(fx: LINK.SeamFx): void {
    const core = this.core
    const rooms = core.roomsOn(this.server)
    const locals = core.media.on(this.server)
    switch (fx) {
      case 'floor.dc_down': for (const r of rooms) r.floor.dcDown(); break
      case 'floor.dc_up': for (const r of rooms) r.floor.dcUp(); break
      case 'floor.down_server': for (const r of rooms) r.floor.down(); break
      case 'pub.drop_server': for (const l of locals) l.dropServer(); break
      case 'pub.nego_ok': for (const l of locals) l.nego(true); break
      case 'pub.nego_fail': for (const l of locals) l.nego(false); break
      case 'pub.reregister_server': core.media.reregisterAll(this.server); break
      case 'rooms.rejoin_server': core.rejoinAll(rooms); break
      case 'store.drop_server': for (const r of rooms) r.downAll(); break
      case 'sub.nego_ok': for (const r of rooms) r.subStep('negoOk', SUBmod.negoOk(r.sub), 'nego'); break
      case 'sub.nego_fail': for (const r of rooms) r.subStep('negoFail', SUBmod.negoFail(r.sub), 'nego'); break
      case 'sub.table_changed': for (const r of rooms) r.subStep('tableChanged', SUBmod.tableChanged(r.sub), 'table'); break
      case 'sub.table_rebound': for (const r of rooms) r.subStep('tableRebound', SUBmod.tableRebound(r.sub), 'table'); break
    }
  }

  /** 협상 큐 — 위 상태기의 nego 가 서 있는 동안 한 번에 하나 */
  private async negotiate(): Promise<void> {
    const p = this.peer
    if (!p) return
    this.negotiating = true
    this.buildArev = this.table.arev
    p.setRows(this.table.mlines)
    const r = await p.negotiate()
    this.negotiating = false
    if (p !== this.peer) return
    if (r.ok) this.sdpArev = this.buildArev
    else if (r.fault) this.negoFault = r.fault
    this.step('negoRes', LINK.negoRes(this.st, r.ok), r.ok ? 'nego.ok' : 'nego.fail')
    for (const room of this.core.roomsOn(this.server)) {
      if (!r.ok && room.joinPending) room.events.emit('error', this.negoFault ?? new Fault({ code: 0, name: 'NEGOTIATION_APPLY', category: 'negotiation' }))
      if (room.joinPending && !this.st.nego) room.finishJoin()
      else room.syncRemotes()
    }
  }

  negoFault: Fault | null = null

  // ── 앱 투영 ──────────────────────────────────────────────────────────

  get state(): LinkState {
    const ls = this.st.ls
    if (ls === 'NONE') return 'closed'
    if (ls === 'REBUILD') return 'rebuilding'
    if (ls === 'WAIT' || ls === 'REOPEN') return 'wobbly'
    if (ls === 'CHECK' || ls === 'RESTART' || ls === 'APPLY') return 'restarting'
    return this.st.everUp ? 'up' : 'connecting'
  }

  info(): LinkInfo {
    return { server: this.server, state: this.state, rung: this.rung, attempt: this.attempt, cause: this.blocked ? 'path_unreachable' : this.cause, since: this.since }
  }

  private surface(): void {
    const s = this.state
    if (s !== this.lastState) { this.lastState = s; this.since = wall(); this.cause = this.st.cause === 'NONE' ? null : this.st.cause.toLowerCase() }
    this.core.emitLink(this.info())
    for (const r of this.core.roomsOn(this.server)) r.floor.linkChanged()
  }
}

import * as SUBmod from './gen/sub_client.js'
