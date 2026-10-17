import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEVICE_COOKIE,
  PhoneAuth,
  cookieValue,
  deviceCookie,
  normalizePairCode,
  safeEqualHex,
  sha256Hex,
} from '../lib/auth.js'
import { DeviceStore } from '../lib/store.js'

/**
 * Build an auth owner with a fixed clock, deterministic randomness, and a
 * temporary store.
 * @returns auth, store, clock controls, logs, and cleanup.
 */
async function makeAuth() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-phone-auth-'))
  const path = join(directory, 'phone-bridge.json')
  const store = new DeviceStore({ path })
  let clock = Date.parse('2026-10-17T12:00:00.000Z')
  let randomCalls = 0
  let uuidCalls = 0
  const logs = []
  const random = (size) => {
    randomCalls += 1
    const bytes = Buffer.alloc(size)
    for (let index = 0; index < size; index += 1) bytes[index] = (randomCalls * 37 + index * 11) & 0xff
    return bytes
  }
  const auth = new PhoneAuth({
    store,
    now: () => clock,
    random,
    uuid: () => `device-${String(++uuidCalls).padStart(8, '0')}`,
    log: (level, event, fields) => logs.push({ level, event, fields }),
  })
  await auth.load()
  return {
    auth,
    store,
    path,
    directory,
    logs,
    advance: (milliseconds) => {
      clock += milliseconds
    },
    cleanup: async () => {
      await store.queue.catch(() => {})
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test('pairing info has eight Crockford characters and a 120-second lifetime', async (t) => {
  const { auth, cleanup } = await makeAuth()
  t.after(cleanup)
  const info = auth.pairingInfo()
  assert.match(info.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.equal(info.remainingMs, 120_000)
  assert.equal(new Date(info.expiresAt).getTime(), Date.parse('2026-10-17T12:02:00.000Z'))
})

test('normalizePairCode applies Crockford substitutions and separators', () => {
  assert.equal(normalizePairCode('abcd-efgh'), 'ABCDEFGH')
  assert.equal(normalizePairCode('O0I1L2AB'), '001112AB')
  assert.equal(normalizePairCode('1234'), undefined)
  assert.equal(normalizePairCode('not!code'), undefined)
  assert.equal(normalizePairCode('ABCDEFGU'), undefined)
})

test('a successful pair returns a token, stores only its hash, and authorizes requests', async (t) => {
  const { auth, store, path, cleanup } = await makeAuth()
  t.after(cleanup)
  const code = auth.pairingInfo().code
  const result = await auth.pair({ code, name: '  Adolanium’s iPhone  ', source: '100.64.1.20' })
  assert.equal(result.ok, true)
  assert.equal(result.token.length, 43)
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(result.device.name, 'Adolanium’s iPhone')
  assert.equal(result.device.id, 'device-00000001')

  const stored = store.list()[0]
  assert.equal(stored.tokenHash, sha256Hex(result.token))
  assert.notEqual(stored.tokenHash, result.token)
  const text = await fs.readFile(path, 'utf8')
  assert.equal(text.includes(result.token), false)

  assert.equal(auth.verifyToken(result.token).id, stored.id)
  assert.equal(auth.verifyToken(`${result.token.slice(0, -1)}A`), undefined)
  assert.equal(auth.authorize({ headers: { cookie: `${DEVICE_COOKIE}=${result.token}` } }), true)
  assert.equal(auth.authorize({ headers: { cookie: `${DEVICE_COOKIE}=wrong` } }), false)
  assert.equal(auth.authorize({ headers: {} }), false)
})

test('a wrong code does not consume the current code, and a correct code is single use', async (t) => {
  const { auth, cleanup, logs } = await makeAuth()
  t.after(cleanup)
  const code = auth.pairingInfo().code
  const wrong = await auth.pair({ code: 'ZZZZZZZZ', name: 'Phone', source: '100.64.1.21' })
  assert.equal(wrong.status, 401)
  assert.equal(auth.pairingInfo().code, code)

  const first = await auth.pair({ code: code.toLowerCase(), name: 'Phone', source: '100.64.1.21' })
  assert.equal(first.ok, true)
  const second = await auth.pair({ code, name: 'Phone', source: '100.64.1.21' })
  assert.equal(second.status, 401)
  assert.notEqual(auth.pairingInfo().code, code)
  assert.equal(JSON.stringify(logs).includes(code), false, 'logs must not contain the pairing code')
})

test('rotating the pairing code invalidates the previous code', async (t) => {
  const { auth, cleanup } = await makeAuth()
  t.after(cleanup)
  const first = auth.pairingInfo().code
  auth.rotatePairing()
  const second = auth.pairingInfo().code
  assert.notEqual(second, first)
  const rejected = await auth.pair({ code: first, name: 'Phone', source: '100.64.1.29' })
  assert.equal(rejected.status, 401)
  const accepted = await auth.pair({ code: second, name: 'Phone', source: '100.64.1.29' })
  assert.equal(accepted.ok, true)
})

test('an expired code fails and pairingInfo rotates automatically', async (t) => {
  const { auth, advance, cleanup } = await makeAuth()
  t.after(cleanup)
  const expired = auth.pairingInfo().code
  advance(120_001)
  const result = await auth.pair({ code: expired, name: 'Phone', source: '100.64.1.22' })
  assert.equal(result.status, 401)
  const current = auth.pairingInfo()
  assert.notEqual(current.code, expired)
  assert.equal(current.remainingMs, 120_000)
})

test('five failures lock a source for fifteen minutes; another source is unaffected', async (t) => {
  const { auth, advance, cleanup } = await makeAuth()
  t.after(cleanup)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await auth.pair({ code: 'ZZZZZZZZ', name: 'Phone', source: '100.64.1.23' })
    assert.equal(result.status, 401)
  }
  const locked = await auth.pair({ code: auth.pairingInfo().code, name: 'Phone', source: '100.64.1.23' })
  assert.equal(locked.status, 429)
  assert.ok(locked.retryAfterMs > 14 * 60_000)

  const other = await auth.pair({ code: auth.pairingInfo().code, name: 'Phone', source: '100.64.1.24' })
  assert.equal(other.ok, true)

  advance(15 * 60_000 + 1)
  const info = auth.pairingInfo()
  const allowed = await auth.pair({ code: info.code, name: 'Phone', source: '100.64.1.23' })
  assert.equal(allowed.ok, true)
})

test('revocation invalidates the token immediately', async (t) => {
  const { auth, cleanup } = await makeAuth()
  t.after(cleanup)
  const code = auth.pairingInfo().code
  const paired = await auth.pair({ code, name: 'Phone', source: '100.64.1.25' })
  assert.equal(auth.verifyToken(paired.token).id, paired.device.id)
  assert.equal(await auth.revoke(paired.device.id), true)
  assert.equal(auth.verifyToken(paired.token), undefined)
  assert.equal(auth.authorize({ headers: { cookie: `${DEVICE_COOKIE}=${paired.token}` } }), false)

  const second = await auth.pair({ code: auth.pairingInfo().code, name: 'Phone', source: '100.64.1.25' })
  assert.equal(second.ok, true)
  assert.equal(await auth.revokeAll(), 1)
  assert.equal(auth.verifyToken(second.token), undefined)
})

test('lastSeenAt is persisted after verification', async (t) => {
  const { auth, store, advance, cleanup } = await makeAuth()
  t.after(cleanup)
  const paired = await auth.pair({ code: auth.pairingInfo().code, name: 'Phone', source: '100.64.1.26' })
  advance(31_000)
  assert.equal(auth.verifyToken(paired.token).id, paired.device.id)
  await store.queue
  const stored = store.list()[0]
  assert.equal(stored.lastSeenAt, new Date(Date.parse('2026-10-17T12:00:31.000Z')).toISOString())
})

test('a store write failure makes pairing fail closed', async (t) => {
  const { auth, cleanup } = await makeAuth()
  t.after(cleanup)
  auth.store.add = async () => {
    throw Object.assign(new Error('write failed'), { code: 'store/write-failed' })
  }
  const result = await auth.pair({ code: auth.pairingInfo().code, name: 'Phone', source: '100.64.1.27' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.equal(result.code, 'store-write-failed')
})

test('status never exposes a token or a token hash', async (t) => {
  const { auth, cleanup } = await makeAuth()
  t.after(cleanup)
  const paired = await auth.pair({ code: auth.pairingInfo().code, name: 'Phone', source: '100.64.1.28' })
  const snapshot = JSON.stringify(auth.status())
  assert.equal(snapshot.includes(paired.token), false)
  assert.equal(snapshot.includes(sha256Hex(paired.token)), false)
  assert.equal(auth.status().deviceCount, 1)
})

test('cookie helpers serialize and parse the device cookie', () => {
  const token = 'a'.repeat(43)
  assert.equal(deviceCookie(token), `dsh-phone=${token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`)
  assert.match(deviceCookie(token, { secure: true }), /; Secure$/)
  assert.equal(cookieValue(`a=1; ${DEVICE_COOKIE}=${token}; b=2`, DEVICE_COOKIE), token)
  assert.equal(cookieValue('a=1', DEVICE_COOKIE), undefined)
  assert.equal(safeEqualHex('a'.repeat(64), 'a'.repeat(64)), true)
  assert.equal(safeEqualHex('a'.repeat(64), 'b'.repeat(64)), false)
  assert.equal(safeEqualHex('a'.repeat(63), 'a'.repeat(64)), false)
})
