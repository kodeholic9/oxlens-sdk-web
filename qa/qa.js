// author: kodeholic (powered by Claude)
// 3층 어댑터 — spec 은 이 표면만 쓴다. SDK 내부를 직접 만지지 않는다.
import { createClient } from '../dist/index.js'

// ★시험 전용 관측 — 산 연결의 손잡이를 여기서 잡는다. 제품에 구멍을 내지 않으려고
//   페이지가 생성자를 감싼다. 갈래B 가 "브라우저에게 offer 를 시키면 어떻게 되나" 를 재현하는 자리다.
const seenPcs = []
const OriginalPc = window.RTCPeerConnection
window.RTCPeerConnection = function (config) {
  const pc = new OriginalPc(config)
  seenPcs.push(pc)
  return pc
}
window.RTCPeerConnection.prototype = OriginalPc.prototype

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
  async connect({ base, token, pcMode }) {
    state.base = base
    state.token = token
    // 연§9-10-2 — `pc_mode` 는 붙기 전에 정해진다. 시험이 모드를 지정하는 자리가 여기다.
    const client = createClient(pcMode ? { base, token, pcMode } : { base, token })
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
    room.on('resync', () => note('resync', { room: roomId }))
    room.on('message', (m) => note('message', { room: roomId, userId: m.userId, content: m.content }))
    room.on('error', (e) => note('roomError', { room: roomId, name: e.name, code: e.code }))
    return { id: room.id, mode: room.mode, server: room.server, participants: room.participants.length }
  },

  async leave(roomId) { await state.client.rooms.get(roomId)?.leave() },

  /** 연§6-5 — 응답의 msg_id 로 내 것을 안다. 에코는 오지 않는다. */
  async sendMessage(roomId, content) {
    return state.client.rooms.get(roomId).sendMessage(content)
  },

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

  /** 연§5-3 — SDK 표면으로 부른다. 페이지 origin 이 hub 와 다르면 CORS 가 없으면 막힌다. */
  async listRooms() {
    const rooms = await state.client.listRooms()
    return rooms.map((r) => ({ roomId: r.roomId, userCount: r.userCount }))
  },

  /** 연§5-5 ① — 정원을 먹지 않고 명단에 오르지 않는다. */
  async preview(roomId) {
    const p = await state.client.preview(roomId)
    return {
      roomId: p.roomId, userCount: p.userCount,
      participants: p.participants.map((x) => x.userId),
      version: p.version,
    }
  },

  /**
   * 장치만 죽인다 — 등록·배관은 살아 있고 RTP 만 멎는다.
   * ★깨끗한 퇴장은 정체가 아니다(배관이 같이 걷힌다). 서버 감지가 보는 것은 이 형상이다.
   */
  killSource() {
    for (const t of state.client.media.tracks) t.mediaStreamTrack.stop()
    return state.client.media.tracks.length
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
      // 연§9-10 규칙 2 — 끊김은 계수가 멎는 것으로도, 디코더가 얼어붙는 것으로도 드러난다.
      let freezeCount = null
      let pauseCount = null
      for (const row of (await track.getStats()).values()) {
        if (row.type !== 'inbound-rtp') continue
        packets = row.packetsReceived ?? null
        bytes = row.bytesReceived ?? null
        framesDecoded = row.framesDecoded ?? null
        freezeCount = row.freezeCount ?? null
        pauseCount = row.pauseCount ?? null
      }
      out.push({
        id, roomId, kind: track.kind, active: track.active,
        muted: track.mediaStreamTrack.muted,
        readyState: track.mediaStreamTrack.readyState,
        packets, bytes, framesDecoded, freezeCount, pauseCount,
        ...(el ? { videoWidth: el.videoWidth, videoHeight: el.videoHeight, currentTime: el.currentTime } : {}),
      })
    }
    return out
  },

  /**
   * 연§9-10 규칙 1 을 어긴다 — 산 연결에서 ★브라우저가 자기 offer 를 내게 한다.
   * 성공하면 되돌려 세션을 원래대로 둔다(대조군이 그 뒤로도 돌아야 한다).
   */
  async forceBrowserOffer() {
    const pc = seenPcs[seenPcs.length - 1]
    if (!pc) return { refused: false, message: 'no pc', mids: [] }
    const mids = pc.getTransceivers().map((t) => `${t.mid}:${t.currentDirection}`)
    try {
      await pc.setLocalDescription(await pc.createOffer())
      await pc.setLocalDescription({ type: 'rollback' })
      return { refused: false, message: '', mids }
    } catch (e) {
      return { refused: true, message: String(e.message ?? e), mids }
    }
  },

  session() {
    const s = state.client.session
    return { state: s.state, recovering: s.recovering, userId: s.userId, pcMode: s.pcMode }
  },

  events(kind) { return kind ? state.events.filter((e) => e.kind === kind) : state.events },

  // SDK§6-2 — 수신 오디오는 SDK 가 낸다. ★그 계약을 3층이 볼 자리다.
  //   패킷 차분(trackStats)은 "온다" 까지고, 실제로 소리가 나는지는 재생 요소가 말한다.
  //   판정 재료만 낸다 — 참·거짓은 spec 이 정한다.
  audioOut() {
    const els = [...document.querySelectorAll('audio')]
    return {
      count: els.length,
      playing: els.filter((el) => !el.paused && el.srcObject !== null).length,
      muted: els.filter((el) => el.muted).length,
      volumes: els.map((el) => el.volume),
      allowed: state.client ? state.client.media.audio.playbackAllowed : null,
    }
  },

  async startAudio() { await state.client.media.audio.startAudio() },

  roomAudio(roomId, patch) {
    const r = state.client.rooms.get(roomId)
    if (patch.muted !== undefined) r.audio.setMuted(patch.muted)
    if (patch.volume !== undefined) r.audio.setVolume(patch.volume)
    return { muted: r.audio.muted, volume: r.audio.volume }
  },

  async devices(kind) {
    const list = await state.client.media.devices.list(kind ? { kind } : undefined)
    return list.map((d) => ({ deviceId: d.deviceId, kind: d.kind, groupId: d.groupId }))
  },

  permissions() { return state.client.media.permissions() },

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
