// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-DIAG-PROBE · SDK:RULE-DIAG-STATS · SDK:RULE-DIAG-QUALITY · SDK:RULE-MOD-AREA-MIRROR domain/ses · model: claude-opus-5-5
// 옛 domain/media-registry.ts 의 진단 몫(probe 조립 · getStats 주기 · session.quality)을 옮겨 왔다 — 진단은 가로지르고(층 자체가 자리) 이 몫은 세션 · 방 · 연결 · 발행 전부를 읽으니 그것을 다 든 세션이 소유한다.
import type { ProbeResult } from '../../internal/wire/ws.js'
import * as Probe from '../../internal/probe.js'
import { describe, enumerate, permission } from '../../platform/env.js'
import type { Core } from './core.js'

/** 진단 수집 — probe(TASK) · diagnostics.stats 주기 · 서버별 품질의 최악값 */
export class Diag {
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private prevNet = new Map<string, Probe.NetSample>()

  constructor(private readonly core: Core) {}

  /** getStats 주기는 세션이 active 인 동안만 돈다 */
  sessionActive(on: boolean): void {
    const ms = this.core.cfg.statsIntervalMs
    if (on && this.statsTimer === null && ms > 0) this.statsTimer = setInterval(() => void this.stats(), ms)
    if (!on) this.stop()
  }

  stop(): void {
    if (this.statsTimer !== null) { clearInterval(this.statsTimer); this.statsTimer = null }
  }

  /** probe — TASK{request} 를 ACK 한 뒤 조립해 report 로 보낸다 · 모르는 값은 null 로 채우지 않는다 */
  async probeTask(reqId: number): Promise<void> {
    const result = await this.probe()
    this.core.events.emit('probe', result)
    this.core.sig.request('TASK', { phase: 'report', req_id: reqId, type: 'probe', result }).catch(() => undefined)
  }

  async probe(): Promise<ProbeResult> {
    const core = this.core
    const r: { -readonly [K in keyof ProbeResult]: ProbeResult[K] } = {}
    try {
      const reports: RTCStatsReport[] = []
      for (const l of core.links.values()) if (l.peer) reports.push(...(await l.peer.stats()))
      const pub = Probe.outbound(reports)
      const sub = Probe.inbound(reports)
      if (pub.length) r.pub_tracks = pub
      if (sub.length) r.sub_tracks = sub
      r.env = describe()
      r.devices = (await enumerate()).map((d) => ({ kind: d.kind, label: d.label, groupId: d.groupId }))
      r.permissions = { microphone: await permission('microphone'), camera: await permission('camera') }
      r.state = {
        session: core.sessionState,
        rooms: [...core.rooms.values()].map((x) => ({ room_id: x.id, state: x.state, floor: x.floor.phase, link: x.link?.state ?? null })),
        links: [...core.links.values()].map((l) => l.info()),
        pub_room: core.rooms.aff.speakingRoom,
      }
      if (reports.length) r.network = Probe.network(reports)
    } catch (e) {
      r.error = String(e)
    }
    return r
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
