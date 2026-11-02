// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-DIAG-PROBE · SDK:RULE-DIAG-STATS · SDK:RULE-DIAG-QUALITY · SDK:RULE-MOD-AREA-MIRROR domain(가로지름 — DIAG) · 연:RULE-AUX-PROBE-NO-INVENT · model: claude-opus-5-5
// 진단 수집(probe 조립 · getStats 주기 · session.quality) — DIAG 는 개념 영역이 아니라 가로지르는 측면이라 영역 디렉터리가 아닌 domain 층 자체에 둔다(SDK:RULE-MOD-AREA-MIRROR).
// 세션 · 방 · 연결 · 발행을 읽기만 하고 소유는 세션(Core.diag)이 한다 — 세션이 만들고 세션 active 동안만 주기를 돌린다.
import type { ProbeResult } from '../internal/wire/ws.js'
import * as Probe from '../internal/probe.js'
import { describe, listDevices, permission } from '../platform/env.js'
import type { Core } from './ses/core.js'
import type { LinkCore } from './link/core.js'
import { Every } from '../platform/clock.js'

/** 진단 수집 — probe(TASK) · diagnostics.stats 주기 · 서버별 품질의 최악값 */
export class Diag {
  private readonly statsTimer = new Every()
  private prevNet = new Map<string, Probe.NetSample>()

  constructor(private readonly core: Core) {}

  /** getStats 주기는 세션이 active 인 동안만 돈다 */
  sessionActive(on: boolean): void {
    const ms = this.core.cfg.statsIntervalMs
    if (on && !this.statsTimer.armed && ms > 0) this.statsTimer.start(ms, () => void this.stats())
    if (!on) this.stop()
  }

  stop(): void {
    this.statsTimer.stop()
  }

  /** probe — TASK{request} 를 ACK 한 뒤 조립해 report 로 보낸다 · 모르는 값은 null 로 채우지 않는다 */
  async probeTask(reqId: number): Promise<void> {
    const result = await this.probe()
    this.core.events.emit('probe', result)
    this.core.sig.request('TASK', { phase: 'report', req_id: reqId, type: 'probe', result }).catch(() => undefined)
  }

  /**
   * probe result 조립(SDK:IMPL-DIAG-PROBE 분담 표) — 못 모은 칸은 뺀다 · state 는 늘 싣는다 ·
   * ★수집 자체가 던지면 그것만(error 하나 — 반쯤 모은 칸을 섞지 않는다).
   */
  async probe(): Promise<ProbeResult> {
    const core = this.core
    try {
      const r: { -readonly [K in keyof ProbeResult]: ProbeResult[K] } = {}
      const reports: RTCStatsReport[] = []
      const sub: Record<string, unknown>[] = []
      for (const l of core.links.values()) {
        if (!l.peer) continue
        const mine = await l.peer.stats()
        reports.push(...mine)
        sub.push(...this.subTracks(l, mine))
      }
      const pub = Probe.outbound(reports)
      if (pub.length) r.pub_tracks = pub
      if (sub.length) r.sub_tracks = sub
      const env = describe()
      if (env) r.env = env
      const devices = await listDevices()
      if (devices) r.devices = devices.map((d) => ({ kind: d.kind, label: d.label, groupId: d.groupId }))
      const perms = { microphone: await permission('microphone'), camera: await permission('camera') }
      if (perms.microphone !== 'unknown' || perms.camera !== 'unknown') r.permissions = perms
      r.state = {
        session: core.sessionState,
        rooms: [...core.rooms.values()].map((x) => ({ room_id: x.id, state: x.state, floor: x.floor.phase, link: x.link?.state ?? null })),
        links: [...core.links.values()].map((l) => l.info()),
        pub_room: core.rooms.aff.speakingRoom,
      }
      if (reports.length) r.network = Probe.network(reports)
      return r
    } catch (e) {
      return { error: String(e) }
    }
  }

  /** 받는 트랙 — 그 서버 수신 통계에 track_id(줄 mid 로 찾는다)와 ★마지막으로 요청한 레이어 상한(spatial · temporal · paused — 요청한 적 없으면 칸 없음)을 붙인다 */
  private subTracks(l: LinkCore, reports: RTCStatsReport[]): Record<string, unknown>[] {
    const rooms = this.core.roomsOn(l.server)
    return Probe.inbound(reports).map((row) => {
      const out: Record<string, unknown> = { ...row }
      const mid = row['mid']
      if (typeof mid !== 'string') return out
      for (const room of rooms) {
        const remote = [...room.trk.remotes.values()].find((x) => x.row?.mid === mid)
        if (!remote) continue
        out['track_id'] = remote.id
        const asked = room.trk.sub.asked.get(remote.id)
        if (asked?.spatial !== undefined) out['spatial'] = asked.spatial
        if (asked?.temporal !== undefined) out['temporal'] = asked.temporal
        if (asked?.paused !== undefined) out['paused'] = asked.paused
        break
      }
      return out
    })
  }

  /** getStats 주기 — diagnostics.stats · session.quality(여러 서버면 최악값) */
  async stats(): Promise<void> {
    const core = this.core
    if (core.ses.cs !== 'ACTIVE') return
    let q: Probe.Quality = 'excellent'
    const out: Record<string, unknown> = {}
    for (const l of core.links.values()) {
      if (!l.peer) continue
      const reports = await l.peer.stats()
      const cur = Probe.network(reports)
      q = Probe.worst(q, Probe.grade(this.prevNet.get(l.server) ?? null, cur, l.state === 'up' || l.state === 'connecting', core.cfg.quality))
      this.prevNet.set(l.server, cur)
      out[l.server] = { pub: Probe.outbound(reports), sub: Probe.inbound(reports), network: cur }
    }
    core.events.emit('stats', out)
    if (q !== core.quality) { core.quality = q; core.surface() }
  }
}
