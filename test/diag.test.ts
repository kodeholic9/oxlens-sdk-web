// author: kodeholic (powered by Claude)
// SDK:IMPL-DIAG-PROBE · 연:RULE-AUX-PROBE-NO-INVENT — 진단(DIAG — 가로지르는 것 · domain/diag) 1층. probe result 칸마다 「없으면 뺀다 · 늘 싣는다 · 실패면 그것만」을 단위(SD-FIELD-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트 · 가짜 PeerLink(test/_rig — getStats 는 시험이 고른다) · 가짜 navigator(이 파일 — 있고 없음을 시험이 고른다).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SA, up, linkOf, enter, fakeTrack, type Rig } from './_rig.js'
import { Op, type TrackEntry, type MlineEntry } from '../src/internal/wire/ws.js'
import { tick } from './_ws.js'

// ══ 가짜 navigator — 시험마다 있음 · 없음 · 던짐을 고른다 ═══════════════════════════════════════════

let navNow: unknown = undefined
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => navNow })
function navWith(o: { devices?: MediaDeviceInfo[] | 'throw' | 'none'; perm?: string } = {}): void {
  const md = o.devices === 'none' ? undefined : {
    enumerateDevices: async () => { if (o.devices === 'throw') throw new Error('enumerate 실패'); return o.devices ?? [] },
    addEventListener: () => undefined, removeEventListener: () => undefined, getUserMedia: async () => { throw new Error('없다') },
  }
  navNow = { userAgent: 'TestAgent/1.0', platform: 'TestOS', language: 'ko-KR', onLine: true, ...(md ? { mediaDevices: md } : {}), permissions: { query: async () => ({ state: o.perm ?? 'granted' }) } }
}
const devInfo = (kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo => ({ kind, deviceId, label: deviceId, groupId: `g-${deviceId}`, toJSON: () => ({}) }) as MediaDeviceInfo

const rigs: Rig[] = []
afterEach(async () => { navNow = undefined; for (const r of rigs.splice(0)) await r.c.close().catch(() => undefined) })
async function rig(): Promise<Rig> { const r = await up({ statsIntervalMs: 0 }); rigs.push(r); return r }

/** getStats 한 판 — RTCStatsReport 꼴(Map) */
const report = (...rows: Record<string, unknown>[]): RTCStatsReport => new Map(rows.map((x) => [String(x['id']), x])) as unknown as RTCStatsReport
const OUT = { id: 'o1', type: 'outbound-rtp', kind: 'audio', ssrc: 11, mid: '0', packetsSent: 10, bytesSent: 900 }
const IN = { id: 'i1', type: 'inbound-rtp', kind: 'video', ssrc: 21, mid: '0', packetsReceived: 50, packetsLost: 1, jitter: 0.01, framesDecoded: 30 }
const PAIR = [{ id: 'tp', type: 'transport', selectedCandidatePairId: 'cp' }, { id: 'cp', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.02, availableOutgoingBitrate: 900000 }]

const noNull = (v: unknown): boolean => v !== null && (typeof v !== 'object' || Object.values(v as object).every(noNull))

/** 방 하나 · 그 서버 PeerLink 의 getStats 를 고른다 · 줄 0 에 받는 트랙 t2 */
async function joined(stats: () => Promise<RTCStatsReport[]>): Promise<Rig> {
  const r = await rig()
  linkOf(r, SA)
  r.peers.get('sfu-a')!.rx.set('0', { track: fakeTrack('video'), getStats: async () => new Map() })
  const tr: TrackEntry = { type: 'individual', room_id: 'r1', track_id: 't2', kind: 'video', user_id: 'u2', scalability: 'L3T3' }
  const row: MlineEntry = { mid: '0', kind: 'video', pt: 102, codec: 'H264', ssrc: 2147480000, stream_id: 'ox-m0', track_id: 't2', room_id: 'r1' }
  await enter(r, 'r1', { tracks: [tr], mlines: [row] })
  ;(r.peers.get('sfu-a') as unknown as { stats: () => Promise<RTCStatsReport[]> }).stats = stats
  return r
}

test('SD-FIELD-PUB-TRACKS — 보내는 트랙 통계를 못 모으면 pub_tracks 칸이 없다(null · 빈 목록 0) · 모으면 값 그대로(null 0)', async () => {
  navWith()
  const r = await joined(async () => [report(IN)])
  const a = await r.c.diagnostics.probe() as Record<string, unknown>
  assert.equal('pub_tracks' in a, false, 'SD-FIELD-PUB-TRACKS — 못 모으면 칸 부재')
  ;(r.peers.get('sfu-a') as unknown as { stats: () => Promise<RTCStatsReport[]> }).stats = async () => [report(OUT, IN)]
  const b = await r.c.diagnostics.probe() as { pub_tracks?: Record<string, unknown>[] }
  assert.deepEqual(b.pub_tracks, [{ ssrc: 11, kind: 'audio', mid: '0', packetsSent: 10, bytesSent: 900 }], 'SD-FIELD-PUB-TRACKS — 모은 값 그대로')
  assert.ok(noNull(b.pub_tracks), 'SD-FIELD-PUB-TRACKS — null 0')
})

test('SD-FIELD-SUB-TRACKS — 받는 트랙마다 track_id · spatial/temporal/paused 는 마지막 요청값(요청한 적 없으면 칸 없음 — 지어내지 않는다)', async () => {
  navWith()
  const r = await joined(async () => [report(IN)])
  const a = await r.c.diagnostics.probe() as { sub_tracks?: Record<string, unknown>[] }
  assert.deepEqual(a.sub_tracks?.map((x) => [x['track_id'], 'spatial' in x, 'temporal' in x, 'paused' in x]), [['t2', false, false, false]], 'SD-FIELD-SUB-TRACKS — 요청 전엔 상한 칸 없음')
  const t = r.c.rooms.get('r1')!.tracks[0]!
  for (const v of [{ spatial: 2, temporal: 1 }, { paused: true }, { temporal: 0 }]) {
    const p = t.setLayer(v)
    await tick()
    r.ws.answer(r.ws.last(Op.SUBSCRIBE_LAYER), {})
    await p
  }
  const b = await r.c.diagnostics.probe() as { sub_tracks?: Record<string, unknown>[] }
  const s = b.sub_tracks![0]!
  assert.deepEqual([s['track_id'], s['spatial'], s['temporal'], s['paused'], s['packetsReceived']], ['t2', 2, 0, true, 50], 'SD-FIELD-SUB-TRACKS — 마지막 요청값(칸마다 마지막으로 요청한 값) · 수신 통계 그대로')
})

test('SD-FIELD-ENV — env 는 부재 허용(환경을 모르면 칸이 없다 · null 로 채우지 않는다) · 알면 아는 칸만', async () => {
  const r = await rig()
  navNow = undefined
  const a = await r.c.diagnostics.probe() as Record<string, unknown>
  assert.deepEqual(['env' in a, 'error' in a], [false, false], 'SD-FIELD-ENV — 모르면 칸 부재(실패 아님)')
  navWith()
  const b = await r.c.diagnostics.probe() as { env?: Record<string, unknown> }
  assert.ok(b.env && b.env['ua'] === 'TestAgent/1.0' && noNull(b.env), 'SD-FIELD-ENV — 알면 아는 칸만(null 0)')
})

test('SD-FIELD-DEVICES — devices 는 부재 허용(장치 API 가 없거나 던지면 칸이 없다 — 빈 목록으로 「장치 0」을 지어내지 않는다)', async () => {
  const r = await rig()
  navWith({ devices: 'none' })
  const a = await r.c.diagnostics.probe() as Record<string, unknown>
  assert.deepEqual(['devices' in a, 'error' in a], [false, false], 'SD-FIELD-DEVICES — 장치 API 없음: 칸 부재')
  navWith({ devices: 'throw' })
  const b = await r.c.diagnostics.probe() as Record<string, unknown>
  assert.deepEqual(['devices' in b, 'error' in b], [false, false], 'SD-FIELD-DEVICES — 목록이 던짐: 칸 부재')
  navWith({ devices: [devInfo('audioinput', 'mic-1'), devInfo('videoinput', 'cam-1')] })
  const c = await r.c.diagnostics.probe() as { devices?: unknown[] }
  assert.deepEqual(c.devices, [{ kind: 'audioinput', label: 'mic-1', groupId: 'g-mic-1' }, { kind: 'videoinput', label: 'cam-1', groupId: 'g-cam-1' }], '모으면 목록')
})

test('SD-FIELD-STATE — state 는 항상 존재(연결 전 · 방 없음 · 방과 연결이 있을 때 모두)', async () => {
  const r = await rig()
  const a = await r.c.diagnostics.probe() as { state?: { session: string; rooms: unknown[] } }
  assert.deepEqual([a.state?.session, a.state?.rooms], ['active', []], 'SD-FIELD-STATE — 방 없음에도 존재')
  await enter(r, 'r1')
  const b = await r.c.diagnostics.probe() as { state?: { rooms: { room_id: string }[]; links: unknown[] } }
  assert.deepEqual([b.state?.rooms.map((x) => x.room_id), b.state?.links.length], [['r1'], 1], 'SD-FIELD-STATE — 방 · 연결이 있을 때도 존재')
  await r.c.close()
  const c = await r.c.diagnostics.probe() as { state?: { session: string } }
  assert.equal(c.state?.session, 'disconnected', 'SD-FIELD-STATE — 끊긴 뒤에도 존재')
})

test('SD-FIELD-NETWORK — network 는 부재 허용(통계가 없으면 칸이 없다) · 있으면 ICE 후보 쌍의 RTT · 대역', async () => {
  const r = await rig()
  const a = await r.c.diagnostics.probe() as Record<string, unknown>
  assert.deepEqual(['network' in a, 'error' in a], [false, false], 'SD-FIELD-NETWORK — 통계 없음: 칸 부재')
  const s = await joined(async () => [report(IN, ...PAIR)])
  const b = await s.c.diagnostics.probe() as { network?: { rttMs: number; outgoingBps: number } }
  assert.deepEqual([b.network?.rttMs, b.network?.outgoingBps], [20, 900000], '있으면 network')
})

test('SD-FIELD-ERROR — 수집 자체가 던지면 error 만(반쯤 모은 칸 · state 를 섞지 않는다)', async () => {
  navWith({ devices: [devInfo('audioinput', 'mic-1')] })
  const r = await joined(async () => { throw new Error('getStats 가 깨졌다') })
  const a = await r.c.diagnostics.probe() as Record<string, unknown>
  assert.deepEqual(Object.keys(a), ['error'], 'SD-FIELD-ERROR — error 하나만')
  assert.match(String(a['error']), /getStats 가 깨졌다/)
  const reports: unknown[] = []
  r.c.diagnostics.on('probe', (p) => reports.push(p))
  r.ws.notify(Op.TASK, { phase: 'request', req_id: 3, type: 'probe' })
  await tick(); await tick()
  const sent = r.ws.requests(Op.TASK).at(-1)!.body as { result: Record<string, unknown> }
  assert.deepEqual(Object.keys(sent.result), ['error'], 'SD-FIELD-ERROR — report 에도 error 만')
})
