// author: kodeholic (powered by Claude)
// 연§3-1 — WS opcode 는 binary 고정이다. 위층은 이 표면만 보고 브라우저 WebSocket 을 모른다.

export interface CloseInfo {
  readonly code: number
  readonly reason: string
}

export interface Socket {
  send(data: Uint8Array): void
  /** 이미 닫혔으면 아무 일도 하지 않는다. */
  close(code: number, reason: string): void
  /** 받은 프레임을 순서대로 낸다. 소켓이 닫히면 끝난다. */
  frames(): AsyncIterableIterator<Uint8Array>
  readonly closed: Promise<CloseInfo>
}

/** 연§10-3 — 클라가 먼저 끊을 때 쓰는 정상 종료. */
export const CLOSE_NORMAL = 1000

export function connectWebSocket(url: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const pending: Uint8Array[] = []
    let wake: (() => void) | null = null
    let done = false
    let closeInfo: CloseInfo = { code: 1006, reason: '' }
    let settleClosed: (info: CloseInfo) => void = () => {}
    const closed = new Promise<CloseInfo>((r) => { settleClosed = r })

    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      pending.push(new Uint8Array(ev.data))
      wake?.()
    }
    ws.onclose = (ev: CloseEvent) => {
      done = true
      closeInfo = { code: ev.code, reason: ev.reason }
      settleClosed(closeInfo)
      wake?.()
      reject(new Error(`WS closed before open: ${ev.code}`))
    }
    ws.onerror = () => { ws.close() }
    ws.onopen = () => {
      resolve({
        send: (data) => { ws.send(data) },
        close: (code, reason) => { if (ws.readyState <= WebSocket.OPEN) ws.close(code, reason) },
        closed,
        async *frames() {
          for (;;) {
            while (pending.length > 0) yield pending.shift()!
            if (done) return
            await new Promise<void>((r) => { wake = r })
            wake = null
          }
        },
      })
    }
  })
}
