// author: kodeholic (powered by Claude)
// SDK:IMPL-MOD-TABLE · SDK:RULE-MOD-BINDING-VALUES — 모듈(MOD — 가로지르는 것) 1층. 보관본 단일 진입(트랙 층) · 결합이 상태기 모형 자리에 넘기는 값(인터너 · 배정표 지문)을 단위(K-cond-IMPL-MOD-TABLE-* · K-sym-RULE-MOD-BINDING-VALUES-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트 · 진짜 연결 상태기에 가짜 PeerLink(test/_rig).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { FakeWS, tick } from './_ws.js'
import { SA, up, linkOf, enter, drain, note, vers, mem, httpMock, getRoom, fakeTrack, BIND_OK, type Rig, type JB } from './_rig.js'
import { Op, type TrackEntry, type MlineEntry, type RoomSnapshot } from '../src/internal/wire/ws.js'
import { Interner } from '../src/domain/ses/core.js'
import { RoomTracks } from '../src/domain/trk/tracks.js'
import { TableStore } from '../src/domain/link/table.js'

const rigs: Rig[] = []
afterEach(async () => { for (const r of rigs.splice(0)) await r.c.close().catch(() => undefined) })
async function rig(): Promise<Rig> { const r = await up(); rigs.push(r); return r }

const tr = (id: string, o: Partial<TrackEntry> = {}): TrackEntry => ({ type: 'individual', room_id: 'r1', track_id: id, kind: 'video', user_id: 'u2', ...o })
const row = (mid: string, track_id: string | undefined, o: Partial<MlineEntry> = {}): MlineEntry => ({
  mid, kind: 'video', pt: 102, codec: 'H264', ssrc: 2147480000 + Number(mid), stream_id: `ox-m${mid}`, ...(track_id ? { track_id, room_id: 'r1' } : {}), ...o,
})

async function join(r: Rig, id: string, o: JB = {}): Promise<void> {
  linkOf(r, SA)
  for (const m of o.mlines ?? []) if (m.track_id) r.peers.get('sfu-a')!.rx.set(m.mid, { track: fakeTrack('video'), getStats: async () => new Map() })
  await enter(r, id, o)
}

/** src 의 코드(주석 뺀) 한 줄씩 — [파일, 줄 번호, 줄] */
function codeLines(): [string, number, string][] {
  const root = pathJoin(process.cwd(), 'src')
  const out: [string, number, string][] = []
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = pathJoin(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.ts')) {
        const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
        code.split('\n').forEach((l, i) => out.push([p.slice(root.length + 1), i + 1, l.replace(/\/\/.*$/, '')]))
      }
    }
  }
  walk(root)
  return out
}

test('K-cond-IMPL-MOD-TABLE-1 — 트랙 층 보관본(TrackEntry)의 쓰기는 한 곳(domain/trk/tracks 의 입구 delta · snapshot · storeDrop 아래) · 네 경로(JOIN · EVENT · RESUME · HTTP)가 전부 그 입구를 지난다 · 그 밖의 쓰기 0', async () => {
  // 정적 가드 — TrackEntry 를 든 자료 · 그 자료를 고치는 줄
  const lines = codeLines()
  const holders = lines.filter(([, , l]) => /Map<string,\s*TrackEntry>/.test(l)).map(([f]) => f)
  assert.deepEqual(holders, ['domain/trk/tracks.ts'], 'K-cond-IMPL-MOD-TABLE-1 — TrackEntry 보관본은 하나(domain/trk/tracks)')
  const writes = lines.filter(([, , l]) => /\bentries\.(set|delete|clear)\(|(?<!readonly )\bentries\s*=(?!=)/.test(l))
  assert.ok(writes.length > 0)
  assert.deepEqual([...new Set(writes.map(([f]) => f))], ['domain/trk/tracks.ts'], 'K-cond-IMPL-MOD-TABLE-1 — 보관본 쓰기는 domain/trk/tracks 밖에 0')
  const src = readFileSync(pathJoin(process.cwd(), 'src/domain/trk/tracks.ts'), 'utf8').split('\n')
  const owner = (n: number): string => { for (let i = n - 1; i >= 0; i--) { const m = /^ {2}(?:private |async )*(\w+)\(/.exec(src[i]!); if (m) return m[1]! } return '?' }
  assert.deepEqual([...new Set(writes.map(([, n]) => owner(n)))].sort(), ['run', 'snapshot', 'storeDrop'], 'K-cond-IMPL-MOD-TABLE-1 — 쓰기는 입구(delta → run · snapshot · storeDrop) 안에서만')
  // 동적 — 네 경로가 그 입구를 지난다
  const via: string[] = []
  const proto = RoomTracks.prototype as unknown as { snapshot: (l: unknown, c: string) => void; delta: (op: string, b: unknown) => void }
  const snap = proto.snapshot
  const delta = proto.delta
  proto.snapshot = function (this: RoomTracks, l: unknown, c: string) { via.push(`snapshot:${c}`); snap.call(this, l, c) }
  proto.delta = function (this: RoomTracks, op: string, b: unknown) { via.push(`delta:${op}`); delta.call(this, op, b) }
  const http = httpMock(() => ({ status: 200, body: getRoom('r1', 9, [], 'e1', [tr('t2'), tr('t4')]) }))
  try {
    const r = await rig()
    await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
    await note(r, Op.TRACK_EVENT, { action: 'add', room_id: 'r1', tracks: [tr('t3')], version: vers(2) })
    r.ws.close(); await tick(5)
    const ws2 = FakeWS.made.at(-1)!
    ws2.open(); await tick()
    ws2.reply(Op.BIND, BIND_OK); await tick()
    const s: RoomSnapshot = { participants: [mem('u1'), mem('u2')], me: mem('u1'), tracks: [tr('t2'), tr('t3')], version: vers(5) }
    ws2.reply(Op.RESUME, { snapshot: { r1: s }, publications: [], mline_tables: [] })
    await tick(); await tick()
    ws2.notify(Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    await tick(); await tick(); await tick()
    const paths = via.map((v) => v.replace(/:.*/, ''))
    assert.deepEqual(via, ['snapshot:ROOM.C.JOINING.join_ok', 'delta:TRACK_EVENT', 'snapshot:ROOM.C.JOINED.resume_snapshot', 'snapshot:ROOM.C.JOINED.snapshot'], `K-cond-IMPL-MOD-TABLE-1 — JOIN · EVENT · RESUME · HTTP 가 입구를 하나씩 지난다: ${via.join(' · ')}`)
    assert.ok(paths.every((p) => p === 'snapshot' || p === 'delta'))
    assert.deepEqual([...r.core.rooms.get('r1')!.trk.entries.keys()].sort(), ['t2', 't4'], '마지막 경로(HTTP)의 보관본이 남는다')
  } finally { proto.snapshot = snap; proto.delta = delta; http.restore() }
})

test('K-sym-RULE-MOD-BINDING-VALUES-1 — 인터너: 처음 보는 신원 문자열 하나 = 1 · 같은 문자열 두 번 = 같은 값 · 다른 문자열 = 다른 값 · 0 은 한 번도 안 나온다(세션 · 기동 · ufrag 세대 · 발행 개체 신원)', async () => {
  const i = new Interner()
  const a = i.id('s-1')
  assert.equal(a, 1, 'K-sym-RULE-MOD-BINDING-VALUES-1 — 처음 본 것 = 1')
  assert.equal(i.id('s-1'), a, 'K-sym-RULE-MOD-BINDING-VALUES-1 — 같은 문자열은 같은 값')
  const b = i.id('s-2')
  assert.ok(b !== a, 'K-sym-RULE-MOD-BINDING-VALUES-1 — 다른 문자열은 다른 값')
  const many = ['', '0', 'e1', 'e2', 'ufrag:x', 'sfu-a', ...Array.from({ length: 50 }, (_, k) => `k${k}`)].map((s) => i.id(s))
  assert.ok(![a, b, ...many].includes(0), 'K-sym-RULE-MOD-BINDING-VALUES-1 — 0 은 안 나온다(모형의 「없음」 자리)')
  // 클라이언트가 쥔 인터너 셋(세션 · 기동/세대 · 발행 개체) — 실제 흐름에서도 같은 법
  const r = await rig()
  await join(r, 'r1')
  const media = r.core.media.ids
  const firstMedia = media.id('sfu:sfu-a')
  assert.ok(firstMedia >= 1 && media.id('sfu:sfu-a') === firstMedia && media.id('room:r1') !== firstMedia, 'K-sym-RULE-MOD-BINDING-VALUES-1 — 발행 개체 신원 인터너도 같은 법')
  for (const [name, it] of [['sids', r.core.sids], ['epochs', r.core.epochs]] as const) {
    const v = it.id(name === 'sids' ? 's-1' : 'e1')
    assert.ok(v >= 1 && it.id(name === 'sids' ? 's-1' : 'e1') === v, `K-sym-RULE-MOD-BINDING-VALUES-1 — ${name}: 이미 본 신원은 같은 값(0 아님)`)
  }
  assert.equal(r.core.ses.sid !== 0 && r.core.rooms.get('r1')!.st.cepoch !== 0, true, 'K-sym-RULE-MOD-BINDING-VALUES-1 — 상태기에 들어간 신원 값이 0 이 아니다')
})

test('K-sym-RULE-MOD-BINDING-VALUES-2 — 줄 수는 그대로 · 한 줄의 pt · codec 만 바뀐 배정표는 rows 가 바뀐다 → LINK.C.any.table(SDP 다시 짓기) · 실린 track_id 만 바뀐 표는 rows 그대로(다시 짓기 0)', async () => {
  const r = await rig()
  await join(r, 'r1', { tracks: [tr('t2'), tr('t3')], mlines: [row('0', 't2')] })
  const link = r.core.links.get('sfu-a')!
  const peer = r.peers.get('sfu-a')!
  const rows0 = link.st.rows
  assert.equal(rows0, TableStore.materials([row('0', 't2')]))
  const linkLabels = (): string[] => r.trace.filter((t) => t.layer === 'LINK').map((t) => t.label)
  // pt · codec 만 바뀐다(줄 수 1 그대로)
  let n = linkLabels().length
  const asm = peer.assembled
  await note(r, Op.MLINE_EVENT, { table: { sfu_id: 'sfu-a', arev: 2, mlines: [row('0', 't2', { pt: 98, codec: 'VP8' })] } })
  await drain(r)
  assert.notEqual(link.st.rows, rows0, 'K-sym-RULE-MOD-BINDING-VALUES-2 — pt · codec 만 바뀐 표: rows 가 바뀐다(줄 수가 아니다)')
  assert.ok(linkLabels().slice(n).includes('LINK.C.any.table'), `K-sym-RULE-MOD-BINDING-VALUES-2 — 연결 상태기가 LINK.C.any.table: ${linkLabels().slice(n).join(' · ')}`)
  assert.ok(peer.assembled > asm, 'K-sym-RULE-MOD-BINDING-VALUES-2 — SDP 를 다시 짓는다')
  // 실린 track_id 만 바뀐다
  const rows1 = link.st.rows
  n = linkLabels().length
  const asm2 = peer.assembled
  await note(r, Op.MLINE_EVENT, { table: { sfu_id: 'sfu-a', arev: 3, mlines: [row('0', 't3', { pt: 98, codec: 'VP8' })] } })
  await drain(r)
  assert.equal(link.st.rows, rows1, 'K-sym-RULE-MOD-BINDING-VALUES-2 — 실린 트랙만 바뀐 표: rows 그대로')
  assert.ok(!linkLabels().slice(n).includes('LINK.C.any.table') && peer.assembled === asm2, `K-sym-RULE-MOD-BINDING-VALUES-2 — 다시 짓기 0: ${linkLabels().slice(n).join(' · ')}`)
})
