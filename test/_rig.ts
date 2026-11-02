// author: kodeholic (powered by Claude)
// 1층 클라이언트 받침 — 가짜 WebSocket(test/_ws) 위의 진짜 클라이언트 · 진짜 연결 상태기(LinkCore)에 가짜 PeerLink(협상은 시험이 끝낸다).
// 방(room.test) · 받는 쪽(trk.test)이 같이 쓴다.
import { FakeWS, tick, type Frame } from './_ws.js'
import { Op, type MemberInfo, type Permission, type RoomJoinRes, type ServerConfig, type TrackEntry, type GetRoomRes, type MlineEntry } from '../src/internal/wire/ws.js'
import type { Core, Transition } from '../src/domain/ses/core.js'
import { createClient, type OxLensClient, type ClientOptions, type Room } from '../src/index.js'
import { LinkCore } from '../src/domain/links.js'
import { SC } from './_fixtures.js'

export const BIND_OK = { user_id: 'u1', server_ver: 1, heartbeat_interval: 10_000, session_id: 's-1', resume_window_ms: 60_000, pc_mode: '2pc' }
export const SA: ServerConfig = { ...SC, sfu_id: 'sfu-a' }
export const SB: ServerConfig = { ...SC, sfu_id: 'sfu-b', ice: { ...SC.ice, publish_ufrag: 'pubUfB' } }

/** 수신 트랙 자리 — 첫 디코딩 프레임은 시험이 unmute 로 낸다 */
export interface FakeTrack { readonly kind: string; muted: boolean; unmute(): void; addEventListener(n: string, f: () => void): void }
export function fakeTrack(kind = 'video'): FakeTrack {
  const fs: (() => void)[] = []
  return { kind, muted: true, unmute() { this.muted = false; for (const f of fs.splice(0)) f() }, addEventListener: (n, f) => { if (n === 'unmute') fs.push(f) } }
}

/** PeerLink 자리 — 협상은 settle() 이 끝낸다 · 조립 횟수를 센다 · 줄(mid)마다 수신 트랜시버(rx) */
export interface FakePeer { assembled: number; rx: Map<string, { track: FakeTrack; getStats(): Promise<unknown> }>; settle(ok?: boolean): void }
export function fakePeer(): FakePeer {
  const waiting: ((r: { ok: boolean }) => void)[] = []
  const rx = new Map<string, { track: FakeTrack; getStats(): Promise<unknown> }>()
  const p = {
    assembled: 0, rx, dcOpen: false, ice: 'new', sctpState: null,
    negotiate: () => { p.assembled++; return new Promise<{ ok: boolean }>((r) => waiting.push(r)) },
    settle: (ok = true) => { for (const w of waiting.splice(0)) w({ ok }) },
    setRows: () => undefined, receiverOf: (mid: string) => rx.get(mid) ?? null, sendDc: () => false, close: () => undefined,
    acquireSlot: (kind: string) => ({ kind, transceiver: null, mid: null }), releaseSlot: () => undefined, deactivate: () => undefined,
    sendInfo: () => null, restartWith: () => undefined, reopenDc: () => undefined, stats: async () => [],
  }
  return p
}

export interface Rig { c: OxLensClient; core: Core; ws: FakeWS; peers: Map<string, FakePeer>; labels: { key: string; label: string }[]; trace: Transition[] }

export async function up(o: Partial<ClientOptions> = {}): Promise<Rig> {
  FakeWS.made.length = 0
  FakeWS.auto.set(Op.READY, {})
  const c = createClient({ base: 'https://hub.example', token: 'tok', pcMode: '2pc', massJitterMs: 0, ...o })
  const r: Rig = { c, core: c.core, ws: undefined as unknown as FakeWS, peers: new Map(), labels: [], trace: [] }
  c.diagnostics.on('transition', (t) => {
    r.trace.push(t)
    if (t.layer === 'ROOM') r.labels.push({ key: t.key, label: t.label })
  })
  const p = c.connect()
  await tick(); r.ws = FakeWS.made[0]!; r.ws.open(); await tick()
  r.ws.reply(Op.BIND, BIND_OK)
  await p
  return r
}

/** 그 서버의 연결 — 진짜 연결 상태기 · 가짜 PeerLink(입장 응답이 이것을 고른다 — LinkCore.adopt) */
export function linkOf(r: Rig, sc: ServerConfig): LinkCore {
  const have = r.core.links.get(sc.sfu_id)
  if (have?.peer) return have
  const peer = fakePeer()
  r.peers.set(sc.sfu_id, peer)
  if (have) { have.peer = peer as never; have.sc = sc; return have }
  const Link = LinkCore as unknown as new (core: Core, sc: ServerConfig, peer: unknown) => LinkCore
  const link = new Link(r.core, sc, peer)
  r.core.links.set(sc.sfu_id, link)
  return link
}

/** 그 서버의 협상을 끝까지 — 연달아 걸린 재협상까지 */
export async function drain(r: Rig, sc: ServerConfig = SA, ok = true): Promise<void> {
  for (let i = 0; i < 6; i++) { r.peers.get(sc.sfu_id)?.settle(ok); await tick() }
}

export interface JB { sc?: ServerConfig; me?: Permission; meSelect?: boolean; hidden?: boolean; others?: MemberInfo[]; pub?: string | null; subs?: string[]; epoch?: string; seq?: number; tracks?: TrackEntry[]; mlines?: MlineEntry[]; arev?: number }

export const mem = (user_id: string, permission?: Permission, o: { select?: boolean; type?: 0 | 1 | 2 } = {}): MemberInfo => ({ user_id, select: o.select ?? false, participant_type: o.type ?? 0, ...(permission ? { permission } : {}) })

/** 입장 응답 — sub_rooms 는 그 서버에 이미 들어간 방 + 이 방(서버가 보는 그대로) */
export function joinBody(r: Rig, id: string, o: JB = {}): RoomJoinRes {
  const sc = o.sc ?? SA
  const subs = o.subs ?? [...new Set([...[...r.core.rooms.values()].filter((x) => x.sfuId === sc.sfu_id && x.st.rs === 'JOINED').map((x) => x.id), id])]
  const me = mem('u1', o.me, { select: o.meSelect ?? false })
  return {
    room_id: id, participants: [...(o.hidden ? [] : [me]), ...(o.others ?? [])], me, affiliation: { sub_rooms: subs, pub_room: o.pub ?? null },
    server_config: sc, tracks: o.tracks ?? [], version: { epoch: o.epoch ?? 'e1', seq: o.seq ?? 1 }, media_codecs: { audio: 'opus', video: 'H264' },
    mline_table: { sfu_id: sc.sfu_id, arev: o.arev ?? 1, mlines: o.mlines ?? [] },
  }
}

export const joinFrame = (ws: FakeWS, id: string): Frame => ws.requests(Op.ROOM_JOIN).filter((f) => (f.body as { room_id: string }).room_id === id).at(-1)!
export const leaveFrame = (ws: FakeWS, id: string): Frame => ws.requests(Op.ROOM_LEAVE).filter((f) => (f.body as { room_id: string }).room_id === id).at(-1)!
export const FAIL = (code: number, name: string, details?: Record<string, unknown>): unknown => ({ code, name, permanent: false, ...(details ? { details } : {}) })

/** client.join() 하나를 끝까지 — 입장 응답 · 첫 협상 */
export async function enter(r: Rig, id: string, o: JB & { mode?: 'listen' | 'talk' } = {}): Promise<Room> {
  const sc = o.sc ?? SA
  const p = r.c.join(id, o.mode ? { mode: o.mode } : {})
  await tick()
  linkOf(r, sc)
  r.ws.answer(joinFrame(r.ws, id), joinBody(r, id, o))
  await tick()
  await drain(r, sc)
  return p
}

export const vers = (seq: number, epoch = 'e1'): { epoch: string; seq: number } => ({ epoch, seq })
export async function note(r: Rig, op: number, body: unknown): Promise<void> { r.ws.notify(op, body); await tick() }

/** 재동기 · 미리보기 · 목록의 HTTP — 시험이 응답을 쥔다 */
export function httpMock(h: (url: string) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }): { calls: { url: string; headers: Record<string, string> }[]; restore(): void } {
  const g = globalThis as unknown as { fetch: unknown }
  const saved = g.fetch
  const calls: { url: string; headers: Record<string, string> }[] = []
  g.fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    const x = await h(url)
    return { status: x.status, text: async () => JSON.stringify(x.body) }
  }
  return { calls, restore: () => { g.fetch = saved } }
}

export function getRoom(id: string, seq: number, others: MemberInfo[] = [], epoch = 'e1', tracks: TrackEntry[] = []): GetRoomRes {
  return { room_id: id, name: id, capacity: 10, user_count: others.length + 1, participants: [mem('u1'), ...others], me: mem('u1'), created_at: 0, media_codecs: {}, version: vers(seq, epoch), tracks }
}
