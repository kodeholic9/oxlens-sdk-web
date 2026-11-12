// author: kodeholic (powered by Claude)
// ★실측(probe) A5 — AI 에이전트 브리지(SDK:RULE-PLAT-AGENT) 너머에 실제 모델(ASR → LLM → TTS) 데모 뒷단을 붙였을 때의 응답 지연.
//   크로뮴 가짜 마이크가 질문 wav 를 말한다(실 인코더) → 브리지 → 데모 뒷단(labs aidemo) → 브리지가 발언권을 잡고 냄 → 청취 브라우저가 디코드.
//   놓음 → 청취자에게 에이전트 화자 통지까지 · 브리지 요약의 응답 지연 둘(턴 끝 → AI 첫 음성 = 고객 몫 · AI 첫 음성 → 첫 RTP = 브리지 몫).
//   판정이 아니라 수치다 — 정규 게이트 밖(chromium-probe). 데모 뒷단과 LLM 서버는 미리 띄운다(`AIDEMO_URL` — 없으면 실패한다).
//   결과는 `test-results/probe/a5_bridge_ai.json`.
import { chromium, test } from '@playwright/test'
import { Participant, Scope, ensureRoom, expect } from '../../fixtures/scope.js'
import { TrackStat } from '../../fixtures/delta.js'
import { buildPeer, runPeer } from '../../fixtures/oxpeer.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const S = new Scope('peer_a5')

test.beforeAll(() => { buildPeer() })
test.afterEach(async () => { await S.teardown() })

const AI_URL = process.env.AIDEMO_URL ?? 'ws://127.0.0.1:8765/agent'
const WAVS = process.env.AIDEMO_WAVS ?? join(homedir(), '.local/share/oxlens-aidemo/out/supertonic/q')
const LEAD_S = 1.0
const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']

const slot = (t: TrackStat): boolean => t.kind === 'audio' && t.id.startsWith('ptt-')
const lastSpeaker = (p: Participant): Promise<{ at: number; userId: string | null } | null> =>
  p.call<{ at: number; detail: { userId: string | null } }[]>('events', 'speaker').then((e) => {
    const x = e.at(-1)
    return x ? { at: x.at, userId: x.detail.userId } : null
  })

/** 질문 wav 를 크로뮴 가짜 마이크가 읽는 꼴로 — 앞 무음 LEAD_S(마이크 데움과 누름 사이) · 뒤 무음 0.5초 · 48kHz 16비트 */
function padded(src: string, dir: string): { file: string; secs: number } {
  const file = join(dir, src.split('/').pop()!)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-af', `adelay=${LEAD_S * 1000}:all=1,apad=pad_dur=0.5`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file])
  const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString())
  return { file, secs }
}

test('A5 실제 모델 데모 뒷단 — 놓음에서 에이전트 목소리까지', { annotation: { type: 'spec', description: 'SDK:RULE-PLAT-AGENT · SDK:RULE-PLAT-AGENT-SILENCE' } }, async ({ browser }) => {
  test.setTimeout(420_000)
  const ROOM = S.room('demo')
  await ensureRoom(ROOM)
  const AGENT = S.user('AGENT')
  const tmp = mkdtempSync(join(tmpdir(), 'aidemo-a5-'))
  const qs = readdirSync(WAVS).filter((f) => f.endsWith('.wav')).sort().map((f) => padded(join(WAVS, f), tmp))
  const secs = Math.ceil(qs.reduce((s, q) => s + q.secs + 25, 20))

  const listener = await S.open(await browser.newContext(), { userId: S.user('U02') })
  await listener.call('join', ROOM, 'listen')
  const br = runPeer('oxbridge-ai', ['--room', ROOM, '--ai-url', AI_URL, '--secs', String(secs), '--user', AGENT, '--rate', '24000', '--custom', 'wake=에이전트'])
  await br.joined

  const rows: Record<string, unknown>[] = []
  for (const [i, q] of qs.entries()) {
    const b = await chromium.launch({ args: [...MEDIA, `--use-file-for-fake-audio-capture=${q.file}`] })
    try {
      const speaker = await S.open(await b.newContext(), { userId: S.user(`U01_${i}`) })
      await speaker.call('join', ROOM, 'talk')
      const t0 = Date.now()
      await speaker.call('pttEnable', ROOM)
      await speaker.call('press', ROOM)
      await expect.poll(() => speaker.call<{ phase: string }>('ptt', ROOM).then((s) => s.phase), { message: '사람이 허가를 받는다' }).toBe('has_permission')
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + (q.secs - 0.3) * 1000 - Date.now())))
      await speaker.call('release', ROOM)
      const released = Date.now()

      await expect.poll(() => lastSpeaker(listener).then((s) => s?.userId), { message: '에이전트가 발언권을 잡는다', timeout: 20_000 }).toBe(AGENT)
      const agentAt = (await lastSpeaker(listener))!.at
      const s0 = (await listener.call<TrackStat[]>('trackStats')).find(slot)
      await expect.poll(() => lastSpeaker(listener).then((s) => s?.userId ?? null), { message: '에이전트가 다 말하고 놓는다', timeout: 40_000 }).toBe(null)
      const s1 = (await listener.call<TrackStat[]>('trackStats')).find(slot)
      rows.push({ q: i, turn_s: Number((q.secs - LEAD_S - 0.5).toFixed(2)), release_to_agent_ms: agentAt - released, agent_samples: (s1?.samplesReceived ?? 0) - (s0?.samplesReceived ?? 0), concealed: (s1?.concealed ?? 0) - (s0?.concealed ?? 0) })
      await speaker.call('teardown').catch(() => {})
    } finally {
      await b.close()
    }
  }
  const sum = await br.done
  const out = { ai_url: AI_URL, wavs: WAVS, rows, bridge: sum }
  mkdirSync('test-results/probe', { recursive: true })
  writeFileSync('test-results/probe/a5_bridge_ai.json', JSON.stringify(out, null, 2))
  process.stdout.write(`  [A5] ${JSON.stringify({ rows, lat_ai_ms: sum.lat_ai_ms, lat_bridge_ms: sum.lat_bridge_ms, replies: sum.replies, turns: sum.turns })}\n`)
  expect(Number(sum.orphan_sourced) + Number(sum.orphan_sourceless), '버그 계수(유예 창 밖 프레임) 0').toBe(0)
  expect(rows.length, '질문마다 답을 받았다').toBe(qs.length)
})
