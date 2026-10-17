import assert from 'node:assert/strict'
import test from 'node:test'

import { VERSION, createLog, isAdminPath, resolveConfig, sanitizeFields } from '../lib/index.js'

test('resolveConfig applies the defaults', () => {
  assert.deepEqual(resolveConfig(), { port: 8787, retryMs: 15_000, bindAddress: undefined })
})

test('resolveConfig accepts an explicit tailnet bind address', () => {
  assert.deepEqual(resolveConfig({ port: 9000, retryMs: 2000, bindAddress: '100.64.1.2' }), {
    port: 9000,
    retryMs: 2000,
    bindAddress: '100.64.1.2',
  })
})

test('resolveConfig rejects an invalid port or a non-tailnet bind address', () => {
  assert.throws(() => resolveConfig({ port: 0 }), /port must be an integer/)
  assert.throws(() => resolveConfig({ port: 65536 }), /port must be an integer/)
  assert.throws(() => resolveConfig({ port: 1.5 }), /port must be an integer/)
  assert.throws(() => resolveConfig({ retryMs: 10 }), /retryMs must be at least/)
  assert.throws(() => resolveConfig({ bindAddress: '10.0.0.1' }), /refusing to bind/)
})

test('sanitizeFields removes credential-shaped keys and bounds strings', () => {
  const safe = sanitizeFields({
    cookie: 'dsh-auth-secret',
    token: 'launch-token',
    authorization: 'Bearer x',
    secret: 'x',
    pair: 'dsh-auth-x=1',
    'set-cookie': 'a=b',
    upstreamPort: '1234',
    message: 'x'.repeat(700),
    url: 'http://127.0.0.1:1234/?token=super-secret&x=1',
    raw: 'cookie dsh-auth-abc=xyz;',
    error: Object.assign(new Error('boom'), { code: 'EBOOM' }),
  })
  assert.equal(safe.cookie, undefined)
  assert.equal(safe.token, undefined)
  assert.equal(safe.authorization, undefined)
  assert.equal(safe.secret, undefined)
  assert.equal(safe.pair, undefined)
  assert.equal(safe['set-cookie'], undefined)
  assert.equal(safe.upstreamPort, '1234')
  assert.equal(safe.message.length, 501)
  assert.equal(safe.url, 'http://127.0.0.1:1234/?token=<redacted>&x=1')
  assert.equal(safe.raw, 'cookie dsh-auth-<redacted>;')
  assert.deepEqual(safe.error, { name: 'Error', code: 'EBOOM' })
})

test('createLog emits one JSON line, keeps a recent ring, and scopes the logger', () => {
  const lines = []
  const ctx = {
    logger(name) {
      assert.equal(name, 'phone-bridge')
      return {
        info: (line) => lines.push(line),
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
      }
    },
  }
  const log = createLog(ctx)
  log('info', 'listening', { address: '100.64.1.2', port: 8787, cookie: 'must-not-appear' })
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.component, 'phone-bridge')
  assert.equal(parsed.event, 'listening')
  assert.equal(parsed.address, '100.64.1.2')
  assert.equal(parsed.cookie, undefined)
  assert.equal(JSON.stringify(log.recent).includes('must-not-appear'), false)
  assert.equal(log.recent.length, 1)
})

test('isAdminPath reserves the loopback admin subtree', () => {
  assert.equal(isAdminPath('/phone-bridge'), true)
  assert.equal(isAdminPath('/phone-bridge/status'), true)
  assert.equal(isAdminPath('/phone-bridgex'), false)
  assert.equal(isAdminPath('/api/phone-bridge'), false)
  assert.equal(isAdminPath('/'), false)
})

test('VERSION comes from the package manifest', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/)
})
