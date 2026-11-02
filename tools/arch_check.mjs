// author: kodeholic (powered by Claude)
// SDK§8-1 구조 가드 — 위반은 빌드 실패.
//   ① import 방향은 api → domain → internal → platform 한 방향뿐이다.
//   ② IoC 릴레이 금지 — 모듈 사이는 직접 호출·직접 소유로 잇는다.
//   ③ 표면 오류형(OxLensError)은 api 층에서만 산다 — 아래는 사실만 올린다.
//   ④ 층 아래는 규격 영역의 거울이다(SDK:RULE-MOD-AREA-MIRROR) — 영역 없는 디렉터리 · 디렉터리 없는 영역 · may_use 밖 import · SES 를 필드(core)로 건너 부르기를 센다.
//      영역 표는 SDK 정의서 짓기의 deps.json 사본(tools/sdk_deps.json — 손으로 고치지 않는다 · 생성본처럼 옮긴다).
//      ★아직 거울이 아닌 곳은 판정표(tools/arch_known.tsv — 위반 · 사유)에 둔다. 표 밖 위반 · 표에만 남은 줄은 실패(줄어들기만 한다).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const LAYER = ['api', 'domain', 'internal', 'platform']
const ENTRY = 'index.ts'

const RELAY = [
  [/\bset[A-Z]\w*Hook\s*\(/, 'setXHook 릴레이'],
  [/\bhooks?\s*[:=]\s*\{/, 'hook 표 주입'],
  [/\breadonly\s+on[A-Z]\w*\s*[?]?\s*:\s*\(/, 'onX 콜백 필드'],
]

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 파일이 속한 층. 진입점(src/index.ts)은 어디든 볼 수 있어 -1 이다. */
function layerOf(file) {
  const rel = relative(SRC, file)
  if (!rel.includes(sep)) return -1
  return LAYER.indexOf(rel.split(sep)[0])
}

const violations = []
for (const file of walk(SRC)) {
  const rel = relative(SRC, file)
  const from = layerOf(file)
  if (from === -1 && rel !== ENTRY) violations.push(`${rel}: src/ 바로 밑은 ${ENTRY} 뿐이다`)
  const text = readFileSync(file, 'utf8')

  for (const m of text.matchAll(/from\s+'(\.[^']*)'/g)) {
    const target = resolve(dirname(file), m[1]).replace(/\.js$/, '.ts')
    const to = layerOf(target)
    if (from === -1 || to === -1) continue
    if (to < from) violations.push(`${rel}: ${LAYER[from]} → ${LAYER[to]} 역참조 (${m[1]})`)
  }

  for (const [pat, why] of RELAY) {
    if (pat.test(text)) violations.push(`${rel}: ${why} — 직접 호출·직접 소유로 바꾼다`)
  }

  if (from > 0 && /\bOxLensError\b/.test(text)) {
    violations.push(`${rel}: ${LAYER[from]} 는 표면 오류형을 모른다 — 사실만 올리고 api 가 감싼다`)
  }
}

// ④ 영역 거울
const DEPS = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'sdk_deps.json'), 'utf8'))
const AREAS = Object.fromEntries(DEPS.concepts.map((a) => [a.toLowerCase(), a]))
const NOT_AREA = new Set(['gen', 'wire'])   // 생성본 · 운반 형식(TRN — SDK 정의서 개념 밖) 자리
const mirror = []
for (const layer of ['domain', 'internal']) {
  const base = join(SRC, layer)
  for (const name of readdirSync(base)) {
    const p = join(base, name)
    if (statSync(p).isDirectory()) { if (!AREAS[name] && !NOT_AREA.has(name)) mirror.push(`${layer}/${name}/: 영역 없는 디렉터리`) }
    else if (name.endsWith('.ts')) mirror.push(`${layer}/${name}: 영역 디렉터리 밖의 ${layer} 파일`)
  }
}
for (const [dir, A] of Object.entries(AREAS)) {
  if (!walkDirs(join(SRC, 'domain')).includes(dir)) mirror.push(`domain/${dir}/: 디렉터리 없는 영역(${A})`)
}
for (const file of walk(join(SRC, 'domain'))) {
  const parts = relative(join(SRC, 'domain'), file).split(sep)
  const from = AREAS[parts[0]]
  if (!from || parts.length < 2) continue
  const may = new Set([from, ...((DEPS.areas[from] || {}).may_use || [])])
  const text = readFileSync(file, 'utf8')
  // 건너 부르기 — 세션 객체(Core)는 방 · 연결이 든 필드(core)로도 닿는다 · import 경로만 보면 못 잡는다
  if (!may.has('SES') && /\.core\b|\['core'\]/.test(text)) mirror.push(`${relative(SRC, file)}: ${from} → SES 를 필드(core)로 건너 부른다 — may_use 밖`)
  for (const m of text.matchAll(/from\s+'(\.[^']*)'/g)) {
    const to = relative(join(SRC, 'domain'), resolve(dirname(file), m[1])).split(sep)[0]
    const A = AREAS[to]
    if (A && !may.has(A)) mirror.push(`${relative(SRC, file)}: ${from} → ${A} 는 may_use 밖 (${m[1]})`)
  }
}
function walkDirs(dir) { return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()) }
// 판정표 — 위반 · 갈래(이행 = 영역을 지을 때 지운다 · 가로지름 = 가로지르는 것은 층 자체가 자리라 둔다) · 사유
const KNOWN = new Map(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'arch_known.tsv'), 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')).map(([v, kind, why]) => [v, { kind, why }]))
for (const v of mirror) if (!KNOWN.has(v)) violations.push(`${v} — 거울 위반(판정표 밖)`)
for (const [v, k] of KNOWN) if (!['이행', '가로지름'].includes(k.kind) || !k.why) violations.push(`판정표 ${v} — 갈래(이행 · 가로지름) · 사유가 없다`)
for (const v of KNOWN.keys()) if (!mirror.includes(v)) violations.push(`판정표 ${v} — 이제 위반이 아니다(줄을 지운다)`)
const pending = mirror.filter((v) => KNOWN.get(v)?.kind === '이행').length

if (violations.length) {
  console.error(`arch_check 위반 ${violations.length}건`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log(`arch_check OK${pending ? ` · ★영역 거울 남은 것 ${pending}(tools/arch_known.tsv)` : ' · 영역 거울'}`)
