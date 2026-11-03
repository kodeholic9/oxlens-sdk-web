// author: kodeholic (powered by Claude)
// 한 명령 게이트. 통과·실패·미실행을 다른 표시로 쓰고, 미실행에는 사유를 붙인다
// — "못 쟀다"가 초록으로 새지 않게 한다.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
// ★생성본 스물(src/domain/gen · src/internal/wire)이 규격 원천의 산출과 같은가 — 옮기기 · 대조는 context 의 도구 하나가 한다(npm run sync:sdk · 202611/20261103j M1).
//   손으로 옮기다 빠진 파일 · 손으로 고친 생성본이 1층 초록으로 새지 않게.
const sync = resolve(root, '..', '..', 'context', 'spec', 'tools', 'sdk_sync.py')
if (existsSync(sync)) ok = step('생성본', 'python3', [sync, '--check', root]) && ok
else skip('생성본', `규격 원천이 없다(${sync})`)
ok = step('typecheck', npx, ['tsc', '--noEmit', '-p', 'tsconfig.json']) && ok
ok = step('arch', process.execPath, ['tools/arch_check.mjs']) && ok
ok = step('3층 좌표', process.execPath, ['tools/qa_spec_check.mjs']) && ok
ok = step('build', npx, ['tsc', '-p', 'tsconfig.build.json']) && ok
const tapFile = join(root, '.archive', 'gate', 'unit.tap')
mkdirSync(dirname(tapFile), { recursive: true })
rmSync(tapFile, { force: true })
ok = step('1층 단위', process.execPath, ['test/run.mjs'], root, { OXSDK_TEST_TAP: tapFile }) && ok
keepGateRecord()
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
else if (!(await serverIsHead())) {
  // ★떠 있는 hub 가 서버 저장소 HEAD 의 빌드가 아니면 3층을 돌리지 않는다 — 옛 hub 에 붙어 받은 초록은 지금 코드의 초록이 아니다(20261101 실측 · 202611/20261101c).
  ok = false
  skip('3층 정규', '서버 신원이 HEAD 와 다르다')
  skip('3층 갈래B', '서버 신원이 HEAD 와 다르다')
} else {
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

/** 떠 있는 hub 의 빌드 신원(`/healthz/ready` 의 `build` — `{SHA 12}{-dirty}.{초}[+라벨]`). 안 떠 있으면 null. */
async function serverBuild() {
  const hub = process.env.OXE2E_HUB ?? '127.0.0.1:1974'
  try {
    const res = await fetch(`http://${hub}/healthz/ready`)
    return (await res.json()).build ?? null
  } catch {
    return null
  }
}

/**
 * 3층 앞 확인 — 떠 있는 hub 의 빌드 SHA 12 자리 = 서버 저장소(`OXE2E_SERVER_REPO` · 기본 `../oxlens-sfu`) HEAD.
 * dirty 는 막지 않는다(커밋 전 작업 트리의 게이트가 정상 경로다) — 기록에 그대로 남는다. 2층 하네스 `server.ensure()` 가 서버를 갈아 띄우는 것과 같은 자리.
 */
async function serverIsHead() {
  const t = Date.now()
  const repo = process.env.OXE2E_SERVER_REPO ?? resolve(root, '..', 'oxlens-sfu')
  const build = await serverBuild()
  const head = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout?.trim() ?? ''
  const sha = (build ?? '').split('.')[0].replace(/-dirty$/, '')
  const same = Boolean(build) && head !== '' && sha === head
  rows.push({ name: '서버 신원', mark: same ? 'PASS' : 'FAIL', note: `${Date.now() - t}ms · hub ${build ?? '응답 없음'} · HEAD ${head || '모름'}` })
  if (!same) console.log(`  ✗ 서버 신원 — 떠 있는 hub 는 ${build ?? '없다'} · 서버 저장소 HEAD 는 ${head || '모름'}(${repo}). 2층 하네스로 서버를 다시 띄운 뒤 돌린다.`)
  return same
}

/**
 * 작업 트리(무시 파일 빼고 · 새 파일 포함)의 나무 객체 — 진짜 색인은 건드리지 않는다. 커밋한 뒤 HEAD^{tree} 와 같으면 「이 기록은 그 커밋을 잰 것」이다
 * (context spec/tools/commit_check.py 의 work_tree 와 같은 셈 · 202611/20261103j S3).
 */
function workTree() {
  const dir = mkdtempSync(join(tmpdir(), 'oxsdk-tree-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
  const git = (...a) => spawnSync('git', a, { cwd: root, env, encoding: 'utf8' })
  git('read-tree', 'HEAD')
  git('add', '-A', '--', '.')
  const tree = git('write-tree').stdout.trim()
  rmSync(dir, { recursive: true, force: true })
  return tree
}

/** 1층 기록 — .archive/gate/latest.json(통과 · 실패 수 · 작업 트리). 커밋 꼬리의 「SDK 1층 N」을 context 커밋 앞 훅이 이것과 대조한다. */
function keepGateRecord() {
  const tap = existsSync(tapFile) ? readFileSync(tapFile, 'utf8') : ''
  const num = (k) => Number((tap.match(new RegExp(`^# ${k} (\\d+)$`, 'm')) ?? [])[1] ?? NaN)
  const sha = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const rec = { at: new Date().toISOString(), sdk_sha: sha, tree: workTree(), unit: { pass: num('pass'), fail: num('fail'), tests: num('tests') } }
  writeFileSync(join(root, '.archive', 'gate', 'latest.json'), JSON.stringify(rec, null, 1) + '\n')
  console.log(`  ⓘ 1층 기록: .archive/gate/latest.json (통과 ${rec.unit.pass} · 실패 ${rec.unit.fail} · 트리 ${rec.tree.slice(0, 12)})`)
}

async function keepLiveRecord(passed) {
  const hub = process.env.OXE2E_HUB ?? '127.0.0.1:1974'
  const server = await serverBuild()
  const sha = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim() !== ''
  const rec = { at: new Date().toISOString(), run: `live-${stamp}`, passed, sdk_sha: sha, sdk_dirty: dirty, tree: workTree(), server_build: server, hub, rows }
  const body = JSON.stringify(rec, null, 1) + '\n'
  mkdirSync(runDir, { recursive: true })
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
