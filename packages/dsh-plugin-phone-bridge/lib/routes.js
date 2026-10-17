/**
 * Loopback admin routes for the Settings → Phone page.
 *
 * They live on the Desktop Host's loopback Web server, not on the tailnet
 * listener. Every route requires the custom header `x-dsh-phone-admin: 1` and
 * either no `Origin` or the Web client's own origin (the Electron shell also
 * presents `dsh-app://app`). A custom header forces a CORS preflight that this
 * server never answers, so a foreign page cannot read a response even if it
 * manages to send a request. No CORS headers are emitted.
 */
import { HttpError, hasJsonContentType, isLoopbackAddress, readJsonBody, sendJson } from './http.js'
import { buildPairPayload, renderQrSvg } from './qr.js'

/** Custom header that proves the caller is the Settings page. */
export const ADMIN_HEADER = 'x-dsh-phone-admin'

/** Allowed desktop-shell origin. */
const DESKTOP_ORIGIN = 'dsh-app://app'

/**
 * Guard one admin request.
 * @param req - incoming request.
 * @param ownOrigin - the Host's loopback origin, when available.
 * @returns undefined when admitted, or a classified refusal.
 */
export function adminGuard(req, ownOrigin) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return { status: 403, code: 'forbidden-host', message: 'phone-bridge admin routes are loopback-only' }
  }
  if (req.headers?.[ADMIN_HEADER] !== '1') {
    return { status: 403, code: 'missing-admin-header', message: `header ${ADMIN_HEADER}: 1 is required` }
  }
  const origin = req.headers?.origin
  if (origin !== undefined && origin !== DESKTOP_ORIGIN && origin !== ownOrigin) {
    return { status: 403, code: 'forbidden-origin', message: 'request origin does not match the Host' }
  }
  return undefined
}

/**
 * Dispatch one admin request.
 * @param req - incoming request.
 * @param res - response to write.
 * @param options - route kind, bridge, logger, and origin reader.
 */
export async function handleAdmin(req, res, { kind, bridge, log, getOrigin }) {
  const refusal = adminGuard(req, getOrigin())
  if (refusal !== undefined) {
    sendJson(res, refusal.status, { ok: false, code: refusal.code, message: refusal.message })
    return
  }
  const expectedMethod = kind === 'status' || kind === 'devices' || kind === 'qr' ? 'GET' : 'POST'
  if (req.method !== expectedMethod) {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: expectedMethod })
    return
  }
  const auth = bridge.auth
  if (auth === undefined) {
    sendJson(res, 503, { ok: false, code: 'auth-unavailable' })
    return
  }

  if (kind === 'status') {
    sendJson(res, 200, { ok: true, ...bridge.status() })
    return
  }
  if (kind === 'qr') {
    if (!auth.ready) {
      sendJson(res, 503, { ok: false, code: 'store-unavailable' })
      return
    }
    const status = bridge.status()
    const pairing = status.auth?.pairing
    const listener = status.listener
    const tailnet = status.tailnet
    if (pairing === undefined || listener === undefined || listener === null || tailnet === undefined || tailnet === null) {
      sendJson(res, 503, { ok: false, code: 'listener-offline' })
      return
    }
    const host = typeof tailnet.dnsName === 'string' && tailnet.dnsName !== '' ? tailnet.dnsName : listener.address
    const name = typeof tailnet.dnsName === 'string' && tailnet.dnsName !== ''
      ? tailnet.dnsName.split('.')[0]
      : listener.address
    const payload = buildPairPayload({
      origin: `http://${host}:${String(listener.port)}`,
      code: pairing.code,
      name,
    })
    sendSvg(res, renderQrSvg(payload))
    return
  }
  if (kind === 'devices') {
    if (!auth.ready) {
      sendJson(res, 503, { ok: false, code: 'store-unavailable' })
      return
    }
    sendJson(res, 200, { ok: true, devices: auth.devices() })
    return
  }
  if (kind === 'rotate') {
    if (!auth.ready) {
      sendJson(res, 503, { ok: false, code: 'store-unavailable' })
      return
    }
    auth.rotatePairing()
    sendJson(res, 200, { ok: true, pairing: auth.pairingInfo() })
    return
  }
  if (kind === 'revoke') {
    if (!auth.ready) {
      sendJson(res, 503, { ok: false, code: 'store-unavailable' })
      return
    }
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, { ok: false, code: 'unsupported-media-type' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, code: error.code })
        return
      }
      throw error
    }
    if (body.all === true) {
      const revoked = await auth.revokeAll()
      const socketsClosed = typeof bridge.closeAllDeviceSockets === 'function'
        ? bridge.closeAllDeviceSockets()
        : 0
      log('info', 'devices-revoked-all', { revoked, socketsClosed })
      sendJson(res, 200, { ok: true, revoked })
      return
    }
    if (typeof body.id !== 'string' || body.id === '') {
      sendJson(res, 400, { ok: false, code: 'invalid-device-id' })
      return
    }
    const revoked = await auth.revoke(body.id)
    const socketsClosed = revoked && typeof bridge.closeDevice === 'function'
      ? bridge.closeDevice(body.id)
      : 0
    log('info', 'device-revoked', { revoked: revoked ? 1 : 0, socketsClosed })
    sendJson(res, 200, { ok: true, revoked: revoked ? 1 : 0 })
    return
  }
  sendJson(res, 404, { ok: false, code: 'unknown-route' })
}

/**
 * Send one SVG document.
 * @param res - response to write.
 * @param svg - SVG document string.
 */
function sendSvg(res, svg) {
  if (res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  const payload = Buffer.from(svg, 'utf8')
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-length': String(payload.length),
  })
  res.end(payload)
}

/**
 * Register the admin routes on the Host's Web server.
 * @param webCtx - context owning the Web server.
 * @param bridge - bridge with `auth` and `status()`.
 * @param log - structured logger.
 */
export function registerAdminRoutes(webCtx, bridge, log) {
  const getOrigin = () => {
    try {
      return webCtx.webServer.getOrigin()
    } catch {
      return undefined
    }
  }
  const routes = [
    ['/phone-bridge/status', 'status'],
    ['/phone-bridge/devices', 'devices'],
    ['/phone-bridge/qr.svg', 'qr'],
    ['/phone-bridge/rotate', 'rotate'],
    ['/phone-bridge/revoke', 'revoke'],
  ]
  for (const [path, kind] of routes) {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        handleAdmin(req, res, { kind, bridge, log, getOrigin }).catch((error) => {
          log('warn', 'admin-route-failed', {
            path,
            code: typeof error?.code === 'string' ? error.code : 'admin-failed',
          })
          sendJson(res, 500, { ok: false, code: 'internal' })
        })
      },
    }), `phone-bridge: ${path}`)
  }
}
