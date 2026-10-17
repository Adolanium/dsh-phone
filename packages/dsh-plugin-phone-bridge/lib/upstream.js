/**
 * Upstream authentication for the phone bridge.
 *
 * The plugin lives inside the Desktop Host process, so it can ask the public
 * `connection` service for a launch-token URL and exchange that token for the
 * Host's own browser cookie:
 *
 *   GET <origin>/?token=<process launch token>
 *     → 303 + Set-Cookie: dsh-auth-<authority hash>=v1....
 *
 * That cookie is bound to the loopback authority (`127.0.0.1:<port>`), which
 * is exactly the authority the proxy presents upstream after rewriting Host
 * and Origin. The cookie value is held in memory only and never logged,
 * persisted, put in a QR code, or exposed to the phone.
 *
 * The process launch token appears only in the URL handed to `http.request`;
 * it is never written to a log, error message, or response.
 */
import http from 'node:http'

/** Cookie prefix minted by `@deepseek-ai/dsh-client-connection`. */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** Default single-flight request timeout for the token exchange. */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * Exchange a launch-token URL for the browser cookie it mints.
 * @param authenticatedUrl - URL carrying the process launch token.
 * @param timeoutMs - request timeout.
 * @returns the `name=value` cookie pair, without attributes.
 */
function mintCookie(authenticatedUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(authenticatedUrl)
    } catch {
      reject(new Error('upstream bootstrap URL is not a valid URL'))
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error('upstream bootstrap URL is not HTTP(S)'))
      return
    }
    let timedOut = false
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        accept: 'text/html',
        'cache-control': 'no-cache',
      },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode
      const setCookie = response.headers['set-cookie']
      response.resume()
      if (status !== 303) {
        reject(new Error(`upstream bootstrap returned HTTP ${String(status)}`))
        return
      }
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
      const pair = typeof header === 'string' ? header.split(';', 1)[0].trim() : ''
      const separator = pair.indexOf('=')
      if (separator <= 0 || !pair.startsWith(AUTH_COOKIE_PREFIX) || pair.length === separator + 1) {
        reject(new Error('upstream bootstrap did not mint a browser cookie'))
        return
      }
      resolve(pair)
    })
    request.on('timeout', () => {
      timedOut = true
      request.destroy()
    })
    request.on('error', (error) => {
      if (timedOut) reject(new Error('upstream bootstrap timed out'))
      else reject(new Error(`upstream bootstrap request failed (${String(error?.code ?? 'error')})`))
    })
    request.end()
  })
}

/**
 * In-memory owner of the upstream browser cookie.
 *
 * One cookie is enough for every proxied request, so minting is single-flight.
 * A mint failure backs off exponentially (capped at five seconds) before the
 * next attempt; a success resets the backoff.
 */
export class UpstreamAuth {
  /**
   * @param options - origin reader, launch-token URL builder, logger, and test seams.
   */
  constructor({
    getOrigin,
    authenticatedUrl,
    log = () => {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    backoffBaseMs = 250,
    backoffMaxMs = 5000,
    now = Date.now,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    if (typeof getOrigin !== 'function') throw new TypeError('UpstreamAuth: getOrigin is required')
    if (typeof authenticatedUrl !== 'function') throw new TypeError('UpstreamAuth: authenticatedUrl is required')
    this.getOrigin = getOrigin
    this.authenticatedUrl = authenticatedUrl
    this.log = log
    this.timeoutMs = timeoutMs
    this.backoffBaseMs = backoffBaseMs
    this.backoffMaxMs = backoffMaxMs
    this.now = now
    this.sleep = sleep
    this.pair = undefined
    this.originForPair = undefined
    this.mintedAt = undefined
    this.failures = 0
    this.lastFailureAt = 0
    this.inFlight = undefined
  }

  /**
   * The Host's loopback origin, read fresh on every call: the desktop Host's
   * port changes on every launch, so nothing may cache it.
   * @returns normalized origin, for example `http://127.0.0.1:54694`.
   */
  get origin() {
    const origin = this.getOrigin()
    if (typeof origin !== 'string' || origin === '') throw new Error('phone-bridge: upstream origin is unavailable')
    return new URL(origin).origin
  }

  /** Upstream port, or undefined before the Web server has bound. */
  get port() {
    try {
      return new URL(this.origin).port
    } catch {
      return undefined
    }
  }

  /**
   * Cookie header value for one upstream request. Re-mints when the origin
   * changed (a restarted Host has a new random port and the old cookie is
   * bound to the old authority).
   * @returns `name=value`.
   */
  async cookieHeader() {
    const origin = this.origin
    if (this.pair !== undefined && this.originForPair === origin) return this.pair
    return this.refresh()
  }

  /**
   * Forget the current cookie. Called when upstream returns 401.
   * @param pair - the pair the failing request used; a concurrent refresh is
   *   not discarded by a stale caller.
   */
  invalidate(pair) {
    if (pair === undefined || pair === this.pair) {
      this.pair = undefined
      this.originForPair = undefined
    }
  }

  /**
   * Mint a fresh cookie, single-flight, after the failure backoff.
   * @returns `name=value`.
   */
  async refresh() {
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = (async () => {
      await this.waitForBackoff()
      const origin = this.origin
      const authenticatedUrl = this.authenticatedUrl(`${origin}/`)
      const pair = await mintCookie(authenticatedUrl, this.timeoutMs)
      this.pair = pair
      this.originForPair = origin
      this.mintedAt = this.now()
      this.failures = 0
      this.log('info', 'upstream-cookie-minted', { upstreamPort: new URL(origin).port })
      return pair
    })().catch((error) => {
      this.failures += 1
      this.lastFailureAt = this.now()
      this.log('warn', 'upstream-cookie-mint-failed', {
        attempt: this.failures,
        reason: typeof error?.message === 'string' ? error.message : 'unknown error',
      })
      const failure = new Error('phone-bridge: upstream authentication failed')
      failure.code = 'upstream-auth-failed'
      throw failure
    }).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  /** Sleep out the exponential backoff since the previous failure. */
  async waitForBackoff() {
    if (this.failures === 0) return
    const exponent = Math.min(this.failures - 1, 10)
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** exponent)
    const remaining = this.lastFailureAt + delay - this.now()
    if (remaining > 0) await this.sleep(remaining)
  }

  /**
   * Secret-free snapshot for diagnostics.
   * @returns port, mint age, and failure count.
   */
  status() {
    let upstreamPort
    try {
      upstreamPort = this.port
    } catch {
      upstreamPort = undefined
    }
    return {
      upstreamPort,
      cookieAgeMs: this.mintedAt === undefined ? undefined : Math.max(0, this.now() - this.mintedAt),
      mintFailures: this.failures,
    }
  }
}
