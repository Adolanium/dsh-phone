import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PhoneAuth, sha256Hex } from '../lib/auth.js'
import { handlePairRequest } from '../lib/pairing.js'
import { DeviceStore } from '../lib/store.js'

/**
 * Start a pair endpoint backed by a fresh auth/store.
 * @returns server origin, auth, logs, clock control, and cleanup.
 */
async function startPairServer() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-phone-pair-'))
  const path = join(directory, 'phone-bridge.json')
  const logs = []
  const log = (level, event, fields) => logs.push({ level, event, fields })
  const auth = new PhoneAuth({ store: new DeviceStore({ path }), log })
  await auth.load()
  const server = http.createServer((req, res) => {
    void handlePairRequest(req, res, { auth, log })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    auth,
    logs,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await auth.store.queue.catch(() => {})
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Send one raw request to the pair endpoint.
 * @param port - server port.
 * @param options - method, headers, body.
 * @returns status, headers, and body.
 */
function request(port, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/__pair',
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('a valid code returns 204 with a one-year device cookie', async (t) => {
  const server = await startPairServer()
  t.after(() => server.close())
  const code = server.auth.pairingInfo().code
  const response = await request(server.port, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Phone' }),
  })
  assert.equal(response.status, 204)
  const setCookie = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0]
    : response.headers['set-cookie']
  assert.match(setCookie, /^dsh-phone=[A-Za-z0-9_-]{43}; Max-Age=31536000; Path=\/; HttpOnly; SameSite=Lax$/)
  const token = setCookie.slice('dsh-phone='.length, setCookie.indexOf(';'))
  assert.equal(server.auth.deviceFromRequest({ headers: { cookie: `dsh-phone=${token}` } }).name, 'Phone')
  assert.equal(server.auth.status().deviceCount, 1)
  assert.equal((await fs.stat(server.auth.store.path)).isFile(), true)
  assert.equal(JSON.stringify(server.auth.store.list()).includes(token), false)
  assert.equal(JSON.stringify(server.auth.store.list()).includes(sha256Hex(token)), true)
})

test('a malformed or expired code returns 401 without a cookie', async (t) => {
  const server = await startPairServer()
  t.after(() => server.close())
  const wrong = await request(server.port, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ZZZZZZZZ', name: 'Phone' }),
  })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.headers['set-cookie'], undefined)
  assert.equal(JSON.parse(wrong.body).code, 'invalid-code')

  const valid = server.auth.pairingInfo().code
  const malformed = await request(server.port, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'not-a-code', name: 'Phone' }),
  })
  assert.equal(malformed.status, 401)
  assert.equal(valid.length, 8)
})

test('method, content type, and JSON errors are classified', async (t) => {
  const server = await startPairServer()
  t.after(() => server.close())

  const get = await request(server.port, { method: 'GET' })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')
  assert.equal(JSON.parse(get.body).code, 'method-not-allowed')

  const noType = await request(server.port, {
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(noType.status, 415)

  const badJson = await request(server.port, {
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(badJson.status, 400)
  assert.equal(JSON.parse(badJson.body).code, 'invalid-json')
})

test('six failed attempts lock the source and return retry-after', async (t) => {
  const server = await startPairServer()
  t.after(() => server.close())
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(server.port, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZZZ', name: 'Phone' }),
    })
    assert.equal(response.status, 401)
  }
  const locked = await request(server.port, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: server.auth.pairingInfo().code, name: 'Phone' }),
  })
  assert.equal(locked.status, 429)
  assert.ok(Number(locked.headers['retry-after']) >= 900)
  assert.equal(JSON.parse(locked.body).code, 'rate-limited')
})

test('failure logs never contain the submitted code', async (t) => {
  const server = await startPairServer()
  t.after(() => server.close())
  const submitted = 'ZZZZZZZZ'
  await request(server.port, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: submitted, name: 'Phone' }),
  })
  assert.equal(JSON.stringify(server.logs).includes(submitted), false)
  assert.equal(JSON.stringify(server.logs).includes('invalid-or-expired-code'), true)
})
