/**
 * HTTP and WebSocket reverse proxy from the tailnet listener into the Desktop
 * Host's loopback Web server.
 *
 * The Host's browser-trust fence decides admission from `Host` and `Origin`,
 * and its browser cookie is bound to the loopback authority. The proxy
 * therefore:
 *
 *   - always targets the origin read from `webServer.getOrigin()` — never a
 *     URL supplied by the phone, so this cannot become an open proxy;
 *   - rewrites `Host` and, when present, `Origin` to that loopback origin;
 *   - replaces `Cookie` with the single bootstrap cookie, so phone cookies
 *     never reach the Host;
 *   - drops `Referer`, `Forwarded`, `X-Forwarded-*`, and `X-Real-IP`;
 *   - strips every upstream `Set-Cookie` on the way back;
 *   - proxies WebSocket upgrades without retrying them.
 *
 * Bodies up to one MiB are buffered so a 401 can re-mint the cookie and retry
 * the request once. Larger or chunked bodies stream and are not retried; the
 * Host is the source of truth and the client can retry.
 */
import http from 'node:http'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const DEFAULT_MAX_BUFFERED_BODY = 1024 * 1024
const DEFAULT_HEALTH_LIMIT_MS = 1000
const UPGRADE_HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_HEALTH_KEYS = 512

/**
 * Extract the upstream path from the request line without trusting its
 * authority. Absolute-form request lines (`GET http://evil/…`) are reduced to
 * their path and re-joined with the Host's loopback origin.
 * @param rawUrl - `req.url`.
 * @returns pathname and search of the upstream target.
 */
export function upstreamTarget(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl ?? '/', 'http://phone-bridge.invalid')
  } catch {
    parsed = new URL('/', 'http://phone-bridge.invalid')
  }
  return { pathname: parsed.pathname, search: parsed.search }
}

/**
 * Headers sent upstream for a normal request.
 * @param req - incoming phone request.
 * @param origin - loopback origin.
 * @param cookie - bootstrap cookie pair.
 * @returns a fresh header map.
 */
export function upstreamRequestHeaders(req, origin, cookie) {
  const authority = new URL(origin).host
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host' || lower === 'origin' || lower === 'cookie' || lower === 'referer' || lower === 'expect') continue
    if (lower === 'forwarded' || lower === 'x-real-ip' || lower.startsWith('x-forwarded-')) continue
    headers[lower] = value
  }
  headers.host = authority
  if (req.headers.origin !== undefined) headers.origin = origin
  headers.cookie = cookie
  return headers
}

/**
 * Response headers safe to hand to the phone. Every `Set-Cookie` is removed:
 * the Host's cookies are bound to the loopback authority and are meaningless
 * (and stale) on the phone.
 * @param headers - `IncomingMessage.headers`.
 * @returns a fresh header map.
 */
export function downstreamResponseHeaders(headers) {
  const safe = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'set-cookie') continue
    if (HOP_BY_HOP.has(lower)) continue
    safe[lower] = value
  }
  return safe
}

/**
 * Build the proxy for one Host activation.
 * @param options - auth owner, logger, version, display host, and test seams.
 * @returns request/upgrade handlers plus a secret-free status snapshot.
 */
export function createProxy({
  auth,
  authorize,
  identify,
  log = () => {},
  version = '0.0.0',
  host = 'unknown',
  healthLimitMs = DEFAULT_HEALTH_LIMIT_MS,
  maxBufferedBodyBytes = DEFAULT_MAX_BUFFERED_BODY,
  now = Date.now,
}) {
  if (typeof auth?.cookieHeader !== 'function') throw new TypeError('phone-bridge: auth owner is required')
  if (authorize !== undefined && typeof authorize !== 'function') throw new TypeError('phone-bridge: authorize must be a function')
  if (identify !== undefined && typeof identify !== 'function') throw new TypeError('phone-bridge: identify must be a function')

  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  const upgraded = new Set()
  const deviceSockets = new Map()
  const upstreamRequests = new Set()
  const healthSeen = new Map()
  let requests = 0
  let errors = 0
  let upstream401s = 0
  let reauths = 0
  let lastError = null

  /** Record one failure without leaking URLs, queries, cookies, or tokens. */
  function recordError(event, details) {
    errors += 1
    lastError = {
      event,
      code: typeof details?.code === 'string' ? details.code : undefined,
      path: typeof details?.path === 'string' ? details.path : undefined,
      at: new Date(now()).toISOString(),
    }
    log('warn', event, lastError)
  }

  /**
   * Apply the optional device gate. `/__health` never reaches this function.
   * A throwing authorizer fails closed.
   * @param req - incoming request.
   * @returns true when the request may be proxied.
   */
  function isAuthorized(req) {
    if (identify !== undefined) {
      try {
        const identity = identify(req)
        return identity !== undefined && identity !== null
      } catch {
        return false
      }
    }
    if (authorize === undefined) return true
    try {
      return authorize(req) === true
    } catch {
      return false
    }
  }

  /**
   * Resolve the device identity for an upgrade. `identify` returns the public
   * device (including its id) so the socket can be evicted on revoke. When only
   * `authorize` is configured, identity is the boolean true and cannot be
   * targeted by `closeDevice`.
   */
  function identifyForUpgrade(req) {
    if (identify !== undefined) {
      try {
        return identify(req)
      } catch {
        return undefined
      }
    }
    return isAuthorized(req) ? true : undefined
  }

  /** Serve `GET|HEAD /__health`, rate-limited per source address. */
  function handleHealth(req, res) {    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed')
      return
    }
    const source = req.socket?.remoteAddress ?? 'unknown'
    const at = now()
    const previous = healthSeen.get(source)
    if (previous !== undefined && at - previous < healthLimitMs) {
      res.writeHead(429, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': '1',
      })
      res.end('too many health requests\n')
      return
    }
    healthSeen.set(source, at)
    if (healthSeen.size > MAX_HEALTH_KEYS) {
      for (const [key, seenAt] of healthSeen) {
        if (at - seenAt > 60_000) healthSeen.delete(key)
      }
    }
    const payload = Buffer.from(JSON.stringify({ ok: true, version, host }), 'utf8')
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.length),
    })
    res.end(req.method === 'HEAD' ? undefined : payload)
  }

  /**
   * Buffer a request body only when it is small enough to retry safely.
   * @returns `{ kind: 'empty' }`, `{ kind: 'buffer', value }`, or `{ kind: 'stream' }`.
   */
  async function readBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return { kind: 'empty' }
    const declared = req.headers['content-length']
    if (declared === undefined) return { kind: 'stream' }
    const length = Number(declared)
    if (!Number.isFinite(length) || length < 0) return { kind: 'stream' }
    if (length === 0) return { kind: 'empty' }
    if (length > maxBufferedBodyBytes) return { kind: 'stream' }
    return { kind: 'buffer', value: await collectBody(req, maxBufferedBodyBytes) }
  }

  /** Forward one HTTP request, retrying once with a fresh cookie on 401. */
  async function proxyHttp(req, res, target) {
    const origin = auth.origin
    const body = await readBody(req)
    const retryable = body.kind !== 'stream'

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const usedCookie = await auth.cookieHeader()
      const headers = upstreamRequestHeaders(req, origin, usedCookie)
      const outcome = await sendOnce({
        req,
        res,
        target,
        origin,
        headers,
        body,
        retryable,
        isRetry: attempt > 0,
      })
      if (outcome.retry !== true) {
        if (outcome.unauthorized === true) {
          upstream401s += 1
          // A streamed body cannot be replayed. Drop the stale cookie here so
          // the next request starts from a freshly minted one.
          auth.invalidate(usedCookie)
        }
        return
      }
      upstream401s += 1
      auth.invalidate(usedCookie)
      reauths += 1
      log('info', 'upstream-401-retry', { path: target.pathname })
    }
  }

  /**
   * One upstream HTTP attempt. Resolves `{ retry: true }` only when the caller
   * may safely repeat the request; otherwise the response has been forwarded.
   */
  function sendOnce({ req, res, target, origin, headers, body, retryable, isRetry }) {
    return new Promise((resolve, reject) => {
      const upstreamUrl = new URL(origin)
      let settled = false
      let upstreamRequest
      const onClientClose = () => {
        if (!res.writableEnded) upstreamRequest.destroy()
      }
      const settle = (value, keepClientClose = false) => {
        if (settled) return
        settled = true
        if (!keepClientClose) res.off('close', onClientClose)
        resolve(value)
      }
      upstreamRequest = http.request({
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        agent,
      }, (upstreamResponse) => {
        if (body.kind === 'stream') {
          req.unpipe(upstreamRequest)
          req.resume()
        }
        if (upstreamResponse.statusCode === 401 && retryable && !isRetry) {
          upstreamResponse.resume()
          settle({ retry: true })
          return
        }
        const unauthorized = upstreamResponse.statusCode === 401
        forwardResponse(upstreamResponse, res, target.pathname)
        settle({ done: true, unauthorized }, true)
      })
      upstreamRequests.add(upstreamRequest)
      res.once('close', onClientClose)
      upstreamRequest.on('error', (error) => {
        upstreamRequests.delete(upstreamRequest)
        if (!settled) res.off('close', onClientClose)
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      upstreamRequest.on('close', () => {
        upstreamRequests.delete(upstreamRequest)
      })
      if (body.kind === 'buffer') upstreamRequest.end(body.value)
      else if (body.kind === 'empty') upstreamRequest.end()
      else req.pipe(upstreamRequest)
    })
  }

  /** Copy one upstream response to the phone, stripping cookies and hop-by-hop headers. */
  function forwardResponse(upstreamResponse, res, pathname) {
    const headers = downstreamResponseHeaders(upstreamResponse.headers)
    if (pathname === '/') headers['cache-control'] = 'no-store'
    if (upstreamResponse.statusMessage !== undefined) {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers)
    } else {
      res.writeHead(upstreamResponse.statusCode ?? 502, headers)
    }
    upstreamResponse.on('error', () => {
      if (!res.destroyed) res.destroy()
    })
    upstreamResponse.pipe(res)
  }

  /** Proxy a WebSocket upgrade. Upgrades are never retried. */
  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {})
    if (socket.destroyed) return
    const target = upstreamTarget(req.url)
    if (target.pathname === '/__health') {
      rejectUpgrade(socket, 404, 'not found')
      return
    }
    const identity = identifyForUpgrade(req)
    if (identity === undefined || identity === null) {
      rejectUpgrade(socket, 401, 'pairing required')
      return
    }
    const deviceId = identity !== null && typeof identity === 'object' && typeof identity.id === 'string'
      ? identity.id
      : undefined
    socket.pause()
    let origin
    let cookie
    try {
      origin = auth.origin
      cookie = await auth.cookieHeader()
    } catch {
      recordError('upgrade-auth-failed', { path: target.pathname, code: 'upstream-auth-failed' })
      rejectUpgrade(socket, 503, 'phone bridge: upstream unavailable')
      return
    }
    if (socket.destroyed) return
    // Re-check after the async cookie mint: a revoke that raced the handshake
    // must not leave a freshly upgraded socket behind.
    if (identify !== undefined) {
      let stillAuthorized = false
      try {
        const current = identify(req)
        stillAuthorized = current !== undefined && current !== null
      } catch {
        stillAuthorized = false
      }
      if (!stillAuthorized) {
        rejectUpgrade(socket, 401, 'pairing required')
        return
      }
    }

    const headers = upstreamRequestHeaders(req, origin, cookie)
    headers.connection = 'Upgrade'
    headers.upgrade = typeof req.headers.upgrade === 'string' ? req.headers.upgrade : 'websocket'

    let settled = false
    const upstreamUrl = new URL(origin)
    const upstreamRequest = http.request({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      path: `${target.pathname}${target.search}`,
      method: req.method ?? 'GET',
      headers,
      agent: false,
    })
    upstreamRequests.add(upstreamRequest)
    const handshakeTimer = setTimeout(() => {
      if (settled) return
      settled = true
      upstreamRequest.destroy()
      recordError('upgrade-timeout', { path: target.pathname, code: 'ETIMEDOUT' })
      rejectUpgrade(socket, 504, 'phone bridge: upstream upgrade timed out')
    }, UPGRADE_HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref?.()

    const clearHandshake = () => {
      settled = true
      clearTimeout(handshakeTimer)
      upstreamRequests.delete(upstreamRequest)
    }

    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      clearHandshake()
      if (socket.destroyed) {
        upstreamSocket.destroy()
        return
      }
      upstreamSocket.on('error', () => {})
      upstreamSocket.setNoDelay(true)
      upstreamSocket.setKeepAlive(true, 30_000)
      upstreamSocket.setTimeout(0)
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 30_000)
      socket.setTimeout(0)

      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`]
      const raw = upstreamResponse.rawHeaders
      for (let index = 0; index < raw.length; index += 2) {
        if (raw[index].toLowerCase() === 'set-cookie') continue
        lines.push(`${raw[index]}: ${raw[index + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)

      upgraded.add(socket)
      upgraded.add(upstreamSocket)
      let entry
      const closeBoth = () => {
        upgraded.delete(socket)
        upgraded.delete(upstreamSocket)
        if (deviceId !== undefined && entry !== undefined) {
          const entries = deviceSockets.get(deviceId)
          if (entries !== undefined) {
            entries.delete(entry)
            if (entries.size === 0) deviceSockets.delete(deviceId)
          }
        }
        if (!socket.destroyed) socket.destroy()
        if (!upstreamSocket.destroyed) upstreamSocket.destroy()
      }
      entry = { close: closeBoth }
      if (deviceId !== undefined) {
        let entries = deviceSockets.get(deviceId)
        if (entries === undefined) {
          entries = new Set()
          deviceSockets.set(deviceId, entries)
        }
        entries.add(entry)
      }
      socket.once('close', closeBoth)
      upstreamSocket.once('close', closeBoth)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      socket.resume()
    })

    upstreamRequest.on('response', (upstreamResponse) => {
      clearHandshake()
      if (socket.destroyed) {
        upstreamResponse.resume()
        return
      }
      if (upstreamResponse.statusCode === 401) {
        upstream401s += 1
        auth.invalidate(cookie)
      }
      const headers = downstreamResponseHeaders(upstreamResponse.headers)
      headers.connection = 'close'
      const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`]
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) lines.push(`${name}: ${entry}`)
        } else if (value !== undefined) {
          lines.push(`${name}: ${value}`)
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstreamResponse.on('error', () => {
        if (!socket.destroyed) socket.destroy()
      })
      upstreamResponse.pipe(socket)
      socket.resume()
    })

    const onClientClose = () => {
      if (!settled) upstreamRequest.destroy()
    }
    socket.once('close', onClientClose)
    upstreamRequest.on('error', (error) => {
      upstreamRequests.delete(upstreamRequest)
      if (!settled) {
        clearHandshake()
        recordError('upgrade-failed', {
          path: target.pathname,
          code: typeof error?.code === 'string' ? error.code : 'upgrade-failed',
        })
        rejectUpgrade(socket, 502, 'phone bridge: upstream upgrade failed')
      }
    })
    upstreamRequest.end()
  }

  return {
    /** Handle one ordinary HTTP request. */
    handleRequest(req, res) {
      requests += 1
      const target = upstreamTarget(req.url)
      if (target.pathname === '/__health') {
        handleHealth(req, res)
        return
      }
      if (!isAuthorized(req)) {
        sendText(res, 401, 'pairing required')
        return
      }
      proxyHttp(req, res, target).catch((error) => {
        recordError('http-proxy-failed', {
          path: target.pathname,
          code: typeof error?.code === 'string' ? error.code : 'proxy-failed',
        })
        if (res.destroyed) return
        if (res.headersSent) {
          res.destroy()
          return
        }
        sendText(res, error?.code === 'ERR_BODY_TOO_LARGE' ? 413 : 503, 'phone bridge: upstream unavailable')
      })
    },

    /** Handle one HTTP upgrade. */
    handleUpgrade(req, socket, head) {
      requests += 1
      handleUpgrade(req, socket, head).catch(() => {
        if (!socket.destroyed) socket.destroy()
      })
    },

    /**
     * Destroy every upgraded socket owned by one revoked device.
     * @param deviceId - public device id.
     * @returns how many proxy connections were closed.
     */
    closeDevice(deviceId) {
      const entries = deviceSockets.get(deviceId)
      if (entries === undefined) return 0
      let closed = 0
      for (const entry of [...entries]) {
        entry.close()
        closed += 1
      }
      deviceSockets.delete(deviceId)
      return closed
    },

    /** Destroy upgraded sockets for every device (revoke-all). */
    closeAllDeviceSockets() {
      let closed = 0
      for (const deviceId of [...deviceSockets.keys()]) {
        closed += this.closeDevice(deviceId)
      }
      return closed
    },

    /** Secret-free diagnostics for the Settings page and the health endpoint. */
    status() {
      return {
        version,
        host,
        requests,
        errors,
        upstream401s,
        reauths,
        upgradedSockets: upgraded.size,
        deviceSockets: [...deviceSockets.values()].reduce((total, entries) => total + entries.size, 0),
        lastError,
        upstream: typeof auth.status === 'function' ? auth.status() : undefined,
      }
    },

    /** Destroy pooled connections and every upgraded socket. */
    close() {
      agent.destroy()
      deviceSockets.clear()
      for (const request of upstreamRequests) request.destroy()
      upstreamRequests.clear()
      for (const socket of upgraded) socket.destroy()
      upgraded.clear()
      healthSeen.clear()
    },
  }
}

/**
 * Read a bounded request body.
 * @param req - incoming request.
 * @param limit - maximum bytes.
 * @returns the body buffer.
 */
function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('request body is too large to buffer')
        error.code = 'ERR_BODY_TOO_LARGE'
        req.destroy()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Send a small plain-text response.
 * @param res - response to write.
 * @param status - HTTP status.
 * @param message - body without a trailing newline.
 */
function sendText(res, status, message) {
  if (res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  const payload = Buffer.from(`${message}\n`, 'utf8')
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.length),
  })
  res.end(payload)
}

/**
 * Refuse an upgrade before any HTTP response has been written.
 * @param socket - raw client socket.
 * @param status - HTTP status.
 * @param message - body without a trailing newline.
 */
export function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return
  const payload = `${message}\n`
  const reason = http.STATUS_CODES[status] ?? 'Error'
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'connection: close\r\n' +
    'cache-control: no-store\r\n' +
    'content-type: text/plain; charset=utf-8\r\n' +
    `content-length: ${String(Buffer.byteLength(payload))}\r\n\r\n` +
    payload,
  )
}
