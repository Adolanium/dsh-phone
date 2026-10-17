import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PhoneAuth, sha256Hex } from '../lib/auth.js'
import { adminGuard, handleAdmin } from '../lib/routes.js'
import { DeviceStore } from '../lib/store.js'

/** Map an admin path to the route kind used by the dispatcher. */
const KINDS = {
  '/phone-bridge/status': 'status',
  '/phone-bridge/devices': 'devices',
  '/phone-bridge/qr.svg': 'qr',
  '/phone-bridge/rotate': 'rotate',
  '/phone-bridge/revoke': 'revoke',
}

/**
 * Start an admin dispatcher with a fresh auth/store.
 * @param options - optional listener override.
 * @returns server origin and cleanup.
 */
async function startAdminServer({ listener = { address: '100.64.1.2', port: 8787 } } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-phone-admin-'))
  const auth = new PhoneAuth({ store: new DeviceStore({ path: join(directory, 'phone-bridge.json') }) })
  await auth.load()
  const logs = []
  const socketsClosed = []
  let ownOrigin
  const bridge = {
    auth,
    closeDevice: (id) => {
      socketsClosed.push(`device:${id}`)
      return 1
    },
    closeAllDeviceSockets: () => {
      socketsClosed.push('all')
      return 2
    },
    status: () => ({
      version: '0.2.0-test',
      state: 'listening',
      tailnet: { ip: '100.64.1.2', dnsName: 'desk.tail.ts.net', source: 'tailscale-cli' },
      listener,
      auth: auth.status(),
    }),
  }
  const server = http.createServer((req, res) => {
    const kind = KINDS[new URL(req.url, 'http://x').pathname]
    if (kind === undefined) {
      res.writeHead(404).end()
      return
    }
    void handleAdmin(req, res, {
      kind,
      bridge,
      log: (level, event, fields) => logs.push({ level, event, fields }),
      getOrigin: () => ownOrigin,
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  ownOrigin = `http://127.0.0.1:${String(server.address().port)}`
  return {
    origin: ownOrigin,
    ownOrigin,
    auth,
    logs,
    socketsClosed,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await auth.store.queue.catch(() => {})
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Send one admin request.
 * @param fixture - server fixture.
 * @param path - admin path.
 * @param options - method, headers, body.
 * @returns status, headers, and JSON body.
 */
function request(fixture, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, fixture.origin)
  const finalHeaders = { ...headers }
  if (body !== undefined) finalHeaders['content-length'] = String(Buffer.byteLength(body))
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: finalHeaders,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('adminGuard requires loopback, the custom header, and a known Origin', () => {
  const own = 'http://127.0.0.1:1234'
  const base = { headers: { 'x-dsh-phone-admin': '1' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(adminGuard(base, own), undefined)
  assert.equal(adminGuard({ ...base, headers: {} }, own).code, 'missing-admin-header')
  assert.equal(adminGuard({
    ...base,
    headers: { 'x-dsh-phone-admin': '1', origin: 'http://evil.example' },
  }, own).code, 'forbidden-origin')
  assert.equal(adminGuard({
    ...base,
    headers: { 'x-dsh-phone-admin': '1', origin: 'dsh-app://app' },
  }, own), undefined)
  assert.equal(adminGuard({
    ...base,
    socket: { remoteAddress: '100.64.1.9' },
  }, own).code, 'forbidden-host')
})

test('status requires the header and returns pairing info without credentials', async (t) => {
  const fixture = await startAdminServer()
  t.after(() => fixture.close())

  const missing = await request(fixture, '/phone-bridge/status')
  assert.equal(missing.status, 403)
  assert.equal(missing.body.code, 'missing-admin-header')

  const foreign = await request(fixture, '/phone-bridge/status', {
    headers: { 'x-dsh-phone-admin': '1', origin: 'http://evil.example' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.body.code, 'forbidden-origin')

  const own = await request(fixture, '/phone-bridge/status', {
    headers: { 'x-dsh-phone-admin': '1', origin: fixture.ownOrigin },
  })
  assert.equal(own.status, 200)
  assert.equal(own.body.ok, true)
  assert.equal(own.body.state, 'listening')
  assert.match(own.body.auth.pairing.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.equal(own.headers['access-control-allow-origin'], undefined)

  const shell = await request(fixture, '/phone-bridge/status', {
    headers: { 'x-dsh-phone-admin': '1', origin: 'dsh-app://app' },
  })
  assert.equal(shell.status, 200)

  const absent = await request(fixture, '/phone-bridge/status', {
    headers: { 'x-dsh-phone-admin': '1' },
  })
  assert.equal(absent.status, 200)
})

test('rotate, devices, and revoke operate on the store without exposing hashes', async (t) => {
  const fixture = await startAdminServer()
  t.after(() => fixture.close())
  const headers = { 'x-dsh-phone-admin': '1' }

  const rotated = await request(fixture, '/phone-bridge/rotate', { method: 'POST', headers })
  assert.equal(rotated.status, 200)
  assert.match(rotated.body.pairing.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  const firstCode = rotated.body.pairing.code

  const paired = await fixture.auth.pair({ code: firstCode, name: 'iPhone', source: '100.64.1.2' })
  assert.equal(paired.ok, true)

  const devices = await request(fixture, '/phone-bridge/devices', { headers })
  assert.equal(devices.status, 200)
  assert.equal(devices.body.devices.length, 1)
  assert.equal(devices.body.devices[0].name, 'iPhone')
  assert.equal('tokenHash' in devices.body.devices[0], false)
  assert.equal(JSON.stringify(devices.body).includes(paired.token), false)
  assert.equal(JSON.stringify(devices.body).includes(sha256Hex(paired.token)), false)

  const revoked = await request(fixture, '/phone-bridge/revoke', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ id: paired.device.id }),
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.revoked, 1)
  assert.equal(fixture.auth.verifyToken(paired.token), undefined)
  assert.deepEqual(fixture.socketsClosed, [`device:${paired.device.id}`])

  const empty = await request(fixture, '/phone-bridge/devices', { headers })
  assert.deepEqual(empty.body.devices, [])
})

test('revoke all clears every device in one request', async (t) => {
  const fixture = await startAdminServer()
  t.after(() => fixture.close())
  const headers = { 'x-dsh-phone-admin': '1' }

  await fixture.auth.pair({ code: fixture.auth.pairingInfo().code, name: 'One' })
  await fixture.auth.pair({ code: fixture.auth.pairingInfo().code, name: 'Two' })
  assert.equal(fixture.auth.status().deviceCount, 2)

  const revoked = await request(fixture, '/phone-bridge/revoke', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.body.revoked, 2)
  assert.deepEqual(fixture.socketsClosed, ['all'])
  assert.equal(fixture.auth.status().deviceCount, 0)
})

test('qr.svg returns an SVG for the current code without printing the code', async (t) => {
  const fixture = await startAdminServer()
  t.after(() => fixture.close())
  const code = fixture.auth.pairingInfo().code
  const qr = await request(fixture, '/phone-bridge/qr.svg', {
    headers: { 'x-dsh-phone-admin': '1' },
  })
  assert.equal(qr.status, 200)
  assert.match(qr.headers['content-type'], /^image\/svg\+xml/)
  assert.match(qr.text, /^<svg /)
  assert.match(qr.text, /viewBox="0 0 \d+ \d+"/)
  assert.match(qr.text, /<path d="M/)
  assert.equal(qr.text.includes(code), false)
  assert.equal(qr.headers['access-control-allow-origin'], undefined)

  const missing = await request(fixture, '/phone-bridge/qr.svg')
  assert.equal(missing.status, 403)
})

test('qr.svg fails closed while the listener is offline', async (t) => {
  const fixture = await startAdminServer({ listener: null })
  t.after(() => fixture.close())
  const qr = await request(fixture, '/phone-bridge/qr.svg', {
    headers: { 'x-dsh-phone-admin': '1' },
  })
  assert.equal(qr.status, 503)
  assert.equal(qr.body.code, 'listener-offline')
})

test('method, content type, and body errors are classified', async (t) => {
  const fixture = await startAdminServer()
  t.after(() => fixture.close())
  const headers = { 'x-dsh-phone-admin': '1' }

  const wrongMethod = await request(fixture, '/phone-bridge/rotate', { headers })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const noType = await request(fixture, '/phone-bridge/revoke', {
    method: 'POST',
    headers,
    body: '{"all":true}',
  })
  assert.equal(noType.status, 415)

  const noId = await request(fixture, '/phone-bridge/revoke', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(noId.status, 400)
  assert.equal(noId.body.code, 'invalid-device-id')
})
