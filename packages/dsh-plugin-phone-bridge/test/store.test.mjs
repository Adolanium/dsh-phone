import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { DeviceStore, resolveStorePath, validateDeviceRecord } from '../lib/store.js'

/**
 * Create a store rooted in a fresh temporary directory.
 * @returns directory, path, and store.
 */
async function temporaryStore() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-phone-store-'))
  const path = join(directory, 'storages', 'phone-bridge.json')
  return { directory, path, store: new DeviceStore({ path }) }
}

/**
 * Build one valid device record.
 * @param overrides - fields to replace.
 * @returns record.
 */
function device(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: `device-${randomBytes(4).toString('hex')}`,
    name: 'iPhone',
    tokenHash: createHash('sha256').update(randomBytes(16)).digest('hex'),
    createdAt: now,
    lastSeenAt: now,
    ...overrides,
  }
}

test('a missing store loads as empty and is not created', async (t) => {
  const { directory, path, store } = await temporaryStore()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await store.load()
  assert.equal(store.size, 0)
  await assert.rejects(fs.access(path))
})

test('add persists hashes only, reloads, and writes atomically with mode 0600', async (t) => {
  const { directory, path, store } = await temporaryStore()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await store.load()
  const token = randomBytes(32).toString('base64url')
  const record = device({ tokenHash: createHash('sha256').update(token).digest('hex') })
  await store.add(record)

  const text = await fs.readFile(path, 'utf8')
  assert.equal(text.includes(token), false, 'the bearer token must never be persisted')
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.devices.length, 1)
  assert.equal(parsed.devices[0].tokenHash, record.tokenHash)
  assert.equal(JSON.stringify(parsed).includes('dsh-phone='), false)

  if (process.platform !== 'win32') {
    const mode = (await fs.stat(path)).mode & 0o777
    assert.equal(mode, 0o600)
  }

  const leftovers = (await fs.readdir(dirname(path))).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])

  const reloaded = new DeviceStore({ path })
  await reloaded.load()
  assert.deepEqual(reloaded.list(), store.list())
})

test('concurrent additions are serialized and all survive a reload', async (t) => {
  const { directory, path, store } = await temporaryStore()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await store.load()
  const first = device()
  const second = device()
  await Promise.all([store.add(first), store.add(second)])
  assert.equal(store.size, 2)

  const reloaded = new DeviceStore({ path })
  await reloaded.load()
  assert.deepEqual(reloaded.list().map((entry) => entry.id).sort(), [first.id, second.id].sort())
})

test('remove, clear, and touch update the file', async (t) => {
  const { directory, path, store } = await temporaryStore()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await store.load()
  const first = device()
  const second = device()
  await store.add(first)
  await store.add(second)

  const seenAt = new Date(Date.now() + 60_000).toISOString()
  assert.equal(await store.touch(first.id, seenAt), true)
  assert.equal(await store.touch('missing-device', seenAt), false)

  const reloaded = new DeviceStore({ path })
  await reloaded.load()
  assert.equal(reloaded.list().find((entry) => entry.id === first.id).lastSeenAt, seenAt)

  assert.equal(await store.remove(first.id), true)
  assert.equal(await store.remove(first.id), false)
  assert.equal(store.size, 1)
  assert.equal(await store.clear(), 1)
  assert.equal(store.size, 0)

  const empty = new DeviceStore({ path })
  await empty.load()
  assert.deepEqual(empty.list(), [])
})

test('a malformed store fails closed instead of silently dropping devices', async (t) => {
  const { directory, path, store } = await temporaryStore()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, '{not json', 'utf8')
  await assert.rejects(store.load(), (error) => error.code === 'store/invalid')
})

test('an invalid record or duplicate id fails the load', async (t) => {
  const { directory, path, store } = await temporaryStore()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify({
    version: 1,
    devices: [device({ tokenHash: 'too-short' })],
  }), 'utf8')
  await assert.rejects(store.load(), (error) => error.code === 'store/invalid-device')

  const duplicate = device()
  await fs.writeFile(path, JSON.stringify({ version: 1, devices: [duplicate, duplicate] }), 'utf8')
  const second = new DeviceStore({ path })
  await assert.rejects(second.load(), (error) => error.code === 'store/invalid')
})

test('validateDeviceRecord rejects unknown shapes but normalizes dates', () => {
  const now = new Date().toISOString()
  assert.deepEqual(validateDeviceRecord({
    id: 'device-abcdef12',
    name: 'Phone',
    tokenHash: 'a'.repeat(64),
    createdAt: now,
  }), {
    id: 'device-abcdef12',
    name: 'Phone',
    tokenHash: 'a'.repeat(64),
    createdAt: now,
    lastSeenAt: now,
  })
  assert.throws(() => validateDeviceRecord({ id: 'x' }), /device id/)
  assert.throws(() => validateDeviceRecord({
    id: 'device-abcdef12',
    name: '',
    tokenHash: 'a'.repeat(64),
    createdAt: now,
  }), /name/)
})

test('resolveStorePath prefers storePath, then storagesRoot, then DSH_HOME', () => {
  assert.equal(
    resolveStorePath({ storePath: '/tmp/custom.json' }, {}),
    '/tmp/custom.json',
  )
  assert.equal(
    resolveStorePath({ storagesRoot: '/tmp/storages' }, {}),
    '/tmp/storages/phone-bridge.json',
  )
  assert.equal(
    resolveStorePath({ dshHome: '/tmp/home' }, {}),
    '/tmp/home/storages/phone-bridge.json',
  )
  assert.equal(
    resolveStorePath({}, { DSH_HOME: '/tmp/env-home' }),
    '/tmp/env-home/storages/phone-bridge.json',
  )
})
