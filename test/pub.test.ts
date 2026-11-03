// author: kodeholic (powered by Claude)
// SDK:IMPL-PUB-API · SDK:RULE-PUB-DUPLEX-SWITCH · SDK:IMPL-SRC-BLOCKS · SDK:RULE-SRC-DEVICES — 발행(PUB) 영역 1층. 위가 지은 발행 클라 상태기 둘레의 손 결합(입구 표 · 효과 표 · 이음매 · 소유권 · 손잡이)을 잰다.
// ★입구는 위 결합(pub_binding)의 ENTRY 를 지나는지 · 효과는 결합 plan() 이 낸 대로 SDK 가 하는지를 PUB 단위(SD-ENTRY-PUB-* · SD-EFFECT-PUB-* · SD-API-* · SD-OWNER-*)마다 · SRC 손잡이(SD-KNOB-*)는 발행이 쥔 것만 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 진짜 클라이언트 · 진짜 연결 상태기(LinkCore) 위에 가짜 발행 PeerLink(이 파일) · 가짜 navigator.mediaDevices(이 파일 — platform/env 가 부르는 전역).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FakeWS, tick } from './_ws.js'
import { decodeFrame } from '../src/internal/ses/signaling.js'
import { SA, SB, enter, drain, leaveFrame, note, vers, mem, BIND_OK, FAIL } from './_rig.js'
import * as PUB from '../src/domain/gen/publish_client.js'
import * as PBn from '../src/domain/gen/pub_binding.js'
import * as PB from '../src/domain/gen/ptt_binding.js'
import { Op, type TrackEntry } from '../src/internal/wire/ws.js'
import { createClient, OxLensError } from '../src/index.js'
import type { LocalCore } from '../src/domain/pub/local.js'
import { ft, nav, dev, pubUp, answerAdd, answerLast, pubReqs, settlePublish, mic, halfMic, grant, ungrant, wire, type FT, type Gum, type FakeSender, type X, type PubPeer } from './_pub.js'

// ══ 위 결합 ENTRY 를 지나는가 — 입구마다 부른 횟수 · 인자 · 걸음 ═══════════════════════════════════

function spyOn(): { calls: Record<string, unknown[][]>; steps: Record<string, (PUB.Step | null)[]>; n(k: string): number; reset(): void; restore(): void } {
  const E = PBn.ENTRY as unknown as Record<string, (...a: unknown[]) => PUB.Step | null>
  const saved = { ...E }
  const calls: Record<string, unknown[][]> = {}
  const steps: Record<string, (PUB.Step | null)[]> = {}
  const reset = (): void => { for (const k of Object.keys(saved)) { calls[k] = []; steps[k] = [] } }
  reset()
  for (const k of Object.keys(saved)) {
    E[k] = (...a: unknown[]) => { calls[k]!.push(a.slice(1)); const s = saved[k]!(...a); steps[k]!.push(s); return s }
  }
  return { calls, steps, n: (k) => calls[k]?.length ?? 0, reset, restore: () => { Object.assign(E, saved) } }
}
type Spy = ReturnType<typeof spyOn>
const planOf = (spy: Spy, k: string, i = -1): PBn.Plan => PBn.plan(spy.steps[k]!.at(i)!)

test('SD-ENTRY-PUB-ON — enable* · publish · ptt.enable 하나마다 ENTRY.on 하나(결합 코드를 지난다)', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    await mic(x)
    assert.equal(spy.n('on'), 1, 'SD-ENTRY-PUB-ON — enableMicrophone 이 ENTRY.on 하나')
    assert.equal(planOf(spy, 'on', 0).label, 'PUB.C.IDLE.on')
    const [lobby] = await x.r.c.media.acquire({ camera: true })
    assert.equal(spy.n('on'), 1, 'SD-ENTRY-PUB-ON — 획득만으로는 0')
    const p = x.r.c.media.publish(lobby!)
    await settlePublish(x, 't-cam')
    await p
    assert.equal(spy.n('on'), 2, 'SD-ENTRY-PUB-ON — media.publish(LocalTrack) 이 ENTRY.on 하나')
    await halfMic(x)
    assert.equal(spy.n('on'), 3, 'SD-ENTRY-PUB-ON — ptt.enable 이 ENTRY.on 하나')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-NEGO — 연결의 협상 결과(위 이음매 pub.nego_ok · pub.nego_fail)가 ENTRY.nego 하나 · ok 인자 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.nego, ['LINK:pub.nego_ok', 'LINK:pub.nego_fail'], 'SD-ENTRY-PUB-NEGO — 위가 정한 부르는 곳(연결)')
    const x = await pubUp()
    const p = x.r.c.media.enableMicrophone()
    await tick()
    assert.equal(spy.n('on'), 1)
    assert.equal(spy.n('nego'), 0, 'SD-ENTRY-PUB-NEGO — 앱 조작(켬)이 넣지 않는다 · 협상이 끝나기 전 0')
    await drain(x.r)
    assert.deepEqual(spy.calls['nego'], [[true]], 'SD-ENTRY-PUB-NEGO — 협상 성공 이음매가 ENTRY.nego(true) 하나')
    assert.equal(planOf(spy, 'nego').label, 'PUB.C.STAGED.nego_ok')
    answerAdd(x, 't-mic'); await tick(); await tick()
    const t = await p
    const m = t.setMuted(true); await tick()
    answerLast(x, Op.TRACK_SET); await m
    assert.equal(spy.n('nego'), 1, 'SD-ENTRY-PUB-NEGO — 트랙 설정 · 발행 응답이 넣는 곳 0')
    // 실패 갈래 — 다음 트랙의 협상이 깨졌다
    const q = x.r.c.media.enableCamera().catch((e: unknown) => e)
    await tick()
    await drain(x.r, SA, false)
    assert.deepEqual(spy.calls['nego']!.at(-1), [false], 'SD-ENTRY-PUB-NEGO — 협상 실패 이음매가 ENTRY.nego(false) 하나')
    assert.equal(planOf(spy, 'nego').label, 'PUB.C.STAGED.nego_fail')
    assert.ok((await q) instanceof OxLensError)
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-PUB-RES — 받은 발행 응답 하나가 ENTRY.pubRes 하나(action · code · part)', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    assert.deepEqual(spy.calls['pubRes'], [[{ action: 'add', code: 0, part: 'res' }]], 'SD-ENTRY-PUB-PUB-RES — add 응답이 ENTRY.pubRes 하나')
    assert.equal(planOf(spy, 'pubRes').label, 'PUB.C.STAGED.pub_ok')
    const s = t.stop(); await tick()
    answerLast(x, Op.PUBLISH_TRACKS, {}); await s; await tick()
    assert.deepEqual(spy.calls['pubRes']!.at(-1), [{ action: 'remove', code: 0, part: 'res' }], 'SD-ENTRY-PUB-PUB-RES — remove 응답도 ENTRY.pubRes 하나')
    const q = x.r.c.media.enableCamera().catch((e: unknown) => e)
    await tick(); await drain(x.r)
    answerLast(x, Op.PUBLISH_TRACKS, { code: 4002, name: 'TRACK_LIMIT', permanent: false }, false); await tick()
    assert.deepEqual(spy.calls['pubRes']!.at(-1), [{ action: 'add', code: 4002, part: 'fail' }], 'SD-ENTRY-PUB-PUB-RES — 실패 응답은 code · fail')
    const e = await q
    assert.ok(e instanceof OxLensError && e.code === 4002 && e.category === 'limit')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-ATTACH — Encoder 가 sender 에 트랙을 얹은 결과가 ENTRY.attach 하나 · ok(얹은 뒤에 넣는다)', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const E = PBn.ENTRY as unknown as Record<string, (...a: unknown[]) => unknown>
    const inner = E['attach']!
    E['attach'] = (...a: unknown[]) => { x.log.push(`attach(${String(a[1])})`); return inner(...a) }
    const t = await mic(x)
    assert.deepEqual(spy.calls['attach'], [[true]], 'SD-ENTRY-PUB-ATTACH — 입구 attach 하나 · ok')
    assert.deepEqual(x.log.filter((l) => l.startsWith('replaceTrack') || l.startsWith('attach')), ['replaceTrack(track)', 'attach(true)'], 'SD-ENTRY-PUB-ATTACH — sender 에 얹은 뒤에 넣는다')
    assert.equal(t.state, 'sending')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-OFF — LocalTrack.stop() 이 ENTRY.off 하나', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    assert.equal(spy.n('off'), 0)
    const s = t.stop(); await tick()
    answerLast(x, Op.PUBLISH_TRACKS); await s
    assert.equal(spy.n('off'), 1, 'SD-ENTRY-PUB-OFF — stop() 이 ENTRY.off 하나')
    assert.equal(planOf(spy, 'off').label, 'PUB.C.SENDING.off')
    await t.stop()
    assert.equal(spy.n('off'), 1, 'SD-ENTRY-PUB-OFF — 끝난 트랙의 stop() 은 0')
  } finally { spy.restore() }
})

const mine = (id: string, kind: 'audio' | 'video' = 'audio'): TrackEntry => ({ type: 'individual', room_id: 'r1', track_id: id, kind, user_id: 'u1' })

test('SD-ENTRY-PUB-REVOKED — 트랙 목록에서 내 트랙이 빠지면(위 이음매 TRK pub.revoked) ENTRY.revoked 하나 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.revoked, ['TRK:pub.revoked'], 'SD-ENTRY-PUB-REVOKED — 위가 정한 부르는 곳 하나(트랙)')
    const x = await pubUp()
    await mic(x)
    await note(x.r, Op.TRACK_EVENT, { action: 'add', room_id: 'r1', tracks: [mine('t-mic')], version: vers(2) })
    assert.equal(spy.n('revoked'), 0, 'SD-ENTRY-PUB-REVOKED — 내 트랙의 add 는 0')
    await note(x.r, Op.TRACK_EVENT, { action: 'remove', room_id: 'r1', tracks: [mine('t-other')], version: vers(3) })
    assert.equal(spy.n('revoked'), 0, 'SD-ENTRY-PUB-REVOKED — 남의(내 것 아닌) remove 는 0')
    await note(x.r, Op.TRACK_EVENT, { action: 'remove', room_id: 'r1', tracks: [mine('t-mic')], version: vers(4) })
    assert.equal(spy.n('revoked'), 1, 'SD-ENTRY-PUB-REVOKED — 내 track_id 의 remove 가 ENTRY.revoked 하나')
    assert.equal(planOf(spy, 'revoked').label, 'PUB.C.SENDING.revoked')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-REREGISTER · SD-ENTRY-PUB-DROP-SERVER — 세션 재구축이 그 서버 연결을 닫고(위 이음매 pub.drop_server) 다시 발행을 건다(위 이음매 pub.reregister_all) · 입구 하나씩 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.reregister, ['LINK:pub.reregister_server', 'SES:pub.reregister_all'], 'SD-ENTRY-PUB-REREGISTER — 위가 정한 부르는 곳(연결 · 세션)')
    assert.deepEqual(PUB.REACTS.dropServer, ['LINK:pub.drop_server'], 'SD-ENTRY-PUB-DROP-SERVER — 위가 정한 부르는 곳 하나(연결)')
    const x = await pubUp()
    const t = await mic(x)
    const m = t.setMuted(true); await tick(); answerLast(x, Op.TRACK_SET); await m
    assert.deepEqual([spy.n('reregister'), spy.n('dropServer')], [0, 0], 'SD-ENTRY-PUB-REREGISTER · SD-ENTRY-PUB-DROP-SERVER — 앱 조작이 넣는 곳 0')
    x.r.ws.close(); await tick(5)
    const ws = FakeWS.made.at(-1)!
    ws.open(); await tick()
    ws.reply(Op.BIND, { ...BIND_OK, session_id: 's-2' }); await tick(5)
    assert.equal(spy.n('dropServer'), 1, 'SD-ENTRY-PUB-DROP-SERVER — 연결이 닫히면 그 서버 발행이 ENTRY.dropServer 하나')
    assert.equal(planOf(spy, 'dropServer').label, 'PUB.C.any.drop_server')
    assert.equal(spy.n('reregister'), 1, 'SD-ENTRY-PUB-REREGISTER — 세션 재구축이 ENTRY.reregister 하나')
    assert.equal(planOf(spy, 'reregister').label, 'PUB.C.any.reregister')
    assert.equal(t.state, 'staged', '다시 발행이 섰다(협상 대기)')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-FLOOR-OPEN · SD-ENTRY-PUB-FLOOR-CLOSE — 발언권 허가 · 끝(위 이음매 FLR mic.open · mic.close)이 ENTRY.floorOpen · floorClose 하나 · 발언권 효과 표에 게이트 행 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual([PUB.REACTS.floorOpen, PUB.REACTS.floorClose], [['FLR:mic.open'], ['FLR:mic.close']], 'SD-ENTRY-PUB-FLOOR-OPEN · SD-ENTRY-PUB-FLOOR-CLOSE — 위가 정한 부르는 곳(발언권)')
    assert.deepEqual([PB.effect('mic.open'), PB.effect('mic.close')], [{ seam: 'PUB' }, { seam: 'PUB' }], 'SD-ENTRY-PUB-FLOOR-OPEN — 발언권 결합은 mic.* 를 발행 이음매로만 넘긴다(동작 행 아님)')
    const FLR_FX = ['mic.close', 'mic.open', 'media.render', 'app.speaker_none', 'app.floor_unreliable', 'app.floor_reliable', 'app.speaker', 'app.granted', 'app.denied', 'app.queued', 'app.revoked', 'app.granted_queued', 'app.request_timeout', 'app.queue_timeout', 'app.grant_expired'] as const
    assert.deepEqual(FLR_FX.map((f) => (PB.effect(f) as { action?: string }).action).filter((a) => a && a.startsWith('gate')), [], 'SD-ENTRY-PUB-FLOOR-OPEN — 발언권 효과 표에 게이트 행 0(게이트는 발행 효과 track.attach · track.detach 의 몫)')
    const x = await pubUp()
    const h = await halfMic(x)
    assert.deepEqual([spy.n('floorOpen'), spy.n('floorClose')], [0, 0], '발행 · 등록만으로는 0')
    grant(x)
    assert.equal(spy.n('floorOpen'), 1, 'SD-ENTRY-PUB-FLOOR-OPEN — 허가가 ENTRY.floorOpen 하나')
    assert.equal(planOf(spy, 'floorOpen').label, 'PUB.C.REGISTERED.floor_open')
    assert.equal(h.state, 'sending')
    void ungrant(x)
    assert.equal(spy.n('floorClose'), 1, 'SD-ENTRY-PUB-FLOOR-CLOSE — 놓기가 ENTRY.floorClose 하나')
    assert.equal(planOf(spy, 'floorClose').label, 'PUB.C.SENDING.floor_close')
    assert.equal(h.state, 'registered')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-RESUME-CHECK — 이어받기 응답 대조(위 이음매 SES pub.resume_check)가 ENTRY.resumeCheck 하나 · listed = 응답의 발행 목록에 내 트랙이 있다', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.resumeCheck, ['SES:pub.resume_check'], 'SD-ENTRY-PUB-RESUME-CHECK — 위가 정한 부르는 곳 하나(세션)')
    const x = await pubUp()
    await mic(x)
    const resume = async (pubs: unknown[]): Promise<void> => {
      const n = FakeWS.made.length
      FakeWS.made.at(-1)!.close()
      for (let i = 0; i < 400 && FakeWS.made.length === n; i++) await tick(5)
      const ws = FakeWS.made.at(-1)!
      ws.open(); await tick()
      ws.reply(Op.BIND, BIND_OK); await tick(); await tick()
      ws.reply(Op.RESUME, { snapshot: { r1: { participants: [mem('u1')], me: mem('u1'), tracks: [], version: vers(1) } }, publications: pubs, mline_tables: [] })
      await tick(); await tick()
    }
    assert.equal(spy.n('resumeCheck'), 0)
    await resume([{ track_id: 't-mic', room_id: 'r1', kind: 'audio', duplex: 'full', codec: 'opus' }])
    assert.deepEqual(spy.calls['resumeCheck'], [[true]], 'SD-ENTRY-PUB-RESUME-CHECK — 내 트랙이 실린 응답 → ENTRY.resumeCheck(listed 참) 하나')
    assert.equal(planOf(spy, 'resumeCheck').label, 'PUB.C.any.resume_listed')
    await resume([])
    assert.deepEqual(spy.calls['resumeCheck']!.at(-1), [false], 'SD-ENTRY-PUB-RESUME-CHECK — 빠진 응답 → listed 거짓')
    assert.deepEqual(planOf(spy, 'resumeCheck').seams.map((s) => s.fx), ['link.pub_lost'], '발행이 사라졌으면 위가 그 서버 재구축을 건다')
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-ROOM-GONE — 발행한 방을 잃으면(위 이음매 ROOM pub.room_gone) ENTRY.roomGone 하나 · SDK 사건으로 넣는 곳 0 · 같은 서버에 방이 남으면 연결은 그대로(drop_server 0)', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.roomGone, ['ROOM:pub.room_gone'], 'SD-ENTRY-PUB-ROOM-GONE — 위가 정한 부르는 곳 하나(방)')
    const x = await pubUp()
    await enter(x.r, 'r2', { pub: 'r1' })
    const t = await mic(x)
    const m = t.setMuted(true); await tick(); answerLast(x, Op.TRACK_SET); await m
    assert.equal(spy.n('roomGone'), 0, 'SD-ENTRY-PUB-ROOM-GONE — 앱 조작이 넣는 곳 0')
    const l = x.room.leave(); await tick()
    x.r.ws.answer(leaveFrame(x.r.ws, 'r1'), {}); await l; await tick()
    assert.equal(spy.n('roomGone'), 1, 'SD-ENTRY-PUB-ROOM-GONE — 발행한 방의 퇴장이 ENTRY.roomGone 하나')
    assert.equal(planOf(spy, 'roomGone').label, 'PUB.C.any.room_gone')
    assert.equal(spy.n('dropServer'), 0, '같은 서버 방(r2)이 남았다 — 연결은 닫히지 않는다')
    assert.equal(t.state, 'acquired', '발행 단만 내린다(registered → acquired)')
    assert.equal(nav.gum[0]!.track.stops, 0, 'Source 는 남긴다(SDK:RULE-MOD-TEARDOWN room.leave)')
  } finally { spy.restore() }
})

// ══ 효과 표 — 결합 plan() 이 낸 대로 ═══════════════════════════════════════════════════════════════

test('SD-EFFECT-PUB-APP-PUBLISHING — 위 효과 app.publishing → published · 기다리던 publish resolve · state sending(반이중 registered) · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const [a] = await x.r.c.media.acquire({ microphone: true })
    let published = 0
    a!.on('published', () => { published++ })
    const p = x.r.c.media.publish(a!)
    await settlePublish(x, 't-mic')
    assert.equal(await p, a, 'SD-EFFECT-PUB-APP-PUBLISHING — 기다리던 publish 가 같은 트랙으로 resolve')
    assert.deepEqual(planOf(spy, 'attach').events, ['published'], 'SD-EFFECT-PUB-APP-PUBLISHING — 결합 plan() 이 published 를 낸다')
    assert.equal(published, 1, 'SD-EFFECT-PUB-APP-PUBLISHING — published 하나')
    assert.equal(a!.state, 'sending', 'SD-EFFECT-PUB-APP-PUBLISHING — 전이중 state sending')
    const h = await halfMic(x)
    assert.equal(planOf(spy, 'attach').label, 'PUB.C.REGISTERED.attach_ok_half')
    assert.deepEqual(planOf(spy, 'attach').events, ['published'], 'SD-EFFECT-PUB-APP-PUBLISHING — 반이중도 결합 plan() 이 published 를 낸다')
    assert.equal(h.state, 'registered', 'SD-EFFECT-PUB-APP-PUBLISHING — 반이중 state registered(발언권 동안만 sending)')
  } finally { spy.restore() }
})

test('SD-EFFECT-PUB-APP-PUBLISH-FAILED — 위 효과 app.publish_failed → publishFailed · 기다리던 publish reject · 그 단만 되돌린다(acquired · 트랙은 앱 것 그대로) · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const [a] = await x.r.c.media.acquire({ microphone: true })
    const failed: unknown[] = []
    a!.on('publishFailed', (e) => failed.push(e))
    const p = x.r.c.media.publish(a!).catch((e: unknown) => e)
    await tick(); await drain(x.r, SA, false)
    const e = await p
    assert.deepEqual(planOf(spy, 'nego').events, ['publishFailed'], 'SD-EFFECT-PUB-APP-PUBLISH-FAILED — 결합 plan() 이 publishFailed 를 낸다')
    assert.ok(e instanceof OxLensError && e.category === 'negotiation', 'SD-EFFECT-PUB-APP-PUBLISH-FAILED — 기다리던 publish reject(negotiation)')
    assert.equal(failed.length, 1, 'SD-EFFECT-PUB-APP-PUBLISH-FAILED — publishFailed 하나')
    assert.deepEqual([a!.state, a!.owner, nav.gum[0]!.track.stops], ['acquired', 'app', 0], 'SD-EFFECT-PUB-APP-PUBLISH-FAILED — 그 단만 되돌린다: acquired · owner app · 정지 0')
  } finally { spy.restore() }
})

test('SD-EFFECT-PUB-APP-REVOKED · SD-EFFECT-PUB-TRANSCEIVER-INACTIVE — 서버가 내 발행을 지우면 ended{revoked} · state idle · 그 트랜시버 inactive + 재협상 · remove 송신 0 · Source 를 멈춘다(핸들이 끝나 아무도 못 놓는다) · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    const ended: unknown[] = []
    t.on('ended', (e) => ended.push(e))
    const before = x.peer.assembled
    await note(x.r, Op.TRACK_EVENT, { action: 'remove', room_id: 'r1', tracks: [mine('t-mic')], version: vers(2) })
    const plan = planOf(spy, 'revoked')
    assert.deepEqual(plan.events, ['ended'], 'SD-EFFECT-PUB-APP-REVOKED — 결합 plan() 이 ended 를 낸다')
    assert.deepEqual(ended, [{ reason: 'revoked' }], "SD-EFFECT-PUB-APP-REVOKED — LocalTrack.ended{reason:'revoked'}")
    assert.equal(t.state, 'idle', 'SD-EFFECT-PUB-APP-REVOKED — state idle')
    assert.ok(plan.actions.includes('transceiver.inactive'), 'SD-EFFECT-PUB-TRANSCEIVER-INACTIVE — 결합 plan() 이 transceiver.inactive 를 낸다')
    assert.deepEqual([x.peer.deactivated.length, x.peer.slots[0]!.transceiver.direction], [1, 'inactive'], 'SD-EFFECT-PUB-TRANSCEIVER-INACTIVE — 그 트랜시버를 inactive 로')
    await tick()
    assert.ok(x.peer.assembled > before, 'SD-EFFECT-PUB-TRANSCEIVER-INACTIVE — 재협상')
    assert.equal(pubReqs(x, 'remove').length, 0, 'remove 송신 0 — 발행은 이미 없다(SDK:RULE-MOD-TEARDOWN 권한 회수)')
    assert.equal(nav.gum[0]!.track.stops, 1, 'SD-EFFECT-PUB-APP-REVOKED — Source 를 멈춘다(owner sdk · SDK:RULE-MOD-TEARDOWN 권한 회수 행 — 카메라 · 마이크 표시등이 꺼진다)')
    await t.stop()
    assert.equal(nav.gum[0]!.track.stops, 1, '끝난 트랙의 stop() 은 아무것도 안 한다(이미 멈췄다)')
  } finally { spy.restore() }
})

test('SD-EFFECT-PUB-TRACK-ATTACH · SD-EFFECT-PUB-TRACK-DETACH — 위 효과 track.attach → gate.open(허가 전 송출 0) · track.detach → gate.close(곧바로) · 결합 plan() 이 낸다', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const h = await halfMic(x)
    const s = x.peer.slots[0]!.transceiver.sender
    assert.deepEqual(s.replaced, [], 'SD-EFFECT-PUB-TRACK-ATTACH — 허가 전 sender 에 얹은 것 0(송출 0)')
    assert.equal(s.track, null)
    grant(x)
    assert.deepEqual(planOf(spy, 'floorOpen').actions, ['gate.open'], 'SD-EFFECT-PUB-TRACK-ATTACH — 결합 plan() 이 gate.open 을 낸다')
    assert.deepEqual(s.replaced, [h.track.id], 'SD-EFFECT-PUB-TRACK-ATTACH — 게이트가 열려 보관한 소스를 한 번 얹는다')
    void ungrant(x)
    assert.deepEqual(planOf(spy, 'floorClose').actions, ['gate.close'], 'SD-EFFECT-PUB-TRACK-DETACH — 결합 plan() 이 gate.close 를 낸다')
    assert.deepEqual(s.replaced, [h.track.id, null], 'SD-EFFECT-PUB-TRACK-DETACH — 곧바로(같은 걸음 안에서) replaceTrack(null)')
    assert.equal(h.state, 'registered')
  } finally { spy.restore() }
})

// ══ 표면 — enable* · acquire · publish · LocalTrack ═════════════════════════════════════════════════

const maxBitrate = (s: FakeSender): unknown => s.params.at(-1)?.encodings[0]?.['maxBitrate']

test('SD-API-MEDIA-ENABLE-MICROPHONE — 프로필은 트랙 duplex 가 고른다(전이중 conference · 반이중 ptt) · profile 이 덮어쓴다', async () => {
  const x = await pubUp()
  await mic(x, 't-1')
  assert.equal(nav.gum[0]!.c.channelCount, undefined, 'SD-API-MEDIA-ENABLE-MICROPHONE — 전이중 기본 conference: mono 제약 없음')
  assert.equal(nav.gum[0]!.c.echoCancellation, true)
  assert.equal(maxBitrate(x.peer.slots[0]!.transceiver.sender), 48000, 'SD-API-MEDIA-ENABLE-MICROPHONE — conference 인코딩 music(48k)')
  await mic(x, 't-2', { profile: 'ptt' })
  assert.deepEqual([nav.gum[1]!.c.channelCount, nav.gum[1]!.c.echoCancellation], [1, true], 'SD-API-MEDIA-ENABLE-MICROPHONE — profile ptt 가 덮어쓴다: mono · EC 켬')
  assert.equal(maxBitrate(x.peer.slots[1]!.transceiver.sender), 24000, 'SD-API-MEDIA-ENABLE-MICROPHONE — ptt 인코딩 speech(24k)')
  await halfMic(x, 't-3')
  assert.equal(nav.gum[2]!.c.channelCount, 1, 'SD-API-MEDIA-ENABLE-MICROPHONE — 반이중(ptt.enable) 기본 ptt')
  assert.equal(maxBitrate(x.peer.slots[2]!.transceiver.sender), 24000)
})

test('SD-API-LOCAL-TRACK-STOP — stop() 은 remove 하나 · 트랜시버 유지(방향 그대로) · state idle · ended{stopped}', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const ended: unknown[] = []
  t.on('ended', (e) => ended.push(e))
  const s = t.stop(); await tick()
  answerLast(x, Op.PUBLISH_TRACKS); await s
  assert.deepEqual(pubReqs(x, 'remove').map((b) => b.track_ids), [['t-mic']], 'SD-API-LOCAL-TRACK-STOP — remove 하나(내 track_id)')
  assert.deepEqual([x.peer.deactivated.length, x.peer.slots[0]!.transceiver.direction], [0, 'sendonly'], 'SD-API-LOCAL-TRACK-STOP — 트랜시버 유지 · inactive 로 돌리지 않는다')
  assert.equal(t.state, 'idle', 'SD-API-LOCAL-TRACK-STOP — idle')
  assert.deepEqual(ended, [{ reason: 'stopped' }])
})

test('SD-API-LOCAL-TRACK-SET-MUTED — setDuplex 뒤 enabled=true · 반이중 트랙 setMuted 는 wire 전에 STATE_HALF_DUPLEX_NO_MUTE · 3006 은 permanent · half 기준 방이 없으면 STATE_NO_SPEAKING_ROOM(wire 0)', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const m = t.setMuted(true); await tick(); answerLast(x, Op.TRACK_SET); await m
  assert.deepEqual([t.muted, t.mediaStreamTrack.enabled], [true, false], 'setMuted 의 손잡이는 track.enabled')
  const d = t.setDuplex('half'); await tick()
  assert.deepEqual(x.r.ws.last(Op.TRACK_SET).body, { room_id: 'r1', track_id: 't-mic', duplex: 'half' }, '기준 방 = speakingRoom')
  answerLast(x, Op.TRACK_SET); await d
  assert.deepEqual([t.duplex, t.muted, t.mediaStreamTrack.enabled], ['half', false, true], 'SD-API-LOCAL-TRACK-SET-MUTED④ — setDuplex 응답 뒤 enabled=true(서버도 muted=false 로 초기화)')
  const sets = x.r.ws.requests(Op.TRACK_SET).length
  const e1 = await t.setMuted(true).catch((e: unknown) => e)
  assert.ok(e1 instanceof OxLensError && e1.category === 'state' && e1.name === 'STATE_HALF_DUPLEX_NO_MUTE' && e1.code === 0, 'SD-API-LOCAL-TRACK-SET-MUTED③ — 반이중 트랙 setMuted → STATE_HALF_DUPLEX_NO_MUTE(code 0)')
  assert.equal(x.r.ws.requests(Op.TRACK_SET).length, sets, 'SD-API-LOCAL-TRACK-SET-MUTED③ — wire 0')
  const cam = x.r.c.media.enableCamera({ simulcast: true })
  await settlePublish(x, 't-cam')
  const c = await cam
  const gate = x.peer.slots[1]!.transceiver.sender.replaced.length
  const d2 = c.setDuplex('half').catch((e: unknown) => e); await tick()
  answerLast(x, Op.TRACK_SET, { code: 3006, name: 'TRACK_OP_UNSUPPORTED', permanent: true }, false)
  const e2 = await d2
  assert.ok(e2 instanceof OxLensError && e2.code === 3006 && e2.permanent === true, 'SD-API-LOCAL-TRACK-SET-MUTED① — 3006 은 permanent 로 reject')
  assert.deepEqual([c.duplex, x.peer.slots[1]!.transceiver.sender.replaced.length], ['full', gate], '응답 전엔 아무것도 바꾸지 않는다(게이트 그대로 — 벙어리 0)')
  const a = x.r.c.setSpeakingRoom(null); await tick()
  answerLast(x, Op.AFFILIATION, { sub_rooms: ['r1'], pub_room: null }); await a
  const sets2 = x.r.ws.requests(Op.TRACK_SET).length
  const e3 = await c.setDuplex('half').catch((e: unknown) => e)
  assert.ok(e3 instanceof OxLensError && e3.category === 'state' && e3.name === 'STATE_NO_SPEAKING_ROOM' && e3.code === 0, 'SD-API-LOCAL-TRACK-SET-MUTED② — half 기준 방 없음 → STATE_NO_SPEAKING_ROOM(code 0)')
  assert.equal(x.r.ws.requests(Op.TRACK_SET).length, sets2, 'SD-API-LOCAL-TRACK-SET-MUTED② — wire 0')
})

test('SD-API-LOCAL-TRACK-STATE — 상태는 한 칸씩(acquired → staged → registered → sending) · 반이중 마이크는 registered 가 정상', async () => {
  const x = await pubUp()
  const [a] = await x.r.c.media.acquire({ microphone: true })
  // state 는 이벤트가 없는 속성이다(SD-EVENT-LOCAL-TRACK-STATE) — 발행 상태기 걸음(전이 기록)마다 속성을 읽어 한 칸씩인지 본다
  const seen: string[] = [a!.state]
  x.r.c.diagnostics.on('transition', (t) => { if (t.layer === 'PUB' && seen.at(-1) !== a!.state) seen.push(a!.state) })
  const p = x.r.c.media.publish(a!)
  await settlePublish(x, 't-mic'); await p
  assert.deepEqual(seen, ['acquired', 'staged', 'registered', 'sending'], 'SD-API-LOCAL-TRACK-STATE — 넷 앞의 acquired 부터 한 칸씩')
  const h = await halfMic(x)
  await tick(30)
  assert.equal(h.state, 'registered', 'SD-API-LOCAL-TRACK-STATE — 반이중 마이크는 발행된 채 registered(발화 중에만 sending)')
})

test('SD-API-LOCAL-TRACK-SERVER — server 는 단수(그 트랙을 발행한 서버 sfu_id 하나) · 발행 전 · 끝난 뒤 null', async () => {
  const x = await pubUp()
  const [a] = await x.r.c.media.acquire({ microphone: true })
  assert.equal(a!.server, null, 'SD-API-LOCAL-TRACK-SERVER — 획득만이면 null')
  const p = x.r.c.media.publish(a!)
  await settlePublish(x, 't-mic'); await p
  assert.equal(a!.server, 'sfu-a', 'SD-API-LOCAL-TRACK-SERVER — 발언 방 서버 하나(문자열 하나 — 목록이 아니다)')
  const s = a!.stop(); await tick(); answerLast(x, Op.PUBLISH_TRACKS); await s
  assert.equal(a!.server, null, 'SD-API-LOCAL-TRACK-SERVER — 끝나면 null')
})

test('SD-API-MEDIA-PUBLISH — 외부 트랙은 전이중 · owner external · 반이중 외부 트랙은 ptt 경유(media.publish 에 duplex 칸이 없다)', async () => {
  const x = await pubUp()
  const canvas = ft('video', 'canvas')
  const p = x.r.c.media.publish(canvas, { source: 'camera' })
  await settlePublish(x, 't-canvas')
  const t = await p
  assert.deepEqual([t.duplex, t.owner, t.mediaStreamTrack], ['full', 'external', canvas], 'SD-API-MEDIA-PUBLISH① — 전이중으로만 · external')
  assert.deepEqual([pubReqs(x, 'add')[0]!.tracks![0]!['duplex'], pubReqs(x, 'add')[0]!.tracks![0]!['source']], ['full', 'camera'], 'SD-API-MEDIA-PUBLISH① — wire 에도 전이중 · source 라벨 그대로')
  const tone = ft('video', 'tone')
  const q = x.room.ptt.enableVideo({ track: tone })
  await settlePublish(x, 't-tone')
  const v = await q
  assert.deepEqual([v.duplex, v.owner], ['half', 'external'], 'SD-API-MEDIA-PUBLISH② — 반이중 외부 트랙은 이 길이 아니다 — room.ptt.enableVideo({ track }) 로(기준 방이 필요)')
  assert.equal(pubReqs(x, 'add')[1]!.tracks![0]!['duplex'], 'half')
})

test('SD-API-LOCAL-TRACK-ON-SILENCE — 전이중 audio 는 첫 송신 뒤 · 반이중은 has_permission 첫 창 · enable 직후엔 0 · 완전 무음 = 창 동안 totalAudioEnergy 가 안 늘었다', async () => {
  const x = await pubUp()
  const t = await mic(x)
  let full = 0
  t.on('silence', () => { full++ })
  await tick(60)
  assert.equal(full, 1, 'SD-API-LOCAL-TRACK-ON-SILENCE — 전이중: 첫 송신 뒤 창 동안 에너지 그대로 → silence 하나')
  const h = await halfMic(x)
  let half = 0
  h.events.on('silence', () => { half++ })
  await tick(60)
  assert.equal(half, 0, 'SD-API-LOCAL-TRACK-ON-SILENCE — 반이중: enable 직후엔 판정하지 않는다(0)')
  grant(x)
  await tick(60)
  assert.equal(half, 1, 'SD-API-LOCAL-TRACK-ON-SILENCE — 반이중: 허가 첫 창이 무음이면 silence 하나')
  void ungrant(x)
  grant(x); await tick(60)
  assert.equal(half, 1, '첫 창만 — 두 번째 허가는 0')
})

test('SD-API-MEDIA-ACQUIRE — 접속 전 acquire 는 LocalTrack[](acquired · server null · owner app) · 하나가 실패하면 획득한 것은 전부 stop 하고 device(details.kind)로 reject', async () => {
  const c = createClient({ base: 'https://hub.example', token: 'tok' })
  const ts = await c.media.acquire({ microphone: true, camera: true })
  assert.deepEqual(ts.map((t) => [t.kind, t.state, t.server, t.owner]), [['audio', 'acquired', null, 'app'], ['video', 'acquired', null, 'app']], 'SD-API-MEDIA-ACQUIRE — 접속 전 · 상태 acquired · server null · owner app(SDK §8 — 항목서의 idle 은 acquired 로 읽는다)')
  nav.failKind = 'video'
  const e = await c.media.acquire({ microphone: true, camera: true }).catch((x: unknown) => x)
  assert.ok(e instanceof OxLensError && e.category === 'device' && e.details?.['kind'] === 'video', 'SD-API-MEDIA-ACQUIRE — 실패한 kind 로 device reject')
  assert.equal(nav.gum.at(-1)!.track.stops, 1, 'SD-API-MEDIA-ACQUIRE — 먼저 획득한 마이크는 SDK 가 stop(전부 아니면 전무)')
  await c.close()
})

test('SD-API-MEDIA-ENABLE — enable* 가 중간(협상)에서 실패하면 자기가 만든 트랙을 stop(표시등 0)', async () => {
  const x = await pubUp()
  const p = x.r.c.media.enableMicrophone().catch((e: unknown) => e)
  await tick(); await drain(x.r, SA, false)
  assert.ok((await p) instanceof OxLensError)
  assert.equal(nav.gum[0]!.track.stops, 1, 'SD-API-MEDIA-ENABLE — 자기가 만든 트랙 stop')
  assert.equal(x.r.c.media.tracks.length, 0)
})

// ══ 소유권 — 장치 수명 관리는 owner:'sdk' 에만 ════════════════════════════════════════════════════

test('SD-OWNER-ALL — acquire → publish → replaceSource(track) → replaceSource(null): owner app → sdk → external → sdk', async () => {
  const x = await pubUp()
  const [a] = await x.r.c.media.acquire({ microphone: true })
  const seen = [a!.owner]
  const p = x.r.c.media.publish(a!)
  await settlePublish(x, 't-mic'); await p
  seen.push(a!.owner)
  await a!.replaceSource(ft('audio', 'proc'))
  seen.push(a!.owner)
  await a!.replaceSource(null)
  seen.push(a!.owner)
  assert.deepEqual(seen, ['app', 'sdk', 'external', 'sdk'], 'SD-OWNER-ALL — app → sdk → external → sdk')
})

test('SD-OWNER-APP — 앱 소유 획득 트랙은 publish 실패 · close() · 무발화 창 뒤에도 정지 0 · cold 미적용', async () => {
  const x = await pubUp()
  x.r.core.media.coldAfter = 10
  const [a] = await x.r.c.media.acquire({ microphone: true })
  const dev0 = nav.gum[0]!.track
  const p = x.r.c.media.publish(a!).catch((e: unknown) => e)
  await tick(); await drain(x.r, SA, false)
  assert.ok((await p) instanceof OxLensError)
  assert.deepEqual([a!.owner, dev0.stops], ['app', 0], 'SD-OWNER-APP — publish 실패에도 트랙은 앱 것 · 정지 0')
  await tick(40)
  assert.deepEqual([(a as unknown as { core: LocalCore }).core.cold, dev0.stops], [false, 0], 'SD-OWNER-APP — 무발화 창이 지나도 cold 미적용')
  await x.r.c.close()
  assert.equal(dev0.stops, 0, 'SD-OWNER-APP — close() 에도 정지 0(앱 소유 획득 트랙은 남긴다)')
})

test('SD-OWNER-SDK — enable* 트랙은 SDK 가 장치 수명을 쥔다: 무발화 창 → cold 진입 · switchDevice 적용 · device_lost 재획득', async () => {
  const x = await pubUp()
  x.r.core.media.coldAfter = 10
  const h = await halfMic(x)
  const dev0 = nav.gum[0]!.track
  await tick(40)
  assert.deepEqual([h.cold, dev0.stops, h.state], [true, 1, 'registered'], 'SD-OWNER-SDK — 무발화 창 → cold 진입(Source 정지 · 발행은 registered 그대로)')
  const t = await mic(x)
  const n = nav.gum.length
  await x.r.c.media.switchDevice('audioinput', 'mic-2')
  assert.equal(nav.gum.length, n + 1, 'SD-OWNER-SDK — switchDevice 가 sdk 트랙에 적용된다(재획득)')
  assert.equal((nav.gum.at(-1)!.c.deviceId as { exact: string }).exact, 'mic-2')
  assert.equal(t.mediaStreamTrack, nav.gum.at(-1)!.track)
  const ended: unknown[] = []
  t.on('ended', (e) => ended.push(e))
  const before = nav.gum.length
  ;(t.mediaStreamTrack as unknown as FT).fire('ended'); await tick(5)
  assert.equal(nav.gum.length, before + 1, 'SD-OWNER-SDK — device_lost: 대체 장치로 재획득')
  assert.deepEqual([ended.length, t.state], [0, 'sending'], 'SD-OWNER-SDK — 트랙은 계속(ended 0)')
})

test('SD-OWNER-EXTERNAL — publish(mediaStreamTrack) 트랙은 무발화 창 · switchDevice · capture 옵션 전부 대상 아님 · 소스가 죽어도 ended 0', async () => {
  const x = await pubUp()
  x.r.core.media.coldAfter = 10
  const ext = ft('audio', 'ext')
  const p = x.r.c.media.publish(ext)
  await settlePublish(x, 't-ext')
  const t = await p
  const n = nav.gum.length
  await x.r.c.media.switchDevice('audioinput', 'mic-2')
  assert.equal(nav.gum.length, n, 'SD-OWNER-EXTERNAL — switchDevice 대상 아님(재획득 0)')
  assert.equal(t.mediaStreamTrack, ext)
  const tone = ft('audio', 'tone')
  const q = x.room.ptt.enable({ track: tone, capture: { echoCancellation: false } })
  await settlePublish(x, 't-tone'); await q
  await tick(40)
  const half = x.r.core.media.halfMic('sfu-a')!
  assert.deepEqual([tone.applied.length, half.cold, tone.stops], [0, false, 0], 'SD-OWNER-EXTERNAL — capture 제약 미적용 · 무발화 창 뒤 cold 미적용')
  const ended: unknown[] = []
  t.on('ended', (e) => ended.push(e))
  ext.fire('ended'); await tick(5)
  assert.deepEqual([ended.length, nav.gum.length, t.state], [0, n, 'sending'], 'SD-OWNER-EXTERNAL — 소스가 죽어도 ended 0 · 재획득 0(앱이 안다)')
})

// ══ SRC — 장치 정책 · 브라우저 손잡이(발행이 쥔 블록: Source · Encoder) ═══════════════════════════════

const devOf = (g: Gum): string | undefined => (g.c.deviceId as { exact?: string } | undefined)?.exact

test('SD-API-MEDIA-SWITCH-DEVICE — id 면 명시 고정(새 장치를 따라가지 않는다 · 뽑히면 자동 임시 복귀 · 다시 꽂히면 명시로) · null 이면 자동 · cold 중이면 저장 제약만', async () => {
  const x = await pubUp()
  const t = await mic(x)
  await x.r.c.media.switchDevice('audioinput', 'mic-2')
  assert.deepEqual([x.r.c.media.devices.preferred.audioinput, devOf(nav.gum.at(-1)!)], ['mic-2', 'mic-2'], 'SD-API-MEDIA-SWITCH-DEVICE — id 는 명시 선택(preferred) · 그 장치로 재획득')
  const n = nav.gum.length
  nav.devices = [...nav.devices, dev('audioinput', 'mic-3')]; nav.fire(); await tick(5)
  assert.equal(nav.gum.length, n, 'SD-API-MEDIA-SWITCH-DEVICE — 명시는 고정: 새 장치가 꽂혀도 따라가지 않는다')
  nav.devices = nav.devices.filter((d) => d.deviceId !== 'mic-2'); nav.fire(); await tick(5)
  assert.deepEqual([nav.gum.length, devOf(nav.gum.at(-1)!), t.state], [n + 1, undefined, 'sending'], 'SD-API-MEDIA-SWITCH-DEVICE — 명시 장치가 뽑히면 자동(OS 기본)으로 임시 복귀 · 트랙은 계속')
  nav.devices = [...nav.devices, dev('audioinput', 'mic-2')]; nav.fire(); await tick(5)
  assert.equal(devOf(nav.gum.at(-1)!), 'mic-2', 'SD-API-MEDIA-SWITCH-DEVICE — 다시 꽂히면 명시로 돌아간다')
  await x.r.c.media.switchDevice('audioinput', null)
  assert.deepEqual([x.r.c.media.devices.preferred.audioinput, devOf(nav.gum.at(-1)!)], [undefined, undefined], 'SD-API-MEDIA-SWITCH-DEVICE — null 은 명시를 풀고 자동(OS 기본)')
  x.r.core.media.coldAfter = 10
  const h = await halfMic(x)
  await tick(40)
  assert.equal(h.cold, true)
  const m = nav.gum.length
  await x.r.c.media.switchDevice('audioinput', 'mic-3')
  assert.equal(nav.gum.length, m + 1, '산 전이중 마이크만 재획득한다')
  assert.deepEqual([h.cold, h.opts.deviceId], [true, 'mic-3'], 'SD-API-MEDIA-SWITCH-DEVICE — cold 면 즉시 재획득하지 않고 저장 제약만')
  grant(x); await tick(5)
  assert.equal(devOf(nav.gum.at(-1)!), 'mic-3', '다음 데우기가 바뀐 제약으로 잡는다')
})

/** src 의 코드(주석 뺀)에서 그 무늬가 나오는 파일 */
function codeHits(re: RegExp): string[] {
  const root = join(process.cwd(), 'src')
  const out: string[] = []
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.ts')) {
        const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
        if (re.test(code)) out.push(p.slice(root.length + 1))
      }
    }
  }
  walk(root)
  return out.sort()
}

test('SD-KNOB-ACQUIRE — getUserMedia · getDisplayMedia 는 Source(platform/env) 안에서만 부른다', () => {
  assert.deepEqual(codeHits(/\.(getUserMedia|getDisplayMedia)\s*\(/), ['platform/env.ts'], 'SD-KNOB-ACQUIRE — 획득 손잡이는 platform/env 한 곳')
})

test('SD-KNOB-ATTACH — srcObject · 요소 volume 은 Playback(받는 쪽 — RemoteTrack · 재생) 안에서만', () => {
  const hits = codeHits(/\.srcObject\b|\bel\.volume\s*=/)
  assert.ok(hits.length > 0)
  assert.deepEqual(hits.filter((p) => !p.startsWith('domain/trk/')), [], 'SD-KNOB-ATTACH — 장착 손잡이는 domain/trk(RemoteTrack · Playback) 밖에 0')
})

test('SD-KNOB-COLD — 무발화 창 뒤 Source.stop + sender 는 replaceTrack(null) 상태 · registered 유지', async () => {
  const x = await pubUp()
  x.r.core.media.coldAfter = 10
  const h = await halfMic(x)
  const dev0 = nav.gum[0]!.track
  const s = x.peer.slots[0]!.transceiver.sender
  await tick(40)
  assert.deepEqual([dev0.stops, s.track, h.state, h.cold], [1, null, 'registered', true], 'SD-KNOB-COLD — Source.stop · sender 비움(replaceTrack(null)) · registered 유지')
  assert.equal(pubReqs(x).length, 1, 'wire 0(발행 그대로)')
})

test('SDK:RULE-FLR-MIC-POWER 줄 서기 — 누름 응답 · 줄 서기 동안은 무발화 창이 지나도 반납 0 · 허가에 재획득 0 · 거절로 no_permission 에 돌아오면 그때부터 창을 다시 세어 반납', async () => {
  const x = await pubUp()
  x.r.core.media.coldAfter = 10
  const h = await halfMic(x)
  const f = x.room.core.floor
  const gums = nav.gum.length
  f.st = { ...f.st, cs: 'PREQ' }
  f.receive({ t: 'QINFO', info: { position: 1, priority: 0 } } as never)
  assert.equal(f.st.cs, 'QUEUED')
  await tick(40)
  assert.deepEqual([h.cold, nav.gum[0]!.track.stops], [false, 0], '줄 서는 동안 창(10ms)의 네 배가 지나도 반납 0 — 곧 말한다')
  f.receive({ t: 'GRANTED', priority: 0, duration: 30 } as never)
  f.enter('intent', 'hold', [])   // 줄 선 사람의 허가는 발언 의지를 거쳐 연다(연:FLR.C.QUEUED.intent · T132)
  await tick()
  assert.deepEqual([f.st.cs, nav.gum.length], ['PERM', gums], '허가 — 데우기(재획득) 없이 게이트만 연다')
  await ungrant(x)
  f.st = { ...f.st, cs: 'PREQ' }
  await tick(40)
  assert.equal(h.cold, false, '누름 응답 대기도 반납 0')
  f.receive({ t: 'DENY', cause: 3 } as never)
  assert.equal(f.st.cs, 'NOPERM')
  await tick(4)
  assert.equal(h.cold, false, '거절 직후 — 창을 그때부터 다시 센다')
  await tick(40)
  assert.equal(h.cold, true, '거절 뒤 창이 지나면 반납')
})

test('SD-KNOB-LOCAL-TRACK-STOP — 순서: replaceTrack(null) → remove → Source.stop · 트랜시버 잔존(방향 그대로 — inactive 로 돌리지 않는다)', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const ws = x.r.ws
  const send = ws.send.bind(ws)
  ws.send = (b: Uint8Array) => {
    const f = decodeFrame(b)
    if (f.op === Op.PUBLISH_TRACKS && (f.body as { action?: string }).action === 'remove') x.log.push('remove')
    send(b)
  }
  const dev0 = nav.gum[0]!.track
  const stop = dev0.stop.bind(dev0)
  dev0.stop = () => { x.log.push('Source.stop'); stop() }
  x.log.length = 0
  const s = t.stop(); await tick()
  answerLast(x, Op.PUBLISH_TRACKS); await s
  const at = (k: string): number => x.log.indexOf(k)
  assert.ok(at('replaceTrack(null)') >= 0 && at('replaceTrack(null)') < at('remove') && at('remove') < at('Source.stop'), `SD-KNOB-LOCAL-TRACK-STOP — 게이트 닫기 → remove → Source.stop: ${x.log.join(' · ')}`)
  assert.deepEqual([x.log.includes('inactive'), x.peer.slots[0]!.transceiver.direction], [false, 'sendonly'], 'SD-KNOB-LOCAL-TRACK-STOP — 트랜시버 잔존 · 방향 그대로(SDK:RULE-MOD-TEARDOWN · 연:RULE-PUB-OFF)')
})

test('SD-KNOB-REPLACE-SOURCE — replaceSource(track) 은 replaceTrack · owner external · null 이면 자기 장치 트랙 · owner sdk · SSRC(트랜시버) · 발행 · 발언권 불변 · 게이트가 닫혀 있으면 보관만', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const s = x.peer.slots[0]!.transceiver.sender
  const pubs = pubReqs(x).length
  const nego = x.peer.assembled
  const proc = ft('audio', 'proc')
  await t.replaceSource(proc)
  assert.deepEqual([s.replaced.at(-1), t.owner, t.mediaStreamTrack], [proc.id, 'external', proc], 'SD-KNOB-REPLACE-SOURCE — replaceTrack(처리기) · owner external')
  await t.replaceSource(null)
  assert.deepEqual([s.replaced.at(-1), t.owner], [nav.gum[0]!.track.id, 'sdk'], 'SD-KNOB-REPLACE-SOURCE — null 은 보관한 자기 장치 트랙으로 · owner sdk')
  assert.deepEqual([pubReqs(x).length, x.peer.assembled, x.peer.slots.length, t.state], [pubs, nego, 1, 'sending'], 'SD-KNOB-REPLACE-SOURCE — 재발행 0 · 재협상 0 · 같은 트랜시버(SSRC)')
  const h = await halfMic(x)
  const hs = x.peer.slots[1]!.transceiver.sender
  const phase = x.room.ptt.state.phase
  const handle = x.r.c.media.tracks.find((y) => y.duplex === 'half')!
  const tone = ft('audio', 'tone')
  await handle.replaceSource(tone)
  assert.deepEqual([hs.replaced, x.room.ptt.state.phase], [[], phase], 'SD-KNOB-REPLACE-SOURCE — 반이중 게이트가 닫혀 있으면 sender 에 얹지 않고 보관만 · 발언권 그대로')
  grant(x)
  assert.deepEqual(hs.replaced, [tone.id], '허가 때 보관한 소스가 처음 얹힌다')
  assert.equal(h.owner, 'external')
})

test('SD-KNOB-SET-MUTED — setMuted 의 손잡이는 track.enabled 만 · sender 는 그대로(replaceTrack · setParameters 0)', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const s = x.peer.slots[0]!.transceiver.sender
  const before = { replaced: s.replaced.length, params: s.params.length, track: s.track }
  const m = t.setMuted(true); await tick(); answerLast(x, Op.TRACK_SET); await m
  assert.deepEqual([t.mediaStreamTrack.enabled, s.replaced.length, s.params.length, s.track], [false, before.replaced, before.params, before.track], 'SD-KNOB-SET-MUTED — enabled=false 만 · sender 유지')
  assert.deepEqual(x.r.ws.last(Op.TRACK_SET).body, { room_id: 'r1', track_id: 't-mic', muted: true })
})

// ══ 재발 시험 — 이번에 고친 결함 ══════════════════════════════════════════════════════════════════

test('재발 — 1pc SSRC 충돌 3008 은 그 트랜시버를 inactive 로 두고 새 트랜시버로 한 번 다시 발행한다 · 두 번째 3008 은 negotiation 으로 앱에(SDK §8 LocalTrack.state)', async () => {
  const x = await pubUp()
  const p = x.r.c.media.enableMicrophone()
  await tick(); await drain(x.r)
  answerLast(x, Op.PUBLISH_TRACKS, { code: 3008, name: 'SSRC_COLLISION', permanent: false }, false)
  await tick(); await drain(x.r)
  assert.deepEqual([x.peer.deactivated.length, x.peer.slots.length, x.peer.slots[1]?.fresh], [1, 2, true], '충돌한 트랜시버는 inactive · 새 트랜시버(재활용 아님 — 같은 SSRC 를 다시 내지 않는다)')
  assert.equal(pubReqs(x, 'add').length, 2, '한 번 다시 발행')
  answerAdd(x, 't-mic'); await tick(); await tick()
  assert.equal((await p).state, 'sending')
  const q = x.r.c.media.enableCamera().catch((e: unknown) => e)
  await tick(); await drain(x.r)
  answerLast(x, Op.PUBLISH_TRACKS, { code: 3008, name: 'SSRC_COLLISION', permanent: false }, false)
  await tick(); await drain(x.r)
  answerLast(x, Op.PUBLISH_TRACKS, { code: 3008, name: 'SSRC_COLLISION', permanent: false }, false)
  await tick()
  const e = await q
  assert.ok(e instanceof OxLensError && e.category === 'negotiation', '두 번째 3008 은 negotiation 으로 reject')
})

test('재발 — 발행 거절 2006 은 막힌 비트(details.denied)를 auth 로 그대로 올리고 room.permission 을 맞춘다 · 재시도 0(SDK:RULE-PUB-DENIED)', async () => {
  const x = await pubUp()
  const perms: unknown[] = []
  x.room.on('permission', (c) => perms.push(c))
  const p = x.r.c.media.enableCamera().catch((e: unknown) => e)
  await tick(); await drain(x.r)
  answerLast(x, Op.PUBLISH_TRACKS, { code: 2006, name: 'NOT_AUTHORIZED', permanent: false, details: { denied: ['publish_video'] } }, false)
  await tick(); await tick(20)
  const e = await p
  assert.ok(e instanceof OxLensError && e.category === 'auth' && JSON.stringify(e.details?.['denied']) === '["publish_video"]', 'auth · details.denied 그대로')
  assert.deepEqual([x.room.permission.publishVideo, x.room.permission.publishAudio], [false, true], 'room.permission 을 막힌 비트로')
  assert.equal((perms[0] as { mine: boolean }).mine, true, 'permission{mine:true}')
  assert.equal(pubReqs(x, 'add').length, 1, '재시도 0')
})

// ══ 서버를 건너는 발언 방 전환 — 발행 트랙이 따라간다(연:RULE-AFF-SWITCH-TRACKS · 위 입구 moveOut · moveIn) ═══════════

/** 서버 A 의 r1(발언 방 · 전이중 마이크 발행) + 서버 B 의 r3(듣기 · 반이중 마이크) */
async function xsfu(): Promise<X & { peerB: PubPeer; mic: Awaited<ReturnType<typeof mic>> }> {
  const x = await pubUp()
  const m = await mic(x)
  const r3 = await enter(x.r, 'r3', { sc: SB })
  const peerB = wire(x.r, SB, x.log)
  const h = r3.ptt.enable()
  await tick(); await drain(x.r, SB); answerAdd(x, 't-halfB'); await tick(); await tick()
  await h
  return { ...x, peerB, mic: m }
}
async function affAnswer(x: X, body: unknown, ok = true): Promise<void> { await tick(); x.r.ws.answer(x.r.ws.last(Op.AFFILIATION), body, ok); await tick(); await tick() }

test('SD-ENTRY-PUB-MOVE-OUT — 서버를 건너는 발언 방 전환 ①(위 이음매 pub.move_out)이 트랙마다 ENTRY.moveOut 하나 · here 참인 트랙만 remove 하나 · SDK 사건으로 넣는 곳 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.moveOut, ['AFF:pub.move_out'], 'SD-ENTRY-PUB-MOVE-OUT② — 위가 정한 부르는 곳 하나(AFF) · SDK 사건으로 넣는 곳 0')
    const x = await xsfu()
    spy.reset()
    const removes = pubReqs(x, 'remove').length
    const sw = x.r.c.setSpeakingRoom('r3').catch(() => undefined)
    await tick()
    assert.deepEqual(x.r.ws.last(Op.AFFILIATION).body, { pub_deselect: 'r1' }, '옛 서버 해제 요청')
    assert.equal(spy.n('moveOut'), 2, 'SD-ENTRY-PUB-MOVE-OUT① — 내 트랙마다 ENTRY.moveOut 하나')
    const byHere = spy.calls['moveOut']!.map((a) => a[0]).sort()
    assert.deepEqual(byHere, [false, true], 'SD-ENTRY-PUB-MOVE-OUT① — 읽는 값 here = 트랙의 서버가 떠나는 발행 방(r1)의 서버다')
    // 시그널링 창 1 — remove 는 해제 응답 뒤에 나간다(본문은 이미 정해졌다)
    await affAnswer(x, { sub_rooms: ['r1'], pub_room: null, cause: 'user' })
    const sent = pubReqs(x, 'remove').slice(removes)
    assert.deepEqual(sent.map((b) => [b.room_id, b.track_ids]), [['r1', ['t-mic']]], 'SD-ENTRY-PUB-MOVE-OUT① — here 참인 트랙만 PUBLISH_TRACKS{remove} 하나(옛 서버 · 옛 방) · 거짓이면 보낼 것 0')
    assert.equal(planOf(spy, 'moveOut', spy.calls['moveOut']!.findIndex((a) => a[0] === true)).label, 'PUB.C.SENDING.move_out', '결합 코드 ENTRY 를 지난다')
    assert.equal(x.mic.state, 'acquired', '내린 트랙은 다시 켤 때까지 acquired')
    answerLast(x, Op.PUBLISH_TRACKS, { action: 'remove' }); await tick(); await tick()
    await affAnswer(x, { sub_rooms: ['r3'], pub_room: 'r3', cause: 'user' })
    await sw
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-MOVE-IN — 발행 방이 섰다(위 이음매 pub.move_in)가 트랙마다 ENTRY.moveIn 하나 · 넣기 전에 server 를 그 발행 방의 서버로 · 내린 트랙만 그 서버에서 다시 켠다 · 옮기던 트랙이 아니면 보낼 것 0', async () => {
  const spy = spyOn()
  try {
    assert.deepEqual(PUB.REACTS.moveIn, ['AFF:pub.move_in'], 'SD-ENTRY-PUB-MOVE-IN — 위가 정한 부르는 곳 하나(AFF)')
    const x = await xsfu()
    const failed: unknown[] = []
    x.mic.on('publishFailed', (e) => failed.push(e))
    const sw = x.r.c.setSpeakingRoom('r3')
    await affAnswer(x, { sub_rooms: ['r1'], pub_room: null, cause: 'user' })
    answerLast(x, Op.PUBLISH_TRACKS, { action: 'remove' }); await tick(); await tick()
    spy.reset()
    const adds = pubReqs(x, 'add').length
    const builtB = x.peerB.assembled
    await affAnswer(x, { sub_rooms: ['r3'], pub_room: 'r3', cause: 'user' })
    await sw
    assert.equal(spy.n('moveIn'), 2, 'SD-ENTRY-PUB-MOVE-IN — 내 트랙마다 ENTRY.moveIn 하나')
    const labels = spy.steps['moveIn']!.map((st) => st!.label).sort()
    assert.deepEqual(labels, ['PUB.C.any.move_in', 'PUB.C.any.move_in_other'], 'SD-ENTRY-PUB-MOVE-IN②③ — 내린 트랙만 다시 켠다 · 옮기던 트랙이 아니면 그대로')
    assert.deepEqual([x.mic.server, x.mic.state], ['sfu-b', 'staged'], 'SD-ENTRY-PUB-MOVE-IN① — 넣기 전에 LocalTrack.server 를 새 발행 방의 서버로 · staged')
    assert.equal(x.peerB.assembled, builtB + 1, 'SD-ENTRY-PUB-MOVE-IN② — 새 서버에서 협상 하나')
    await drain(x.r, SB)
    const sent = pubReqs(x, 'add').slice(adds)
    assert.deepEqual(sent.map((b) => b.room_id), ['r3'], 'SD-ENTRY-PUB-MOVE-IN② — PUBLISH_TRACKS{add} 하나(새 방) · 옮기던 트랙이 아닌 것은 보낼 것 0')
    answerAdd(x, 't-mic-b'); await tick(); await tick()
    assert.deepEqual([x.mic.state, x.mic.server, failed.length], ['sending', 'sfu-b', 0], 'SD-ENTRY-PUB-MOVE-IN② — 새 서버에서 sending · 실패(3007 등) 0')
    assert.deepEqual([pubReqs(x, 'remove').at(-1)!.room_id, pubReqs(x, 'add').at(-1)!.room_id], ['r1', 'r3'], 'SD-API-CLIENT-SET-SPEAKING-ROOM③ — 서버를 건너면 옛 서버 트랙 remove(moveOut) → 새 발행 방이 서면 그 서버에 add(moveIn · 3007 0)')
  } finally { spy.restore() }
})

// ══ duplex 전환 — 위 입구 setDuplex · setDuplexRes · 효과 app.duplex · app.duplex_failed ═══════════════════

test('SD-ENTRY-PUB-SET-DUPLEX — LocalTrack.setDuplex() 가 ENTRY.setDuplex 하나 · TRACK_SET{duplex} 하나 · 응답 전 브라우저 손잡이 0', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    const s = x.peer.slots[0]!.transceiver.sender
    const replaced = s.replaced.length
    spy.reset()
    const d = t.setDuplex('half'); await tick()
    assert.deepEqual([spy.n('setDuplex'), spy.calls['setDuplex']![0]], [1, ['half']], 'SD-ENTRY-PUB-SET-DUPLEX① — 입구 setDuplex 하나 · 바라는 duplex')
    assert.equal(planOf(spy, 'setDuplex').label, 'PUB.C.any.set_duplex', '결합 코드 ENTRY 를 지난다')
    assert.deepEqual(x.r.ws.requests(Op.TRACK_SET).map((f) => f.body), [{ room_id: 'r1', track_id: 't-mic', duplex: 'half' }], 'SD-ENTRY-PUB-SET-DUPLEX① — TRACK_SET{duplex} 하나(기준 방 = 발언 방)')
    assert.deepEqual([t.state, t.core.gateOpen, s.replaced.length, t.core.duplex], ['sending', true, replaced, 'full'], 'SD-ENTRY-PUB-SET-DUPLEX② — 응답 전 브라우저 손잡이 0(게이트 · 반이중 여부 그대로)')
    answerLast(x, Op.TRACK_SET, { ssrc: 1000, duplex: 'half' }); await d
  } finally { spy.restore() }
})

test('SD-ENTRY-PUB-SET-DUPLEX-RES — TRACK_SET 응답마다 ENTRY.setDuplexRes 하나 · sending 의 반이중 응답 → 게이트 닫힘 · registered · 발언권에 반이중 발행 · 반이중 registered 의 전이중 응답 → 게이트 열림 · sending · 끝난 발행의 응답은 반이중 여부 변화 0', async () => {
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    const s = x.peer.slots[0]!.transceiver.sender
    spy.reset()
    const d1 = t.setDuplex('half'); await tick()
    answerLast(x, Op.TRACK_SET, { ssrc: 1000, duplex: 'half' }); await d1
    assert.deepEqual([spy.n('setDuplexRes'), spy.calls['setDuplexRes']![0]], [1, [{ duplex: 'half', noop: false, part: 'res' }]], 'SD-ENTRY-PUB-SET-DUPLEX-RES① — 응답 하나에 입구 하나')
    assert.equal(planOf(spy, 'setDuplexRes').label, 'PUB.C.SENDING.set_half', '결합 코드 ENTRY 를 지난다')
    assert.deepEqual([t.state, t.core.gateOpen, s.replaced.at(-1), x.room.core.floor.st.hasHalf], ['registered', false, null, true], 'SD-ENTRY-PUB-SET-DUPLEX-RES② — 게이트 닫힘 · registered · 발언권에 반이중 발행(floor.reg_half)')
    const d2 = t.setDuplex('full'); await tick()
    answerLast(x, Op.TRACK_SET, { ssrc: 1000, duplex: 'full' }); await d2; await tick()
    assert.equal(planOf(spy, 'setDuplexRes').label, 'PUB.C.REGISTERED.set_full')
    assert.deepEqual([t.state, t.core.gateOpen, t.core.duplex], ['sending', true, 'full'], 'SD-ENTRY-PUB-SET-DUPLEX-RES③ — 게이트 열림 · sending')
    // 그 사이 발행이 끝났다(권한 회수) — 옛 발행의 응답은 반이중 여부를 바꾸지 않는다
    const d3 = t.setDuplex('half').catch((e: unknown) => e); await tick()
    await note(x.r, Op.TRACK_EVENT, { action: 'remove', room_id: 'r1', tracks: [{ type: 'individual', room_id: 'r1', track_id: 't-mic', kind: 'audio', user_id: 'u1' }], version: vers(2) })
    answerLast(x, Op.TRACK_SET, { ssrc: 1000, duplex: 'half' })
    const e = await d3
    assert.equal(planOf(spy, 'setDuplexRes').label, 'PUB.C.any.set_res_gone')
    assert.deepEqual([t.core.st.half, e instanceof OxLensError && e.category], [false, 'closed'], 'SD-ENTRY-PUB-SET-DUPLEX-RES④ — 반이중 여부 변화 0 · 기다리던 setDuplex() 는 closed')
  } finally { spy.restore() }
})

test('SD-EFFECT-PUB-APP-DUPLEX — 위 효과 app.duplex(응답 · noop 포함)는 기다리던 setDuplex() resolve · 게이트 · enabled · 발언권 · 프로필은 응답 뒤에만 · 결합 plan() 이 낸다', async () => {
  assert.equal(PBn.effect('app.duplex').event, 'duplexApplied', 'SD-EFFECT-PUB-APP-DUPLEX — 효과 표: app.duplex → duplexApplied')
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    const m = t.setMuted(true); await tick(); answerLast(x, Op.TRACK_SET, { ssrc: 1000, muted: true }); await m
    const dev = t.mediaStreamTrack as unknown as FT
    let done = false
    const d = t.setDuplex('half').then(() => { done = true })
    await tick()
    assert.deepEqual([done, dev.enabled, t.core.gateOpen], [false, false, true], 'SD-EFFECT-PUB-APP-DUPLEX② — 응답 전에는 enabled · 게이트 그대로')
    answerLast(x, Op.TRACK_SET, { ssrc: 1000, duplex: 'half' }); await d
    assert.deepEqual(planOf(spy, 'setDuplexRes').events, ['duplexApplied'], 'SD-EFFECT-PUB-APP-DUPLEX — 결합 plan() 이 낸다')
    assert.deepEqual([done, dev.enabled, t.muted, t.core.gateOpen, t.core.profile], [true, true, false, false, 'ptt'], 'SD-EFFECT-PUB-APP-DUPLEX①② — resolve · enabled=true · 게이트 닫힘 · 프로필 ptt(응답 뒤)')
    // noop — 서버가 이미 그 상태라고 하면 바꿀 것 없이 resolve
    const n = t.setDuplex('full'); await tick()
    answerLast(x, Op.TRACK_SET, { ssrc: 1000, noop: true }); await n
    assert.deepEqual([planOf(spy, 'setDuplexRes').label, planOf(spy, 'setDuplexRes').events], ['PUB.C.any.set_noop', ['duplexApplied']], 'SD-EFFECT-PUB-APP-DUPLEX① — noop 도 app.duplex 로 resolve')
  } finally { spy.restore() }
})

test('SD-EFFECT-PUB-APP-DUPLEX-FAILED — 위 효과 app.duplex_failed(거절 · 그 사이 발행이 끝남)는 기다리던 setDuplex() reject(응답 코드의 분류 · 끝났으면 closed) · 게이트 · 반이중 여부 변화 0 · 결합 plan() 이 낸다', async () => {
  assert.equal(PBn.effect('app.duplex_failed').event, 'duplexFailed', 'SD-EFFECT-PUB-APP-DUPLEX-FAILED — 효과 표: app.duplex_failed → duplexFailed')
  const spy = spyOn()
  try {
    const x = await pubUp()
    const t = await mic(x)
    const d = t.setDuplex('half').catch((e: unknown) => e); await tick()
    answerLast(x, Op.TRACK_SET, FAIL(3009, 'TRACK_OP_UNSUPPORTED'), false)
    const e = await d
    assert.deepEqual(planOf(spy, 'setDuplexRes').events, ['duplexFailed'], 'SD-EFFECT-PUB-APP-DUPLEX-FAILED — 결합 plan() 이 낸다(PUB.C.any.set_fail)')
    assert.deepEqual([e instanceof OxLensError && e.code, e instanceof OxLensError && e.category], [3009, 'state'], 'SD-EFFECT-PUB-APP-DUPLEX-FAILED① — 응답 코드의 분류로 reject')
    assert.deepEqual([t.state, t.core.gateOpen, t.core.duplex], ['sending', true, 'full'], 'SD-EFFECT-PUB-APP-DUPLEX-FAILED② — 게이트 · 반이중 여부 변화 0')
  } finally { spy.restore() }
})

test('SD-API-CLIENT-SET-SPEAKING-ROOM④ — 새 서버가 거절하면 옛 방으로 되돌린다(연:AFF.C.PUB.switch_back) · 트랙은 옛 서버에 다시 add', async () => {
  const x = await xsfu()
  const sw = x.r.c.setSpeakingRoom('r3').catch((e: unknown) => e)
  await affAnswer(x, { sub_rooms: ['r1'], pub_room: null, cause: 'user' })
  answerLast(x, Op.PUBLISH_TRACKS, { action: 'remove' }); await tick(); await tick()
  await affAnswer(x, FAIL(2006, 'NOT_AUTHORIZED', { denied: ['publish_audio'] }), false)
  const e = await sw
  assert.ok(e instanceof OxLensError && e.code === 2006, 'SD-API-CLIENT-SET-SPEAKING-ROOM④ — setSpeakingRoom() 은 그 실패로 reject')
  assert.deepEqual(x.r.ws.last(Op.AFFILIATION).body, { pub_select: 'r1' }, 'SD-API-CLIENT-SET-SPEAKING-ROOM④ — 옛 방 pub_select(되돌림)')
  const adds = pubReqs(x, 'add').length
  await affAnswer(x, { sub_rooms: ['r1'], pub_room: 'r1', cause: 'user' })
  await drain(x.r, SA)
  assert.deepEqual([x.r.c.speakingRoom?.id, x.mic.server, pubReqs(x, 'add').slice(adds).map((b) => b.room_id)], ['r1', 'sfu-a', ['r1']], 'SD-API-CLIENT-SET-SPEAKING-ROOM④ — 발언 방은 옛 방 · 트랙은 옛 서버에 다시 add')
  answerAdd(x, 't-mic-back'); await tick(); await tick()
  assert.equal(x.mic.state, 'sending')
})
