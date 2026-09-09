// author: kodeholic (powered by Claude)
// 연§7-0-3·§7-2·§7-3·§8-2 — 연결 상태기와 재접속 사다리.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decode, encode, Kind } from '../src/internal/frame.js'
import { Op } from '../src/internal/wire.js'
import { BACKOFF_MS, JITTER_FROM, Session, T_BIND_MS } from '../src/domain/session.js'
import { FakeClock, FakeSocket, tick } from './_fakes.js'

const BIND_OK = {
  user_id: 'u1', role: 'user', server_ver: 1,
  heartbeat_interval: 10_000, session_id: 's-1', resume_window_ms: 60_000, pc_mode: '2pc',
}

interface Stand {
  clock: FakeClock
  sockets: FakeSocket[]
  session: Session
  live: { rooms: string[]; publish: { track_id: string; kind: string }[] }
  /** 마지막 소켓의 op 목록. */
  ops(): number[]
  answer(op: number, body?: Record<string, unknown>): void
  fail(op: number, code: number, name: string): void
}

function stand(over: Partial<{ jitter: number; clientVer: number }> = {}): Stand {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const live = { rooms: [] as string[], publish: [] as { track_id: string; kind: string }[] }
  const session = new Session({
    url: 'wss://hub/ws',
    token: 't',
    connect: () => { const s = new FakeSocket(); sockets.push(s); return Promise.resolve(s) },
    live: { rooms: () => live.rooms, publish: () => live.publish },
    clock,
    jitter: () => over.jitter ?? 0,
    ...(over.clientVer === undefined ? {} : { clientVer: over.clientVer }),
  })
  const last = (): FakeSocket => sockets[sockets.length - 1]!
  return {
    clock, sockets, session, live,
    ops: () => last().sent.map((b) => decode(b).op),
    answer(op, body) {
      const f = last().sent.map(decode).find((x) => x.op === op && x.kind === Kind.Request)!
      last().deliver(encode(Kind.Ok, op, f.pid, body ?? {}))
    },
    fail(op, code, name) {
      const f = last().sent.map(decode).find((x) => x.op === op && x.kind === Kind.Request)!
      last().deliver(encode(Kind.Fail, op, f.pid, { code, name }))
    },
  }
}

test('붙으면 BIND 부터 보내고 다른 것은 안 보낸다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick()
  assert.deepEqual(s.ops(), [Op.Bind], '서버는 먼저 말하지 않는다')
  const body = decode(s.sockets[0]!.sent[0]!).body as Record<string, unknown>
  assert.equal(body.token, 't')
  assert.equal(body.client_ver, 1)
  assert.equal(body.pc_mode, '2pc')
  assert.ok(!('session_id' in body), '첫 접속에는 이어받을 것이 없다')

  s.answer(Op.Bind, BIND_OK)
  assert.equal((await p).session_id, 's-1')
  assert.equal(s.session.state, 'active')
})

test('BIND 응답이 준 주기로 하트비트가 돈다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  await s.clock.advance(10_000)
  assert.deepEqual(s.ops(), [Op.Bind, Op.Heartbeat], '안 시작하면 30초 뒤 끊긴다')
})

test('T-bind 가 끝나면 소켓을 닫는다', async () => {
  const s = stand()
  const p = s.session.connect()
  p.catch(() => {})
  await tick()
  await s.clock.advance(T_BIND_MS)
  await assert.rejects(p)
  assert.equal(s.sockets[0]!.closedWith?.code, 4003)
})

test('끊기면 사다리를 돌며 다시 붙는다 — 첫 칸은 0ms 다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.live.rooms.push('r1')

  s.sockets[0]!.close(1006, '')
  await tick()
  assert.equal(s.session.state, 'resuming')
  assert.equal(s.session.recovering, true)

  await s.clock.advance(BACKOFF_MS[0]!)
  assert.equal(s.sockets.length, 2, '첫 칸은 기다리지 않는다')
  const body = decode(s.sockets[1]!.sent[0]!).body as Record<string, unknown>
  assert.equal(body.session_id, 's-1', '이어받기용으로 옛 세션을 싣는다')
})

test('이어받았으면 RESUME 이 살아 있는 것만 신고한다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.live.rooms.push('r1', 'r2')
  s.live.publish.push({ track_id: 'tA', kind: 'audio' })

  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.answer(Op.Bind, BIND_OK)
  await tick()

  assert.deepEqual(s.ops(), [Op.Bind, Op.Resume])
  assert.deepEqual(decode(s.sockets[1]!.sent[1]!).body, {
    rooms: ['r1', 'r2'], publish: [{ track_id: 'tA', kind: 'audio' }],
  })
})

test('RESUME 은 윈도우 밖이라 BIND 응답을 기다리지 않는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.live.rooms.push('r1')
  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.answer(Op.Bind, BIND_OK)
  await tick()
  assert.equal(s.sockets[1]!.sent.length, 2)
})

test('세션이 새것이면 RESUME 을 보내지 않고 재구축으로 간다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.live.rooms.push('r1')
  const seen: string[] = []
  void (async () => { for await (const e of s.session.listen()) seen.push(e.kind) })()

  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.answer(Op.Bind, { ...BIND_OK, session_id: 's-2' })
  await tick()

  assert.ok(!s.ops().includes(Op.Resume), '이어받을 것이 없는데 왕복을 태우지 않는다')
  assert.ok(seen.includes('rebuild'))
})

test('창을 넘겼으면 RESUME 을 아예 건너뛴다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.live.rooms.push('r1')
  const seen: string[] = []
  void (async () => { for await (const e of s.session.listen()) seen.push(e.kind) })()

  s.sockets[0]!.close(1006, '')
  await tick()
  await s.clock.advance(70_000)
  const body = decode(s.sockets[1]!.sent[0]!).body as Record<string, unknown>
  assert.ok(!('session_id' in body), '죽은 세션임을 알면서 이어받기를 태우지 않는다')
  assert.ok(seen.includes('rebuild'))
})

test('지터는 3번째 칸부터 붙는다', async () => {
  const s = stand({ jitter: 500 })
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p

  for (let i = 0; i < JITTER_FROM; i += 1) {
    const before = s.sockets.length
    s.sockets[before - 1]!.close(1006, '')
    await tick()
    await s.clock.advance(BACKOFF_MS[i]!)
    assert.equal(s.sockets.length, before + 1, `${i}번째 칸에는 지터가 없다`)
    s.answer(Op.Bind, BIND_OK)
    await tick()
  }
})

test('다시 붙어도 소용없는 사유면 사다리를 안 돈다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: { kind: string; retryable?: boolean }[] = []
  void (async () => {
    for await (const e of s.session.listen()) seen.push({ kind: e.kind, ...('retryable' in e ? { retryable: e.retryable } : {}) })
  })()

  s.sockets[0]!.close(4005, 'DUPLICATE_SESSION')
  await tick()
  await s.clock.advance(60_000)
  assert.equal(s.sockets.length, 1, '두 세션이 서로를 밀어내며 무한 재접속한다')
  assert.equal(s.session.state, 'disconnected')
  assert.deepEqual(seen.at(-1), { kind: 'closed', retryable: false })
})

// ★연§10-3 `4004` — 운영자 절단은 차단이 아니다. 세션은 즉시 폐기고, 다시 붙되 이어받지 않는다.
// 자격이 정말로 사라졌으면 그 재`BIND` 가 `2003` 으로 막는다 — 막는 자리는 토큰이지 close code 가 아니다.
test('★4004 는 다시 붙는다 — session_id 를 안 싣고, 그 BIND 가 토큰을 다시 검사한다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.live.rooms.push('r1')
  const seen: string[] = []
  void (async () => { for await (const e of s.session.listen()) seen.push(e.kind) })()

  s.sockets[0]!.close(4004, 'SESSION_REVOKED')
  await tick()
  assert.equal(s.session.state, 'resuming', '끝난 것이 아니다 — 백오프로 다시 붙는다')
  assert.ok(!seen.includes('closed'), '재접속 금지 코드가 아니다')

  await s.clock.advance(BACKOFF_MS[0]!)
  assert.equal(s.sockets.length, 2)
  const body = decode(s.sockets[1]!.sent[0]!).body as Record<string, unknown>
  assert.ok(!('session_id' in body), '★세션은 폐기됐다 — 이어받기를 태우면 2008 만 받는다')
  assert.ok('token' in body, '★토큰을 싣는다 — 다시 검사시키는 것이 그 절단의 목적이다')

  // 자격이 사라졌으면 여기서 막힌다 — tokenRequired 로 앱에 간다.
  s.fail(Op.Bind, 2003, 'TOKEN_EXPIRED')
  await tick()
  assert.ok(seen.includes('token_required'), '막는 자리는 토큰이다')
})

test('★4004 는 이어받은 뒤에도 사유가 앱에 남는다 — session.reason', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: { kind: string; code?: number }[] = []
  void (async () => {
    for await (const e of s.session.listen()) seen.push({ kind: e.kind, ...('info' in e ? { code: e.info.code } : {}) })
  })()

  s.sockets[0]!.close(4004, 'SESSION_REVOKED')
  await tick()
  assert.deepEqual(seen.at(-1), { kind: 'resuming', code: 4004 },
    '다시 붙는 사유는 closed 를 안 지난다 — 이 자리 말고 앱에 닿을 길이 없다')
})

test('모르는 close code 는 다시 붙는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.sockets[0]!.close(4099, 'SOMETHING_NEW')
  await tick(); await s.clock.advance(0)
  assert.equal(s.sockets.length, 2, '사유를 늘려도 클라가 안 깨져야 한다')
})

test('사다리를 소진하면 재시도 가능으로 닫는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: { kind: string; retryable?: boolean }[] = []
  void (async () => {
    for await (const e of s.session.listen()) seen.push({ kind: e.kind, ...('retryable' in e ? { retryable: e.retryable } : {}) })
  })()

  s.sockets[0]!.close(1006, '')
  for (const wait of BACKOFF_MS) {
    await tick()
    await s.clock.advance(wait)
    await tick()
    await s.clock.advance(T_BIND_MS)
    await tick()
  }
  assert.equal(s.session.state, 'disconnected')
  assert.deepEqual(seen.at(-1), { kind: 'closed', retryable: true })
})

test('앱이 닫으면 사다리를 돌지 않는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.session.close()
  await tick()
  await s.clock.advance(60_000)
  assert.equal(s.sockets.length, 1)
  assert.deepEqual(s.sockets[0]!.closedWith, { code: 1000, reason: '' })
})

test('clientVer 옵션이 BIND 의 client_ver 로 실린다', async () => {
  const s = stand({ clientVer: 2 })
  const p = s.session.connect()
  await tick()
  const body = decode(s.sockets[0]!.sent[0]!).body as Record<string, unknown>
  assert.equal(body.client_ver, 2)
  s.answer(Op.Bind, BIND_OK); await p
})

test('재접속 BIND 가 2003 이면 새 토큰을 기다렸다가 그 토큰으로 다시 붙는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: string[] = []
  void (async () => { for await (const e of s.session.listen()) seen.push(e.kind) })()

  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.fail(Op.Bind, 2003, 'TOKEN_EXPIRED')
  await tick()
  assert.ok(seen.includes('token_required'))
  assert.deepEqual(s.sockets[1]!.closedWith, { code: 1000, reason: '' }, '실패한 소켓은 정상 종료로 놓는다')
  await s.clock.advance(5_000)
  assert.equal(s.sockets.length, 2, '토큰이 올 때까지 다시 붙지 않는다')

  s.session.setToken('t2')
  await tick()
  assert.equal(s.sockets.length, 3, '새 토큰이 오면 사다리 없이 바로 붙는다')
  const body = decode(s.sockets[2]!.sent[0]!).body as Record<string, unknown>
  assert.equal(body.token, 't2')
  s.answer(Op.Bind, BIND_OK)
  await tick()
  assert.equal(s.session.state, 'active')
})

test('새 토큰이 창 안에 안 오면 재시도 가능으로 닫는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: { kind: string; retryable?: boolean }[] = []
  void (async () => {
    for await (const e of s.session.listen()) seen.push({ kind: e.kind, ...('retryable' in e ? { retryable: e.retryable } : {}) })
  })()

  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.fail(Op.Bind, 2003, 'TOKEN_EXPIRED')
  await tick()
  await s.clock.advance(BIND_OK.resume_window_ms)
  await tick()
  assert.equal(s.session.state, 'disconnected')
  assert.deepEqual(seen.at(-1), { kind: 'closed', retryable: true })
  assert.equal(s.sockets.length, 2)
})

test('재접속 BIND 가 2002 면 다시 붙어도 같아 끝낸다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: { kind: string; retryable?: boolean; reason?: string }[] = []
  void (async () => {
    for await (const e of s.session.listen()) {
      seen.push({ kind: e.kind, ...(e.kind === 'closed' ? { retryable: e.retryable, reason: e.info.reason } : {}) })
    }
  })()

  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.fail(Op.Bind, 2002, 'TOKEN_INVALID')
  await tick()
  assert.equal(s.session.state, 'disconnected')
  assert.deepEqual(seen.at(-1), { kind: 'closed', retryable: false, reason: 'BIND_FAILED' })
  await s.clock.advance(60_000)
  assert.equal(s.sockets.length, 2, '사다리를 돌지 않는다')
})

test('재접속 BIND 가 4003 이면 사다리를 계속 돈다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.fail(Op.Bind, 4003, 'QUOTA_EXCEEDED')
  await tick()
  assert.equal(s.session.state, 'resuming')
  await s.clock.advance(BACKOFF_MS[1]!)
  assert.equal(s.sockets.length, 3)
})

test('살아남은 것이 하나도 없으면 RESUME 을 보내지 않는다', async () => {
  const s = stand()
  const p = s.session.connect()
  await tick(); s.answer(Op.Bind, BIND_OK); await p
  const seen: string[] = []
  void (async () => { for await (const e of s.session.listen()) seen.push(e.kind) })()

  s.sockets[0]!.close(1006, '')
  await tick(); await s.clock.advance(0)
  s.answer(Op.Bind, BIND_OK)
  await tick()

  assert.deepEqual(s.ops(), [Op.Bind], '신고할 것이 없는데 왕복을 태우지 않는다')
  assert.ok(seen.includes('rebuild'))
})
