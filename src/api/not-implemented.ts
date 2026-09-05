// author: kodeholic (powered by Claude)
// 표면이 먼저다 — 아직 안쪽이 없는 진입은 이것을 던진다. 조용히 아무 일도 안 하지 않는다.
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'
  constructor(what: string) { super(`not implemented: ${what}`) }
}
