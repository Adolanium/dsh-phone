/**
 * A small upstream that behaves like the Host's browser-trust fence and cookie
 * exchange, without a DSH install. It is deliberately strict: a proxied
 * request is admitted only when Host and Origin are the loopback authority and
 * the Cookie is exactly the pair minted by `GET /?token=test-token`.
 */
import http from 'node:http'
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Start the mock Host.
 * @returns upstream server, origin, mutable state, and a close function.
 */
export async function startMockUpstream() {
  const state = {
    generation: 0,
    expectedCookie: undefined,
    records: [],
    upgrades: [],
    upgradeSockets: new Set(),
  }
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid')
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === 'test-token') {
      state.generation += 1
      state.expectedCookie = `dsh-auth-test=${String(state.generation)}`
      res.writeHead(303, {
        location: './',
        'cache-control': 'no-store',
        'set-cookie': `${state.expectedCookie}; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }

    const authority = `127.0.0.1:${String(server.address().port)}`
    const hostOk = req.headers.host === authority
    const originOk = req.headers.origin === undefined || req.headers.origin === `http://${authority}`
    const cookieOk = req.headers.cookie === state.expectedCookie
    if (!hostOk || !originOk || !cookieOk) {
      res.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'set-cookie': 'stale=1; Path=/',
      })
      res.end('unauthorized')
      return
    }

    state.records.push({ method: req.method, url: req.url, headers: req.headers })
    const body = await readAll(req)

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['upstream-one=1; Path=/', 'upstream-two=2; Path=/'],
      })
      res.end('<!doctype html><html><body>mock harness</body></html>')
      return
    }
    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body.length <= 4096 ? body.toString('utf8') : undefined,
        bodyLength: body.length,
      }))
      return
    }
    if (url.pathname === '/api/expire') {
      state.expectedCookie = 'dsh-auth-test=stale'
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('expired')
      return
    }
    if (url.pathname === '/api/forbidden') {
      res.writeHead(403, {
        'content-type': 'text/plain; charset=utf-8',
        'set-cookie': 'forbidden=1; Path=/',
      })
      res.end('forbidden')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  server.on('upgrade', (req, socket) => {
    const authority = `127.0.0.1:${String(server.address().port)}`
    const hostOk = req.headers.host === authority
    const cookieOk = req.headers.cookie === state.expectedCookie
    const key = req.headers['sec-websocket-key']
    if (!hostOk || !cookieOk || typeof key !== 'string') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
      return
    }
    state.upgrades.push({ url: req.url, headers: req.headers })
    state.upgradeSockets.add(socket)
    socket.once('close', () => state.upgradeSockets.delete(socket))
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-accept: ${accept}\r\n\r\n`,
    )
    setTimeout(() => {
      if (!socket.destroyed) socket.write(textFrame('hello'))
    }, 20)
    socket.on('error', () => {})
    socket.on('data', () => {})
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${String(server.address().port)}`
  return {
    server,
    origin,
    state,
    /** Simulate a half-open upstream: drop upgraded sockets without closing the server. */
    destroyUpgrades() {
      for (const socket of state.upgradeSockets) socket.destroy()
      state.upgradeSockets.clear()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Read a request body. */
export function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Encode a small unmasked text frame for the WebSocket test. */
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
}
