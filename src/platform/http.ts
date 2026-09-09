// author: kodeholic (powered by Claude)
// 연§5-1 — HTTP 는 매 요청 인증한다(WS 세션과 다르다). 위층은 이 표면만 보고 fetch 를 모른다.

export interface HttpResponse {
  readonly status: number
  readonly body: unknown
}

export interface Http {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<HttpResponse>
}

/** 연§4-5 `Failure` 형 — HTTP 실패 body 도 이 형이다(연§5-5). 상태 코드가 아니라 `code` 로 판단한다. */
export interface HttpFailure {
  readonly code: number
  readonly name: string
  readonly message?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export class HttpFailed extends Error {
  override readonly name = 'HttpFailed'
  readonly failure?: HttpFailure
  constructor(readonly status: number, readonly url: string, failure?: HttpFailure) {
    super(failure === undefined ? `${url} → ${status}` : `${url} → ${status} ${failure.code} ${failure.name}`)
    if (failure !== undefined) this.failure = failure
  }
}

export const browserHttp: Http = {
  async get(url, headers): Promise<HttpResponse> {
    const res = await fetch(url, { headers })
    const body: unknown = res.status === 204 ? null : await res.json().catch(() => null)
    return { status: res.status, body }
  },
}
