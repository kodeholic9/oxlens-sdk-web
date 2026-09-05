// author: kodeholic (powered by Claude)
// 브라우저 WebRTC 원시 표면. 위층은 이것만 보고 RTCPeerConnection 을 모른다 —
// 1층이 실제 협상 없이 상태기를 판정할 수 있는 자리가 여기다.

export type SignalingState =
  | 'stable' | 'have-local-offer' | 'have-remote-offer'
  | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed'

export type IceState =
  | 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed'

export type TransceiverDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' | 'stopped'

export interface Description {
  readonly type: 'offer' | 'answer' | 'rollback'
  readonly sdp?: string
}

export interface MediaTrackLike {
  readonly id: string
  readonly kind: string
  stop(): void
}

export interface SenderLike {
  replaceTrack(track: MediaTrackLike | null): Promise<void>
}

export interface TransceiverLike {
  readonly mid: string | null
  direction: TransceiverDirection
  readonly sender: SenderLike
  readonly receiver: { readonly track: MediaTrackLike }
}

/** 연§3-3 — 이름은 "unreliable" 하나, 순서 보장을 끄고 재전송하지 않는다. */
export interface DataChannelLike {
  readonly label: string
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed'
  send(data: Uint8Array): void
  close(): void
  messages(): AsyncIterableIterator<Uint8Array>
  readonly opened: Promise<void>
  readonly closed: Promise<void>
}

export interface RemoteTrackArrival {
  readonly track: MediaTrackLike
  readonly transceiver: TransceiverLike
}

export interface PeerConnectionLike {
  readonly signalingState: SignalingState
  readonly iceConnectionState: IceState
  readonly localDescription: Description | null
  readonly remoteDescription: Description | null
  createOffer(): Promise<Description>
  createAnswer(): Promise<Description>
  setLocalDescription(desc?: Description): Promise<void>
  setRemoteDescription(desc: Description): Promise<void>
  addTransceiver(kind: 'audio' | 'video', init?: { direction: TransceiverDirection }): TransceiverLike
  getTransceivers(): readonly TransceiverLike[]
  createDataChannel(label: string, init: { ordered: boolean; maxRetransmits: number }): DataChannelLike
  getStats(): Promise<ReadonlyMap<string, Record<string, unknown>>>
  close(): void
  iceStates(): AsyncIterableIterator<IceState>
  remoteTracks(): AsyncIterableIterator<RemoteTrackArrival>
}

export interface PeerFactory {
  create(): PeerConnectionLike
}

/** 연§9-2 — 서버가 ICE-lite 라 후보를 모으지 않는다. 브라우저 쪽 STUN 도 필요 없다. */
export const browserPeers: PeerFactory = {
  create(): PeerConnectionLike {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' })
    return wrap(pc)
  },
}

function pump<T>(): { push(v: T): void; end(): void; iter(): AsyncIterableIterator<T> } {
  const queue: T[] = []
  let wake: (() => void) | null = null
  let done = false
  return {
    push(v) { queue.push(v); wake?.() },
    end() { done = true; wake?.() },
    async *iter() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (done) return
        await new Promise<void>((r) => { wake = r })
        wake = null
      }
    },
  }
}

function wrapChannel(dc: RTCDataChannel): DataChannelLike {
  dc.binaryType = 'arraybuffer'
  const msgs = pump<Uint8Array>()
  let markOpen: () => void = () => {}
  let markClosed: () => void = () => {}
  const opened = new Promise<void>((r) => { markOpen = r })
  const closed = new Promise<void>((r) => { markClosed = r })
  dc.onmessage = (ev: MessageEvent<ArrayBuffer>) => { msgs.push(new Uint8Array(ev.data)) }
  dc.onopen = () => { markOpen() }
  dc.onclose = () => { msgs.end(); markClosed() }
  return {
    get label() { return dc.label },
    get readyState() { return dc.readyState },
    send: (data) => { dc.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) },
    close: () => { dc.close() },
    messages: () => msgs.iter(),
    opened,
    closed,
  }
}

function wrap(pc: RTCPeerConnection): PeerConnectionLike {
  const ice = pump<IceState>()
  const tracks = pump<RemoteTrackArrival>()
  pc.oniceconnectionstatechange = () => { ice.push(pc.iceConnectionState as IceState) }
  pc.ontrack = (ev) => { tracks.push({ track: ev.track, transceiver: ev.transceiver as TransceiverLike }) }

  return {
    get signalingState() { return pc.signalingState as SignalingState },
    get iceConnectionState() { return pc.iceConnectionState as IceState },
    get localDescription() { return pc.localDescription as Description | null },
    get remoteDescription() { return pc.remoteDescription as Description | null },
    createOffer: () => pc.createOffer() as Promise<Description>,
    createAnswer: () => pc.createAnswer() as Promise<Description>,
    setLocalDescription: (desc) => pc.setLocalDescription(desc as RTCLocalSessionDescriptionInit),
    setRemoteDescription: (desc) => pc.setRemoteDescription(desc as RTCSessionDescriptionInit),
    addTransceiver: (kind, init) => pc.addTransceiver(kind, init as RTCRtpTransceiverInit) as TransceiverLike,
    getTransceivers: () => pc.getTransceivers() as readonly TransceiverLike[],
    createDataChannel: (label, init) => wrapChannel(pc.createDataChannel(label, init)),
    getStats: async () => {
      const report = await pc.getStats()
      const out = new Map<string, Record<string, unknown>>()
      report.forEach((v, k) => out.set(k, v as Record<string, unknown>))
      return out
    },
    close: () => { ice.end(); tracks.end(); pc.close() },
    iceStates: () => ice.iter(),
    remoteTracks: () => tracks.iter(),
  }
}
