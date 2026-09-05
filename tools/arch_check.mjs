// author: kodeholic (powered by Claude)
// SDK§8-1 구조 가드 — 위반은 빌드 실패.
//   ① import 방향은 api → domain → internal → platform 한 방향뿐이다.
//   ② IoC 릴레이 금지 — 모듈 사이는 직접 호출·직접 소유로 잇는다.
//   ③ 표면 오류형(OxLensError)은 api 층에서만 산다 — 아래는 사실만 올린다.
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

if (violations.length) {
  console.error(`arch_check 위반 ${violations.length}건`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log('arch_check OK')
