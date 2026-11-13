// author: kodeholic (powered by Claude)
// 샘플 앱의 백엔드 — 정적 파일 + 토큰 발급 + 방 만들기. Node 18 이상, 의존성 없음.
// ★API 비밀은 브라우저에 두지 않는다(연:RULE-TRN-HTTP-AUTH-TWO) — 페이지는 이 서버의 POST /token 만 부른다.
// --https: 다른 기기(폰)에서 붙는 판 — 브라우저는 https 에서만 마이크 · 카메라를 연다. 이 서버가 LAN IP 인증서(mkcert)로 https 를 열고
//          hub 접속점(HTTP · WebSocket)을 같은 주소 아래로 중계한다 — 페이지가 wss 로 붙고 인증서 허용은 한 번이면 된다. 미디어(RTP)는 sfud 로 곧장 간다.
import { execFileSync } from 'node:child_process'
import dgram from 'node:dgram'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect } from 'node:net'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))        // examples/web
const ROOT = join(HERE, '..', '..')                          // 저장소 뿌리(dist/ 가 여기)
const PORT = Number(process.env.PORT ?? 5590)
const BASE = process.env.OXLENS_BASE ?? 'http://127.0.0.1:1974/media'     // hub 접속점
const API_KEY = process.env.OXLENS_API_KEY ?? 'ox_k_demo'                 // 서버 system.toml 의 시연 계정
const API_SECRET = process.env.OXLENS_API_SECRET ?? 'ox_s_demo'
const HTTPS = process.argv.includes('--https')
const HUB = new URL(BASE)
const CERTS = join(HERE, '.certs')

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

// 기본 경로로 나가는 인터페이스의 주소 = 폰이 붙을 LAN IP(패킷은 보내지 않는다)
function lanIp() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4')
    s.on('error', reject)
    s.connect(53, '8.8.8.8', () => {
      const ip = s.address().address
      s.close()
      if (!ip || ip.startsWith('127.') || ip === '0.0.0.0') reject(new Error(`LAN IP 를 못 찾았다(${ip})`))
      else resolve(ip)
    })
  })
}

// 인증서 — OXLENS_TLS_CERT · OXLENS_TLS_KEY 가 있으면 그것 · 없으면 mkcert 로 LAN IP · localhost 인증서를 .certs/ 에 한 번 만든다.
// mkcert 의 CA 를 폰에 깔면(GET /ca.crt) 경고가 안 뜨고, 안 깔면 경고를 한 번 넘기면 된다.
function tlsFor(ip) {
  if (process.env.OXLENS_TLS_CERT && process.env.OXLENS_TLS_KEY) {
    return { cert: readFileSync(process.env.OXLENS_TLS_CERT), key: readFileSync(process.env.OXLENS_TLS_KEY), ca: null }
  }
  let caRoot
  try { caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim() } catch {
    throw new Error('mkcert 가 없다 — `brew install mkcert && mkcert -install` 하거나 OXLENS_TLS_CERT · OXLENS_TLS_KEY 로 인증서를 준다')
  }
  mkdirSync(CERTS, { recursive: true })
  const cert = join(CERTS, `${ip}.pem`)
  const key = join(CERTS, `${ip}-key.pem`)
  if (!existsSync(cert) || !existsSync(key)) {
    execFileSync('mkcert', ['-cert-file', cert, '-key-file', key, ip, 'localhost', '127.0.0.1'], { stdio: 'ignore' })
  }
  const ca = join(caRoot, 'rootCA.pem')
  return { cert: readFileSync(cert), key: readFileSync(key), ca: existsSync(ca) ? readFileSync(ca) : null }
}

function proxyHttp(req, res) {
  const up = request({ host: HUB.hostname, port: Number(HUB.port || 80), method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`hub 에 못 닿는다: ${e.message}`) })
  req.pipe(up)
}

function proxyUpgrade(req, socket, head) {
  if (!req.url?.startsWith(HUB.pathname)) return socket.destroy()
  const up = connect(Number(HUB.port || 80), HUB.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  const closeBoth = () => { up.destroy(); socket.destroy() }
  up.on('error', closeBoth)
  socket.on('error', closeBoth)
}

let caCert = null

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (HTTPS && url.pathname.startsWith(HUB.pathname)) return proxyHttp(req, res)
  if (HTTPS && url.pathname === '/ca.crt' && caCert) {
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="oxlens-dev-ca.crt"' })
    return res.end(caCert)
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const { userId, roomId } = JSON.parse(raw || '{}')
      if (typeof userId !== 'string' || !userId || typeof roomId !== 'string' || !roomId) return json(res, 400, { error: 'userId · roomId' })
      const token = await tokenFor(userId)
      await createRoom(roomId, token)
      return json(res, 200, { token, base: HTTPS ? `https://${req.headers.host}${HUB.pathname}` : BASE })
    } catch (e) {
      return json(res, 502, { error: String(e instanceof Error ? e.message : e) })
    }
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  const p = normalize(url.pathname)
  if (p.startsWith('/dist/')) return serveFile(res, join(ROOT, p))           // SDK 빌드 산출물
  if (p.split('/').some((x) => x.startsWith('.'))) { res.writeHead(404); res.end(); return }   // .certs 등 숨은 것
  return serveFile(res, join(HERE, p === '/' ? 'index.html' : p))           // 페이지 자신
}

if (HTTPS) {
  const ip = await lanIp()
  const { cert, key, ca } = tlsFor(ip)
  caCert = ca
  const server = createTlsServer({ cert, key }, handle)
  server.on('upgrade', proxyUpgrade)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`oxlens sample  https://${ip}:${PORT}   (hub ${BASE} 를 ${HUB.pathname} 로 중계)`)
    console.log(`  폰 — 같은 와이파이에서 위 주소 · 경고가 뜨면 CA 를 깔거나(https://${ip}:${PORT}/ca.crt) 한 번 넘긴다`)
    console.log(`  맥 — https://localhost:${PORT}`)
  })
} else {
  createServer(handle).listen(PORT, () => {
    console.log(`oxlens sample  http://localhost:${PORT}   (hub ${BASE})`)
  })
}
