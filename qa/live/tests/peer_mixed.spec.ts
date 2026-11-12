// author: kodeholic (powered by Claude)
// ★3층의 몫 — 서버사이드 SDK(oxpeer)와 브라우저가 한 방에서 ★실 코덱으로 주고받는다(context 202611/20261108d R9).
//   ① 브라우저(크로뮴 가짜 장치 — 실 인코더)가 발행하고 oxpeer 녹화기가 받아 쓴 파일이 끝까지 디코드된다(오류 0 · 프레임 있음).
//   ② oxpeer 에이전트가 ffmpeg 가 지은 진짜 Opus · H264 를 발행하고 브라우저가 실제로 디코드한다(프레임 · 샘플 차분 · 폭).
//   와이어(패킷 · seq · 신원)는 2층 labs 가 본다 — 여기는 디코더가 판정을 바꾸는 것만.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { flowOf, TrackStat } from '../fixtures/delta.js'
import { buildPeer, decode, decodeStream, makeSamples, runPeer } from '../fixtures/oxpeer.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const S = new Scope('peer_mixed')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

interface FileRow { file: string; who?: string; tracks: Array<{ kind: string; frames: number }> }

test('PEER-MIX-01 브라우저 발행을 oxpeer 녹화기가 받아 쓴 파일이 디코드된다', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-SERVER' } }, async ({ browser }) => {
  const ROOM = S.room('rec')
  await ensureRoom(ROOM)
  const ctx = await browser.newContext()
  const a = await S.open(ctx, { userId: S.user('U01') })
  await a.call('join', ROOM, 'talk')
  await a.call('enableMic')
  await a.call('enableCamera')
  const out = mkdtempSync(join(tmpdir(), 'oxpeer-rec-'))
  const rec = runPeer('oxrec', ['--room', ROOM, '--out', out, '--secs', '6', '--user', S.user('REC'), '--video'])
  await rec.joined
  const summary = await rec.done
  const files = (summary.files as FileRow[] | undefined) ?? []
  const mine = files.filter((f) => f.who === S.user('U01'))
  // ★사람마다 영상 · 음성 한 파일(SDK:RULE-PLAT-REC-MKV · context 202611/20261110e) — 파일 하나 · 트랙 둘
  expect(mine.length, '브라우저 사람의 파일이 하나 — 없으면 받지도 못했다').toBe(1)
  expect(mine[0].tracks.map((t) => t.kind).sort(), '한 파일에 오디오 · 영상').toEqual(['audio', 'video'])
  const d = decode(mine[0].file)
  expect(d.errors, '파일 디코드 오류 — 정리층 조립 · MKV 가 실 인코더 프레임을 깨뜨렸다').toBe('')
  expect(d.frames, '영상 스트림에 프레임이 있다(6초 녹화)').toBeGreaterThan(60)
  const audio = decodeStream(mine[0].file, 'a')
  expect(audio, '음성 스트림에 프레임이 있다(6초 녹화 · Opus 20ms)').toBeGreaterThan(150)
})

test('PEER-MIX-02 oxpeer 에이전트의 진짜 코덱 발행을 브라우저가 디코드한다', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-SERVER · SDK:IMPL-PUB-API' } }, async ({ browser }) => {
  const ROOM = S.room('agent')
  await ensureRoom(ROOM)
  const sm = makeSamples(3)
  const ctx = await browser.newContext()
  const b = await S.open(ctx, { userId: S.user('U02') })
  await b.call('join', ROOM, 'talk')
  const ag = runPeer('agent_echo', ['--room', ROOM, '--secs', '12', '--user', S.user('AGENT'), '--mode', 'file', '--opus', sm.opus, '--h264', sm.h264])
  await ag.joined
  const video = (t: TrackStat): boolean => t.kind === 'video' && !t.id.startsWith('ptt-')
  const audio = (t: TrackStat): boolean => t.kind === 'audio' && !t.id.startsWith('ptt-')
  await expect.poll(() => b.call<TrackStat[]>('trackStats').then((s) => s.find(video)?.videoWidth ?? 0), {
    message: '★패킷이 오는 것과 디코드되는 것은 다르다 — 폭이 0 이면 검은 화면이다(표본은 640x360)',
    timeout: 20_000,
  }).toBe(640)
  const vf = await flowOf(b, video)
  expect(vf, '영상 트랙이 사라지면 0 과 구별한다').not.toBeNull()
  expect(vf!.frames, '디코드한 프레임 차분 — 첫 프레임만 오고 멎으면 여기서 잡힌다').toBeGreaterThan(30)
  const s0 = (await b.call<TrackStat[]>('trackStats')).find(audio)
  await new Promise((r) => setTimeout(r, 2_500))
  const s1 = (await b.call<TrackStat[]>('trackStats')).find(audio)
  expect(s0 && s1, '오디오 트랙이 붙는다').toBeTruthy()
  const got = (s1!.samplesReceived ?? 0) - (s0!.samplesReceived ?? 0)
  const hid = (s1!.concealed ?? 0) - (s0!.concealed ?? 0)
  expect(got, '디코드한 오디오 샘플 차분(48kHz · 2.5초 ≈ 120000)').toBeGreaterThan(90_000)
  expect(hid, '은닉 샘플이 받은 것의 10% 를 넘지 않는다 — 송신 시계가 고르게 낸다').toBeLessThan(got / 10)
  await ag.done
})
