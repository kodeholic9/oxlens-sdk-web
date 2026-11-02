// author: kodeholic (powered by Claude)
// 1층 러너 — test/*.test.ts 를 esbuild 로 묶어 node:test 로 돌린다.
// SDK 소스가 쓰는 .js 접미 import 를 번들러가 풀어 준다.
import { build } from 'esbuild'
import { readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// 인자를 주면 이름에 그 말이 든 파일만(예: node test/run.mjs api err) — 게이트는 인자 없이 전량
const only = process.argv.slice(2)
const entries = readdirSync(here).filter((f) => f.endsWith('.test.ts') && (!only.length || only.some((o) => f.includes(o)))).map((f) => join(here, f))
if (entries.length === 0) {
  console.error('test/ 밑에 *.test.ts 가 없다')
  process.exit(1)
}

// 규격 벡터는 형제 저장소에 있다 — 번들이 임시 디렉터리에서 도니 자리를 묶을 때 박는다.
const vectors = process.env.OXLENS_SPEC_VECTORS ?? resolve(here, '..', '..', 'oxlens-spec', 'vectors')

const out = mkdtempSync(join(tmpdir(), 'oxsdk-test-'))
await build({
  entryPoints: entries,
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  sourcemap: 'inline',
  define: {
    __SPEC_VECTORS__: JSON.stringify(vectors),
    __FLOOR_TRACE__: JSON.stringify(resolve(here, 'data', 'floor_trace.json')),
  },
})

const built = readdirSync(out).filter((f) => f.endsWith('.mjs')).map((f) => join(out, f))
// 한 시험의 시한 — 걸린 시험이 게이트를 붙잡지 않고 실패로 드러나게(기본 60초)
const timeout = process.env.OXSDK_TEST_TIMEOUT ?? '60000'
const r = spawnSync(process.execPath, ['--test', `--test-timeout=${timeout}`, ...built], { stdio: 'inherit' })
process.exit(r.status ?? 1)
