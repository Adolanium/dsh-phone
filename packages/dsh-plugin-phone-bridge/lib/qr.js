/**
 * Pairing payload and dependency-free QR rendering.
 *
 * The QR encoder itself is vendored from Kazuhiko Arase's MIT-licensed QRCode
 * implementation (see `qr/VENDOR.md`). This module owns the bridge-specific
 * payload shape and the SVG output:
 *
 *   dshphone://pair?v=1&u=http%3A%2F%2Fhost%3A8787&c=K7QM2X9R&n=host
 *
 * The payload never contains the DSH launch token or the upstream port. The
 * pairing code is the only credential in it, and it expires after 120 seconds.
 */
import QRCode from './qr/vendor/index.js'
import QRErrorCorrectLevel from './qr/vendor/QRErrorCorrectLevel.js'

/** Custom URL scheme the iOS app will register. */
export const PAIR_SCHEME = 'dshphone'

/** QR error-correction level. M tolerates ~15% damage and keeps the code small. */
const QR_ERROR_CORRECTION = QRErrorCorrectLevel.M

/** Default rendered size and quiet-zone width (in modules). */
const DEFAULT_SIZE = 320
const DEFAULT_MARGIN = 4

/**
 * Build the versioned pairing payload.
 * @param options - origin (`http://host:port`), code, and display name.
 * @returns `dshphone://pair?...`.
 */
export function buildPairPayload({ origin, code, name } = {}) {
  if (typeof origin !== 'string' || origin.trim() === '') throw new TypeError('pairing origin is required')
  let parsed
  try {
    parsed = new URL(origin.trim())
  } catch {
    throw new TypeError('pairing origin is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('pairing origin must be HTTP(S)')
  }
  if (typeof code !== 'string' || code.trim() === '') throw new TypeError('pairing code is required')
  const label = typeof name === 'string'
    ? name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 64)
    : ''
  const params = new URLSearchParams()
  params.set('v', '1')
  params.set('u', parsed.origin)
  params.set('c', code.trim())
  params.set('n', label === '' ? 'DSH' : label)
  return `${PAIR_SCHEME}://pair?${params.toString()}`
}

/**
 * Encode text as a QR matrix.
 * @param text - payload; must be non-empty.
 * @returns module count and a row-major boolean matrix.
 */
export function buildQrMatrix(text) {
  if (typeof text !== 'string' || text === '') throw new TypeError('QR text is required')
  const qr = new QRCode(0, QR_ERROR_CORRECTION)
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const rows = []
  for (let row = 0; row < count; row += 1) {
    const modules = []
    for (let column = 0; column < count; column += 1) modules.push(qr.isDark(row, column))
    rows.push(modules)
  }
  return { size: count, rows }
}

/**
 * Render text as a standalone dark-on-white SVG with a four-module quiet zone.
 * @param text - payload; must be non-empty.
 * @param options - rendered pixel size, quiet-zone margin, and colors.
 * @returns an SVG document string.
 */
export function renderQrSvg(text, { size = DEFAULT_SIZE, margin = DEFAULT_MARGIN, dark = '#000000', light = '#ffffff' } = {}) {
  if (!Number.isInteger(size) || size <= 0) throw new TypeError('QR size must be a positive integer')
  if (!Number.isInteger(margin) || margin < 0) throw new TypeError('QR margin must be a non-negative integer')
  const { size: count, rows } = buildQrMatrix(text)
  const total = count + margin * 2
  const segments = []
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (rows[row][column]) segments.push(`M${column + margin} ${row + margin}h1v1h-1z`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" role="img" aria-label="DSH Phone pairing QR code" ` +
    `shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">` +
    '<title>DSH Phone pairing</title>' +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${segments.join('')}" fill="${dark}"/>` +
    '</svg>'
  )
}
