// author: kodeholic (powered by Claude)
// 한 명령 게이트. 통과·실패·미실행을 다른 표시로 쓰고, 미실행에는 사유를 붙인다
// — "못 쟀다"가 초록으로 새지 않게 한다.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const live = process.argv.includes('--live')
const rows = []

function step(name, cmd, args, cwd = root, env = undefined) {
  const t = Date.now()
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false, env: env ? { ...process.env, ...env } : process.env })
  const ok = r.status === 0
  rows.push({ name, mark: ok ? 'PASS' : 'FAIL', note: `${Date.now() - t}ms` })
  return ok
}

function skip(name, why) {
  rows.push({ name, mark: 'SKIP', note: why })
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
let ok = true
ok = step('typecheck', npx, ['tsc', '--noEmit', '-p', 'tsconfig.json']) && ok
ok = step('arch', process.execPath, ['tools/arch_check.mjs']) && ok
ok = step('3층 좌표', process.execPath, ['tools/qa_spec_check.mjs']) && ok
ok = step('build', npx, ['tsc', '-p', 'tsconfig.build.json']) && ok
ok = step('1층 단위', process.execPath, ['test/run.mjs']) && ok
// ★3층 앞에 빌드를 강제한다 — SDK 를 고치고 빌드를 잊으면 옛 코드를 시험하고 초록을 받는다.

const liveDir = join(root, 'qa', 'live')
// ★3층 회차 자리 — 한 번 쓰는 폴더 하나(보관소 규칙 · 회고 55 · 20261023): record.json · report-<판>.json(Playwright) · trace/(실패 때)
// 현지 시각 — 2층 회차 ID(e2e-YYYYMMDD-HHMMSS)와 같은 시계로 읽게
const now = new Date()
const two = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
const runDir = join(root, '.archive', 'gate-live', `live-${stamp}`)
if (!live) {
  skip('3층 정규', '--live 를 안 줬다')
  skip('3층 갈래B', '--live 를 안 줬다')
} else if (!existsSync(join(liveDir, 'package.json'))) skip('3층 라이브', 'qa/live 가 아직 없다')
else {
  mkdirSync(runDir, { recursive: true })
  const pw = (project) => ['playwright', 'test', `--project=${project}`, '--reporter=list,json']
  ok = step('3층 정규', npx, pw('chromium'), liveDir, { PLAYWRIGHT_JSON_OUTPUT_NAME: join(runDir, 'report-chromium.json') }) && ok
  ok = step('3층 갈래B', npx, pw('chromium-fault'), liveDir, { PLAYWRIGHT_JSON_OUTPUT_NAME: join(runDir, 'report-chromium-fault.json') }) && ok
  if (!ok && existsSync(join(liveDir, 'test-results'))) cpSync(join(liveDir, 'test-results'), join(runDir, 'trace'), { recursive: true })
}

console.log('')
for (const r of rows) console.log(`  ${r.mark.padEnd(5)} ${r.name.padEnd(12)} ${r.note}`)
console.log(rows.some((r) => r.mark === 'SKIP') ? '\n  ★SKIP 은 통과가 아니다 — 사유를 읽는다.' : '')
// ★3층 회차 기록 — 보관소(.archive/)에 남긴다. 서버 · SDK 의 push 전 확인(.githooks/pre-push)이 이 기록을 본다:
//   「그 빌드로 3층을 돌려 통과했나」. 기록이 없으면 push 가 막힌다 — 2층 초록만으로 미디어 변경이 나가지 않게.
if (live) await keepLiveRecord(ok)
process.exit(ok ? 0 : 1)

async function keepLiveRecord(passed) {
  const hub = process.env.OXE2E_HUB ?? '127.0.0.1:19745'
  let server = null
  try {
    const res = await fetch(`http://${hub}/healthz/ready`)
    server = (await res.json()).build ?? null
  } catch {
    server = null
  }
  const sha = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim() !== ''
  const rec = { at: new Date().toISOString(), run: `live-${stamp}`, passed, sdk_sha: sha, sdk_dirty: dirty, server_build: server, hub, rows }
  const body = JSON.stringify(rec, null, 1) + '\n'
  writeFileSync(join(runDir, 'record.json'), body, { flag: 'wx' })
  writeFileSync(join(root, '.archive', 'gate-live', 'latest.json'), body)
  rotateLive(join(root, '.archive', 'gate-live'), `live-${stamp}`)
  console.log(`  ⓘ 3층 회차 기록: .archive/gate-live/live-${stamp}/ (server ${server ?? '모름'} · sdk ${sha}${dirty ? '-dirty' : ''}) · latest.json 갱신`)
}

/** 3층 회차도 2층과 같은 등급 — context 기록이 인용한 `live-…` 는 고정, 그 밖은 최근 30 개(지금 회차는 남긴다). */
function rotateLive(dir, current) {
  const ctx = resolve(root, '..', '..', 'context')
  const pinned = new Set()
  for (const m of existsSync(ctx) ? readdirSync(ctx).filter((x) => /^20\d{4}$/.test(x)) : []) {
    for (const f of readdirSync(join(ctx, m)).filter((x) => x.endsWith('.md'))) {
      for (const id of readFileSync(join(ctx, m, f), 'utf8').match(/\blive-\d{8}-\d{6}\b/g) ?? []) pinned.add(id)
    }
  }
  const old = readdirSync(dir).filter((x) => x.startsWith('live-') && x !== current && !pinned.has(x)).sort()
  for (const x of old.slice(0, Math.max(0, old.length - 29))) rmSync(join(dir, x), { recursive: true, force: true })
}
