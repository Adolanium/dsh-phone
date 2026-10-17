/**
 * `POST /__pair` on the tailnet listener. This is the only tailnet route that
 * is not gated by the device cookie; it is gated by the pairing code, a
 * per-source rate limit, and the store being loaded.
 */
import { deviceCookie } from './auth.js'
import { HttpError, hasJsonContentType, readJsonBody, sendJson } from './http.js'

/**
 * Handle one pairing request.
 * @param req - incoming request.
 * @param res - response to write.
 * @param options - auth owner and logger.
 */
export async function handlePairRequest(req, res, { auth, log }) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'method-not-allowed' }, { allow: 'POST' })
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
    sendJson(res, 400, { ok: false, code: 'invalid-body' })
    return
  }
  const source = req.socket?.remoteAddress ?? 'unknown'
  try {
    const result = await auth.pair({ code: body.code, name: body.name, source })
    if (result.ok !== true) {
      const headers = result.retryAfterMs === undefined
        ? {}
        : { 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) }
      sendJson(res, result.status, { ok: false, code: result.code }, headers)
      return
    }
    res.writeHead(204, {
      'cache-control': 'no-store',
      'set-cookie': deviceCookie(result.token),
    })
    res.end()
  } catch (error) {
    log('error', 'pair-handler-failed', { code: typeof error?.code === 'string' ? error.code : 'pair-failed' })
    sendJson(res, 500, { ok: false, code: 'internal' })
  }
}
