// author: kodeholic (powered by Claude)
// 한 명령 게이트. 통과·실패·미실행을 다른 표시로 쓰고, 미실행에는 사유를 붙인다
// — "못 쟀다"가 초록으로 새지 않게 한다.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const live = process.argv.includes('--live')
const rows = []

function step(name, cmd, args, cwd = root) {
  const t = Date.now()
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false })
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
ok = step('build', npx, ['tsc', '-p', 'tsconfig.build.json']) && ok
ok = step('1층 단위', process.execPath, ['test/run.mjs']) && ok
// ★3층 앞에 빌드를 강제한다 — SDK 를 고치고 빌드를 잊으면 옛 코드를 시험하고 초록을 받는다.

const liveDir = join(root, 'qa', 'live')
if (!live) {
  skip('3층 정규', '--live 를 안 줬다')
  skip('3층 갈래B', '--live 를 안 줬다')
} else if (!existsSync(join(liveDir, 'package.json'))) skip('3층 라이브', 'qa/live 가 아직 없다')
else {
  ok = step('3층 정규', npx, ['playwright', 'test', '--project=chromium'], liveDir) && ok
  ok = step('3층 갈래B', npx, ['playwright', 'test', '--project=chromium-fault'], liveDir) && ok
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
  const rec = { at: new Date().toISOString(), passed, sdk_sha: sha, sdk_dirty: dirty, server_build: server, hub, rows }
  const dir = join(root, '.archive', 'gate-live')
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify(rec, null, 1) + '\n'
  writeFileSync(join(dir, `${rec.at.replace(/[:.]/g, '-')}.json`), body, { flag: 'wx' })
  writeFileSync(join(dir, 'latest.json'), body)
  console.log(`  ⓘ 3층 회차 기록: .archive/gate-live/latest.json (server ${server ?? '모름'} · sdk ${sha}${dirty ? '-dirty' : ''})`)
}
