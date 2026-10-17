import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { UpstreamAuth } from '../lib/upstream.js'
import { startMockUpstream } from './helpers/mock-upstream.mjs'

/**
 * Start a minimal server whose handler is supplied by the test.
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

test('mints one cookie and reuses it', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const auth = new UpstreamAuth({
    getOrigin: () => upstream.origin,
    authenticatedUrl: (url) => `${url}?token=test-token`,
  })
  const [first, second] = await Promise.all([auth.cookieHeader(), auth.cookieHeader()])
  assert.match(first, /^dsh-auth-test=\d+$/)
  assert.equal(second, first)
  assert.equal(upstream.state.generation, 1)
  assert.equal(await auth.cookieHeader(), first)
  assert.equal(upstream.state.generation, 1)
})

test('invalidate forces the next request to mint', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const auth = new UpstreamAuth({
    getOrigin: () => upstream.origin,
    authenticatedUrl: (url) => `${url}?token=test-token`,
  })
  const first = await auth.cookieHeader()
  auth.invalidate(first)
  const second = await auth.cookieHeader()
  assert.notEqual(second, first)
  assert.equal(upstream.state.generation, 2)
})

test('a changed origin invalidates the authority-bound cookie', async (t) => {
  const first = await startMockUpstream()
  const second = await startMockUpstream()
  t.after(async () => {
    await first.close()
    await second.close()
  })
  let current = first.origin
  const auth = new UpstreamAuth({
    getOrigin: () => current,
    authenticatedUrl: (url) => `${url}?token=test-token`,
  })
  assert.match(await auth.cookieHeader(), /^dsh-auth-test=1$/)
  current = second.origin
  assert.match(await auth.cookieHeader(), /^dsh-auth-test=1$/)
  assert.equal(first.state.generation, 1)
  assert.equal(second.state.generation, 1)
})

test('a failed mint is generic and never contains the launch token', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('no cookie here')
  })
  t.after(() => server.close())
  const auth = new UpstreamAuth({
    getOrigin: () => server.origin,
    authenticatedUrl: (url) => `${url}?token=super-secret-launch-token`,
    backoffBaseMs: 1,
  })
  await assert.rejects(auth.cookieHeader(), (error) => {
    assert.equal(error.message, 'phone-bridge: upstream authentication failed')
    assert.equal(error.code, 'upstream-auth-failed')
    assert.equal(error.message.includes('super-secret-launch-token'), false)
    return true
  })
  const snapshot = JSON.stringify(auth.status())
  assert.equal(snapshot.includes('super-secret-launch-token'), false)
  assert.equal(snapshot.includes('dsh-auth-'), false)
})

test('backoff grows after a failure and resets after a success', async (t) => {
  let fail = true
  let calls = 0
  const server = await startServer((req, res) => {
    calls += 1
    if (fail) {
      res.writeHead(503)
      res.end('down')
      return
    }
    res.writeHead(303, { 'set-cookie': 'dsh-auth-recovered=1; Path=/' })
    res.end()
  })
  t.after(() => server.close())
  const auth = new UpstreamAuth({
    getOrigin: () => server.origin,
    authenticatedUrl: (url) => url,
    backoffBaseMs: 25,
    backoffMaxMs: 50,
  })
  await assert.rejects(auth.cookieHeader())
  assert.equal(auth.status().mintFailures, 1)
  fail = false
  const started = Date.now()
  assert.equal(await auth.cookieHeader(), 'dsh-auth-recovered=1')
  assert.ok(Date.now() - started >= 20, 'second mint waited for the failure backoff')
  assert.equal(auth.status().mintFailures, 0)
  assert.equal(calls, 2)
})

test('a non-303 answer is rejected even when it carries a cookie', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'set-cookie': 'dsh-auth-fake=1; Path=/' })
    res.end()
  })
  t.after(() => server.close())
  const auth = new UpstreamAuth({
    getOrigin: () => server.origin,
    authenticatedUrl: (url) => url,
    backoffBaseMs: 1,
  })
  await assert.rejects(auth.cookieHeader(), /upstream authentication failed/)
})
