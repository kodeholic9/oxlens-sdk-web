// author: kodeholic (powered by Claude)
// spec: v1.2 @d626fda · SDK:IMPL-SRC-BLOCKS · SDK:RULE-PLAT-WEB · 연:RULE-LINK-SDP-COMMON · model: claude-opus-5-5

/** PeerConnection 구현체 — 서버는 ICE-lite host 하나라 ICE 서버가 없다 */
export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceServers: [] })
}

let udpCandidate = true

/** QA 스위치 — 3층 TCP 형상이 UDP 후보를 끄는 시험 수단이다. 상용 경로는 부르지 않는다(SDK:RULE-PLAT-WEB) */
export function qaSetUdpCandidate(on: boolean): void {
  udpCandidate = on
}

export function udpCandidateOn(): boolean {
  return udpCandidate
}

if (typeof globalThis !== 'undefined') {
  (globalThis as unknown as { __qaSetUdpCandidate?: (on: boolean) => void }).__qaSetUdpCandidate = qaSetUdpCandidate
}

/** 수신 지연 손잡이 — 표준 jitterBufferTarget, 없으면 playoutDelayHint, 둘 다 없으면 못 건다(SDK:RULE-PLAT-WEB) */
export function setPlayoutDelay(receiver: RTCRtpReceiver, ms: number | null): boolean {
  const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number | null }
  if ('jitterBufferTarget' in r) { r.jitterBufferTarget = ms; return true }
  const h = r as { playoutDelayHint?: number | null }
  if ('playoutDelayHint' in h) { h.playoutDelayHint = ms === null ? null : ms / 1000; return true }
  return false
}
