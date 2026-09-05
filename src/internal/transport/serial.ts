// author: kodeholic (powered by Claude)
// 연§9-10 3 — 협상을 하나씩 태운다. 내 트랙 변경과 남의 입퇴장이 같은 연결을 다투므로,
// 겹치면 한쪽이 통째로 버려지고 버려진 쪽이 내 트랙이면 서버는 등록됐다고 아는데 RTP 가 안 나간다.

export class Serial {
  private tail: Promise<unknown> = Promise.resolve()
  private depth = 0

  run<T>(job: () => Promise<T>): Promise<T> {
    this.depth += 1
    const next = this.tail.then(job, job)
    this.tail = next.then(() => { this.depth -= 1 }, () => { this.depth -= 1 })
    return next
  }

  /** 큐에 남은 개수 — 직렬화가 실제로 도는지 보는 자리다. */
  get pending(): number { return this.depth }
}
