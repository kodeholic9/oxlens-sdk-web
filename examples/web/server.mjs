// author: kodeholic (powered by Claude)
// 샘플 앱의 백엔드 — 정적 파일 + 토큰 발급 + 방 만들기. Node 18 이상, 의존성 없음.
// ★API 비밀은 브라우저에 두지 않는다(연:RULE-TRN-HTTP-AUTH-TWO) — 페이지는 이 서버의 POST /token 만 부른다.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))        // examples/web
const ROOT = join(HERE, '..', '..')                          // 저장소 뿌리(dist/ 가 여기)
const PORT = Number(process.env.PORT ?? 5590)
const BASE = process.env.OXLENS_BASE ?? 'http://127.0.0.1:1974/media'     // hub 접속점
const API_KEY = process.env.OXLENS_API_KEY ?? 'ox_k_demo'                 // 서버 system.toml 의 시연 계정
const API_SECRET = process.env.OXLENS_API_SECRET ?? 'ox_s_demo'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json' }

async function tokenFor(userId) {
  const r = await fetch(`${BASE}/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY, api_secret: API_SECRET, user_id: userId }),
  })
  if (!r.ok) throw new Error(`auth/token ${r.status}`)
  return (await r.json()).token
}

async function createRoom(roomId, token) {
  const r = await fetch(`${BASE}/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ room_id: roomId, name: roomId }),
  })
  if (!r.ok && r.status !== 409) throw new Error(`rooms ${r.status}`)   // 409 = 이미 있다
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function serveFile(res, path) {
  try {
    const data = await readFile(path)
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('not found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (req.method === 'POST' && url.pathname === '/token') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const { userId, roomId } = JSON.parse(raw || '{}')
      if (typeof userId !== 'string' || !userId || typeof roomId !== 'string' || !roomId) return json(res, 400, { error: 'userId · roomId' })
      const token = await tokenFor(userId)
      await createRoom(roomId, token)
      return json(res, 200, { token, base: BASE })
    } catch (e) {
      return json(res, 502, { error: String(e instanceof Error ? e.message : e) })
    }
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  const p = normalize(url.pathname)
  if (p.startsWith('/dist/')) return serveFile(res, join(ROOT, p))           // SDK 빌드 산출물
  return serveFile(res, join(HERE, p === '/' ? 'index.html' : p))           // 페이지 자신
})

server.listen(PORT, () => {
  console.log(`oxlens sample  http://localhost:${PORT}   (hub ${BASE})`)
})
