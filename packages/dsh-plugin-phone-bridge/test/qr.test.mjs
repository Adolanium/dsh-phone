import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPairPayload, buildQrMatrix, renderQrSvg } from '../lib/qr.js'

test('the pairing payload is versioned and keeps the origin, code, and name', () => {
  const payload = buildPairPayload({
    origin: 'http://desk.tail-example.ts.net:8787/',
    code: 'K7QM2X9R',
    name: 'desk',
  })
  assert.equal(
    payload,
    'dshphone://pair?v=1&u=http%3A%2F%2Fdesk.tail-example.ts.net%3A8787&c=K7QM2X9R&n=desk',
  )
  const parsed = new URL(payload)
  assert.equal(parsed.protocol, 'dshphone:')
  assert.equal(parsed.host, 'pair')
  assert.equal(parsed.searchParams.get('v'), '1')
  assert.equal(parsed.searchParams.get('u'), 'http://desk.tail-example.ts.net:8787')
  assert.equal(parsed.searchParams.get('c'), 'K7QM2X9R')
  assert.equal(parsed.searchParams.get('n'), 'desk')
})

test('the pairing payload rejects invalid origins and empty codes', () => {
  assert.throws(() => buildPairPayload({ origin: '', code: 'K7QM2X9R' }), /origin is required/)
  assert.throws(() => buildPairPayload({ origin: 'file:///tmp/x', code: 'K7QM2X9R' }), /HTTP\(S\)/)
  assert.throws(() => buildPairPayload({ origin: 'nope', code: 'K7QM2X9R' }), /valid URL/)
  assert.throws(() => buildPairPayload({ origin: 'http://127.0.0.1:8787', code: '' }), /code is required/)
})

test('the QR matrix has finder patterns and a sane size', () => {
  const matrix = buildQrMatrix('hello')
  assert.ok(matrix.size >= 21)
  assert.equal(matrix.rows.length, matrix.size)
  assert.equal(matrix.rows[0].length, matrix.size)
  assert.equal(matrix.rows[0][0], true)
  assert.equal(matrix.rows[0][6], true)
  assert.equal(matrix.rows[1][1], false)
  assert.equal(matrix.rows[2][2], true)
  assert.equal(matrix.rows[0][matrix.size - 1], true)
  assert.equal(matrix.rows[matrix.size - 1][0], true)
})

test('the SVG is a quiet-zone dark-on-white document without the payload in text', () => {
  const payload = buildPairPayload({
    origin: 'http://100.64.0.10:8787',
    code: 'K7QM2X9R',
    name: 'desk',
  })
  const matrix = buildQrMatrix(payload)
  const svg = renderQrSvg(payload)
  assert.match(svg, /^<svg /)
  assert.match(svg, /width="320"/)
  assert.match(svg, /height="320"/)
  assert.match(svg, new RegExp(`viewBox="0 0 ${String(matrix.size + 8)} ${String(matrix.size + 8)}"`))
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/)
  assert.match(svg, /<path d="M/)
  assert.equal(svg.includes(payload), false)
  assert.equal(svg.includes('K7QM2X9R'), false)
  assert.equal(svg.includes('100.64.0.10'), false)
})

test('size and margin are configurable and validated', () => {
  const svg = renderQrSvg('hello', { size: 640, margin: 2 })
  assert.match(svg, /width="640"/)
  assert.match(svg, /height="640"/)
  assert.throws(() => renderQrSvg(''), /text is required/)
  assert.throws(() => renderQrSvg('hello', { size: 0 }), /positive integer/)
  assert.throws(() => renderQrSvg('hello', { margin: -1 }), /non-negative integer/)
})
