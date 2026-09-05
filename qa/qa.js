// author: kodeholic (powered by Claude)
// 3층 어댑터 — spec 은 이 표면만 쓴다. SDK 내부를 직접 만지지 않는다.
import { createClient } from '../dist/index.js'

const state = {
  client: null,
  base: null,
  token: null,
  tracks: new Map(),
  events: [],
  elements: new Map(),
}

function note(kind, detail) {
  state.events.push({ at: Date.now(), kind, detail })
  if (state.events.length > 500) state.events.shift()
}

// 연§5-1 — /auth/token 은 앱 백엔드 몫이다. 페이지가 부르지 않는다.
// 시험에서는 하니스(node)가 그 자리를 맡아 토큰을 넣어 준다.

const qa = {
  async connect({ base, token }) {
    state.base = base
    state.token = token
    const client = createClient({ base, token })
    state.client = client
    client.on('track', (room, t) => {
      state.tracks.set(t.id, { track: t, roomId: room.id })
      note('track', { id: t.id, kind: t.kind, roomId: room.id, slot: t.slot, userId: t.userId ?? null })
      if (t.kind === 'video') {
        const el = document.createElement('video')
        el.id = `v-${t.id}`
        el.muted = true
        document.getElementById('tiles').appendChild(el)
        t.attach(el)
        state.elements.set(t.id, el)
      }
    })
    client.on('closed', (e) => note('closed', e))
    client.on('session', (s) => note('session', { state: s.state, recovering: s.recovering }))
    await client.connect()
    return { userId: client.session.userId, pcMode: client.session.pcMode }
  },

  async join(roomId, mode) {
    const room = await state.client.join(roomId, mode ? { mode } : {})
    room.on('track', (t) => note('roomTrack', { room: roomId, id: t.id }))
    room.ptt.on('state', (st) => note('ptt', { room: roomId, phase: st.phase, trusted: st.trusted }))
    room.ptt.on('speaker', (e) => note('speaker', { room: roomId, userId: e.userId }))
    return { id: room.id, mode: room.mode, server: room.server, participants: room.participants.length }
  },

  async leave(roomId) { await state.client.rooms.get(roomId)?.leave() },

  async enableMic() {
    const t = await state.client.media.enableMicrophone()
    return { id: t.id, state: t.state, duplex: t.duplex, server: t.server }
  },

  async enableCamera() {
    const t = await state.client.media.enableCamera()
    return { id: t.id, state: t.state, server: t.server }
  },

  async setSpeakingRoom(roomId) { await state.client.setSpeakingRoom(roomId) },

  async press(roomId) { await state.client.rooms.get(roomId).ptt.press() },
  async release(roomId) { await state.client.rooms.get(roomId).ptt.release() },

  ptt(roomId) {
    const st = state.client.rooms.get(roomId)?.ptt.state
    return st ? { phase: st.phase, trusted: st.trusted, canRequest: st.canRequest, remainingSec: st.remainingSec ?? null } : null
  },

  /** 연§5-1 클라 경로를 페이지 origin 에서 그대로 부른다 — SDK 의 preview·listRooms·재동기가 탈 길이다. */
  async httpRooms() {
    const res = await fetch(`${state.base}/rooms`, { headers: { Authorization: `Bearer ${state.token}` } })
    return { status: res.status, count: (await res.json()).rooms?.length ?? null }
  },

  async localTracks() {
    const out = []
    for (const t of state.client.media.tracks) {
      let packets = null
      for (const row of (await t.getStats()).values()) {
        if (row.type === 'outbound-rtp') packets = row.packetsSent ?? null
      }
      out.push({
        id: t.id, kind: t.kind, state: t.state, duplex: t.duplex, owner: t.owner,
        server: t.server ?? null, packets,
      })
    }
    return out
  },

  rooms() {
    return [...state.client.rooms.values()].map((r) => ({
      id: r.id, state: r.state, mode: r.mode, server: r.server,
      participants: r.participants.map((p) => p.userId),
      tracks: r.tracks.map((t) => ({ id: t.id, kind: t.kind, slot: t.slot, userId: t.userId ?? null })),
    }))
  },

  /**
   * 트랙 단위 권위 ② — ★실제로 받는가. 절대값이 아니라 두 스냅샷의 차분으로 판정한다.
   * `packets`·`bytes` 는 그 ssrc 의 inbound-rtp 에서 온다 — 트랙이 붙은 것과 흐르는 것은 다르다.
   */
  async trackStats() {
    const out = []
    for (const [id, { track, roomId }] of state.tracks) {
      const el = state.elements.get(id)
      let packets = null
      let bytes = null
      let framesDecoded = null
      for (const row of (await track.getStats()).values()) {
        if (row.type !== 'inbound-rtp') continue
        packets = row.packetsReceived ?? null
        bytes = row.bytesReceived ?? null
        framesDecoded = row.framesDecoded ?? null
      }
      out.push({
        id, roomId, kind: track.kind, active: track.active,
        muted: track.mediaStreamTrack.muted,
        readyState: track.mediaStreamTrack.readyState,
        packets, bytes, framesDecoded,
        ...(el ? { videoWidth: el.videoWidth, videoHeight: el.videoHeight, currentTime: el.currentTime } : {}),
      })
    }
    return out
  },

  session() {
    const s = state.client.session
    return { state: s.state, recovering: s.recovering, userId: s.userId, pcMode: s.pcMode }
  },

  events(kind) { return kind ? state.events.filter((e) => e.kind === kind) : state.events },

  async teardown() {
    if (!state.client) return
    await state.client.close()
    state.client = null
    state.tracks.clear()
    state.elements.clear()
    document.getElementById('tiles').innerHTML = ''
  },
}

window.qa = qa
window.qaReady = true
