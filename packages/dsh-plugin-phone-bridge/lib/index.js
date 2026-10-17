/**
 * dsh-plugin-phone-bridge — Host half.
 *
 * Opens exactly one listener on this machine's Tailscale address and
 * reverse-proxies it into the running Desktop Host's loopback Web server. The
 * phone therefore talks to the same Host process that owns the sessions; there
 * is no second DSH instance and no second writer.
 *
 * Milestone 1 added the transport:
 *   - tailnet address discovery (Tailscale CLI, then the network interface);
 *   - a fail-closed bind on one `100.64.0.0/10` literal;
 *   - an upstream browser cookie minted through `connection.authenticatedUrl`;
 *   - HTTP and WebSocket proxying with header rewriting and cookie stripping;
 *   - `GET /__health` and structured, secret-free logging;
 *   - deterministic teardown on plugin unload.
 *
 * Milestone 2 adds pairing:
 *   - a hash-only device store at `~/.dsh/storages/phone-bridge.json`;
 *   - `POST /__pair` with a 120-second, single-use pairing code and a
 *     per-source lockout;
 *   - a `dsh-phone` device cookie required by every proxied request and
 *     WebSocket upgrade;
 *   - loopback-only admin routes for status, devices, rotate, and revoke.
 *
 * The Settings → Phone page and the iOS app-support endpoints
 * (`/__pair-bootstrap` and `/__session`) live here. `/__health`, `POST /__pair`,
 * and `/__pair-bootstrap` are the only unauthenticated tailnet endpoints.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'

import { PhoneAuth } from './auth.js'
import { PAIR_BOOTSTRAP_PATH, SESSION_PATH, handleBootstrapRequest, handleSessionRequest } from './bootstrap.js'
import { sendText } from './http.js'
import { handlePairRequest } from './pairing.js'
import { createProxy, rejectUpgrade, upstreamTarget } from './proxy.js'
import { registerAdminRoutes } from './routes.js'
import { DeviceStore, resolveStorePath } from './store.js'
import { assertTailnetAddress, isTailnetIPv4, resolveTailnet } from './tailscale.js'
import { UpstreamAuth } from './upstream.js'

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Version reported by `/__health` and diagnostics. */
export const VERSION = PACKAGE.version

/** Stable Cordis plugin name. */
export const name = 'dsh-plugin-phone-bridge'

/** The Host services the bridge needs before it can start. */
export const inject = ['webServer', 'connection']

const DEFAULT_PORT = 8787
const DEFAULT_RETRY_MS = 15_000
const RETRY_MIN_MS = 1000

/**
 * Whether a path belongs to the loopback-only admin surface. The tailnet proxy
 * must never forward it, even from a paired device.
 * @param pathname - request pathname.
 * @returns true for `/phone-bridge` and its subtree.
 */
export function isAdminPath(pathname) {
  return pathname === '/phone-bridge' || pathname.startsWith('/phone-bridge/')
}

/**
 * Validate the plugin configuration once, at activation.
 * @param config - profile patch config.
 * @returns normalized settings.
 */
export function resolveConfig(config = {}) {
  const port = Number(config.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`phone-bridge: port must be an integer from 1 to 65535, got ${JSON.stringify(config.port)}`)
  }
  const retryMs = Number(config.retryMs ?? DEFAULT_RETRY_MS)
  if (!Number.isFinite(retryMs) || retryMs < RETRY_MIN_MS) {
    throw new Error(`phone-bridge: retryMs must be at least ${String(RETRY_MIN_MS)}`)
  }
  let bindAddress
  if (config.bindAddress !== undefined) {
    if (typeof config.bindAddress !== 'string') throw new Error('phone-bridge: bindAddress must be a string')
    // Fail at activation, not on the first connection: a non-tailnet bind
    // address is a configuration bug, never a fallback.
    bindAddress = assertTailnetAddress(config.bindAddress)
  }
  return { port, retryMs: Math.floor(retryMs), bindAddress }
}

/**
 * Build the scoped logger used by this plugin. The Cordis logger may be a
 * function (`ctx.logger('scope')`) or an object with levelled methods; support
 * both, and never let logging break the bridge.
 * @param ctx - Host context.
 * @returns `(level, event, fields) => void`.
 */
export function createLog(ctx) {
  let scoped
  try {
    if (typeof ctx?.logger === 'function') {
      const candidate = ctx.logger('phone-bridge')
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.info === 'function') scoped = candidate
    }
  } catch {
    scoped = undefined
  }
  if (scoped === undefined && typeof ctx?.logger?.info === 'function') {
    scoped = ctx.logger
  }
  const recent = []
  const mirror = process.env.DSH_PHONE_BRIDGE_LOG === '1'
  const emit = (level, event, fields = {}) => {
    const record = { component: 'phone-bridge', event, ...sanitizeFields(fields) }
    const line = JSON.stringify(record)
    recent.push(record)
    if (recent.length > 50) recent.shift()
    if (mirror) {
      try {
        process.stderr.write(`${line}\n`)
      } catch {
        // A closed stderr must not stop the listener.
      }
    }
    try {
      const method = scoped?.[level]
      if (typeof method === 'function') method.call(scoped, line)
      else if (typeof console[level] === 'function') console[level](line)
      else console.log(line)
    } catch {
      // Logging is diagnostic; a broken logger must not stop the listener.
    }
  }
  emit.recent = recent
  return emit
}

/**
 * Drop anything that could carry a credential and bound diagnostic strings.
 * @param fields - structured log fields.
 * @returns a safe copy.
 */
export function sanitizeFields(fields) {
  const safe = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (/cookie|token|authorization|secret|pair|set-cookie/i.test(key)) continue
    if (value instanceof Error) {
      safe[key] = { name: value.name, code: value.code }
      continue
    }
    if (typeof value === 'string') {
      const redacted = value
        .replace(/([?&]token=)[^&\s]+/giu, '$1<redacted>')
        .replace(/dsh-auth-[A-Za-z0-9_-]+=[^\s;]+/gu, 'dsh-auth-<redacted>')
      safe[key] = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted
      continue
    }
    safe[key] = value
  }
  return safe
}

/**
 * Create one bridge activation.
 *
 * The returned object is intentionally small so tests and the future Settings
 * route can read a secret-free snapshot without reaching into the proxy.
 * @param ctx - Host Cordis context with `webServer` and `connection`.
 * @param config - plugin configuration.
 * @returns lifecycle and status.
 */
export function createBridge(ctx, config = {}) {
  const settings = resolveConfig(config)
  const log = createLog(ctx)
  const startedAt = Date.now()
  const phoneAuth = new PhoneAuth({
    store: new DeviceStore({ path: resolveStorePath(config), log }),
    log,
  })

  let stopped = false
  let starting
  let server
  let proxy
  let auth
  let retryTimer
  let tailnet
  let listener
  let state = 'starting'
  let lastError = null
  const sockets = new Set()

  /** Record one failure for diagnostics and logs, with no credentials. */
  function fail(event, message, code) {
    lastError = {
      event,
      message: typeof message === 'string' ? message : 'unknown error',
      code: typeof code === 'string' ? code : undefined,
      at: new Date().toISOString(),
    }
    log('warn', event, lastError)
  }

  /** Tear down a partial attempt without touching a live listener. */
  async function disposeAttempt() {
    listener = undefined
    if (proxy !== undefined) {
      proxy.close()
      proxy = undefined
    }
    auth = undefined
    if (server !== undefined) {
      const dying = server
      server = undefined
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          dying.close(finish)
        } catch {
          finish()
        }
        const timer = setTimeout(finish, 1000)
        timer.unref?.()
      })
    }
  }

  /** Schedule another discovery/bind attempt after a transient failure. */
  function scheduleRetry() {
    if (stopped || retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void start()
    }, settings.retryMs)
    retryTimer.unref?.()
  }

  /** Resolve the bind target, or explain why the bridge stays offline. */
  async function discover() {
    if (settings.bindAddress !== undefined) {
      return {
        connected: true,
        ip: settings.bindAddress,
        dnsName: undefined,
        source: 'config',
        backendState: undefined,
        version: undefined,
      }
    }
    return resolveTailnet({ interfaces: networkInterfaces() })
  }

  /** Start (or retry) discovery and the listener. Never rejects. */
  async function start() {
    if (stopped || server !== undefined) return
    if (starting !== undefined) return starting
    starting = (async () => {
      try {
        await disposeAttempt()
        state = 'starting'
        try {
          await phoneAuth.load()
        } catch (error) {
          // A corrupt or unreadable device store must fail closed: without it
          // there is no way to tell a paired phone from any other tailnet peer.
          state = 'error'
          fail('store-load-failed', error instanceof Error ? error.message : String(error), error?.code)
          return
        }
        let resolved
        try {
          resolved = await discover()
        } catch (error) {
          state = 'error'
          fail('tailscale-discovery-failed', error instanceof Error ? error.message : String(error))
          scheduleRetry()
          return
        }
        if (stopped) return
        if (resolved.connected !== true) {
          state = 'offline'
          fail('tailscale-offline', resolved.error ?? 'Tailscale is not connected')
          scheduleRetry()
          return
        }
        const address = resolved.ip
        if (!isTailnetIPv4(address)) {
          state = 'error'
          fail('tailnet-address-invalid', `resolved address ${String(address)} is outside 100.64.0.0/10`)
          return
        }
        assertTailnetAddress(address)
        tailnet = {
          ip: address,
          dnsName: resolved.dnsName,
          source: resolved.source,
          backendState: resolved.backendState,
          version: resolved.version,
        }
        const displayHost = resolved.dnsName ?? address

        auth = new UpstreamAuth({
          getOrigin: () => ctx.webServer.getOrigin(),
          authenticatedUrl: (url) => ctx.connection.authenticatedUrl(url),
          log,
        })
        proxy = createProxy({
          auth,
          authorize: (req) => phoneAuth.authorize(req),
          identify: (req) => phoneAuth.deviceFromRequest(req),
          log,
          version: VERSION,
          host: displayHost,
        })

        const candidate = http.createServer((req, res) => {
          if (proxy === undefined) {
            res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
            res.end('phone bridge is stopping\n')
            return
          }
          const target = upstreamTarget(req.url)
          if (target.pathname === '/__pair') {
            void handlePairRequest(req, res, { auth: phoneAuth, log })
            return
          }
          if (target.pathname === PAIR_BOOTSTRAP_PATH) {
            handleBootstrapRequest(req, res)
            return
          }
          if (target.pathname === SESSION_PATH) {
            handleSessionRequest(req, res, { auth: phoneAuth })
            return
          }
          if (isAdminPath(target.pathname)) {
            // The admin surface is loopback-only. A paired phone is already an
            // owner, but it still must not reach the pairing code or device
            // list through the proxy.
            sendText(res, 404, 'not found')
            return
          }
          proxy.handleRequest(req, res)
        })
        candidate.on('upgrade', (req, socket, head) => {
          if (proxy === undefined) {
            socket.destroy()
            return
          }
          const target = upstreamTarget(req.url)
          if (
            target.pathname === '/__pair' ||
            target.pathname === PAIR_BOOTSTRAP_PATH ||
            target.pathname === SESSION_PATH ||
            isAdminPath(target.pathname)
          ) {
            rejectUpgrade(socket, 404, 'not found')
            return
          }
          proxy.handleUpgrade(req, socket, head)
        })
        candidate.on('connection', (socket) => {
          sockets.add(socket)
          socket.setNoDelay(true)
          socket.on('close', () => {
            sockets.delete(socket)
          })
        })
        candidate.on('clientError', (_error, socket) => {
          if (!socket.destroyed) {
            socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
          }
        })
        candidate.headersTimeout = 60_000
        candidate.requestTimeout = 0
        candidate.keepAliveTimeout = 65_000
        candidate.timeout = 0

        server = candidate
        try {
          await new Promise((resolve, reject) => {
            const onError = (error) => {
              candidate.off('listening', onListening)
              reject(error)
            }
            const onListening = () => {
              candidate.off('error', onError)
              resolve()
            }
            candidate.once('error', onError)
            candidate.once('listening', onListening)
            candidate.listen({ host: address, port: settings.port, exclusive: true })
          })
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : undefined
          const description = code === 'EADDRINUSE'
            ? `port ${String(settings.port)} is already in use on ${address}`
            : `could not listen on ${address}:${String(settings.port)}${code === undefined ? '' : ` (${code})`}`
          state = 'error'
          fail('listen-failed', description, code)
          await disposeAttempt()
          // A taken port is a durable conflict; retrying forever would only
          // hide it. Tailscale coming up late is transient and is retried.
          if (code !== 'EADDRINUSE') scheduleRetry()
          return
        }
        if (stopped) {
          await disposeAttempt()
          return
        }

        listener = { address, port: settings.port }
        state = 'listening'
        lastError = null
        let upstreamPort
        try {
          upstreamPort = auth.port
        } catch {
          upstreamPort = undefined
        }
        // A post-listen server error would otherwise be an unhandled 'error'
        // event and take the whole Host process down. Record it, close this
        // attempt, and let the ordinary retry path bring the listener back.
        candidate.on('error', (error) => {
          if (server !== candidate) return
          fail('listener-error', error instanceof Error ? error.message : String(error), error?.code)
          state = 'error'
          void disposeAttempt().then(() => scheduleRetry())
        })
        log('info', 'listening', {
          address,
          port: settings.port,
          host: displayHost,
          upstreamPort,
          version: VERSION,
        })
        // Warm the upstream cookie so the first phone request is not delayed
        // by the token exchange. A failure here is not fatal: the proxy retries.
        auth.cookieHeader().catch(() => {})
      } catch (error) {
        state = 'error'
        fail('start-failed', error instanceof Error ? error.message : String(error))
        await disposeAttempt()
        scheduleRetry()
      }
    })().finally(() => {
      starting = undefined
    })
    return starting
  }

  /** Close the listener, pooled upstream connections, and upgraded sockets. */
  async function stop() {
    if (stopped) return
    stopped = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    if (starting !== undefined) await starting.catch(() => {})
    state = 'stopped'
    listener = undefined
    await disposeAttempt()
    log('info', 'stopped', {})
  }

  return {
    config: settings,
    auth: phoneAuth,
    log,
    start,
    stop,
    /** Close upgraded sockets owned by one revoked device. */
    closeDevice(deviceId) {
      return proxy === undefined ? 0 : proxy.closeDevice(deviceId)
    },
    /** Close every device-owned upgraded socket (revoke-all). */
    closeAllDeviceSockets() {
      return proxy === undefined ? 0 : proxy.closeAllDeviceSockets()
    },
    /**
     * Status for diagnostics and the loopback Settings page. It includes the
     * short-lived pairing code because the page must render it; it never
     * includes a device token or token hash.
     */
    status() {
      return {
        version: VERSION,
        state,
        tailnet,
        listener,
        uptimeMs: Math.max(0, Date.now() - startedAt),
        lastError,
        auth: phoneAuth.status(),
        recent: typeof log.recent === 'object' ? log.recent.slice(-20) : [],
        ...(proxy === undefined ? {} : { traffic: proxy.status() }),
      }
    },
  }
}

/**
 * Plugin entry: start the listener when both services are ready, and close it
 * when the plugin's fiber is disposed.
 * @param ctx - Host Cordis context.
 * @param config - profile patch config.
 */
export function apply(ctx, config = {}) {
  const bridge = createBridge(ctx, config)
  ctx.effect(() => {
    const started = bridge.start()
    // The lifecycle is designed not to reject; keep an explicit handler so an
    // unexpected failure can never surface as an unhandled rejection.
    started.catch(() => {})
    return async () => {
      await started.catch(() => {})
      await bridge.stop()
    }
  }, 'phone-bridge: tailnet listener')
  ctx.inject(['webServer'], (webCtx) => {
    registerAdminRoutes(webCtx, bridge, bridge.log)
  })
}

/** Exported for the package's own tests; not part of the plugin contract. */
export const internals = {
  VERSION,
  resolveConfig,
  createLog,
  sanitizeFields,
}
