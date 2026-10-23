// author: kodeholic (powered by Claude)
// 3층 시험마다 규격 좌표를 든다(회고 51 · 53 · 20261023) — `test('ID …', { annotation: { type: 'spec', description: '…' } }, …)`.
//   좌표 = 시험 항목서 단위 ID · 라벨 인용(연: · 정: · SDK:) · none(환경 자가점검 · 브라우저 관측 — 우리 계약 아님).
//   ★없으면 실패 — 빨강을 시험 이름이 아니라 깨진 약속으로 읽게. 단위 ID 가 항목서에 실재하는지는 규격 게이트(check_test_spec)가 잰다.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'live', 'tests')
const ITEM = /^(none|[CSKPOH]-(proc|timer|code|close|op|cond|sym|state|api|accept|key|sdk|ux|path|rule)-[A-Za-z0-9_.-]+|(CP|SV|SD|PL|OP|HK)-[A-Z][A-Z0-9-]+|(연|정|SDK|정책):[A-Za-z*][A-Za-z0-9_.*-]*)$/
const bad = []
let n = 0
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.spec.ts'))) {
  for (const [i, ln] of readFileSync(join(DIR, f), 'utf8').split('\n').entries()) {
    const m = /^test\('([A-Z0-9-]+) /.exec(ln)
    if (!m) continue
    n++
    const a = /annotation:\s*\{\s*type:\s*'spec',\s*description:\s*'([^']+)'/.exec(ln)
    const items = a ? a[1].split(' · ') : []
    if (!items.length || items.some((x) => !ITEM.test(x)) || (items.includes('none') && items.length > 1)) bad.push(`${f}:${i + 1} ${m[1]} — ${a ? a[1] : '좌표 없음'}`)
  }
}
if (bad.length) {
  console.error(`3층 규격 좌표 — 어긋남 ${bad.length}:\n  ` + bad.join('\n  '))
  process.exit(1)
}
console.log(`3층 규격 좌표 — 시험 ${n} 모두 좌표를 든다`)
