// author: kodeholic (powered by Claude)
// 서버사이드 SDK(oxpeer) 를 3층에 섞는다(context 202611/20261108d R9) — 브라우저와 서버사이드 참가자가 한 방에서 주고받는다.
// ★3층의 몫만 본다 — 실 인코더(크로뮴 가짜 장치)의 프레임을 oxpeer 가 받아 파일로 쓰면 그 파일이 디코드되나 · oxpeer 가 낸 진짜 코덱 표본(ffmpeg)을 브라우저가 디코드하나.
// oxpeer 실행 파일 · 예제(녹화기 oxrec · 에이전트 예제 agent_echo · AI 브리지 oxbridge-ai — 워크스페이스 crates/ 꼴 context 202611/20261112g)는 하네스가 짓고 띄워 ★결과물만 읽는다(2층 labs 와 같은 출처 분리). cargo · ffmpeg 가 없으면 건너뛰지 않고 실패한다(값이 0 ≠ 못 쟀다).
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE } from './env.js'

/** `oxlens/oxlens-sdk-peer` — 이 저장소(`oxlens/oxlens-sdk-web`) 옆 */
export const PEER_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'oxlens-sdk-peer')
const EXAMPLE = (name: string): string => join(PEER_REPO, 'target', 'debug', 'examples', name)

/** 실행 파일 · 예제를 짓는다 — 옛 바이너리로 넘어가지 않는다. ★rawtool 은 기능 `record` 가 있어야 지어진다(oxpeer Cargo `required-features` — 202611/20261110b) */
export function buildPeer(): void {
  execFileSync('cargo', ['build', '--offline', '-p', 'oxpeer', '--features', 'record', '--example', 'agent_echo', '--example', 'rawtool'], { cwd: PEER_REPO, stdio: 'pipe' })
  // 녹음 · 녹화(oxrec) · AI 에이전트 브리지(oxbridge-ai — SDK:RULE-PLAT-AGENT · context 202611/20261112a) — 워크스페이스 멤버 실행 파일
  execFileSync('cargo', ['build', '--offline', '-p', 'oxrec', '-p', 'oxbridge-ai'], { cwd: PEER_REPO, stdio: 'pipe' })
}

/** ffmpeg 로 진짜 표본 — Opus(20ms) · H264(baseline · AUD 경계 · GOP 30) · VP8(IVF) */
export function makeSamples(secs = 3): { dir: string; opus: string; h264: string; vp8: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oxpeer-3l-'))
  const ff = (...a: string[]): void => { execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: 'pipe' }) }
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', String(secs)]
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(secs), '-c:a', 'libopus', '-frame_duration', '20', '-b:a', '32k', join(dir, 'a.ogg'))
  ff(...src, '-c:v', 'libx264', '-profile:v', 'baseline', '-tune', 'zerolatency', '-g', '30', '-x264-params', 'aud=1', '-f', 'h264', join(dir, 'v.h264'))
  ff(...src, '-c:v', 'libvpx', '-deadline', 'realtime', '-g', '30', '-b:v', '800k', join(dir, 'v.ivf'))
  return { dir, opus: join(dir, 'a.ogg'), h264: join(dir, 'v.h264'), vp8: join(dir, 'v.ivf') }
}

export interface PeerRun {
  /** 입장 줄이 나오면 풀린다 */
  readonly joined: Promise<void>
  /** 끝나면 표준 출력 마지막 JSON 줄 */
  readonly done: Promise<Record<string, unknown>>
}

/** 실행 파일 · 예제 하나를 띄운다 — `[agent_echo]`/`[oxrec]`/`[oxbridge-ai]` 의 「들어왔다」 줄을 기다리고 · 끝나면 요약 JSON */
export function runPeer(name: 'agent_echo' | 'oxrec' | 'oxbridge-ai', args: string[]): PeerRun {
  const bin = name === 'agent_echo' ? EXAMPLE(name) : join(PEER_REPO, 'target', 'debug', name)
  const p = spawn(bin, ['--base', BASE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let joinedResolve: () => void = () => {}
  const joined = new Promise<void>((res) => { joinedResolve = res })
  p.stdout.on('data', (d: Buffer) => { out += d.toString() })
  p.stderr.on('data', (d: Buffer) => {
    err += d.toString()
    if (err.includes('들어왔다')) joinedResolve()
  })
  const done = new Promise<Record<string, unknown>>((res, rej) => {
    p.on('close', (code) => {
      const line = out.split('\n').filter((x) => x.startsWith('{')).pop()
      if (code !== 0 || !line) rej(new Error(`${name} 실패(rc=${code}) — ${err.slice(-600)}`))
      else res(JSON.parse(line) as Record<string, unknown>)
    })
  })
  return { joined, done }
}

/** ffmpeg 로 그 파일을 끝까지 디코드한다 — 오류 줄(없으면 빈 문자열) · ffprobe 프레임 수 */
export function decode(file: string): { errors: string; frames: number } {
  let errors = ''
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    errors = String((e as { stderr?: Buffer }).stderr ?? e)
  }
  const n = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', '0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim()
  return { errors: errors.trim(), frames: Number.parseInt(n, 10) || 0 }
}

/** 그 파일의 한 종류 스트림(`v` · `a`) 디코드 프레임 수 — 사람마다 영상 · 음성 한 파일(202611/20261110e) */
export function decodeStream(file: string, kind: 'v' | 'a'): number {
  const n = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', kind, '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim()
  return Number.parseInt(n, 10) || 0
}

export const readJson = (f: string): unknown => JSON.parse(readFileSync(f, 'utf8'))

/** rawtool 하위 명령 하나 — 표준 출력 JSON(원시 파트 읽기 · SDK:RULE-PLAT-REC-RAW) */
export function rawtool(args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(EXAMPLE('rawtool'), args, { maxBuffer: 256 * 1024 * 1024 }).toString()) as Record<string, unknown>
}

