// author: kodeholic (powered by Claude)
// 연:RULE-SES-FINGERPRINT · SDK:IMPL-SES-API `session.fingerprint` — 앱이 보이는 「통화 번호」가 ★서버 로그의 세션 지문과 같은가.
// 양끝이 따로 셈한다(와이어에 없다) — 같은 식인지는 진짜 SDK 와 진짜 서버를 맞대야만 안다(1층은 SDK 식만 · 서버 식은 서버 1층).
// 운영:RULE-READ-HISTORY 로 그 지문을 걸러 서버 기록을 연다 — 사용자가 부른 번호로 바로 여는 길 그대로.
import { test } from '@playwright/test'
import { Scope, ensureRoom, expect } from '../fixtures/scope.js'
import { ROOT } from '../fixtures/env.js'

const S = new Scope('fingerprint')
const ROOM = S.room()

test.afterEach(async () => { await S.teardown() })

interface History { nodes: { node: string; lines?: string[]; error?: number }[] }

test('FP-01 통화 번호로 그 세션의 서버 기록이 열린다', { annotation: { type: 'spec', description: 'SD-API-SESSION-FINGERPRINT⑤' } }, async ({ browser }) => {
  const ctx = await browser.newContext()
  await ensureRoom(ROOM)
  const user = S.user('U01')
  const p = await S.open(ctx, { userId: user })
  await p.call('join', ROOM, 'listen')
  const fp = (await p.call<{ fingerprint: string | null }>('session')).fingerprint
  expect(fp, '접속 뒤 통화 번호 — 16진 소문자 8자').toMatch(/^[0-9a-f]{8}$/)

  const lines = async (): Promise<string[]> => {
    const res = await fetch(`${ROOT}/admin/history?user=${encodeURIComponent(user)}&session=${fp}&since=0`)
    if (!res.ok) return []
    return ((await res.json()) as History).nodes.flatMap((n) => n.lines ?? [])
  }
  await expect.poll(async () => {
    const ls = await lines()
    return { hub: ls.some((l) => l.includes(' proc=hub ') && l.includes('spec=CP-OP-BIND')), sfu: ls.some((l) => l.includes(' proc=sfu ')) }
  }, { message: '★그 번호로 거른 서버 기록에 hub 의 BIND 줄과 미디어 서버 줄이 둘 다 있다 — 양끝의 식이 같다' }).toEqual({ hub: true, sfu: true })
  expect((await lines()).every((l) => l.includes(` session=${fp} `) || l.endsWith(` session=${fp}`)), '걸러진 줄은 전부 그 지문').toBe(true)
})
