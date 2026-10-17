/**
 * Device store for the phone bridge.
 *
 * Shape (`~/.dsh/storages/phone-bridge.json`):
 *
 *   {
 *     "version": 1,
 *     "devices": [
 *       { "id": "…", "name": "…", "tokenHash": "<sha256 hex>",
 *         "createdAt": "ISO", "lastSeenAt": "ISO" }
 *     ]
 *   }
 *
 * Only SHA-256 token hashes are stored; the bearer token exists only in the
 * device's cookie and in the response that created it. Writes are atomic
 * (same-directory temp file + rename, mode 0600) and serialized so a concurrent
 * touch cannot clobber a device addition.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Current on-disk schema version. */
export const STORE_VERSION = 1

/** Token hashes are SHA-256 hex. */
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/

/** Device ids are UUIDs or caller-supplied opaque ids; stay strict. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/

/** Device names are display strings, bounded. */
const MAX_NAME_LENGTH = 64

/** A classified store failure. */
export class StoreError extends Error {
  /**
   * @param code - stable machine-readable code.
   * @param message - human-readable text.
   */
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/**
 * Expand a leading `~` the way DSH home helpers do.
 * @param value - path that may start with `~`.
 * @returns the expanded path.
 */
export function expandTilde(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the DSH data root: explicit config, `$DSH_HOME`, then `~/.dsh`.
 * @param config - plugin configuration.
 * @param env - environment.
 * @returns absolute data root.
 */
export function resolveDshHome(config = {}, env = process.env) {
  if (typeof config.dshHome === 'string' && config.dshHome.trim() !== '') return expandTilde(config.dshHome.trim())
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') return expandTilde(env.DSH_HOME.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve the store file path.
 * @param config - plugin configuration (`storePath`, `storagesRoot`, `dshHome`).
 * @param env - environment.
 * @returns absolute store path.
 */
export function resolveStorePath(config = {}, env = process.env) {
  if (typeof config.storePath === 'string' && config.storePath.trim() !== '') {
    return expandTilde(config.storePath.trim())
  }
  const home = resolveDshHome(config, env)
  const root = typeof config.storagesRoot === 'string' && config.storagesRoot.trim() !== ''
    ? expandTilde(config.storagesRoot.trim())
    : join(home, 'storages')
  return join(root, 'phone-bridge.json')
}

/**
 * Normalize and validate one device record.
 * @param record - candidate record.
 * @returns a fresh record with only known fields.
 * @throws {StoreError} when a field is missing or malformed.
 */
export function validateDeviceRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new StoreError('store/invalid-device', 'device record must be an object')
  }
  if (typeof record.id !== 'string' || !DEVICE_ID_PATTERN.test(record.id)) {
    throw new StoreError('store/invalid-device', 'device id is malformed')
  }
  if (typeof record.name !== 'string' || record.name.trim() === '' || record.name.length > MAX_NAME_LENGTH) {
    throw new StoreError('store/invalid-device', 'device name is malformed')
  }
  if (typeof record.tokenHash !== 'string' || !TOKEN_HASH_PATTERN.test(record.tokenHash)) {
    throw new StoreError('store/invalid-device', 'device token hash is malformed')
  }
  const createdAt = normalizeDate(record.createdAt, 'createdAt')
  const lastSeenAt = record.lastSeenAt === undefined
    ? createdAt
    : normalizeDate(record.lastSeenAt, 'lastSeenAt')
  return {
    id: record.id,
    name: record.name,
    tokenHash: record.tokenHash,
    createdAt,
    lastSeenAt,
  }
}

/**
 * Parse a date field to canonical ISO text.
 * @param value - candidate.
 * @param label - field name for the error.
 * @returns canonical ISO timestamp.
 */
function normalizeDate(value, label) {
  if (typeof value !== 'string') throw new StoreError('store/invalid-device', `device ${label} is malformed`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new StoreError('store/invalid-device', `device ${label} is malformed`)
  return parsed.toISOString()
}

/**
 * Serialized, atomic device store.
 */
export class DeviceStore {
  /**
   * @param options - store path and logger.
   */
  constructor({ path, log = () => {} }) {
    if (typeof path !== 'string' || path === '') throw new TypeError('DeviceStore: path is required')
    this.path = path
    this.log = log
    this.devices = []
    this.loaded = false
    this.queue = Promise.resolve()
  }

  /**
   * Load the file once. A missing file is an empty store; a malformed file is
   * a hard failure so a corrupt store can never silently drop every device.
   * @returns this store.
   * @throws {StoreError} on read, parse, or schema failure.
   */
  async load() {
    if (this.loaded) return this
    let text
    try {
      text = await fs.readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.devices = []
        this.loaded = true
        return this
      }
      throw new StoreError('store/read-failed', 'could not read the phone-bridge store')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new StoreError('store/invalid', 'the phone-bridge store is not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || !Array.isArray(parsed.devices)) {
      throw new StoreError('store/invalid', 'the phone-bridge store has an unsupported shape')
    }
    const seen = new Set()
    const devices = parsed.devices.map((record) => {
      const device = validateDeviceRecord(record)
      if (seen.has(device.id)) throw new StoreError('store/invalid', 'the phone-bridge store contains duplicate device ids')
      seen.add(device.id)
      return device
    })
    this.devices = devices
    this.loaded = true
    return this
  }

  /**
   * Snapshot of all devices.
   * @returns copies of the records.
   */
  list() {
    return this.devices.map((device) => ({ ...device }))
  }

  /** Number of paired devices. */
  get size() {
    return this.devices.length
  }

  /**
   * Add one device and persist it.
   * @param record - validated or raw record.
   * @returns the stored record.
   */
  async add(record) {
    const device = validateDeviceRecord(record)
    return this.#withLock(async () => {
      if (this.devices.some((entry) => entry.id === device.id)) {
        throw new StoreError('store/duplicate-id', 'a device with this id already exists')
      }
      const next = [...this.devices, device]
      await this.#write(next)
      this.devices = next
      return { ...device }
    })
  }

  /**
   * Remove one device and persist the change.
   * @param id - device id.
   * @returns whether a record was removed.
   */
  async remove(id) {
    return this.#withLock(async () => {
      const next = this.devices.filter((entry) => entry.id !== id)
      if (next.length === this.devices.length) return false
      await this.#write(next)
      this.devices = next
      return true
    })
  }

  /**
   * Remove every device and persist the empty store.
   * @returns how many records were removed.
   */
  async clear() {
    return this.#withLock(async () => {
      const removed = this.devices.length
      if (removed === 0) return 0
      await this.#write([])
      this.devices = []
      return removed
    })
  }

  /**
   * Update one device's `lastSeenAt` and persist.
   * @param id - device id.
   * @param at - ISO timestamp.
   * @returns whether a record was updated.
   */
  async touch(id, at) {
    const timestamp = normalizeDate(at, 'lastSeenAt')
    return this.#withLock(async () => {
      const device = this.devices.find((entry) => entry.id === id)
      if (device === undefined) return false
      device.lastSeenAt = timestamp
      await this.#write(this.devices)
      return true
    })
  }

  /**
   * Serialize one mutation behind every earlier write.
   * @param task - mutation to run.
   * @returns the task result.
   */
  #withLock(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Atomically replace the store file.
   * @param devices - records to write.
   */
  async #write(devices) {
    const payload = `${JSON.stringify({ version: STORE_VERSION, devices }, null, 2)}\n`
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.writeFile(temporary, payload, { mode: 0o600 })
      await fs.rename(temporary, this.path)
      try {
        await fs.chmod(this.path, 0o600)
      } catch {
        // Windows and some network filesystems do not implement chmod.
      }
    } catch (error) {
      throw new StoreError(
        'store/write-failed',
        `could not write the phone-bridge store (${typeof error?.code === 'string' ? error.code : 'error'})`,
      )
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }
}
