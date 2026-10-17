/**
 * Pairing and device authentication for the phone bridge.
 *
 * Two credentials exist and they never mix:
 *
 *   - the **device cookie** (`dsh-phone`), a 32-byte random bearer token held
 *     by the phone. Only its SHA-256 hash is persisted.
 *   - the **Host cookie** (`dsh-auth-…`), minted in-process from the Host's
 *     launch token and used only on the loopback side of the proxy.
 *
 * Pairing codes are 8 Crockford base32 characters, valid for 120 seconds,
 * single use, and kept in memory as `sha256(code + salt)`. Pair attempts are
 * limited to five per minute per source address; the sixth starts a 15-minute
 * lockout. Failure logs never include the submitted code.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

/** Device cookie name. */
export const DEVICE_COOKIE = 'dsh-phone'

/** Cookie lifetime, one year. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 31_536_000

/** Pairing code length and lifetime. */
export const PAIR_CODE_LENGTH = 8
export const PAIR_CODE_TTL_MS = 120_000

/** Pair-attempt limits. */
export const PAIR_MAX_ATTEMPTS = 5
export const PAIR_WINDOW_MS = 60_000
export const PAIR_LOCKOUT_MS = 15 * 60_000

/** Crockford base32: no I, L, O, or U. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/

/** 32 random bytes, base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * SHA-256 hex.
 * @param value - text to hash.
 * @returns 64 lowercase hex characters.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Constant-time comparison of two SHA-256 hex strings.
 * @param left - hex digest.
 * @param right - hex digest.
 * @returns true only for equal, well-formed 32-byte digests.
 */
export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== 64 || right.length !== 64) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b)
}

/**
 * Normalize a human-entered pairing code: trim, uppercase, drop separators,
 * and apply Crockford's O→0 and I/L→1 substitutions.
 * @param value - submitted code.
 * @returns the canonical 8-character code, or undefined.
 */
export function normalizePairCode(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replace(/O/gu, '0')
    .replace(/[IL]/gu, '1')
  return CODE_PATTERN.test(normalized) ? normalized : undefined
}

/**
 * Read one cookie value without implementing general cookie decoding.
 * @param header - `Cookie` header.
 * @param name - exact cookie name.
 * @returns the value, or undefined.
 */
export function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Serialize the device cookie. `Secure` is omitted because the tailnet transport is
 * plain HTTP inside the WireGuard tailnet.
 * @param token - bearer token.
 * @param options - set `secure` when TLS is added.
 * @returns a `Set-Cookie` value.
 */
export function deviceCookie(token, { secure = false } = {}) {
  const base = `${DEVICE_COOKIE}=${token}; Max-Age=${String(DEVICE_COOKIE_MAX_AGE_SECONDS)}; Path=/; HttpOnly; SameSite=Lax`
  return secure ? `${base}; Secure` : base
}

/**
 * Sanitize a device display name.
 * @param value - submitted name.
 * @returns a printable name of at most 64 characters.
 */
export function sanitizeDeviceName(value) {
  const text = typeof value === 'string' ? value : ''
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 64)
  return cleaned === '' ? 'Phone' : cleaned
}

/**
 * Public projection of a device record; token hashes are never returned.
 * @param device - stored record.
 * @returns id, name, and timestamps.
 */
export function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  }
}

/**
 * Pairing and device credential owner.
 */
export class PhoneAuth {
  /**
   * @param options - store, logger, and test clock/random seams.
   */
  constructor({
    store,
    log = () => {},
    now = Date.now,
    random = randomBytes,
    uuid = randomUUID,
  }) {
    if (store === undefined) throw new TypeError('PhoneAuth: store is required')
    this.store = store
    this.log = log
    this.now = now
    this.random = random
    this.uuid = uuid
    this.loaded = false
    this.loadError = undefined
    this.pairing = undefined
    this.attempts = new Map()
    this.lastTouch = new Map()
  }

  /**
   * Load the device store and prepare the first pairing code.
   * @returns this auth owner.
   */
  async load() {
    if (this.loaded) return this
    try {
      await this.store.load()
      this.loaded = true
      this.loadError = undefined
      this.ensurePairing()
      return this
    } catch (error) {
      this.loaded = false
      this.loadError = error
      throw error
    }
  }

  /** Whether the store is loaded and authentication can be enforced. */
  get ready() {
    return this.loaded
  }

  /**
   * Current pairing code, rotating first when it expired or was consumed.
   * @returns code, expiry, and remaining lifetime, or undefined before load.
   */
  pairingInfo() {
    if (!this.loaded) return undefined
    const pairing = this.ensurePairing()
    return {
      code: pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      remainingMs: Math.max(0, pairing.expiresAt - this.now()),
    }
  }

  /**
   * Issue a new pairing code, invalidating the previous one.
   * @returns the active pairing record.
   */
  rotatePairing() {
    if (!this.loaded) throw new Error('phone-bridge: store is not loaded')
    const bytes = this.random(PAIR_CODE_LENGTH)
    let code = ''
    for (let index = 0; index < PAIR_CODE_LENGTH; index += 1) code += CODE_ALPHABET[bytes[index] & 31]
    const salt = this.random(16).toString('base64url')
    this.pairing = {
      code,
      salt,
      hash: sha256Hex(`${code}${salt}`),
      expiresAt: this.now() + PAIR_CODE_TTL_MS,
      used: false,
    }
    return this.pairing
  }

  /**
   * Return the active pairing record, rotating when absent, consumed, or expired.
   * @returns the active pairing record.
   */
  ensurePairing() {
    const current = this.pairing
    if (current !== undefined && current.used !== true && current.expiresAt > this.now()) return current
    return this.rotatePairing()
  }

  /**
   * Verify and consume one pairing code. The comparison is constant-time over
   * the SHA-256 digest; a successful verification is single use.
   * @param code - submitted code.
   * @returns whether the code was current, unexpired, and correct.
   */
  verifyPairCode(code) {
    const pairing = this.pairing
    if (pairing === undefined || pairing.used === true) return false
    if (this.now() >= pairing.expiresAt) {
      pairing.used = true
      return false
    }
    const normalized = normalizePairCode(code)
    if (normalized === undefined) return false
    if (!safeEqualHex(sha256Hex(`${normalized}${pairing.salt}`), pairing.hash)) return false
    pairing.used = true
    this.pairing = undefined
    return true
  }

  /**
   * Apply the per-source pairing rate limit.
   * @param source - `req.socket.remoteAddress`.
   * @returns allowed, or the remaining lockout.
   */
  consumeAttempt(source) {
    const now = this.now()
    let entry = this.attempts.get(source)
    if (entry !== undefined) {
      if (entry.lockedUntil > now) return { ok: false, retryAfterMs: entry.lockedUntil - now }
      if (now - entry.windowStart >= PAIR_WINDOW_MS) entry = undefined
    }
    if (entry === undefined) entry = { windowStart: now, count: 0, lockedUntil: 0 }
    if (entry.count >= PAIR_MAX_ATTEMPTS) {
      entry.lockedUntil = now + PAIR_LOCKOUT_MS
      this.attempts.set(source, entry)
      return { ok: false, retryAfterMs: PAIR_LOCKOUT_MS }
    }
    entry.count += 1
    this.attempts.set(source, entry)
    if (this.attempts.size > 512) this.pruneAttempts(now)
    return { ok: true }
  }

  /** Drop attempts that are neither locked nor inside their window. */
  pruneAttempts(now) {
    for (const [key, entry] of this.attempts) {
      if (entry.lockedUntil <= now && now - entry.windowStart > PAIR_WINDOW_MS) this.attempts.delete(key)
    }
  }

  /**
   * Pair one device. The caller must have forwarded the request source for the
   * rate limit; neither the code nor the resulting token is ever logged.
   * @param options - submitted code, display name, and source address.
   * @returns success with a one-time token, or a classified failure.
   */
  async pair({ code, name, source = 'unknown' } = {}) {
    if (!this.loaded) return { ok: false, status: 503, code: 'store-unavailable' }
    const limit = this.consumeAttempt(source)
    if (!limit.ok) {
      this.log('warn', 'pair-rate-limited', { source, retryAfterMs: limit.retryAfterMs })
      return { ok: false, status: 429, code: 'rate-limited', retryAfterMs: limit.retryAfterMs }
    }
    if (normalizePairCode(code) === undefined) {
      this.log('warn', 'pair-failed', { source, reason: 'malformed-code' })
      return { ok: false, status: 401, code: 'invalid-code' }
    }
    if (!this.verifyPairCode(code)) {
      this.log('warn', 'pair-failed', { source, reason: 'invalid-or-expired-code' })
      return { ok: false, status: 401, code: 'invalid-code' }
    }
    const token = this.random(32).toString('base64url')
    const createdAt = new Date(this.now()).toISOString()
    const device = {
      id: this.uuid(),
      name: sanitizeDeviceName(name),
      tokenHash: sha256Hex(token),
      createdAt,
      lastSeenAt: createdAt,
    }
    try {
      await this.store.add(device)
    } catch (error) {
      this.log('error', 'pair-store-failed', { code: typeof error?.code === 'string' ? error.code : 'store-error' })
      return { ok: false, status: 503, code: 'store-write-failed' }
    }
    this.attempts.delete(source)
    this.log('info', 'device-paired', { deviceId: device.id })
    return { ok: true, token, device: publicDevice(device) }
  }

  /**
   * Verify a device token against every stored hash and update last-seen.
   * @param token - cookie value.
   * @returns the public device, or undefined.
   */
  verifyToken(token) {
    if (!this.loaded || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return undefined
    const digest = sha256Hex(token)
    let matched
    for (const device of this.store.list()) {
      if (safeEqualHex(digest, device.tokenHash)) matched = device
    }
    if (matched === undefined) return undefined
    this.touch(matched.id)
    return publicDevice(matched)
  }

  /**
   * Authenticate one request from its `dsh-phone` cookie.
   * @param req - incoming request.
   * @returns the public device, or undefined.
   */
  deviceFromRequest(req) {
    const header = req?.headers?.cookie
    return this.verifyToken(cookieValue(header, DEVICE_COOKIE))
  }

  /**
   * Authorize a proxied request.
   * @param req - incoming request.
   * @returns true only for a live, unrevoked device.
   */
  authorize(req) {
    return this.deviceFromRequest(req) !== undefined
  }

  /**
   * Throttled last-seen persistence; a failure is diagnostic, not fatal.
   * @param id - device id.
   */
  touch(id) {
    const now = this.now()
    const previous = this.lastTouch.get(id) ?? 0
    if (now - previous < 30_000) return
    this.lastTouch.set(id, now)
    void this.store.touch(id, new Date(now).toISOString()).catch((error) => {
      this.log('warn', 'last-seen-write-failed', { code: typeof error?.code === 'string' ? error.code : 'store-error' })
    })
  }

  /**
   * Revoke one device; its next request fails immediately.
   * @param id - device id.
   * @returns whether a device was removed.
   */
  async revoke(id) {
    const removed = await this.store.remove(id)
    this.lastTouch.delete(id)
    return removed
  }

  /**
   * Revoke every device.
   * @returns how many were removed.
   */
  async revokeAll() {
    const removed = await this.store.clear()
    this.lastTouch.clear()
    return removed
  }

  /**
   * Device list for the admin page. Never includes token hashes.
   * @returns public device records.
   */
  devices() {
    return this.store.list().map(publicDevice)
  }

  /**
   * Secret-free auth snapshot for the admin status route.
   * @returns readiness, count, pairing info, and the load error code.
   */
  status() {
    return {
      ready: this.loaded,
      deviceCount: this.loaded ? this.store.size : 0,
      pairing: this.loaded ? this.pairingInfo() : undefined,
      lastError: this.loadError === undefined ? undefined : (this.loadError.code ?? 'store-error'),
    }
  }
}
