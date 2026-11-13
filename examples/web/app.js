// author: kodeholic (powered by Claude)
// 샘플 앱 — README 「빠른 시작」의 실행판. SDK 는 dist/index.js 의 공개 표면만 쓴다.
// 회의: 말하기 모드로 들어가 마이크 · 카메라를 켜고 남의 영상을 타일로 붙인다.
// 무전: 말하기 모드로 들어가 ptt.enable() 로 마이크를 데우고, 누르고 말하기(hold)는 버튼을 누른 동안 press · 떼면 release ·
//       토글(toggle)은 한 번 눌러 press · 다시 눌러 release(큐에서 차례가 오면 다시 눌러 받는다 — 원문 T132 · 기본 2초 안에 PTT 를 눌러야 한다).
//       차례가 오면 진동 · 삑 소리로 알린다(원문 6.2.4.9.4 「floor granted notification」).
import { createClient, OxLensError } from '/dist/index.js'

const $ = (id) => document.getElementById(id)
const ui = {
  form: $('enter'), userId: $('userId'), roomId: $('roomId'), mode: $('mode'), join: $('join'), leave: $('leave'),
  status: $('status'), banner: $('banner'), tiles: $('tiles'), roster: $('roster'),
  ptt: $('ptt'), pttBtn: $('pttBtn'), pttState: $('pttState'), speaker: $('speaker'), log: $('log'),
  logCopy: $('logCopy'), logClear: $('logClear'), hideBeat: $('hideBeat'),
}

const LOG_MAX = 2000

// beat = 상태가 그대로인 전이(하트비트 등) — 「하트비트 숨김」이 켜져 있으면 보이지도 복사되지도 않는다
function log(level, text, beat = false) {
  const line = document.createElement('div')
  line.className = beat ? `${level} beat` : level
  line.textContent = `${new Date().toLocaleTimeString('ko-KR', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')} ${text}`
  ui.log.append(line)
  while (ui.log.childElementCount > LOG_MAX) ui.log.firstElementChild.remove()
  ui.log.scrollTop = ui.log.scrollHeight
}

// 클립보드 API 는 보안 문맥(https · localhost)에서만 있다 — 없으면 예전 방식으로
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* 아래로 */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.append(ta); ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

ui.logCopy.addEventListener('click', async () => {
  const hide = ui.hideBeat.checked
  const lines = [...ui.log.children].filter((el) => !(hide && el.classList.contains('beat'))).map((el) => el.textContent)
  const ok = await copyText(lines.join('\n'))
  ui.logCopy.textContent = ok ? `복사됨 ${lines.length}줄` : '복사 실패'
  setTimeout(() => { ui.logCopy.textContent = '복사' }, 1500)
})
ui.logClear.addEventListener('click', () => ui.log.replaceChildren())
ui.hideBeat.addEventListener('change', () => {
  ui.log.classList.toggle('hideBeat', ui.hideBeat.checked)
  ui.log.scrollTop = ui.log.scrollHeight
})

// 토큰은 백엔드(server.mjs)가 발급한다 — 페이지는 API 비밀을 모른다.
async function fetchToken(userId, roomId) {
  const r = await fetch('/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, roomId }) })
  const body = await r.json()
  if (!r.ok) throw new Error(`token: ${body.error ?? r.status}`)
  return body   // { token, base }
}

function tile(key, label, mediaStreamTrack, muted) {
  let el = ui.tiles.querySelector(`[data-key="${key}"]`)
  if (!el) {
    el = document.createElement('div')
    el.className = 'tile'; el.dataset.key = key
    const v = document.createElement('video')
    v.autoplay = true; v.playsInline = true; v.muted = muted
    const l = document.createElement('span'); l.className = 'label'
    el.append(v, l); ui.tiles.append(el)
  }
  el.querySelector('.label').textContent = label
  const v = el.querySelector('video')
  if (mediaStreamTrack) v.srcObject = new MediaStream([mediaStreamTrack])
  return { el, video: v, remove: () => el.remove() }
}

let client = null
let entered = new AbortController()

async function enter(userId, roomId, mode) {
  entered.abort(); entered = new AbortController()
  const { token, base } = await fetchToken(userId, roomId)
  client = createClient({ base, token })

  client.on('session', (s) => {
    ui.status.textContent = `${s.state}${s.recovering ? ' (recovering)' : ''}${s.reason ? ` · ${s.reason.name}` : ''} · ${userId} @ ${roomId} · ${mode}`
  })
  client.on('tokenRequired', async () => { client.setToken((await fetchToken(userId, roomId)).token) })   // 만료 — 새 토큰으로 다시 붙는다
  client.on('closed', (e) => log(e.retryable ? 'warn' : 'error', `closed ${e.code} ${e.name} retryable=${e.retryable}`))
  client.on('link', (l) => log('info', `link ${l.server ?? ''} ${l.state}`))
  client.on('audioPlayback', (ok) => { ui.banner.style.display = ok ? 'none' : 'block' })   // 브라우저 자동재생 정책
  client.diagnostics.on('log', (e) => { if (e.level === 'warn' || e.level === 'error') log(e.level, `[sdk ${e.ns}] ${e.msg}`) })
  client.diagnostics.on('transition', (t) => log('info', `[sdk ${t.layer}] ${t.key} ${t.from} → ${t.to} (${t.label})`, t.from === t.to))

  // ★받는 트랙은 join 전에 client 에 건다 — 입장 직후 오는 트랙을 놓치지 않는다. 오디오는 SDK 가 재생한다.
  client.on('track', (room, t) => {
    log('info', `track ${t.kind} ${t.type} ${t.userId ?? '(slot)'} ${t.id} muted=${t.muted}`)
    t.on('receiving', () => log('info', `track ${t.id} receiving`))        // 첫 미디어가 닿았다
    t.on('muted', (m) => log('info', `track ${t.id} muted=${m}`))
    if (t.kind !== 'video') return
    if (t.type === 'individual') {     // 사람의 카메라 — 바로 붙인다
      const { video, remove } = tile(`remote:${t.id}`, `${t.userId} @ ${room.id}`, null, false)
      t.attach(video)                  // 보이는지 · 크기를 SDK 가 재서 받을 층을 고른다
      t.on('ended', () => { t.detach(video); remove() })
      return
    }
    // 무전 영상 슬롯(userId 없음) — 방마다 늘 있고 발언자가 영상을 보낼 때만 미디어가 온다. 첫 미디어가 닿으면 타일을 둔다.
    let slot = null
    t.on('receiving', () => { if (!slot) { slot = tile(`remote:${t.id}`, `무전 영상 @ ${room.id}`, null, false); t.attach(slot.video) } })
    t.on('ended', () => { if (slot) { t.detach(slot.video); slot.remove(); slot = null } })
  })

  try {
    await client.connect()
  } catch (e) {
    if (e instanceof OxLensError && e.code === 2003) { client.setToken((await fetchToken(userId, roomId)).token); await client.connect() }
    else throw e
  }

  const room = await client.join(roomId, { mode: 'talk' })   // 말하기 모드 = 이 방이 발언 방. 기본은 'listen'(듣기만)
  const roster = (list) => {
    ui.roster.replaceChildren(...list.map((p) => {
      const li = document.createElement('li')
      li.textContent = `${p.userId} · ${p.mode}${p.userId === userId ? ' (나)' : ''}`
      return li
    }))
  }
  roster(room.participants)            // 입장 응답의 명단 — participants 이벤트는 그 뒤의 변화만 알린다
  room.on('participants', roster)
  room.on('forced', (e) => log('error', `서버가 내보냄 (${e.cause})`))
  room.on('trackUnreachable', (t) => log('info', `track ${t.kind} ${t.userId ?? ''} ${t.id} — 받을 줄이 모자람 · 줄이 오면 track 으로 온다`))
  room.on('error', (e) => log('error', `room ${e.code} ${e.name}`))
  room.ptt.on('speaker', (e) => { ui.speaker.textContent = `speaker: ${e.userId ?? '—'}` })

  if (mode === 'conf') {
    const mic = await client.media.enableMicrophone()
    log('info', `microphone ${mic.state}`)
    const cam = await client.media.enableCamera()
    log('info', `camera ${cam.state}`)
    tile('local', `${userId} (나)`, cam.mediaStreamTrack, true)
  } else {
    ui.ptt.style.display = 'block'
    const ptt = room.ptt
    const toggle = mode === 'ptt-toggle'
    ptt.input = toggle ? 'toggle' : 'hold'                 // 큐에서 차례가 오면 hold 는 버튼을 쥔 채라 바로 열리고 · toggle 은 다시 눌러야 열린다
    await ptt.enable()                                     // 마이크를 미리 데운다(무전 프로필)
    let want = false                                       // 토글 — 지금 말하겠다고 눌러 둔 상태
    let prev = ptt.state.phase
    let talker = null                                      // 남이 말하는 중(TAKEN) — speaker 이벤트의 화자 · 나면 비운다
    const listening = (s) => s.phase === 'no_permission' && talker !== null
    const label = (s) => {
      if (!toggle) return s.phase === 'has_permission' ? '말하는 중' : s.phase === 'queued' ? `대기 ${s.queue?.position ?? ''}` : listening(s) ? `듣는 중 · ${talker}` : '누르고 말하기'
      if (s.acceptPending) return '차례 — 지금 눌러서 말하기'
      if (s.phase === 'has_permission') return '말하는 중 — 눌러서 끝'
      if (s.phase === 'queued') return `대기 ${s.queue?.position ?? ''} — 눌러서 취소`
      if (want) return '요청 중 — 눌러서 취소'
      if (listening(s)) return `듣는 중 · ${talker} — 눌러서 대기`
      return '눌러서 말하기'
    }
    let pending = false
    const show = (s) => {
      if (s.phase === 'no_permission' && prev !== 'no_permission' && prev !== 'off') want = false   // 끝 · 거절 · 회수 — 토글을 내린다
      if (s.acceptPending && !pending) { navigator.vibrate?.([200, 100, 200]); beep(); log('info', '큐 차례 — 지금 누르면 말한다') }
      if (!s.acceptPending && pending && s.lastEnd === 't132_expired') log('warn', '큐 차례를 놓침 (t132_expired)')
      pending = s.acceptPending
      prev = s.phase
      ui.pttBtn.className = listening(s) && !want ? 'listening' : s.phase
      ui.pttBtn.textContent = label(s)
      ui.pttState.textContent = `phase: ${s.phase} · ${toggle ? 'toggle' : 'hold'}${s.remainingSec != null && !s.acceptPending ? ` · ${s.remainingSec}s` : ''}${s.lastDeny ? ` · deny ${s.lastDeny.cause}` : ''}${s.lastRevoke ? ` · revoke ${s.lastRevoke.cause}` : ''}`
    }
    show(ptt.state)
    ptt.on('state', show)
    ptt.on('speaker', (e) => { talker = e.userId && e.userId !== userId ? e.userId : null; show(ptt.state) })
    ptt.on('denied', (s) => log('warn', `denied cause=${s.lastDeny?.cause} ${s.lastDeny?.text ?? ''}`))
    ptt.on('revoked', (s) => log('warn', `revoked cause=${s.lastRevoke?.cause}`))
    const sig = { signal: entered.signal }                 // 나가면 버튼 리스너를 함께 뗀다 — 다시 들어와도 겹치지 않는다
    ui.pttBtn.addEventListener('contextmenu', (ev) => ev.preventDefault(), sig)   // 폰 길게 누름 메뉴
    if (toggle) {
      ui.pttBtn.addEventListener('click', () => {
        unlockBeep()
        if (ptt.state.acceptPending) { void ptt.press(); return }   // 큐에서 차례가 왔다 — 받는다
        want = !want
        void (want ? ptt.press() : ptt.release())
        ui.pttBtn.textContent = label(ptt.state)
      }, sig)
    } else {
      const down = (ev) => { ev.preventDefault(); unlockBeep(); ui.pttBtn.setPointerCapture(ev.pointerId); void ptt.press() }
      const up = () => { void ptt.release() }
      ui.pttBtn.addEventListener('pointerdown', down, sig)
      ui.pttBtn.addEventListener('pointerup', up, sig)
      ui.pttBtn.addEventListener('pointercancel', up, sig)
    }
  }
  return room
}

// 차례 알림 소리 — 폰 브라우저는 사용자 손짓 안에서 만든 AudioContext 만 소리를 낸다(버튼을 누를 때 연다)
let ac = null
function unlockBeep() { try { ac ??= new AudioContext(); void ac.resume() } catch { /* 소리 없음 */ } }
function beep() {
  if (!ac) return
  const o = ac.createOscillator(), g = ac.createGain()
  o.frequency.value = 880; g.gain.value = 0.2
  o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.15)
}

ui.banner.addEventListener('click', () => { void client?.media.startAudio() })
ui.leave.addEventListener('click', () => { void client?.close(); client = null; reset() })
window.addEventListener('pagehide', () => { void client?.close() })

function reset() {
  entered.abort()
  ui.pttBtn.className = ''; ui.pttBtn.textContent = '누르고 말하기'
  ui.tiles.replaceChildren(); ui.roster.replaceChildren()
  ui.ptt.style.display = 'none'; ui.leave.style.display = 'none'; ui.join.disabled = false
  ui.status.textContent = 'disconnected'; ui.speaker.textContent = 'speaker: —'
}

// 고른 것은 이 브라우저에만 기억한다(사생활 창 · 막힌 저장소면 그냥 넘어간다)
const PREF = 'oxlens-sample'
try {
  const p = JSON.parse(localStorage.getItem(PREF) ?? '{}')
  if (p.userId) ui.userId.value = p.userId
  if (p.roomId) ui.roomId.value = p.roomId
  if ([...ui.mode.options].some((o) => o.value === p.mode)) ui.mode.value = p.mode
} catch { /* 기억 없음 */ }

ui.form.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  try { localStorage.setItem(PREF, JSON.stringify({ userId: ui.userId.value.trim(), roomId: ui.roomId.value.trim(), mode: ui.mode.value })) } catch { /* 저장 못 함 */ }
  ui.join.disabled = true; ui.leave.style.display = 'inline-block'
  try {
    await enter(ui.userId.value.trim(), ui.roomId.value.trim(), ui.mode.value)
  } catch (e) {
    const msg = e instanceof OxLensError ? `${e.code} ${e.name} (${e.category})` : String(e?.message ?? e)
    log('error', `입장 실패: ${msg}`)
    await client?.close(); client = null; reset()
  }
})
