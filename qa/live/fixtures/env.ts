// author: kodeholic (powered by Claude)
// 3층 시험 환경 규약 — 식별 가능한 고정 이름을 쓴다.
// 랜덤은 충돌은 막지만 오염을 숨긴다. 고정이면 방 목록만 봐도 정리 실패가 그 자리에서 드러난다.

export const HUB = process.env.OXE2E_HUB ?? '127.0.0.1:19745'
/** 클라 접속점 — 연§5-0 `{base}`. */
export const BASE = `http://${HUB}/media`
/**
 * ★**운영 표면은 `{base}` 밖이다**(C 평면) — `/admin/*`·`/healthz/*` 가 여기 붙는다.
 *
 * ★종전엔 `${BASE}/admin/...` 을 불러 ★**404 를 받고 있었다**(20260913 실측).
 */
export const ROOT = `http://${HUB}`
export const PAGE = '/qa/page.html'

/** 방 `qa_<태그>[_<역할>]` · user `<태그>_<라벨>`. 직접 문자열을 박지 않는다. */
export function roomFor(tag: string, role?: string): string {
  return role === undefined ? `qa_${tag}` : `qa_${tag}_${role}`
}

export function userFor(tag: string, label: string): string {
  return `${tag}_${label}`
}

/** FNV-1a 64 + splitmix64 — 서버 hrw_score 의 포팅. 배치를 이름 단계에서 안다. */
function hrw(sfuId: string, roomId: string): bigint {
  const M = (1n << 64n) - 1n
  let h = 0xcbf29ce484222325n
  const bytes = [...new TextEncoder().encode(sfuId), 0, ...new TextEncoder().encode(roomId)]
  for (const b of bytes) {
    h = (h ^ BigInt(b)) & M
    h = (h * 0x100000001b3n) & M
  }
  let z = (h + 0x9e3779b97f4a7c15n) & M
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M
  return (z ^ (z >> 31n)) & M
}

export function placementOf(roomId: string, sfus: string[]): string {
  return sfus.reduce((best, id) => (hrw(id, roomId) > hrw(best, roomId) ? id : best))
}

/**
 * ★**배치 후보 집합** — 버스가 말한다(운영 §3-8).
 *
 * ★★**키는 `node_id` 다**(정§15-3) — `sfu_id`(=`epoch`)가 아니다. `/admin/sfus` 는
 * ★**그 hub 가 띄운 유닛**이라 제 node 밖을 못 보고, 그 목록의 `sfu_id` 는
 * ★**기동마다 새 값**이라 배치 키로 쓸 수 없다.
 */
export async function sfuIds(): Promise<string[]> {
  const res = await fetch(`${ROOT}/admin/bus`)
  if (!res.ok) throw new Error(`admin/bus ${res.status}`)
  const body = await res.json() as { open?: boolean; nodes?: { node: string }[] }
  if (body.open !== true) throw new Error('버스가 안 열렸다 — 배치 후보를 알 수 없다')
  const ids = (body.nodes ?? []).map((n) => n.node).filter((n) => n !== '')
  if (ids.length === 0) throw new Error('버스가 비었다 — node 토큰이 하나도 안 서 있다')
  return ids
}

/** ★그 이름의 방이 이 노드에 떨어지는지 확인한다 — 정책이 바뀌면 주석은 썩지만 이것은 안 썩는다. */
export async function roomOn(tag: string, sfuId: string, role?: string): Promise<string> {
  const ids = await sfuIds()
  for (let n = 0; n < 200; n += 1) {
    const room = roomFor(tag, role === undefined ? String(n) : `${role}${n}`)
    if (placementOf(room, ids) === sfuId) return room
  }
  throw new Error(`${sfuId} 로 떨어지는 이름을 못 찾았다`)
}
