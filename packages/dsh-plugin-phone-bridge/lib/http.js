/**
 * Small HTTP helpers shared by the pairing endpoint and the loopback admin
 * routes. They keep body limits, JSON envelopes, and loopback classification
 * in one place; they never add CORS headers.
 */
import { isIP } from 'node:net'

/** One classified request failure with an HTTP status. */
export class HttpError extends Error {
  /**
   * @param status - HTTP status to return.
   * @param code - stable machine-readable code.
   * @param message - human-readable text.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/**
 * Whether an address is loopback. Accepts IPv4, IPv6, and IPv4-mapped IPv6.
 * @param address - `req.socket.remoteAddress`.
 * @returns true for `127/8`, `::1`, and `::ffff:127/8`.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (normalized === '::1' || normalized === '::') return true
  if (isIP(normalized) !== 4) return false
  const octets = normalized.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Read a request body with a byte ceiling.
 * @param req - incoming request.
 * @param limit - maximum bytes.
 * @returns the body buffer.
 * @throws {HttpError} 413 when the body exceeds the ceiling.
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new HttpError(413, 'body-too-large', 'request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Read and parse a JSON request body.
 * @param req - incoming request.
 * @param limit - maximum bytes.
 * @returns the parsed object; an empty body reads as `{}`.
 * @throws {HttpError} 400 for malformed JSON, 413 for an oversized body.
 */
export async function readJsonBody(req, limit = 16 * 1024) {
  const text = (await readBody(req, limit)).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid-body', 'request body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'invalid-json', 'request body is not valid JSON')
  }
}

/**
 * Send one JSON response.
 * @param res - response to write.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 * @param headers - extra headers (never CORS).
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.destroyed) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    ...headers,
  })
  res.end(payload)
}

/**
 * Send one small plain-text response.
 * @param res - response to write.
 * @param status - HTTP status.
 * @param message - body without a trailing newline.
 * @param headers - extra headers (never CORS).
 */
export function sendText(res, status, message, headers = {}) {
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
    ...headers,
  })
  res.end(payload)
}

/**
 * Whether a request declares JSON.
 * @param req - incoming request.
 * @returns true for `application/json` with any parameters.
 */
export function hasJsonContentType(req) {
  const value = req.headers?.['content-type']
  return typeof value === 'string' && value.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}
