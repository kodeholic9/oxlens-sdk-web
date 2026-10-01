// author: kodeholic (powered by Claude)
// spec: v1.2 · 연§5-0 · §5-1 · 정§16-1-1 · §18-1 · model: claude-opus-5-5

import { execFileSync } from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const LABS = path.resolve(process.env.OX_LABS ?? path.join(ROOT, '..', 'oxlens-labs'))
const TESTLOGS = path.resolve(process.env.OX_TESTLOGS ?? path.join(ROOT, '..', '..', 'testlogs'))
const HUB = process.env.OX_HUB ?? '127.0.0.1:19745'
const HTTPS_PORT = Number(process.env.OX_LAN_HTTPS_PORT ?? 8443)
const CA_PORT = Number(process.env.OX_LAN_CA_PORT ?? 8080)
const CERTS = path.join(HERE, '.certs')
const [HUB_HOST, HUB_PORT] = HUB.split(':')
const NOT_PROXIED = ['/admin', '/healthz']
const LOG_MAX_BYTES = 20 * 1024 * 1024

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
}

function lanIpByDefaultRoute() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4')
    s.on('error', reject)
    s.connect(53, '8.8.8.8', () => {
      const ip = s.address().address
      s.close()
      if (!ip || ip === '0.0.0.0' || ip.startsWith('127.')) reject(new Error(`LAN IP 를 못 찾았다(${ip})`))
      else resolve(ip)
    })
  })
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
}

function certForIp(ip) {
  fs.mkdirSync(CERTS, { recursive: true })
  const cert = path.join(CERTS, `${ip}.pem`)
  const key = path.join(CERTS, `${ip}-key.pem`)
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    run('mkcert', ['-cert-file', cert, '-key-file', key, ip, 'localhost', '127.0.0.1'])
  }
  const ca = path.join(run('mkcert', ['-CAROOT']).trim(), 'rootCA.pem')
  if (!fs.existsSync(ca)) throw new Error(`CA 가 없다: ${ca} — mkcert 를 한 번 돌려 만든다`)
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), caCertOnly: fs.readFileSync(ca) }
}

function ensureServerByHarness() {
  const py = path.join(LABS, 'oxe2epy', '.venv', 'bin', 'python')
  if (!fs.existsSync(py)) throw new Error(`하네스가 없다: ${py}`)
  const out = run(py, ['-c', 'from oxe2epy import server; print(server.ensure())'], {
    cwd: path.join(LABS, 'oxe2epy'),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return out.trim().split('\n').pop()
}

function isHiddenOrOutside(rel, file) {
  return !file.startsWith(ROOT + path.sep) || rel.split('/').some((p) => p.startsWith('.'))
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end()
  const rel = decodeURIComponent(url.pathname) === '/' ? '/qa/lan/index.html' : decodeURIComponent(url.pathname)
  const file = path.resolve(ROOT, '.' + rel)
  if (isHiddenOrOutside(rel, file)) return void res.writeHead(404).end()
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') return void res.end()
    fs.createReadStream(file).pipe(res)
  })
}

function proxyHttpToHub(req, res) {
  const up = http.request(
    { host: HUB_HOST, port: Number(HUB_PORT), method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    },
  )
  up.on('error', (e) => res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`hub 에 못 닿는다: ${e.message}`))
  req.pipe(up)
}

function proxyUpgradeToHub(req, socket, head) {
  if (!req.url.startsWith('/media')) return socket.destroy()
  const up = net.connect(Number(HUB_PORT), HUB_HOST, () => {
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

function serverTime(res) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ now: Date.now() }))
}

function saveDeviceLog(req, res, url) {
  const device = (url.searchParams.get('device') ?? 'X').replace(/[^\w-]/g, '').slice(0, 16) || 'X'
  const now = new Date()
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  const dir = path.join(TESTLOGS, ym, 'lan')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const file = path.join(dir, `${stamp}_${device}.log`)
  const out = fs.createWriteStream(file)
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > LOG_MAX_BYTES) req.destroy() })
  req.pipe(out)
  out.on('finish', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ saved: path.relative(TESTLOGS, file), bytes: size, serverNow: Date.now() }))
  })
}

function route(req, res) {
  const url = new URL(req.url, 'https://lan')
  if (url.pathname.startsWith('/media')) return proxyHttpToHub(req, res)
  if (url.pathname === '/lan/time') return serverTime(res)
  if (url.pathname === '/lan/log' && req.method === 'POST') return saveDeviceLog(req, res, url)
  if (NOT_PROXIED.some((p) => url.pathname.startsWith(p))) return void res.writeHead(404).end()
  return serveStatic(req, res, url)
}

function serveCaCertOnly(caCertOnly) {
  return (req, res) => {
    if (req.url !== '/ca.crt') return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="oxlens-dev-ca.crt"' })
    res.end(caCertOnly)
  }
}

async function main() {
  const ip = await lanIpByDefaultRoute()
  console.log(`[lan] IP ${ip}`)
  console.log('[lan] SDK 빌드…')
  run('npm', ['run', '-s', 'build'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
  console.log('[lan] 서버 — 하네스 server.ensure()…')
  console.log(`[lan] 서버 build=${ensureServerByHarness()}`)

  const { cert, key, caCertOnly } = certForIp(ip)
  const page = https.createServer({ cert, key }, route)
  page.on('upgrade', proxyUpgradeToHub)
  page.listen(HTTPS_PORT, '0.0.0.0')
  http.createServer(serveCaCertOnly(caCertOnly)).listen(CA_PORT, '0.0.0.0')

  console.log('')
  console.log(`  단말 CA 설치(한 번) : http://${ip}:${CA_PORT}/ca.crt`)
  console.log(`  수동 시험 페이지    : https://${ip}:${HTTPS_PORT}/`)
  console.log(`  Mac 대조군          : https://localhost:${HTTPS_PORT}/  (Mac 이 CA 를 신뢰하지 않으면 경고를 한 번 통과)`)
  console.log(`  서버 사실(Mac 만)   : http://${HUB}/admin/…`)
  console.log(`  단말 로그           : ${path.join(TESTLOGS, '<YYYYMM>', 'lan')}`)
  console.log('  Ctrl-C 로 내린다. 개발 서버는 하네스 것이라 그대로 둔다.')
}

main().catch((e) => {
  console.error(`[lan] ✗ ${e.message}`)
  process.exit(1)
})
