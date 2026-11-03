// author: kodeholic (powered by Claude)
// SDK:RULE-API-HANDLES · SDK:IMPL-API-EVENT-MAP — 앱 표면(API — 가로지르는 것) 1층. 핸들 넷의 수명 · 효과 표 밖의 앱 이벤트를 단위(SD-HANDLE-* · SD-EVENT-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트 · 가짜 PeerLink(test/_rig — 받는 쪽 · test/_pub — 발행) · 가짜 navigator(test/_pub).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWS, tick } from './_ws.js'
import { SA, SB, up, linkOf, enter, joinBody, joinFrame, leaveFrame, note, vers, mem, httpMock, getRoom, fakeTrack, BIND_OK, type Rig, type JB, type FakeTrack } from './_rig.js'
import { nav, dev, ft, pubUp, mic, halfMic, grant, settlePublish, answerLast, pubReqs, live, type FT } from './_pub.js'
import { Op, type TrackEntry, type MlineEntry, type ServerConfig, type RoomSnapshot } from '../src/internal/wire/ws.js'
import * as SDK from '../src/index.js'
import { createClient, type Room } from '../src/index.js'

const tr = (id: string, o: Partial<TrackEntry> = {}): TrackEntry => ({ type: 'individual', room_id: 'r1', track_id: id, kind: 'video', user_id: 'u2', ...o })
const row = (mid: string, track_id: string | undefined, kind: 'audio' | 'video' = 'video', room_id = 'r1'): MlineEntry => ({
  mid, kind, pt: kind === 'audio' ? 111 : 102, codec: kind === 'audio' ? 'opus' : 'H264', ssrc: 2147480000 + Number(mid), stream_id: `ox-m${mid}`,
  ...(track_id ? { track_id, room_id } : {}),
})

/** 그 서버 PeerLink 의 줄 mid 에 수신 트랜시버를 놓는다 */
function rx(r: Rig, mid: string, kind = 'video', sc: ServerConfig = SA): FakeTrack {
  linkOf(r, sc)
  const t = fakeTrack(kind)
  r.peers.get(sc.sfu_id)!.rx.set(mid, { track: t, getStats: async () => new Map() })
  return t
}

/** 표에 실린 줄마다 트랜시버를 놓고 들어간다 */
async function join(r: Rig, id: string, o: JB = {}): Promise<Room> {
  for (const m of o.mlines ?? []) if (m.track_id) rx(r, m.mid, m.kind, o.sc ?? SA)
  return enter(r, id, o)
}

/** 단언이 깨져도 클라이언트를 닫는다(test/_pub 의 afterEach) — 남은 타이머가 시험 프로세스를 붙잡지 않게 */
async function rig(): Promise<Rig> { const r = await up(); live.push(r); return r }

const trackEvent = (action: 'add' | 'remove', tracks: TrackEntry[], seq: number, room = 'r1') => ({ action, room_id: room, tracks, version: vers(seq) })

/** 클라이언트 표면 · 방 표면의 앱 이벤트 전량을 듣는다 — 「앱 이벤트 0」을 잰다 */
function appEvents(r: Rig, rooms: Room[]): string[] {
  const seen: string[] = []
  for (const n of ['session', 'tokenRequired', 'closed', 'rebuilt', 'link', 'speakingRoom', 'speakingRoomFailed', 'track', 'audioPlayback'] as const) r.c.on(n as 'rebuilt', () => seen.push(`client.${n}`))
  for (const h of rooms) {
    for (const n of ['track', 'trackUnreachable', 'participants', 'permission', 'message', 'error', 'joinFailed', 'forced', 'joined', 'left', 'resync', 'state'] as const) h.on(n as 'joined', () => seen.push(`${h.id}.${n}`))
  }
  return seen
}

// ══ 핸들 넷 — 누가 만들고 누가 닫나(SDK:RULE-API-HANDLES) ═══════════════════════════════════════════

test('SD-HANDLE-OX-LENS-CLIENT — 생성 경로는 createClient 하나(공개 배럴에 다른 생성 길 0) · close() 뒤 전 핸들이 닫힌다(세션 · 방 · 발행 · 받는 트랙) · LEAVE 하나(ROOM_LEAVE 0)', async () => {
  const values = Object.entries(SDK).filter(([, v]) => typeof v === 'function')
  const fns = values.filter(([, v]) => !/^class\b/.test(Function.prototype.toString.call(v))).map(([k]) => k)
  assert.deepEqual(fns, ['createClient'], 'SD-HANDLE-OX-LENS-CLIENT — 공개 배럴의 함수는 createClient 하나')
  assert.equal('OxLensClient' in SDK, false, 'SD-HANDLE-OX-LENS-CLIENT — OxLensClient 는 형만(new 로 만드는 둘째 길 0)')
  const x = await pubUp()
  const t = await mic(x)
  const tracks: TrackEntry[] = [tr('t9', { room_id: 'rb' })]
  const hb = await join(x.r, 'rb', { sc: SB, tracks, mlines: [row('0', 't9', 'video', 'rb')] })
  const remote = hb.tracks[0]!
  let remoteEnded = 0
  remote.on('ended', () => { remoteEnded += 1 })
  const ended: unknown[] = []
  t.on('ended', (e) => ended.push(e))
  const leaves = x.r.ws.requests(Op.ROOM_LEAVE).length
  await x.r.c.close()
  await tick()
  assert.deepEqual([x.r.c.session.state, x.room.state, hb.state, x.r.c.rooms.size], ['disconnected', 'closed', 'closed', 0], 'SD-HANDLE-OX-LENS-CLIENT — close 뒤 세션 · 방 핸들 closed · rooms 비움')
  assert.deepEqual([t.state, ended, remoteEnded], ['idle', [{ reason: 'stopped' }], 1], 'SD-HANDLE-OX-LENS-CLIENT — close 뒤 SDK 발행 트랙 idle · 받는 트랙 ended')
  assert.deepEqual([x.r.ws.requests(Op.LEAVE).length, x.r.ws.requests(Op.ROOM_LEAVE).length - leaves], [1, 0], 'SD-HANDLE-OX-LENS-CLIENT — LEAVE 1 · ROOM_LEAVE 0')
})

test('SD-HANDLE-ROOM — join 응답이 Room 을 만든다 · state 전이 넷(joining · joined · leaving · closed) · leave/kick 이 닫으면 client.rooms 에서 빠진다 · 다시 join 하면 새 핸들', async () => {
  const r = await rig()
  const p = r.c.join('r1')
  await tick()
  const states: string[] = [r.core.rooms.get('r1')!.state]
  r.core.rooms.get('r1')!.events.on('state', (s) => states.push(s))
  assert.equal(r.c.rooms.has('r1'), true, 'joining 동안도 rooms 에 있다')
  linkOf(r, SA)
  r.ws.answer(joinFrame(r.ws, 'r1'), joinBody(r, 'r1'))
  await tick()
  for (let i = 0; i < 4; i++) { r.peers.get('sfu-a')!.settle(); await tick() }
  const h1 = await p
  assert.deepEqual([h1.state, r.c.rooms.get('r1')], ['joined', h1], 'SD-HANDLE-ROOM — join 응답의 핸들 · rooms 반영')
  const l = h1.leave()
  await tick()
  r.ws.answer(leaveFrame(r.ws, 'r1'), {})
  await l
  assert.deepEqual(states, ['joining', 'joined', 'leaving', 'closed'], 'SD-HANDLE-ROOM — state 전이 넷')
  assert.equal(r.c.rooms.has('r1'), false, 'SD-HANDLE-ROOM — leave 로 닫히면 rooms 에서 빠진다')
  const h2 = await enter(r, 'r2')
  const h2States: string[] = []
  h2.on('state', (s) => h2States.push(s))
  await note(r, Op.ROOM_EVENT, { type: 'affiliation', room_id: 'r2', affiliation: { sub_rooms: [], pub_room: null }, cause: 'kick' })
  assert.deepEqual([h2.state, h2States, r.c.rooms.has('r2')], ['closed', ['closed'], false], 'SD-HANDLE-ROOM — 서버 강제(kick)도 closed · rooms 에서 빠진다')
  const h1b = await enter(r, 'r1')
  assert.ok(h1b !== h1 && r.c.rooms.get('r1') === h1b, 'SD-HANDLE-ROOM — 닫힌 뒤 다시 join 하면 새 핸들')
  await r.c.close()
})

test('SD-HANDLE-LOCAL-TRACK — enable 이 만든 트랙은 client.media 가 소유한다(media.tracks) · stop 이 끝내면 빠진다 · 반이중 트랙은 ptt 경유(media 의 길은 전이중만)', async () => {
  const x = await pubUp()
  const t = await mic(x)
  assert.deepEqual([x.r.c.media.tracks.includes(t), t.duplex, t.owner], [true, 'full', 'sdk'], 'SD-HANDLE-LOCAL-TRACK — enable 트랙은 media.tracks 에(소유 = media)')
  const s = t.stop(); await tick(); answerLast(x, Op.PUBLISH_TRACKS); await s
  assert.deepEqual([x.r.c.media.tracks.includes(t), t.state], [false, 'idle'], 'SD-HANDLE-LOCAL-TRACK — stop 이 끝내면 media.tracks 에서 빠진다')
  const [a] = await x.r.c.media.acquire({ microphone: true })
  const p = x.r.c.media.publish(a!)
  await settlePublish(x, 't-pub'); await p
  assert.equal(a!.duplex, 'full', 'SD-HANDLE-LOCAL-TRACK — media.publish 는 전이중(반이중 칸이 없다)')
  await halfMic(x)
  const half = x.r.c.media.tracks.filter((y) => y.duplex === 'half')
  assert.equal(half.length, 1, 'SD-HANDLE-LOCAL-TRACK — 반이중 마이크는 room.ptt.enable 경유로 만들어지고 소유는 같은 media')
  assert.equal(pubReqs(x, 'add').at(-1)!.tracks![0]!['duplex'], 'half')
})

test('SD-HANDLE-REMOTE-TRACK — 네 경로(입장 응답 · 트랙 통지 add · 이어받기 스냅샷 · 재동기 HTTP)가 같은 보관본 하나에 든다 · 같은 줄(mid)의 같은 트랙은 같은 핸들', async () => {
  const http = httpMock(() => ({ status: 200, body: getRoom('r1', 9, [], 'e1', [tr('t2', { muted: true })]) }))
  try {
    const r = await rig()
    const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
    const trk = r.core.rooms.get('r1')!.trk
    const store = trk.entries
    const paths: string[] = []
    const snap = trk.snapshot.bind(trk)
    const delta = trk.delta.bind(trk)
    trk.snapshot = (l, c) => { paths.push(`snapshot:${c}`); snap(l, c) }
    trk.delta = (op, b) => { paths.push(`delta:${op}`); delta(op, b) }
    const H = h.tracks[0]!
    assert.equal(H.id, 't2', 'JOIN 경로의 핸들')
    // add — 같은 트랙의 항목 교체
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t2', { scalability: 'L1T3' })], 2))
    assert.ok(h.tracks[0] === H && store.get('t2')?.scalability === 'L1T3', 'SD-HANDLE-REMOTE-TRACK — add 경로: 같은 보관본 · 같은 핸들')
    // RESUME — 이어받기 스냅샷
    r.ws.close(); await tick(5)
    const ws2 = FakeWS.made.at(-1)!
    ws2.open(); await tick()
    ws2.reply(Op.BIND, BIND_OK); await tick()
    const s: RoomSnapshot = { participants: [mem('u1'), mem('u2')], me: mem('u1'), tracks: [tr('t2', { scalability: 'L1T2' })], version: vers(5) }
    ws2.reply(Op.RESUME, { snapshot: { r1: s }, publications: [], mline_tables: [] })
    await tick(); await tick()
    assert.ok(h.tracks[0] === H && store.get('t2')?.scalability === 'L1T2', 'SD-HANDLE-REMOTE-TRACK — RESUME 경로: 같은 보관본 · 같은 핸들')
    // HTTP — 재동기
    ws2.notify(Op.ROOM_EVENT, { type: 'sync_required', room_id: 'r1', reason: 'x' })
    await tick(); await tick(); await tick()
    assert.ok(h.tracks[0] === H && store.get('t2')?.muted === true, 'SD-HANDLE-REMOTE-TRACK — HTTP 경로: 같은 보관본 · 같은 핸들')
    assert.ok(trk.entries === store && r.core.rooms.get('r1')!.trk === trk, 'SD-HANDLE-REMOTE-TRACK — 보관본은 처음부터 끝까지 한 자료(교체 0)')
    assert.deepEqual(paths, ['delta:TRACK_EVENT', 'snapshot:ROOM.C.JOINED.resume_snapshot', 'snapshot:ROOM.C.JOINED.snapshot'], 'SD-HANDLE-REMOTE-TRACK — add · RESUME · HTTP 가 그 방 보관본의 입구(delta · snapshot)를 지난다')
    assert.equal(h.tracks.length, 1)
    await r.c.close()
  } finally { http.restore() }
})

// ══ 효과 표 밖의 앱 이벤트(SDK:IMPL-API-EVENT-MAP) ═══════════════════════════════════════════════

test('SD-EVENT-RESYNC — 갭 뒤 재동기를 반영한 뒤에 resync 하나 · 그동안 그 방 이벤트는 멈춘다', async () => {
  let answer: ((v: { status: number; body: unknown }) => void) | null = null
  const http = httpMock(() => new Promise((res) => { answer = res }))
  try {
    const r = await rig()
    const h = await enter(r, 'r1', { seq: 1 })
    const ev: string[] = []
    h.on('participants', (l) => ev.push(`participants:${l.map((p) => p.userId).join(',')}`))
    h.on('resync', () => ev.push(`resync:${h.participants.map((p) => p.userId).join(',')}`))
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u3', select: false, participant_type: 0, version: vers(3) })
    assert.equal(http.calls.length, 1, '갭(1 → 3)이 재동기를 연다')
    await note(r, Op.PARTICIPANT_EVENT, { type: 'joined', room_id: 'r1', user_id: 'u4', select: false, participant_type: 0, version: vers(4) })
    await note(r, Op.TRACK_EVENT, trackEvent('add', [tr('t4', { user_id: 'u4' })], 5))
    assert.deepEqual(ev, [], 'SD-EVENT-RESYNC — 재동기 동안 그 방 이벤트 0')
    answer!({ status: 200, body: getRoom('r1', 6, [mem('u3'), mem('u4')]) })
    await tick(); await tick()
    assert.deepEqual(ev, ['participants:u1,u3,u4', 'resync:u1,u3,u4'], 'SD-EVENT-RESYNC — 반영(명단) 뒤 resync 하나')
    await r.c.close()
  } finally { http.restore() }
})

test('SD-EVENT-MESSAGE — 방 문자 통지는 그 방 핸들의 message 하나({ userId, content }) · 다른 방 0', async () => {
  const r = await rig()
  const h1 = await enter(r, 'r1')
  const h2 = await enter(r, 'r2')
  const m1: unknown[] = []
  const m2: unknown[] = []
  h1.on('message', (m) => m1.push(m))
  h2.on('message', (m) => m2.push(m))
  await note(r, Op.MESSAGE, { room_id: 'r1', user_id: 'u2', content: 'hello', msg_id: 'm-1' })
  assert.deepEqual([m1, m2], [[{ userId: 'u2', content: 'hello' }], []], 'SD-EVENT-MESSAGE — message 1 · 그 방만')
  await r.c.close()
})

test('SD-EVENT-DIAGNOSTICS-PROBE — 진단 과제 probe 는 앱 이벤트 0(진단 표면 diagnostics.probe 만) · report 송신 1(같은 req_id)', async () => {
  const r = await rig()
  const h = await enter(r, 'r1')
  const app = appEvents(r, [h])
  const probes: unknown[] = []
  r.c.diagnostics.on('probe', (p) => probes.push(p))
  await note(r, Op.TASK, { phase: 'request', req_id: 41, type: 'probe' })
  await tick(); await tick()
  const reports = r.ws.requests(Op.TASK).map((f) => f.body as { phase: string; req_id: number; type: string })
  assert.deepEqual(app, [], 'SD-EVENT-DIAGNOSTICS-PROBE — 앱 이벤트 0')
  assert.deepEqual(reports.map((b) => [b.phase, b.req_id, b.type]), [['report', 41, 'probe']], 'SD-EVENT-DIAGNOSTICS-PROBE — report 송신 1')
  assert.equal(probes.length, 1, '진단 표면(diagnostics.probe)에는 하나')
  await r.c.close()
})

test('SD-EVENT-RECEIVING — 첫 디코딩 프레임(로컬 관측)에 receiving 하나 · 다시 0 · wire 0', async () => {
  const r = await rig()
  const h = await join(r, 'r1', { tracks: [tr('t2')], mlines: [row('0', 't2')] })
  const t = h.tracks[0]!
  let n = 0
  t.on('receiving', () => { n += 1 })
  const sent = r.ws.sent.length
  ;(t.mediaStreamTrack as unknown as FakeTrack).unmute()
  ;(t.mediaStreamTrack as unknown as FakeTrack).unmute()
  await tick()
  assert.deepEqual([n, t.receiving], [1, true], 'SD-EVENT-RECEIVING — receiving 1')
  assert.equal(r.ws.sent.length, sent, 'SD-EVENT-RECEIVING — wire 0')
  await r.c.close()
})

test('SD-EVENT-AUDIO-PLAYBACK — autoplay 가 막히면 audioPlayback(false) · startAudio 로 풀리면 audioPlayback(true) · media.audio.playbackAllowed 가 같은 값', async () => {
  const c = createClient({ base: 'https://hub.example', token: 'tok' })
  const seen: boolean[] = []
  c.on('audioPlayback', (ok) => seen.push(ok))
  let blocked = true
  const el = { play: () => (blocked ? Promise.reject(Object.assign(new Error('autoplay'), { name: 'NotAllowedError' })) : Promise.resolve()), pause: () => undefined, remove: () => undefined, isConnected: true } as unknown as HTMLAudioElement
  const pb = c.core.rooms.playback
  pb.add(el)
  pb.play(el)
  await tick()
  assert.deepEqual([seen, c.media.audio.playbackAllowed], [[false], false], 'SD-EVENT-AUDIO-PLAYBACK — 막힘: audioPlayback(false)')
  blocked = false
  await c.media.startAudio()
  assert.deepEqual([seen, c.media.audio.playbackAllowed], [[false, true], true], 'SD-EVENT-AUDIO-PLAYBACK — 풀림: audioPlayback(true)')
  await c.close()
})

test('SD-EVENT-LOCAL-TRACK-SILENCE — 발행 직후 완전 무음이면 silence 하나(창이 더 지나도 하나)', async () => {
  const x = await pubUp()
  const t = await mic(x)
  let n = 0
  t.on('silence', () => { n += 1 })
  await tick(80)
  assert.equal(n, 1, 'SD-EVENT-LOCAL-TRACK-SILENCE — silence 1')
})

test('SD-EVENT-MEDIA-DEVICES-CHANGE — 장치 핫플러그는 media.devices 의 change{ added, removed, list } 하나씩', async () => {
  const x = await pubUp()
  await tick()
  const seen: { added: string[]; removed: string[]; list: string[] }[] = []
  x.r.c.media.devices.on('change', (c) => seen.push({ added: c.added.map((d) => d.deviceId), removed: c.removed.map((d) => d.deviceId), list: c.list.map((d) => d.deviceId) }))
  nav.devices = [...nav.devices, dev('audioinput', 'mic-3')]; nav.fire(); await tick(5)
  nav.devices = nav.devices.filter((d) => d.deviceId !== 'mic-2'); nav.fire(); await tick(5)
  assert.deepEqual(seen, [
    { added: ['mic-3'], removed: [], list: ['mic-1', 'mic-2', 'cam-1', 'mic-3'] },
    { added: [], removed: ['mic-2'], list: ['mic-1', 'cam-1', 'mic-3'] },
  ], 'SD-EVENT-MEDIA-DEVICES-CHANGE — change{added,removed,list} 1 씩(늘어난 것 · 줄어든 것 · 전량)')
})

test('SD-EVENT-LOCAL-TRACK-ENDED — 장치 상실 · 대체 없음이면 ended{device_lost}(발행을 푼다 · idle) · 반이중이면 ptt.state.phase off', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const h = await halfMic(x)
  const ended: unknown[] = []
  t.on('ended', (e) => ended.push(e))
  const hEnded: unknown[] = []
  h.events.on('ended', (e) => hEnded.push(e))
  nav.devices = nav.devices.filter((d) => d.kind !== 'audioinput')
  ;(t.mediaStreamTrack as unknown as FT).fire('ended'); await tick(5)
  answerLast(x, Op.PUBLISH_TRACKS); await tick(5)
  assert.deepEqual([ended, t.state], [[{ reason: 'device_lost' }], 'idle'], 'SD-EVENT-LOCAL-TRACK-ENDED — 전이중: ended{device_lost} · idle')
  assert.ok(pubReqs(x, 'remove').some((b) => b.track_ids?.includes('t-mic')), '발행을 푼다(remove)')
  ;(h.mediaStreamTrack as unknown as FT).fire('ended'); await tick(5)
  answerLast(x, Op.PUBLISH_TRACKS); await tick(5)
  assert.deepEqual([hEnded, h.state, x.room.ptt.state.phase], [[{ reason: 'device_lost' }], 'idle', 'off'], 'SD-EVENT-LOCAL-TRACK-ENDED — 반이중: ended{device_lost} · ptt.state.phase off')
})

test('SD-EVENT-LOCAL-TRACK-STATE — 발행 단 · 소유권 변화(publish · 게이트 · cold · setDuplex · replaceSource)는 이벤트 0 · 속성 state · owner 만 갱신', async () => {
  const x = await pubUp()
  x.r.core.media.coldAfter = 15
  const [a] = await x.r.c.media.acquire({ microphone: true })
  const core = a!.core
  const emitted: string[] = []
  const emit = core.events.emit.bind(core.events)
  core.events.emit = ((n: string, ...rest: never[]) => { emitted.push(n); emit(n as never, ...rest) }) as typeof core.events.emit
  const seen: string[] = [`${a!.state}/${a!.owner}`]
  const look = (): void => { seen.push(`${a!.state}/${a!.owner}`) }
  const p = x.r.c.media.publish(a!)
  await settlePublish(x, 't-a'); await p
  look()
  await a!.replaceSource(ft('audio', 'proc')); look()
  await a!.replaceSource(null); look()
  const d = a!.setDuplex('half'); await tick(); answerLast(x, Op.TRACK_SET); await d
  look()
  grant(x); await tick(); look()
  await x.room.core.floor.release(); x.room.core.floor.receive({ t: 'ACK', of: 4 } as never); await tick(40); look()   // 놓음 끝은 서버 ACK(연:DEV-FLR-RELEASE-ACK) — 놓는 중(pending_release)엔 반납하지 않는다
  assert.deepEqual(seen, ['acquired/app', 'sending/sdk', 'sending/external', 'sending/sdk', 'registered/sdk', 'sending/sdk', 'registered/sdk'], 'SD-EVENT-LOCAL-TRACK-STATE — 속성 state · owner 갱신')
  assert.equal(core.cold, true, 'cold 에 들어갔다(state 는 registered 그대로)')
  assert.deepEqual(emitted.filter((n) => n !== 'published' && n !== 'silence'), [], `SD-EVENT-LOCAL-TRACK-STATE — 이벤트 0(발행 결과 published · 무음 판정 silence 밖): ${emitted.join(' · ')}`)
})
