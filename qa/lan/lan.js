// author: kodeholic (powered by Claude)
// spec: v1.2 · 연§2-6 · §5-1 · SDK§3 · §4 · §5 · model: claude-opus-5-5

// 로컬망 수동 시험 화면 — qa.js(3층과 같은 어댑터) 위에 얹는다. 화면은 상태를 폴링해 그리고,
// 조작은 qa.* 를 부른다. 토큰·방 생성은 앱 백엔드 몫이라(연§5-1·§5-4) 이 페이지가 데모 키로 대신한다.

const BASE = `${location.origin}/media`
const DEMO = { api_key: 'ox_k_demo', api_secret: 'ox_s_demo' }
const $ = (id) => document.getElementById(id)
const ui = { selected: null, offsetMs: 0, rtt: null, lastPhase: new Map(), rx: new Map() }

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value) } catch { return null }
  return value
}

function serverNow() { return Date.now() + ui.offsetMs }
function hhmmss(ms) { return new Date(ms).toTimeString().slice(0, 8) + '.' + String(ms % 1000).padStart(3, '0') }

function logLine(text) {
  window.qa?.mark?.(`ui:${text}`)
  render.logDirty = true
}

async function syncClock() {
  try {
    const t0 = Date.now()
    const r = await fetch('/lan/time', { cache: 'no-store' })
    const t1 = Date.now()
    const { now } = await r.json()
    ui.rtt = t1 - t0
    ui.offsetMs = Math.round(now - (t0 + t1) / 2)
  } catch { ui.rtt = null }
}

async function token(userId) {
  const r = await fetch(`${BASE}/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...DEMO, user_id: userId, participant_type: 0, hidden: false }),
  })
  if (!r.ok) throw new Error(`token ${r.status}`)
  return (await r.json()).token
}

async function ensureRoom(roomId, userToken) {
  const r = await fetch(`${BASE}/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ room_id: roomId, name: roomId }),
  })
  if (!r.ok && r.status !== 409) throw new Error(`POST /rooms ${r.status}`)
}

function act(name, fn) {
  return async (...a) => {
    try { await fn(...a) } catch (e) { logLine(`✗ ${name}: ${e?.name ?? ''} ${e?.code ?? ''} ${e?.message ?? e}`) }
  }
}

function deviceName() { return $('dev').value }
function userId() { return $('user').value.trim() || `lan_${deviceName()}` }

const connect = act('접속', async () => {
  const t = await token(userId())
  ui.token = t
  const pcMode = $('pc').value || undefined
  const r = await window.qa.connect({ base: BASE, token: t, pcMode })
  logLine(`접속 user=${r.userId} pcMode=${r.pcMode}`)
})

const close = act('종료', async () => { await window.qa.teardown(); ui.selected = null; logLine('종료') })

const join = (mode) => act(`입장(${mode})`, async () => {
  const id = $('roomId').value.trim()
  await ensureRoom(id, ui.token)
  const r = await window.qa.join(id, mode)
  ui.selected = id
  logLine(`입장 ${id} mode=${r.mode} server=${r.server}`)
})

const leave = (id) => act('나가기', async () => { await window.qa.leave(id); if (ui.selected === id) ui.selected = null; logLine(`나감 ${id}`) })
const speakHere = (id) => act('발언 방', async () => { await window.qa.setSpeakingRoom(id); logLine(`발언 방 → ${id}`) })
const muteToggle = (id, muted) => act('방 소리', async () => { window.qa.roomAudio(id, { muted: !muted }) })

const press = act('press', async () => { if (ui.selected) await window.qa.press(ui.selected) })
const release = act('release', async () => { if (ui.selected) await window.qa.release(ui.selected) })

function pttDown(e) {
  e.preventDefault()
  if (!ui.selected) return
  const st = window.qa.pttFull(ui.selected)
  if (st?.input === 'toggle') {
    const holding = st.phase === 'has_permission' || st.phase === 'pending_request'
    const acceptable = st.phase === 'queued' && st.acceptPending
    if (holding || (st.phase === 'queued' && !acceptable)) release()
    else press()
    return
  }
  $('pttBtn').classList.add('on')
  press()
}

function pttUp(e) {
  e.preventDefault()
  if (!ui.selected) return
  const st = window.qa.pttFull(ui.selected)
  if (st?.input === 'toggle') return
  $('pttBtn').classList.remove('on')
  release()
}

const applyPtt = act('발언 설정', async () => {
  if (!ui.selected) return
  const r = window.qa.pttSet(ui.selected, { input: $('input').value, priority: Number($('prio').value) })
  logLine(`발언 설정 input=${r.input} priority=${r.priority}`)
})

const enableMic = act('마이크 데우기', async () => { if (ui.selected) { await window.qa.pttEnable(ui.selected); logLine('마이크 등록(hot_standby)') } })
const warm = act('keepWarm', async () => { if (ui.selected) { window.qa.keepWarm(ui.selected, 60_000); logLine('keepWarm 60s') } })

const mark = () => { const n = (ui.marks = (ui.marks ?? 0) + 1); logLine(`★표시 #${n} @${hhmmss(serverNow())}`) }

const upload = act('로그 올리기', async () => {
  const qa = window.qa
  const body = {
    device: deviceName(), user: userId(), clockOffsetMs: ui.offsetMs, rttMs: ui.rtt, uploadedAt: serverNow(),
    userAgent: navigator.userAgent,
    session: qa.session?.() ?? null,
    rooms: safe(() => qa.rooms()),
    ptt: Object.fromEntries((safe(() => qa.rooms()) ?? []).map((r) => [r.id, qa.pttFull(r.id)])),
    trackStats: await safeAsync(() => qa.trackStats()),
    localTracks: await safeAsync(() => qa.localTracks()),
    icePairs: await safeAsync(() => qa.icePairs()),
    events: qa.events().map((e) => ({ ...e, serverAt: e.at + ui.offsetMs })),
  }
  const r = await fetch(`/lan/log?device=${encodeURIComponent(deviceName())}`, { method: 'POST', body: JSON.stringify(body, null, 1) })
  const j = await r.json()
  $('uploadRes').textContent = `${j.saved} (${j.bytes}B)`
})

function safe(fn) { try { return fn() } catch { return null } }
async function safeAsync(fn) { try { return await fn() } catch { return null } }

function pill(el, text, cls) { el.textContent = text; el.className = `pill ${cls ?? ''}` }

function kv(el, pairs) {
  el.innerHTML = pairs.map(([k, v]) => `<span>${k}</span><b>${v ?? '—'}</b>`).join('')
}

// 연§11-3 — 거절 사유와 회수 사유는 같은 TLV 2 를 쓰지만 표가 다르다(같은 숫자가 다른 뜻).
const DENY_CAUSE = { 1: '다른 사람이 말하는 중', 2: '서버 내부 오류', 3: '참가자가 나뿐', 4: '회수 직후 재요청 차단(T9)', 5: '청취 전용', 6: '자원 없음', 7: '대기줄 만석', 101: '발언 방(pub_room) 아님', 102: '발언 요청 자격 없음', 255: '그 밖' }
const REVOKE_CAUSE = { 1: '남은 사람이 나뿐', 2: '발화 상한 초과(T2)', 3: '권한 회수', 4: '선점당함', 6: '자원 없음', 7: '다른 사람이 회수', 255: '그 밖' }
const causeText = (c, table) => (c ? `${c.cause} ${table[c.cause] ?? ''}${c.text ? ` (${c.text})` : ''}` : null)

function renderRooms(rooms) {
  const sp = window.qa.speakingRoom()
  $('rooms').innerHTML = rooms.map((r) => {
    const st = window.qa.pttFull(r.id) ?? {}
    const speaker = window.qa.speaker(r.id)
    const audio = safe(() => window.qa.roomAudio(r.id, {})) ?? {}
    return `<div class="room ${ui.selected === r.id ? 'sel' : ''}" data-id="${r.id}">
      <div class="title"><b>${r.id}${sp === r.id ? ' 🎙' : ''}</b><span class="phase ${st.phase ?? ''}">${st.phase ?? '—'}</span></div>
      <div class="kv">
        <span>상태·모드</span><b>${r.state} · ${r.mode} · ${r.server ?? ''}</b>
        <span>화자</span><b>${st.phase === 'has_permission' ? '나(발언 중)' : (speaker ?? '없음')}</b>
        <span>명단</span><b>${r.participants.join(', ') || '—'}</b>
        <span>trusted · canRequest</span><b>${st.trusted} · ${st.canRequest}</b>
      </div>
      <div class="row">
        <button data-act="sel">선택</button>
        <button data-act="speak">발언 방</button>
        <button data-act="mute" data-muted="${audio.muted ? 1 : 0}">${audio.muted ? '소리 켜기' : '소리 끄기'}</button>
        <button data-act="leave">나가기</button>
      </div>
    </div>`
  }).join('')
}

function renderPtt() {
  const id = ui.selected
  const st = id ? window.qa.pttFull(id) : null
  if (!st) { kv($('pttKv'), []); $('pttSide').textContent = '방 선택 전'; return }
  const remain = st.talkingSince && st.remainingSec !== undefined
    ? Math.max(0, st.remainingSec - Math.floor((Date.now() - st.talkingSince) / 1000)) : null
  kv($('pttKv'), [
    ['방', id], ['phase', st.phase], ['남은 시간', remain !== null ? `${remain}s / ${st.remainingSec}s` : null],
    ['queue', st.queue ? `${st.queue.position}/${st.queue.size}` : null], ['acceptPending', st.acceptPending],
    ['canRequest', st.canRequest], ['trusted', st.trusted], ['mic', st.mic], ['input', st.input],
    ['우선순위(요청/허가)', `${st.wantPriority} / ${st.priority ?? '—'}`],
    ['lastDeny', causeText(st.lastDeny, DENY_CAUSE)], ['lastRevoke', causeText(st.lastRevoke, REVOKE_CAUSE)], ['lastEnd', st.lastEnd],
  ])
  $('pttSide').textContent = `${id}\n${st.phase}${remain !== null ? ` ${remain}s` : ''}`
  const prev = ui.lastPhase.get(id)
  if (prev !== st.phase) { ui.lastPhase.set(id, st.phase); if (prev !== undefined) logLine(`phase ${id}: ${prev} → ${st.phase}`) }
  $('pttBtn').classList.toggle('on', st.phase === 'has_permission')
}

async function renderRx() {
  const stats = (await safeAsync(() => window.qa.trackStats())) ?? []
  kv($('rxKv'), stats.map((t) => {
    const prev = ui.rx.get(t.id) ?? 0
    ui.rx.set(t.id, t.packets ?? 0)
    return [`${t.kind} ${t.id.slice(-6)}`, `pkt +${(t.packets ?? 0) - prev} · concealed ${t.concealed ?? '—'} · ${t.readyState}`]
  }))
}

function renderLog() {
  const ev = window.qa.events().slice(-200)
  $('log').textContent = ev.map((e) => `${hhmmss(e.at + ui.offsetMs)} ${e.kind} ${JSON.stringify(e.detail)}`).join('\n')
  $('log').scrollTop = $('log').scrollHeight
}

function render() {
  const qa = window.qa
  $('devName').textContent = deviceName()
  pill($('clock'), ui.rtt === null ? '시각 ?' : `서버 ${ui.offsetMs >= 0 ? '+' : ''}${ui.offsetMs}ms · rtt ${ui.rtt}`)
  const s = safe(() => qa.session())
  if (!s) { pill($('sess'), 'disconnected', 'bad'); $('rooms').innerHTML = ''; renderPtt(); return }
  pill($('sess'), `${s.state}${s.recovering ? ' · 복구 중' : ''}`, s.state === 'active' && !s.recovering ? 'ok' : 'warn')
  kv($('sessKv'), [['userId', s.userId], ['pcMode', s.pcMode], ['state', s.state], ['recovering', s.recovering]])
  pill($('spk'), `발언 방 ${qa.speakingRoom() ?? '—'}`)
  const rooms = safe(() => qa.rooms()) ?? []
  if (!ui.selected && rooms.length) ui.selected = rooms[0].id
  renderRooms(rooms)
  renderPtt()
  const allowed = safe(() => qa.audioOut().allowed)
  $('banner').style.display = allowed === false ? 'block' : 'none'
  if (render.logDirty || render.tick++ % 3 === 0) { renderLog(); render.logDirty = false }
}
render.tick = 0

function wire() {
  $('dev').value = store('lan.dev') ?? 'A'
  $('user').value = store('lan.user') ?? ''
  $('dev').onchange = () => store('lan.dev', $('dev').value)
  $('user').onchange = () => store('lan.user', $('user').value)
  $('connectBtn').onclick = connect
  $('closeBtn').onclick = close
  $('joinTalk').onclick = join('talk')
  $('joinListen').onclick = join('listen')
  $('applyPtt').onclick = applyPtt
  $('enableMic').onclick = enableMic
  $('warm60').onclick = warm
  $('markBtn').onclick = mark
  $('uploadBtn').onclick = upload
  $('banner').onclick = act('소리 켜기', async () => { await window.qa.startAudio() })
  const b = $('pttBtn')
  b.addEventListener('pointerdown', pttDown)
  b.addEventListener('pointerup', pttUp)
  b.addEventListener('pointercancel', pttUp)
  b.addEventListener('contextmenu', (e) => e.preventDefault())
  $('rooms').addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    const id = e.target.closest('.room')?.dataset.id
    if (!btn || !id) return
    const a = btn.dataset.act
    if (a === 'sel') ui.selected = id
    if (a === 'speak') speakHere(id)()
    if (a === 'leave') leave(id)()
    if (a === 'mute') muteToggle(id, btn.dataset.muted === '1')()
  })
}

async function boot() {
  for (let i = 0; i < 100 && !window.qaReady; i++) await new Promise((r) => setTimeout(r, 50))
  wire()
  await syncClock()
  setInterval(syncClock, 30_000)
  setInterval(render, 300)
  setInterval(renderRx, 1000)
  render()
}

boot()
