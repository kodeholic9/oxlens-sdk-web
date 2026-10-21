// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · 연:RULE-TRN-ENDPOINTS · 연:RULE-TRN-HTTP-AUTH-TWO · 연:TRN.frame.WS · SDK:RULE-PLAT-SHARE · model: claude-opus-5-5

/** WS 접속점 — {base}/ws, 스킴만 바꾼다 */
export function wsUrl(base: string): string {
  const u = new URL(base.replace(/\/+$/, '') + '/ws')
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol
  return u.toString()
}

export function httpUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

/** binary 고정 소켓 — 서브프로토콜을 보내지 않는다(연:RULE-TRN-WS-NO-UPGRADE-AUTH) */
export function openSocket(url: string): WebSocket {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  return ws
}

export interface HttpReply {
  readonly status: number
  readonly body: unknown
}

export async function httpJson(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<HttpReply> {
  const init: RequestInit = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let parsed: unknown = null
  if (text.length) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  return { status: res.status, body: parsed }
}
