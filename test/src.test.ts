// author: kodeholic (powered by Claude)
// SDK:RULE-SRC-DEVICES · SDK:IMPL-SRC-BLOCKS — 소스 · 장치(SRC — 가로지르는 것) 1층. 장치 목록 · 브라우저 손잡이 맵핑표 가운데 발행(PUB) 시험 밖에 남은 칸(목록 · 발행 구조 · duplex · 레이어)을 단위(SD-API-MEDIA-DEVICES-LIST · SD-KNOB-*)마다 잰다.
// 브라우저 없이 — 가짜 WebSocket(test/_ws) · 가짜 navigator · 가짜 발행 PeerLink(test/_pub) · ★진짜 PeerLink(internal/link/transport) 위에 가짜 RTCPeerConnection(이 파일).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tick } from './_ws.js'
import { SA, up, linkOf, enter, fakeTrack, type Rig } from './_rig.js'
import { nav, dev, pubUp, mic, settlePublish, answerLast, pubReqs, live, type FT } from './_pub.js'
import { PUB_OFFER, SC } from './_fixtures.js'
import { Op, type TrackEntry, type MlineEntry } from '../src/internal/wire/ws.js'
import { PeerLink } from '../src/internal/link/transport.js'
import type { Logger } from '../src/platform/log.js'

// ══ 가짜 RTCPeerConnection — platform/webrtc.createPeerConnection 이 부르는 전역 ════════════════════

type Desc = { type: string; sdp?: string }
interface Tr { mid: string | null; direction: string; kind: string; init: { direction?: string; sendEncodings?: unknown[] } | null; sender: object; receiver: { track: unknown } }

class FakePC {
  static made: FakePC[] = []
  iceConnectionState = 'new'
  signalingState = 'stable'
  localDescription: Desc | null = null
  remoteDescription: Desc | null = null
  oniceconnectionstatechange: (() => void) | null = null
  ontrack: (() => void) | null = null
  sctp = null
  /** addTransceiver 로 SDK 가 만든 것(init 을 남긴다) · 서버 offer 로 브라우저가 만든 것(init null) */
  readonly trs: Tr[] = []
  constructor() { FakePC.made.push(this) }
  createDataChannel(): object { return { readyState: 'connecting', close: () => undefined } }
  addTransceiver(kind: string, init: { direction?: string; sendEncodings?: unknown[] }): Tr {
    const t: Tr = { mid: null, direction: init.direction ?? 'sendrecv', kind, init: { ...init }, sender: {}, receiver: { track: fakeTrack(kind) } }
    this.trs.push(t)
    return t
  }
  getTransceivers(): Tr[] { return this.trs }
  async createOffer(): Promise<Desc> { return { type: 'offer', sdp: PUB_OFFER } }
  async createAnswer(): Promise<Desc> { return { type: 'answer', sdp: this.remoteDescription?.sdp ?? '' } }
  async setLocalDescription(d: Desc): Promise<void> {
    if (d.type === 'rollback') { this.signalingState = 'stable'; return }
    this.localDescription = d
    // 브라우저는 로컬 offer 를 적용하며 트랜시버에 mid 를 매긴다(만든 차례)
    if (d.type === 'offer') this.trs.forEach((t, i) => { if (t.mid === null) t.mid = String(i) })
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: Desc): Promise<void> {
    this.remoteDescription = d
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'
    if (d.type !== 'offer') return
    // 서버(합성) offer 의 새 절마다 브라우저가 트랜시버를 만든다(recvonly 로 — 보내기 방향은 SDK 가 고친다)
    let kind = ''
    for (const l of (d.sdp ?? '').split('\r\n')) {
      if (l.startsWith('m=')) kind = l.slice(2).split(' ')[0]!
      const mid = l.startsWith('a=mid:') ? l.slice(6) : null
      if (mid !== null && kind !== 'application' && !this.trs.some((t) => t.mid === mid)) this.trs.push({ mid, direction: 'recvonly', kind, init: null, sender: {}, receiver: { track: fakeTrack(kind) } })
    }
  }
  async getStats(): Promise<Map<string, unknown>> { return new Map() }
  close(): void { this.signalingState = 'closed' }
}
;(globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC

const log: Logger = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger
const LOW_FIRST = [{ rid: 'l', scaleResolutionDownBy: 2, maxBitrate: 250000 }, { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 1650000 }]

async function rig(): Promise<Rig> { const r = await up(); live.push(r); return r }

// ══ 장치 목록(SDK:RULE-SRC-DEVICES) ═════════════════════════════════════════════════════════════════

test('SD-API-MEDIA-DEVICES-LIST — 권한 전엔 label 이 빈 문자열(브라우저 사실 그대로) · groupId 칸이 있다 · requestPermissions 가 프롬프트(획득)를 띄운 뒤 목록 · \'default\' 는 groupId 로 실제 장치에 정규화', async () => {
  const pre = [dev('audioinput', '', '', ''), dev('videoinput', '', '', ''), dev('audiooutput', '', '', '')]
  const post = [
    dev('audioinput', 'default', 'Default - Headset Mic', 'g-head'), dev('audioinput', 'mic-int', 'Built-in Mic', 'g-int'), dev('audioinput', 'mic-head', 'Headset Mic', 'g-head'),
    dev('audiooutput', 'default', 'Default - Headset', 'g-head'), dev('audiooutput', 'spk-int', 'Built-in Speaker', 'g-int'), dev('audiooutput', 'spk-head', 'Headset', 'g-head'),
    dev('videoinput', 'cam-1', 'FaceTime', 'g-cam'),
  ]
  const md = (globalThis.navigator as unknown as { mediaDevices: { getUserMedia: (c: unknown) => Promise<unknown> } }).mediaDevices
  const gum = md.getUserMedia
  let prompts = 0
  md.getUserMedia = async (c) => { prompts += 1; nav.devices = post; return gum(c) }
  try {
    nav.devices = pre
    const r = await rig()
    const before = await r.c.media.devices.list()
    assert.deepEqual([before.length, prompts], [3, 0], '권한 전 — 프롬프트 없이 목록')
    assert.ok(before.every((d) => d.label === '' && 'groupId' in d && typeof d.groupId === 'string'), 'SD-API-MEDIA-DEVICES-LIST — 권한 전 label \'\' · groupId 칸 있음')
    const after = await r.c.media.devices.list({ requestPermissions: true })
    assert.equal(prompts, 1, 'SD-API-MEDIA-DEVICES-LIST — requestPermissions 가 프롬프트(획득 하나)를 띄운다')
    assert.ok(after.every((d) => d.label !== '' && d.groupId !== ''), 'SD-API-MEDIA-DEVICES-LIST — 권한 뒤 label · groupId 가 있다')
    assert.deepEqual(after.map((d) => `${d.kind}:${d.deviceId}`), ['audioinput:mic-head', 'audioinput:mic-int', 'audiooutput:spk-head', 'audiooutput:spk-int', 'videoinput:cam-1'], 'SD-API-MEDIA-DEVICES-LIST — \'default\' 는 같은 groupId 의 실제 장치로(겹친 것은 하나 · OS 기본이 앞)')
    const mics = await r.c.media.devices.list({ kind: 'audioinput' })
    assert.deepEqual(mics.map((d) => d.deviceId), ['mic-head', 'mic-int'], 'kind 로 거른다')
  } finally { md.getUserMedia = gum }
})

// ══ 브라우저 손잡이(SDK:IMPL-SRC-BLOCKS) ═════════════════════════════════════════════════════════════

test('SD-KNOB-PUBLISH — sendEncodings 는 addTransceiver 때(낮은 품질부터 — 앱이 다른 차례로 줘도) · 같은 kind · 구조의 쉬는 자리 재활용 · 없으면 1pc 는 합성 offer 로 절을 더하고 브라우저가 만든 트랜시버를 보내기로', async () => {
  // SDK 가 만드는 레이어 차례 — 기본값 · 앱이 거꾸로 준 레이어 모두 l → h
  const x = await pubUp()
  const cam = x.r.c.media.enableCamera({ simulcast: true, encoding: { layers: [...LOW_FIRST].reverse() } } as never)
  await settlePublish(x, 't-cam'); await cam
  const encs = x.peer.slots[0]!.encodings as { rid: string }[]
  assert.deepEqual(encs.map((e) => e.rid), ['l', 'h'], 'SD-KNOB-PUBLISH — 앱이 h → l 로 줘도 sendEncodings 는 낮은 품질부터')
  // 2pc — 진짜 PeerLink: 구조(sendEncodings)는 addTransceiver 때 · 재활용
  FakePC.made.length = 0
  const p2 = new PeerLink('2pc', SC, 'minptime=10;useinbandfec=1', log)
  const pc = FakePC.made[0]!
  const room = { name: 'H264' }
  const sim = p2.acquireSlot('video', true, LOW_FIRST, room, '')
  assert.deepEqual(pc.trs.map((t) => [t.kind, t.init?.direction, (t.init?.sendEncodings as { rid: string }[] | undefined)?.map((e) => e.rid)]), [['video', 'sendonly', ['l', 'h']]], 'SD-KNOB-PUBLISH — 시뮬캐스트 구조는 addTransceiver({sendEncodings}) 때 · 낮은 품질부터')
  const single = p2.acquireSlot('video', false, [], room, '')
  assert.equal(pc.trs[1]!.init?.sendEncodings, undefined, '단일 레이어는 sendEncodings 없이')
  p2.releaseSlot(single)
  const again = p2.acquireSlot('video', false, [], room, '')
  assert.deepEqual([again === single, pc.trs.length], [true, 2], 'SD-KNOB-PUBLISH — 같은 kind · 같은 구조의 쉬는 자리를 되쓴다(addTransceiver 0)')
  p2.releaseSlot(sim)
  p2.acquireSlot('video', false, [], room, '')
  assert.equal(pc.trs.length, 3, 'SD-KNOB-PUBLISH — 구조가 다르면(시뮬캐스트 ↔ 단일) 재활용 불가 — 새 트랜시버')
  p2.close()
  // 1pc — 첫 협상(audio 1 + video 1) 뒤 맞는 자리가 없으면 합성 offer 로 절을 더한다
  FakePC.made.length = 0
  const p1 = new PeerLink('1pc', null, 'minptime=10;useinbandfec=1', log)
  const pc1 = FakePC.made[0]!
  await p1.first1pc()
  assert.equal((await p1.complete1pc({ ...SC, pc_mode: '1pc' })).ok, true)
  const adds = pc1.trs.filter((t) => t.init !== null).length
  const first = p1.acquireSlot('video', false, [], room, '')
  assert.equal(first.transceiver, pc1.trs[1] as unknown as RTCRtpTransceiver, 'SD-KNOB-PUBLISH — 1pc 첫 카메라는 첫 협상의 video 절에 붙는다(재활용)')
  const extra = p1.acquireSlot('video', true, LOW_FIRST, room, '')
  assert.equal(pc1.trs.filter((t) => t.init !== null).length, adds, 'SD-KNOB-PUBLISH — 1pc 는 addTransceiver 를 부르지 않는다')
  assert.equal((await p1.negotiate()).ok, true)
  const made = pc1.trs.find((t) => t.init === null && t.mid === extra.mid)
  assert.ok(made, `SD-KNOB-PUBLISH — 합성 offer 의 새 절(mid ${extra.mid})에 브라우저가 트랜시버를 만들었다`)
  assert.deepEqual([extra.transceiver === (made as unknown as RTCRtpTransceiver), made!.direction], [true, 'sendonly'], 'SD-KNOB-PUBLISH — 그 트랜시버를 SDK 가 보내기(sendonly)로 돌린다')
  p1.close()
})

test('SD-KNOB-SET-DUPLEX — setDuplex 의 손잡이는 wire 만(TRACK_SET{duplex} 하나) · 그 호출이 부르는 브라우저 손잡이 0(sender · track 그대로 — 응답 뒤 게이트 · 프로필은 그 표 칸의 몫)', async () => {
  const x = await pubUp()
  const t = await mic(x)
  const s = x.peer.slots[0]!.transceiver.sender
  const dev0 = t.mediaStreamTrack as unknown as FT
  const before = { sent: x.r.ws.sent.length, replaced: s.replaced.length, params: s.params.length, applied: dev0.applied.length, enabled: dev0.enabled, assembled: x.peer.assembled }
  const d = t.setDuplex('half'); await tick()
  assert.deepEqual(x.r.ws.frames().slice(before.sent).filter((f) => f.kind === 'request').map((f) => [f.op, f.body]), [[Op.TRACK_SET, { room_id: 'r1', track_id: 't-mic', duplex: 'half' }]], 'SD-KNOB-SET-DUPLEX — wire 는 TRACK_SET{duplex} 하나')
  assert.deepEqual([s.replaced.length, s.params.length, dev0.applied.length, dev0.enabled, x.peer.assembled], [before.replaced, before.params, before.applied, before.enabled, before.assembled], 'SD-KNOB-SET-DUPLEX — 브라우저 손잡이 0(replaceTrack · setParameters · applyConstraints · enabled · 재협상)')
  answerLast(x, Op.TRACK_SET); await d
  assert.equal(pubReqs(x).length, 1, '재발행 0')
})

test('SD-KNOB-SET-LAYER — setLayer 의 손잡이는 wire 만(SUBSCRIBE_LAYER) · 수신 트랜시버 · 트랙 · 협상에 손대지 않는다', async () => {
  const r = await rig()
  linkOf(r, SA)
  const touched: string[] = []
  const track = fakeTrack('video')
  const receiver = new Proxy({ track, getStats: async () => new Map() } as Record<string, unknown>, {
    get: (o, k) => { if (typeof o[k as string] === 'function') touched.push(`call:${String(k)}`); return o[k as string] },
    set: (o, k, v) => { touched.push(`set:${String(k)}`); o[k as string] = v; return true },
  })
  r.peers.get('sfu-a')!.rx.set('0', receiver as never)
  const tr: TrackEntry = { type: 'individual', room_id: 'r1', track_id: 't2', kind: 'video', user_id: 'u2', scalability: 'L3T3' }
  const row: MlineEntry = { mid: '0', kind: 'video', pt: 102, codec: 'H264', ssrc: 2147480000, stream_id: 'ox-m0', track_id: 't2', room_id: 'r1' }
  const h = await enter(r, 'r1', { tracks: [tr], mlines: [row] })
  const t = h.tracks[0]!
  const peer = r.peers.get('sfu-a')!
  const asm = peer.assembled
  const sent = r.ws.sent.length
  touched.length = 0
  const p = t.setLayer({ spatial: 1, temporal: 2, paused: false })
  await tick()
  r.ws.answer(r.ws.last(Op.SUBSCRIBE_LAYER), {})
  await p
  assert.deepEqual(r.ws.frames().slice(sent).filter((f) => f.kind === 'request').map((f) => f.op), [Op.SUBSCRIBE_LAYER], 'SD-KNOB-SET-LAYER — wire 는 SUBSCRIBE_LAYER 하나')
  assert.deepEqual([touched, peer.assembled, (track as unknown as { muted: boolean }).muted], [[], asm, true], 'SD-KNOB-SET-LAYER — 브라우저 손잡이 0(수신 트랜시버 · 트랙 · 재협상 무변)')
})
