// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:RULE-LINK-LAYERS · SDK:RULE-LINK-REBUILD · SDK:IMPL-LINK-PROJECTION · SDK:IMPL-MOD-TABLE PeerLink 복구 러너 · SDK:RULE-MOD-AREA-MIRROR domain/link · 연:RULE-LINK-RECOVERY-UNIT · model: claude-opus-5-5
import * as LINK from '../gen/link_client.js'
import * as LB from '../gen/link_binding.js'
import type { ServerConfig, MlineTable, IceRestartRes } from '../../internal/wire/ws.js'
import { PeerLink, type LinkFact } from '../../internal/link/transport.js'
import type { Creds } from '../../internal/link/sdp.js'
import type { Reply } from '../../internal/ses/signaling.js'
import * as Mbcp from '../../internal/flr/mbcp.js'
import { Timer, now, wall, type Fired } from '../../platform/clock.js'
import { Fault, fromFailure } from '../../platform/fault.js'
import type { Core } from '../ses/core.js'
import { TableStore } from './table.js'

export type LinkState = 'connecting' | 'up' | 'wobbly' | 'restarting' | 'rebuilding' | 'closed'

export interface LinkInfo {
  readonly server: string
  readonly state: LinkState
  readonly rung: number
  readonly attempt: number
  readonly cause: string | null
  readonly since: number
}

/** 입구 표의 입구 — 위 결합(link_binding)의 ENTRY 열쇠 그대로 */
export type Entry = keyof typeof LB.ENTRY
type Args<K extends Entry> = (typeof LB.ENTRY)[K] extends (s: LINK.St, ...a: infer A) => unknown ? A : never

/**
 * 서버마다 연결 상태기 하나 — 복구 러너(SDK:IMPL-MOD-TABLE PeerLink). 전송 묶음(PeerLink)은 재구축마다 갈아 끼우고 러너는 그대로다.
 * 절차는 위가 정한다 — 여기는 입구 표(층별 사실 · 이음매가 어느 입구를) · 효과 표(위 효과를 무엇으로) · 이음매 집행 · 위가 값을 두지 않은 손잡이만.
 */
export class LinkCore {
  st: LINK.St
  peer: PeerLink | null
  readonly table = new TableStore()
  /** 이 차례의 표가 실린 SDP — READY{arev} 가 싣는다(연:RULE-SUB-TABLE-PROC 3 · 4) */
  sdpArev = 0
  /** path_unreachable 를 드러냈다(효과 표 app.link_blocked 덧붙임) */
  blocked = false
  negoFault: Fault | null = null
  private negotiating = false
  /** 재구축 끝(rebuilt)이 지운 협상 큐 — 새 연결은 지금 보관본으로 짓는다(연:LINK.C.REBUILD.rebuilt) · 떠 있는 협상이 끝나면 한 번 더 */
  private rebuildOwed = false
  /** 입장 응답의 자격이 보관값과 달라 갈아 끼운 새 연결의 세대 — 그 응답의 이음매 link.server_ice 가 넣는다(연:RULE-ROOM-JOIN-PROC) */
  private replaced: number | null = null
  private buildArev = 0
  private readonly grace: Timer
  private readonly applyTimer: Timer
  private readonly reopenTimer: Timer
  private readonly stableTimer: Timer
  private readonly checkTimer: Timer
  /** 이번 DC 다시 열기의 시도 번호(1 부터) · DC 가 닫힌 시각 — 시도 k 는 그 뒤 k × intervalMs 에 연다 */
  private reopenTries = 0
  private dcDownAt = 0
  private restartCreds: { pub: Creds; sub: Creds | null } | null = null
  /** 위 효과 app.link_blocked 를 받은 횟수 — unreachableAfter 회째에 드러낸다 */
  private blockedSeen = 0
  private rung = 0
  private attempt = 0
  private since = wall()
  private lastState: LinkState = 'connecting'
  private cause: string | null = null
  private pendingCheck = false
  private pending: MlineTable | null = null
  /** 지금 넣는 배정표 — 위가 받아들이면(차례 번호가 오르면) 이음매보다 먼저 보관한다 */
  private incoming: MlineTable | null = null
  private closedForApp = false

  private constructor(readonly core: Core, public sc: ServerConfig | null, peer: PeerLink | null) {
    this.peer = peer
    const w = core.cfg.wakeDetectMs
    this.grace = new Timer(w)
    this.applyTimer = new Timer(w)
    this.reopenTimer = new Timer(w)
    this.stableTimer = new Timer(w)
    this.checkTimer = new Timer(w)
    // 위 상태기가 서기 전의 첫 수립 — everUp 거짓 · 표 사본은 비어 있다(SDK:IMPL-LINK-PROJECTION connecting)
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
      if (stale) have.replaced = have.gen(sc.ice.publish_ufrag)
      have.adoptPeer()
      return have
    }
    const link = new LinkCore(core, sc, peer)
    core.links.set(sc.sfu_id, link)
    link.core.record('LINK', link.server, link.st.ls, link.st.ls, 'SDK.link_new', 'join', { rung: 0, attempt: 0 })
    link.adoptPeer()
    return link
  }

  private gen(ufrag: string): number { return this.core.epochs.id(`ufrag:${ufrag}`) }

  private adoptPeer(): void {
    const p = this.peer
    if (!p) return
    for (const l of this.core.media.on(this.server)) if (l.wantsSlot()) l.acquireSlot()
    void this.pumpFacts(p)
    this.core.emitLink(this.info())
  }

  /** 층별 사실은 PeerLink 의 통에서 직접 꺼낸다(콜백 주입 없음) · 갈아 끼운 옛 연결의 사실은 버린다 */
  private async pumpFacts(p: PeerLink): Promise<void> {
    for (;;) {
      const f = await p.facts.next()
      if (!f) break
      if (p !== this.peer) continue
      try { this.fact(f) } catch (e) { this.core.log.error('연결 사실 처리 실패', { err: String(e), stack: e instanceof Error ? e.stack : undefined }) }
    }
  }

  // ── 층별 사실 → 위 입구(SDK:IMPL-LINK-PROJECTION 입구 표) ────────────

  /** 위 입구의 읽기 칸 `leaving`(READS ROOM.rs) — 그 서버 방이 전부 나가는 중이다(하나 이상 LEAVING · 나머지는 NONE).
   *  서버가 마지막 방 퇴장에 Peer 를 거두며 닫는 사실을 재구축 방아쇠로 받지 않게 위 상태기가 가른다(연:RULE-ROOM-LEAVE-RES 2). */
  private leavingAll(): boolean {
    const rooms = this.core.roomsOn(this.server)
    return rooms.some((r) => r.st.rs === 'LEAVING') && rooms.every((r) => r.st.rs === 'LEAVING' || r.st.rs === 'NONE')
  }

  /** 브라우저 사실 하나 — 층마다 따로 읽어 그 층의 입구에 넣는다(SDK:RULE-LINK-LAYERS) */
  fact(f: LinkFact): void {
    if (f.t === 'ice') this.iceFact(f.state)
    else if (f.t === 'dtls') { if (f.state === 'closed' || f.state === 'failed') this.enter('assocLost', 'dtls', [this.leavingAll()]) }
    else if (f.t === 'sctp') { if (f.state === 'closed') this.enter('assocLost', 'sctp', [this.leavingAll()]) }
    else if (f.t === 'dc') this.dcFact(f.open)
    else if (f.t === 'dcData') {
      const rx = Mbcp.parse(f.data)
      if (!rx) return
      const room = this.core.rooms.get(rx.room)
      if (room && room.sfuId === this.server) room.floor.receive(rx.rx)
    } else if (f.t === 'track') {
      for (const r of this.core.roomsOn(this.server)) r.trk.syncRemotes()
    }
  }

  private iceFact(s: RTCIceConnectionState): void {
    if (s === 'connected' || s === 'completed') {
      // 기다림 안이면 iceBack · 재시작 협상 뒤면 applied · 재구축 중이면 새 연결의 결과(rebuilt)
      if (this.st.ls === 'WAIT') this.enter('iceBack', 'ice', [])
      else if (this.st.ls === 'APPLY' && !this.st.nego) this.enter('applied', 'ice', [])
      else if (this.st.ls === 'REBUILD') this.tryRebuilt()
      this.firstUp()
    } else if (s === 'disconnected') {
      this.enter('iceDisc', 'ice', [this.leavingAll()])
    } else if (s === 'failed') {
      if (this.st.ls === 'REBUILD') this.enter('rebuilt', 'ice', [this.peerGen(), false])
      else this.enter('waitOver', 'ice', [true, this.leavingAll()])
    }
  }

  private dcFact(open: boolean): void {
    if (open) {
      if (this.st.ls === 'REOPEN') { this.reopenTimer.stop(); this.enter('reopened', 'dc', ['ok']) }
      this.firstUp()
      if (this.st.ls === 'REBUILD') this.tryRebuilt()
      return
    }
    const sctp = this.peer?.sctpState
    if (sctp !== 'connected') { this.enter('assocLost', 'dc', [this.leavingAll()]); return }
    // 다시 열기 중에 새 DC 가 닫혔다 — 그 시도의 판정은 시한(다음 시도 시각)에 한다(SDK:RULE-LINK-LAYERS DC 다시 열기 손잡이)
    if (this.st.ls === 'REOPEN') return
    this.dcDownAt = now()
    this.enter('dcClosed', 'dc', [this.leavingAll()])
  }

  private peerGen(): number { return this.sc ? this.gen(this.sc.ice.publish_ufrag) : this.st.gen }

  /** 첫 수립 — 전 층이 처음 섰다(위 상태기가 서기 전의 connecting 이 끝난다 · 위 상태 everUp) */
  private firstUp(): void {
    if (this.st.everUp || this.st.ls !== 'OK') return
    if (!this.peer || !this.peer.dcOpen || (this.peer.ice !== 'connected' && this.peer.ice !== 'completed')) return
    const prev = this.st
    this.st = { ...this.st, everUp: true }
    this.core.record('LINK', this.server, prev.ls, this.st.ls, 'SDK.first_up', 'ice+dc', { rung: this.rung, attempt: this.attempt })
    this.blockedSeen = 0
    this.blocked = false
    this.surface()
  }

  private tryRebuilt(): void {
    const p = this.peer
    if (!p || this.st.ls !== 'REBUILD') return
    if ((p.ice === 'connected' || p.ice === 'completed') && p.dcOpen) this.enter('rebuilt', 'rebuild', [this.peerGen(), true])
  }

  // ── 위 이음매가 부르는 입구(위 코드 REACTS) ──────────────────────────

  renego(): void { this.enter('renego', 'seam', []) }
  closeAll(): void { this.enter('closeAll', 'session', []) }
  repair(): void { this.enter('repair', 'resume', []) }
  epochChanged(): void { this.enter('epochChanged', 'epoch', []) }
  pubLost(): void { this.enter('pubLost', 'resume', []) }
  roomLeft(last: boolean): void { this.enter('roomLeft', 'leave', [last]) }
  /** ROOM link.server_ice — 입장 응답의 자격이 보관값과 달랐나(갈아 끼웠나) · 재구축 중이 아니면 옛 Peer 축출 → 그 서버 발행 전부 다시(연:RULE-ROOM-JOIN-PROC) */
  serverIce(): void {
    const g = this.replaced
    this.replaced = null
    this.enter('serverIce', 'ROOM_JOIN.ice', [g !== null, g ?? this.st.gen])
  }

  /** 입장 응답 · 이어받기 응답이 실어 온 표 — MLINE_EVENT 와 같게 받는다(어느 길로 와도 새 arev 가 이긴다) */
  tableCarried(t: MlineTable): void {
    this.acceptTable(t, () => this.enter('tableCarried', 'table', [t.arev, TableStore.midOf(t) as unknown as LINK.St['mid'], TableStore.materials(t.mlines)]))
  }

  pendingTable(t: MlineTable): void { this.pending = t }
  flushPendingTable(): void {
    const t = this.pending
    this.pending = null
    if (t) this.tableCarried(t)
  }

  /** MLINE_EVENT — 그 서버 연결의 배정표 전체 */
  mlineEvent(t: MlineTable): void {
    this.acceptTable(t, () => this.enter('mlineEvent', 'MLINE_EVENT', [{ table: { arev: t.arev, mid: TableStore.midOf(t) as unknown as LINK.St['mid'], rows: TableStore.materials(t.mlines) } }]))
  }

  /** 배정표 — 받아들였는가(차례 번호가 올랐다)는 위가 돌려준 상태로 읽는다(라벨 글자로 가르지 않는다) */
  private acceptTable(t: MlineTable, put: () => void): void {
    if (this.sc && t.sfu_id !== this.sc.sfu_id) return
    const before = this.st.arev
    this.incoming = t
    try { put() } finally { this.incoming = null }
    if (this.st.arev !== before) for (const r of this.core.roomsOn(this.server)) r.trk.syncRemotes()
  }

  /** 위가 받아들인 표를 이음매(sub.table_*)보다 먼저 보관한다 · 재료가 그대로면(같음 · 재배정) 이 표가 적용된 SDP 의 가장 새 표다 */
  private takeTable(prev: LINK.St): void {
    const t = this.incoming
    if (!t || this.st.arev === prev.arev) return
    this.table.accept(t)
    this.peer?.setRows(this.table.mlines)
    if (!this.negotiating && this.st.rows === prev.rows) this.sdpArev = t.arev
  }

  /** 브라우저 `online` — 망이 바뀌었다(위 입구 `online` — 연결이 쉬면 WS 부터 확인 · 복구 중이면 흡수) */
  online(): void { this.enter('online', 'online', []) }

  /** LINK_EVENT{suspect} — ufrag 가 그 연결의 지금 자격 둘 중 하나면 지금 세대, 아니면 옛 세대 */
  linkEvent(ufrag: string): void {
    const sc = this.sc
    const cur = sc ? [sc.ice.publish_ufrag, sc.ice.subscribe_ufrag] : []
    this.enter('linkEvent', 'LINK_EVENT', [{ ufrag: cur.includes(ufrag) ? this.st.gen : -1 }])
  }

  /** 세션 층 복구가 끝났다 — 보류했던 WS 점검을 이어 간다(세션 층 복구 중 러너 전부 보류) */
  sessionBack(): void {
    if (this.pendingCheck) { this.pendingCheck = false; this.wsCheck() }
  }

  /** 발행(PUB)이 연결을 지나 보내는 요청 — 발행은 서버(Peer)마다고 세션 영역을 부르지 않는다(may_use = AFF · FLR · LINK) */
  request(op: 'PUBLISH_TRACKS' | 'TRACK_SET', body: Record<string, unknown>): Promise<Reply> { return this.core.sig.request(op, body) }

  closeForApp(): void {
    this.closedForApp = true
    for (const t of [this.grace, this.applyTimer, this.reopenTimer, this.stableTimer, this.checkTimer]) t.stop()
  }

  // ── 출입구 ────────────────────────────────────────────────────────────

  /** 입구 하나 — 위 결합의 ENTRY 를 지난다 · 받지 않으면(null) 출입구가 impossible 로 남긴다 */
  enter<K extends Entry>(name: K, cause: string, args: Args<K>): boolean {
    const f = LB.ENTRY[name] as unknown as (s: LINK.St, ...a: Args<K>) => LINK.Step | null
    const step = f(this.st, ...args)
    this.step(name, step, cause)
    return step !== null
  }

  /** 상태 변경의 단일 출입구 — 위 한 걸음 → 전이 기록 → 효과 · 송신 · 이음매 → 손잡이(타이머) · 표면(SDK:IMPL-LINK-PROJECTION 러너 규율) */
  step(entry: string, step: LINK.Step | null, cause: string): void {
    if (!step) { this.core.impossible('LINK', this.server, this.st.ls, entry); return }
    const prev = this.st
    const plan = LB.plan(step)
    this.st = plan.state
    this.core.record('LINK', this.server, prev.ls, this.st.ls, plan.label, cause, { rung: this.rung, attempt: this.attempt })
    this.takeTable(prev)
    for (const f of step.fx) this.effect(f)
    for (const a of plan.actions) this.action(a, prev)
    for (const tx of plan.send) this.send(tx)
    for (const sm of plan.seams) this.seam(sm.fx)
    this.follow(prev, plan)
  }

  /** 효과 표의 덧붙임 — 낼 표면(link)은 결합이 정하고 SDK 고유의 몫만 여기 */
  private effect(f: LINK.Fx): void {
    if (f !== 'app.link_blocked') return
    // 드러내기 손잡이 — unreachableAfter 회째에 드러낸다 · 그 전은 표시만 미룬다 · 포기하지 않는다(SDK:RULE-LINK-LAYERS)
    this.blockedSeen++
    if (this.blockedSeen >= this.core.cfg.unreachableAfter) this.blocked = true
  }

  /** 한 걸음 뒤 — 위가 값을 두지 않은 손잡이(기다림 · 적용 시한 · 안정 관찰)와 협상 큐 · 표면 */
  private follow(prev: LINK.St, plan: LB.Plan): void {
    const ls = this.st.ls
    if (ls === 'WAIT' && prev.ls !== 'WAIT') this.grace.start(this.core.cfg.wobblyGraceMs, (f) => this.due('grace', f))
    if (ls !== 'WAIT') this.grace.stop()
    if (ls === 'APPLY' && prev.ls !== 'APPLY') this.applyTimer.start(this.core.cfg.iceRestartTimeoutMs, (f) => this.due('apply', f))
    if (ls !== 'APPLY') this.applyTimer.stop()
    // 협상 중에 받은 새 자격 — 위는 큐에 적기만 한다(restart_ok_queued) · 다음 협상이 싣도록 연결에 넘긴다
    if (ls === 'APPLY' && prev.ls === 'RESTART' && !plan.actions.includes('sdp.restart')) this.loadCreds()
    if (ls !== 'REOPEN') { this.reopenTimer.stop(); this.reopenTries = 0 }
    if (ls === 'OK' && prev.ls !== 'OK' && prev.ls !== 'NONE') this.stableTimer.start(this.core.cfg.recoveryStableMs, () => { this.rung = 0; this.attempt = 0 })
    else if (ls !== 'OK') this.stableTimer.stop()
    if (ls !== 'CHECK') this.checkTimer.stop()
    if (ls === 'OK' && this.st.everUp && this.blocked) { this.blocked = false; this.blockedSeen = 0 }
    if (plan.events.length || prev.ls !== ls || this.lastState !== this.state) this.surface()
    if (prev.ls === 'REBUILD' && ls === 'OK' && prev.dirty) this.rebuildOwed = true
    if (this.rebuildOwed && !this.negotiating && !this.st.nego) { this.rebuildOwed = false; this.renego() }
    if (this.st.nego && !this.negotiating) void this.negotiate()
    if (ls === 'APPLY' && !this.st.nego && prev.nego && this.peer && (this.peer.ice === 'connected' || this.peer.ice === 'completed')) this.enter('applied', 'nego', [])
    if (ls === 'NONE' && prev.ls !== 'NONE') this.core.links.delete(this.server)
  }

  /** 기다림 · 적용 시한 만료 — 깨어남이면 시한 초과로 세지 않고 사실을 다시 읽어 처음부터 넣는다(SDK:IMPL-LINK-PROJECTION 깨어남) */
  private due(name: 'grace' | 'apply', f: Fired): void {
    if (f.woke) {
      this.core.record('LINK', this.server, this.st.ls, this.st.ls, `SDK.wake.${name}`, 'wake', { rung: this.rung, attempt: this.attempt })
      const ice = this.peer?.ice
      if (ice) this.iceFact(ice)
      if (name === 'grace' && this.st.ls === 'WAIT') this.grace.start(this.core.cfg.wobblyGraceMs, (g) => this.due('grace', g))
      if (name === 'apply' && this.st.ls === 'APPLY') this.applyTimer.start(this.core.cfg.iceRestartTimeoutMs, (g) => this.due('apply', g))
      return
    }
    if (name === 'grace') this.enter('waitOver', 'grace', [false, this.leavingAll()])
    else this.enter('applyTimeout', 'timer', [])
  }

  private action(a: LB.LinkAction, prev: LINK.St): void {
    if (a === 'peer.close') {
      this.peer?.close()
      this.peer = null
      this.negotiating = false
      for (const l of this.core.media.on(this.server)) l.peerClosed()
    } else if (a === 'dc.reopen') {
      this.scheduleReopen(prev.ls !== 'REOPEN')
    } else if (a === 'sdp.restart') {
      this.loadCreds()
    }
  }

  /** 새 ICE 자격을 연결에 넘긴다 — 협상 큐가 싣는다(지문 · setup 은 그대로) */
  private loadCreds(): void {
    const c = this.restartCreds
    if (c && this.peer) this.peer.restartWith(c.pub, c.sub)
  }

  /** DC 다시 열기 — 시도 k(1 부터)는 DC 가 닫힌 뒤 k × intervalMs 에 연다 · 판정 시한은 다음 시도 시각 · tries 번째 실패가 소진(정책서 dcReopen) */
  private scheduleReopen(first: boolean): void {
    const { tries, intervalMs } = this.core.cfg.dcReopen
    if (first) this.reopenTries = 0
    const k = this.reopenTries + 1
    this.reopenTimer.start(Math.max(0, this.dcDownAt + k * intervalMs - now()), () => {
      this.reopenTries = k
      this.peer?.reopenDc()
      this.reopenTimer.start(intervalMs, () => {
        if (this.st.ls === 'REOPEN') this.enter('reopened', 'dc', [k >= tries ? 'exhausted' : 'fail'])
      })
    })
  }

  private send(tx: LINK.Tx): void {
    if (tx.ws === 'READY') {
      for (const r of this.core.roomsOn(this.server)) {
        r.trk.sub.sendReady()
        if (r.floor.st.cs === 'QUEUED') r.floor.queuePosition()
      }
    } else if (tx.ws === 'HEARTBEAT') {
      this.wsCheck()
    } else if (tx.ws === 'ICE_RESTART') {
      const id = this.st.req
      this.core.sig.request('ICE_RESTART', { sfu_id: this.server }).then((r) => {
        const b = (r.body ?? {}) as IceRestartRes
        const code = r.ok ? 0 : fromFailure(r.body).code
        if (r.ok) this.restartCreds = { pub: b.publish, sub: b.subscribe ?? null }
        const m = { code, part: (r.ok ? 'res' : 'fail') as LINK.Part, pid: id, publish: { ufrag: r.ok ? this.gen(b.publish.ufrag) : 0 } }
        if (r.ok && this.sc) this.sc = { ...this.sc, ice: { ...this.sc.ice, publish_ufrag: b.publish.ufrag, publish_pwd: b.publish.pwd, ...(b.subscribe ? { subscribe_ufrag: b.subscribe.ufrag, subscribe_pwd: b.subscribe.pwd } : {}) } }
        this.enter('restartRes', r.ok ? 'ICE_RESTART.res' : `ICE_RESTART.${code}`, [m])
      }, () => undefined)
    }
  }

  /** WS 점검 — 같은 치료를 다시 할 때의 간격은 사다리 칸값(정책:sdk.iceRestartBackoffMs) · 끝 칸 되풀이 · 상한 없음.
   *  간격 뒤 보내는 순간에 세션이 ACTIVE 인지 다시 본다 — 아니면 보내지 않고 세션 층 복구 뒤로 미룬다(연:RULE-SES-BIND-PROC · 연:RULE-TRN-FLOW-CONTROL) */
  private wsCheck(): void {
    if (this.closedForApp) return
    if (this.core.ses.cs !== 'ACTIVE') { this.pendingCheck = true; return }
    const ladder = this.core.cfg.iceRestartBackoffMs
    const before = { attempt: this.attempt, rung: this.rung }
    const wait = this.attempt === 0 ? 0 : ladder[Math.min(this.rung, ladder.length - 1)] ?? 7000
    this.attempt++
    if (this.attempt > 1) this.rung = Math.min(this.rung + 1, ladder.length - 1)
    this.checkTimer.start(wait, () => {
      if (this.st.ls !== 'CHECK' || this.closedForApp) return
      if (this.core.ses.cs !== 'ACTIVE') {
        // 보내지 않은 점검은 치료로 세지 않는다 — 세션이 돌아오면 같은 칸에서 다시 건다
        this.attempt = before.attempt; this.rung = before.rung
        this.pendingCheck = true
        return
      }
      void this.core.sig.probe(this.core.cfg.wsProbeTimeoutMs).then((alive) => {
        if (this.st.ls !== 'CHECK') return
        if (alive) this.enter('hbRes', 'HEARTBEAT', [{}])
        else { this.core.log.warn('WS 점검 실패 — 소켓을 LEAVE 없이 닫는다'); this.core.sig.close() }
      })
    })
  }

  /** 이음매 — 받는 곳은 위가 정했다(SEAMS) · 그 서버(sameServer)의 방 · 발행에 위가 낸 차례대로 넘긴다(SDK:RULE-LINK-REBUILD) */
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
      case 'sub.nego_ok': for (const r of rooms) r.trk.sub.enter('negoOk', 'nego', []); break
      case 'sub.nego_fail': for (const r of rooms) r.trk.sub.enter('negoFail', 'nego', []); break
      case 'sub.table_changed': for (const r of rooms) r.trk.sub.enter('tableChanged', 'table', []); break
      case 'sub.table_rebound': for (const r of rooms) r.trk.sub.enter('tableRebound', 'table', []); break
      default: {
        const missing: never = fx
        throw new Error(`이음매 표에 없는 위 이음매: ${String(missing)}`)
      }
    }
  }

  /** 협상 큐 — 위 상태기의 nego 가 서 있는 동안 한 번에 하나 · 결과는 입구 negoRes(SDK:IMPL-MOD-TABLE 협상 결과 = internal/transport) */
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
    this.enter('negoRes', r.ok ? 'nego.ok' : 'nego.fail', [r.ok])
    for (const room of this.core.roomsOn(this.server)) {
      // 재조립 협상 실패는 내 요청이 아니다 — 그 서버에 들어가 있는 방마다 room.error(SDK:IMPL-TRK-RECEIVE · 입장 중 방만이 아니다)
      const fault = r.ok ? null : this.negoFault ?? new Fault({ code: 0, name: 'NEGOTIATION_APPLY', category: 'negotiation' })
      // 첫 협상을 기다리는 입장은 그 결과를 join() 이 받는다(SDK:IMPL-ROOM-API app.joined) — 그 밖 방은 room.error
      if (room.joinPending && !this.st.nego) room.finishJoin(fault)
      else {
        if (fault && room.st.rs === 'JOINED') room.events.emit('error', fault)
        room.trk.syncRemotes()
      }
    }
  }

  // ── 앱 투영(SDK:IMPL-LINK-PROJECTION 위 상태 → 앱 값) ─────────────────

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

  /** link 이벤트는 값이 바뀔 때마다 — 위 앱 효과는 그 바뀜의 부분이다(REOPEN 진입처럼 효과 없는 바뀜도 알린다) */
  private surface(): void {
    const s = this.state
    if (s !== this.lastState) { this.lastState = s; this.since = wall(); this.cause = this.st.cause === 'NONE' ? null : this.st.cause.toLowerCase() }
    this.core.emitLink(this.info())
    for (const r of this.core.roomsOn(this.server)) r.floor.linkChanged()
  }
}
