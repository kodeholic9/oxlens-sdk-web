// author: kodeholic (powered by Claude)
// ★확인이 아니라 clear — 전제 검사는 남아 있다를 알려줄 뿐 해결하지 않는다.
// 시험마다 user_id 를 가르면 서버 Peer 재사용이 아예 안 일어난다(가장 확실한 대응).
import { BrowserContext, Page, expect } from '@playwright/test'
import { BASE, PAGE, roomFor, userFor } from './env.js'

export interface Participant {
  readonly page: Page
  readonly userId: string
  call<T>(fn: string, ...args: unknown[]): Promise<T>
}

export class Scope {
  private readonly parts: Participant[] = []

  constructor(readonly tag: string) {}

  room(role?: string): string { return roomFor(this.tag, role) }
  user(label: string): string { return userFor(this.tag, label) }

  /** ★참가자는 이 문으로만 연다 — 회수 목록에 들어가야 방이 비워진다. */
  async open(context: BrowserContext, opts: { userId: string; priority?: number }): Promise<Participant> {
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') process.stdout.write(`  [console] ${m.text()}\n`) })
    page.on('pageerror', (e) => process.stdout.write(`  [pageerror] ${e.message}\n`))
    await page.goto(PAGE)
    await page.waitForFunction(() => (window as { qaReady?: boolean }).qaReady === true)

    const part: Participant = {
      page,
      userId: opts.userId,
      call: <T>(fn: string, ...args: unknown[]) => page.evaluate(
        ([name, a]) => (window as unknown as { qa: Record<string, (...x: unknown[]) => Promise<unknown>> })
          .qa[name as string]!(...(a as unknown[])),
        [fn, args] as const,
      ) as Promise<T>,
    }
    await part.call('connect', { base: BASE, token: await userToken(opts.userId, opts.priority ?? 0) })
    this.parts.push(part)
    return part
  }

  /** ★정리를 판정보다 먼저 한다 — expect 가 던지면 뒤가 안 돌아 빨강 하나가 스위트를 오염시킨다. */
  async teardown(): Promise<void> {
    for (const p of this.parts) {
      await p.call('teardown').catch(() => {})
      await p.page.close().catch(() => {})
    }
    this.parts.length = 0
  }
}

/** 그 방이 실제로 비었는지 서버에 물어본다 — 값이 0 과 못 물어본 것은 다르다. */
export async function roomHeadcount(roomId: string): Promise<number | null> {
  const res = await fetch(`${BASE}/rooms/${roomId}`, {
    headers: { Authorization: `Bearer ${await userToken('qa-admin')}` },
  })
  if (!res.ok) return null
  const body = await res.json() as { participants?: unknown[]; user_count?: number }
  return body.participants?.length ?? body.user_count ?? null
}

/** 연§5-1 — 토큰 발급은 앱 백엔드 몫이다. 하니스가 그 자리를 맡는다. */
export async function userToken(userId: string, priority = 0): Promise<string> {
  const res = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: 'ox_k_demo', api_secret: 'ox_s_demo',
      user_id: userId, role: 'user', floor_priority: priority,
    }),
  })
  if (!res.ok) throw new Error(`token ${res.status}`)
  return (await res.json() as { token: string }).token
}

/** 연§5-4 — 방 생성은 HTTP 다. 앱 백엔드도 부르는 자리라 하니스가 낸다. */
export async function ensureRoom(roomId: string): Promise<void> {
  const res = await fetch(`${BASE}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await userToken('qa-admin')}` },
    body: JSON.stringify({ room_id: roomId, name: roomId }),
  })
  if (!res.ok && res.status !== 409) throw new Error(`POST /rooms ${roomId}: ${res.status}`)
}

export { expect }
