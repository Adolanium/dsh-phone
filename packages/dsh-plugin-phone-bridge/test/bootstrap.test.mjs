import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  PAIR_BOOTSTRAP_PATH,
  SESSION_PATH,
  handleBootstrapRequest,
  handleSessionRequest,
  renderPairBootstrap,
} from '../lib/bootstrap.js'

/**
 * Start a throwaway HTTP server for one handler.
 * @param handler - request handler.
 * @returns origin and close function.
 */
async function startServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${String(server.address().port)}`,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Send one request.
 * @param origin - server origin.
 * @param path - path.
 * @param options - method and headers.
 * @returns status, headers, and text.
 */
function request(origin, path, { method = 'GET', headers = {} } = {}) {
  const url = new URL(path, origin)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the bootstrap page POSTs the fragment code and returns through the app scheme', () => {
  const html = renderPairBootstrap()
  assert.match(html, /fetch\('\/__pair'/)
  assert.match(html, /location\.replace\('dshphone:\/\/paired'\)/)
  assert.match(html, /location\.hash/)
  assert.equal(html.includes('K7QM2X9R'), false)
  assert.equal(html.includes('dsh-phone'), false)
})

test('the bootstrap route serves HTML with no-store and a restrictive CSP', async (t) => {
  const server = await startServer((req, res) => handleBootstrapRequest(req, res))
  t.after(() => server.close())

  const response = await request(server.origin, PAIR_BOOTSTRAP_PATH)
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /^text\/html/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.headers['content-security-policy'], /connect-src 'self'/)
  assert.match(response.text, /Pairing/)

  const post = await request(server.origin, PAIR_BOOTSTRAP_PATH, { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

test('the session probe is 401 without a device and 200 with one', async (t) => {
  const auth = {
    deviceFromRequest(req) {
      return req.headers.cookie === 'dsh-phone=live' ? { id: 'device-1', name: 'Phone' } : undefined
    },
  }
  const server = await startServer((req, res) => handleSessionRequest(req, res, { auth }))
  t.after(() => server.close())

  const denied = await request(server.origin, SESSION_PATH)
  assert.equal(denied.status, 401)
  assert.deepEqual(JSON.parse(denied.text), { ok: false, code: 'pairing-required' })

  const allowed = await request(server.origin, SESSION_PATH, {
    headers: { cookie: 'dsh-phone=live' },
  })
  assert.equal(allowed.status, 200)
  assert.deepEqual(JSON.parse(allowed.text), { ok: true })

  const wrongMethod = await request(server.origin, SESSION_PATH, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})
