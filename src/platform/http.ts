// author: kodeholic (powered by Claude)
// 연§5-1 — HTTP 는 매 요청 인증한다(WS 세션과 다르다). 위층은 이 표면만 보고 fetch 를 모른다.

export interface HttpResponse {
  readonly status: number
  readonly body: unknown
}

export interface Http {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<HttpResponse>
}

export class HttpFailed extends Error {
  override readonly name = 'HttpFailed'
  constructor(readonly status: number, readonly url: string) {
    super(`${url} → ${status}`)
  }
}

export const browserHttp: Http = {
  async get(url, headers): Promise<HttpResponse> {
    const res = await fetch(url, { headers })
    const body: unknown = res.status === 204 ? null : await res.json().catch(() => null)
    return { status: res.status, body }
  },
}
