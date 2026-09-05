// author: kodeholic (powered by Claude)
// ★환경이 결정적이지 않으면 모든 초록이 거짓이다. 이 절이 그것을 매 실행 대조한다.
import { test } from '@playwright/test'
import { placementOf, roomFor, sfuIds, userFor } from '../fixtures/env.js'
import { Scope, ensureRoom, expect, roomHeadcount } from '../fixtures/scope.js'

const S = new Scope('env')

test.afterEach(async () => { await S.teardown() })

/**
 * ★배치는 사상으로 대조한다 — hub registry 의 노드 id(`sfu-1`)와 클라가 보는
 * `server_config.sfu_id`(프로세스 신원)는 다른 공간이라 문자열로 견줄 수 없다.
 * 포팅이 "같은 노드/다른 노드"라고 말한 것을 서버가 그대로 지키는지가 판정이다.
 */
test('ENV-01 배치 포팅이 서버 판정과 같다', async ({ browser }) => {
  const ids = await sfuIds()
  expect(ids.length, 'hub registry 를 못 읽으면 cross-sfu 시험이 거짓말을 한다').toBeGreaterThan(0)
  test.skip(ids.length < 2, '노드가 하나면 사상을 잴 변량이 없다')

  const names: string[] = []
  for (let n = 0; names.length < 3 && n < 400; n += 1) names.push(roomFor('env', `p${n}`))
  const byNode = new Map<string, string[]>()
  for (const room of names) {
    const node = placementOf(room, ids)
    byNode.set(node, [...(byNode.get(node) ?? []), room])
  }

  const ctx = await browser.newContext()
  const p = await S.open(ctx, { userId: S.user('U01') })
  const seen = new Map<string, string>()
  for (const room of names) {
    await ensureRoom(room)
    const joined = await p.call<{ server: string }>('join', room, 'listen')
    seen.set(room, joined.server)
  }

  for (const [, rooms] of byNode) {
    for (const other of rooms.slice(1)) {
      expect(seen.get(other), `포팅이 같은 노드라 했는데 서버가 갈랐다 (${rooms[0]}, ${other})`)
        .toBe(seen.get(rooms[0]!))
    }
  }
  const nodes = new Set(names.map((r) => placementOf(r, ids)))
  if (nodes.size > 1) {
    expect(new Set(seen.values()).size, '포팅이 갈랐는데 서버가 한 노드에 몰았다').toBe(nodes.size)
  }
})

test('ENV-02 이름은 식별 가능한 고정 이름이다', () => {
  expect(roomFor('conf_audio')).toBe('qa_conf_audio')
  expect(roomFor('x', 'a')).toBe('qa_x_a')
  expect(userFor('conf_audio', 'U01')).toBe('conf_audio_U01')
})

test('ENV-03 나가면 서버 명단에서 빠진다 — 정리 실패가 그 자리에서 드러난다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const room = roomFor('env', 'cleanup')
  await ensureRoom(room)
  const p = await S.open(ctx, { userId: S.user('U02') })
  await p.call('join', room)
  await expect.poll(() => roomHeadcount(room)).toBe(1)

  await p.call('leave', room)
  await expect.poll(() => roomHeadcount(room), {
    message: '★값이 0 인 것과 못 물어본 것은 다르다 — null 이면 여기서 빨개진다',
  }).toBe(0)
})
