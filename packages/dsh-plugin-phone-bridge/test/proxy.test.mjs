import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import test, { after, before } from 'node:test'

import { createProxy, downstreamResponseHeaders, upstreamRequestHeaders, upstreamTarget } from '../lib/proxy.js'
import { UpstreamAuth } from '../lib/upstream.js'
import { startMockUpstream } from './helpers/mock-upstream.mjs'

const PHONE_AUTHORITY = '100.64.0.10:8787'
const PHONE_ORIGIN = `http://${PHONE_AUTHORITY}`

let upstream
let auth
let proxy
let proxyServer
let proxyOrigin
let proxyPort

before(async () => {
  upstream = await startMockUpstream()
  auth = new UpstreamAuth({
    getOrigin: () => upstream.origin,
    authenticatedUrl: (url) => `${url}?token=test-token`,
    backoffBaseMs: 1,
  })
  proxy = createProxy({ auth, version: '0.1.0-test', host: 'test-host', healthLimitMs: 1000 })
  proxyServer = http.createServer((req, res) => proxy.handleRequest(req, res))
  proxyServer.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head))
  proxyServer.requestTimeout = 0
  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject)
    proxyServer.listen(0, '127.0.0.1', resolve)
  })
  proxyPort = proxyServer.address().port
  proxyOrigin = `http://127.0.0.1:${String(proxyPort)}`
})

after(async () => {
  proxy?.close()
  proxyServer?.closeAllConnections?.()
  await new Promise((resolve) => proxyServer?.close(resolve))
  await upstream?.close()
})

/**
 * Send a request the way the phone would: phone authority plus phone Origin.
 * @param path - path or absolute-form request target.
 * @param options - method, headers, body.
 * @returns status, headers, and body.
 */
function phoneRequest(path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, proxyOrigin)
  const finalHeaders = {
    host: PHONE_AUTHORITY,
    origin: PHONE_ORIGIN,
    ...headers,
  }
  if (body !== undefined && finalHeaders['content-length'] === undefined) {
    finalHeaders['content-length'] = String(Buffer.byteLength(body))
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: finalHeaders,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** Latest upstream record for one path. */
function lastRecord(pathname) {
  return [...upstream.state.records].reverse().find((record) => record.url === pathname)
}

test('GET /__health answers once per second per source', async () => {
  const first = await phoneRequest('/__health')
  assert.equal(first.status, 200)
  assert.deepEqual(JSON.parse(first.body.toString('utf8')), {
    ok: true,
    version: '0.1.0-test',
    host: 'test-host',
  })
  const second = await phoneRequest('/__health')
  assert.equal(second.status, 429)
  assert.equal(second.headers['retry-after'], '1')
})

test('the index is proxied with cookies stripped and no-store', async () => {
  const response = await phoneRequest('/')
  assert.equal(response.status, 200)
  assert.match(response.body.toString('utf8'), /mock harness/)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('Host, Origin, Cookie, Referer, and forwarding headers are rewritten', async () => {
  const response = await phoneRequest('/api/echo', {
    headers: {
      referer: 'http://100.64.0.10:8787/somewhere',
      cookie: 'dsh-phone=stolen; other=1',
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-host': 'evil.example',
      'x-real-ip': '203.0.113.9',
      'sec-fetch-site': 'same-origin',
      'accept-encoding': 'gzip',
    },
  })
  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body.toString('utf8'))
  const upstreamPort = new URL(upstream.origin).port
  assert.equal(echoed.headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(echoed.headers.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.match(echoed.headers.cookie, /^dsh-auth-test=\d+$/)
  assert.equal(echoed.headers.referer, undefined)
  assert.equal(echoed.headers['x-forwarded-for'], undefined)
  assert.equal(echoed.headers['x-forwarded-host'], undefined)
  assert.equal(echoed.headers['x-real-ip'], undefined)
  assert.equal(echoed.headers['sec-fetch-site'], 'same-origin')
  assert.equal(echoed.headers['accept-encoding'], 'gzip')
})

test('an absolute-form request line cannot turn the proxy into an open proxy', async () => {
  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: 'http://evil.example/api/echo',
      method: 'GET',
      headers: { host: PHONE_AUTHORITY, origin: PHONE_ORIGIN },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body.toString('utf8'))
  assert.equal(echoed.url, '/api/echo')
  assert.match(echoed.headers.host, /^127\.0\.0\.1:\d+$/)
})

test('a 401 re-mints once and replays a buffered POST body', async () => {
  const before = proxy.status().reauths
  const expire = await phoneRequest('/api/expire')
  assert.equal(expire.status, 200)
  const generationBefore = upstream.state.generation

  const response = await phoneRequest('/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })
  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body.toString('utf8'))
  assert.equal(echoed.method, 'POST')
  assert.equal(echoed.body, '{"hello":"world"}')
  assert.equal(upstream.state.generation, generationBefore + 1)
  assert.equal(proxy.status().reauths, before + 1)
})

test('a large body streams without buffering or retrying', async () => {
  const body = Buffer.alloc(1_200_000, 0x61)
  const response = await phoneRequest('/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
  assert.equal(response.status, 200)
  const echoed = JSON.parse(response.body.toString('utf8'))
  assert.equal(echoed.bodyLength, body.length)
  assert.equal(echoed.body, undefined)
})

test('403 passes through without a retry, and its cookie is stripped', async () => {
  const before = proxy.status().reauths
  const response = await phoneRequest('/api/forbidden')
  assert.equal(response.status, 403)
  assert.equal(response.body.toString('utf8'), 'forbidden')
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(proxy.status().reauths, before)
})

test('WebSocket upgrades are proxied with the bootstrap cookie', { skip: typeof WebSocket !== 'function' }, async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(proxyPort)}/api/ws`)
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the WebSocket message')), 3000)
    socket.addEventListener('message', (event) => {
      clearTimeout(timer)
      resolve(event.data)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket failed'))
    }, { once: true })
  })
  assert.equal(message, 'hello')
  const upgrade = upstream.state.upgrades.at(-1)
  assert.equal(upgrade.url, '/api/ws')
  assert.match(upgrade.headers.host, /^127\.0\.0\.1:\d+$/)
  assert.match(upgrade.headers.cookie, /^dsh-auth-test=\d+$/)
  socket.close()
  await new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true })
    setTimeout(resolve, 500)
  })
})

test('close() destroys upgraded sockets', { skip: typeof WebSocket !== 'function' }, async () => {
  const localProxy = createProxy({
    auth,
    version: '0.1.0-test',
    host: 'test-host',
  })
  const localServer = http.createServer((req, res) => localProxy.handleRequest(req, res))
  localServer.on('upgrade', (req, socket, head) => localProxy.handleUpgrade(req, socket, head))
  await new Promise((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', resolve)
  })
  const socket = new WebSocket(`ws://127.0.0.1:${String(localServer.address().port)}/api/ws`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true })
  })
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
  localProxy.close()
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('socket stayed open after close')), 2000)),
  ])
  localServer.closeAllConnections?.()
  await new Promise((resolve) => localServer.close(resolve))
})

test('an upstream half-open close tears down the client socket', { skip: typeof WebSocket !== 'function' }, async (t) => {
  const localProxy = createProxy({ auth, version: '0.5.0-test', host: 'test-host' })
  const localServer = http.createServer((req, res) => localProxy.handleRequest(req, res))
  localServer.on('upgrade', (req, socket, head) => localProxy.handleUpgrade(req, socket, head))
  await new Promise((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    localProxy.close()
    localServer.closeAllConnections?.()
    await new Promise((resolve) => localServer.close(resolve))
  })
  const socket = new WebSocket(`ws://127.0.0.1:${String(localServer.address().port)}/api/ws`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('message', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true })
  })
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
  upstream.destroyUpgrades()
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('client socket stayed open')), 2000)),
  ])
})

test('revoke evicts only the target device\'s upgraded sockets', { skip: typeof WebSocket !== 'function' }, async (t) => {
  const localProxy = createProxy({
    auth,
    identify: (req) => {
      const url = new URL(req.url ?? '/', 'http://local.invalid')
      const id = url.searchParams.get('device')
      return id === null ? undefined : { id }
    },
    version: '0.5.0-test',
    host: 'test-host',
  })
  const localServer = http.createServer((req, res) => localProxy.handleRequest(req, res))
  localServer.on('upgrade', (req, socket, head) => localProxy.handleUpgrade(req, socket, head))
  await new Promise((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    localProxy.close()
    localServer.closeAllConnections?.()
    await new Promise((resolve) => localServer.close(resolve))
  })
  const port = localServer.address().port

  function connect(id) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws?device=${id}`)
      const messages = []
      socket.addEventListener('message', (event) => messages.push(event.data))
      socket.addEventListener('open', () => resolve({ socket, messages }), { once: true })
      socket.addEventListener('error', () => reject(new Error(`WebSocket ${id} failed`)), { once: true })
    })
  }

  const first = await connect('a')
  const second = await connect('b')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(first.messages, ['hello'])
  assert.deepEqual(second.messages, ['hello'])
  assert.equal(localProxy.status().deviceSockets, 2)

  const firstClosed = new Promise((resolve) => first.socket.addEventListener('close', resolve, { once: true }))
  assert.equal(localProxy.closeDevice('a'), 1)
  await Promise.race([
    firstClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('device a stayed open')), 2000)),
  ])
  assert.equal(localProxy.status().deviceSockets, 1)

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(second.socket.readyState, WebSocket.OPEN)
  assert.deepEqual(second.messages, ['hello'])

  const secondClosed = new Promise((resolve) => second.socket.addEventListener('close', resolve, { once: true }))
  assert.equal(localProxy.closeAllDeviceSockets(), 1)
  await Promise.race([
    secondClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('device b stayed open')), 2000)),
  ])
  assert.equal(localProxy.status().deviceSockets, 0)
})

test('a revoke during the upstream cookie mint rejects the upgrade', async (t) => {
  let checks = 0
  const localProxy = createProxy({
    auth,
    identify: () => {
      checks += 1
      return checks === 1 ? { id: 'racing-device' } : undefined
    },
    version: '0.5.0-test',
    host: 'test-host',
  })
  const localServer = http.createServer((req, res) => localProxy.handleRequest(req, res))
  localServer.on('upgrade', (req, socket, head) => localProxy.handleUpgrade(req, socket, head))
  await new Promise((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    localProxy.close()
    localServer.closeAllConnections?.()
    await new Promise((resolve) => localServer.close(resolve))
  })
  const port = localServer.address().port
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /api/ws HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${String(port)}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, 2000)
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(data)
      }
    })
    socket.on('error', reject)
  })
  assert.match(response, /^HTTP\/1\.1 401/)
  assert.equal(checks, 2)
})

test('the authorize gate protects HTTP and upgrades but never /__health', async (t) => {
  let checks = 0
  const localProxy = createProxy({
    auth,
    authorize: () => {
      checks += 1
      throw new Error('not paired')
    },
    version: '0.2.0-test',
    host: 'test-host',
  })
  const localServer = http.createServer((req, res) => localProxy.handleRequest(req, res))
  localServer.on('upgrade', (req, socket, head) => localProxy.handleUpgrade(req, socket, head))
  await new Promise((resolve, reject) => {
    localServer.once('error', reject)
    localServer.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    localProxy.close()
    localServer.closeAllConnections?.()
    await new Promise((resolve) => localServer.close(resolve))
  })
  const port = localServer.address().port

  const health = await fetch(`http://127.0.0.1:${String(port)}/__health`)
  assert.equal(health.status, 200)
  assert.equal(checks, 0)

  const denied = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/echo',
      headers: { host: PHONE_AUTHORITY, origin: PHONE_ORIGIN },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(denied.status, 401)
  assert.equal(denied.body, 'pairing required\n')
  assert.equal(checks, 1)

  const upgrade = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'GET /api/ws HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${String(port)}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Origin: ${PHONE_ORIGIN}\r\n\r\n`,
      )
    })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, 2000)
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(data)
      }
    })
    socket.on('error', reject)
  })
  assert.match(upgrade, /^HTTP\/1\.1 401/)
  assert.equal(checks, 2)
})

test('upstreamTarget and header helpers are pure and authority-safe', () => {
  assert.deepEqual(upstreamTarget('/a/b?c=d'), { pathname: '/a/b', search: '?c=d' })
  assert.deepEqual(upstreamTarget('http://evil.example/x?y=1'), { pathname: '/x', search: '?y=1' })
  assert.deepEqual(upstreamTarget('//evil.example/x'), { pathname: '/x', search: '' })
  const headers = upstreamRequestHeaders({
    headers: {
      host: PHONE_AUTHORITY,
      origin: PHONE_ORIGIN,
      referer: 'x',
      cookie: 'a=b',
      'x-forwarded-for': '1.2.3.4',
      'content-type': 'application/json',
      connection: 'keep-alive',
    },
  }, 'http://127.0.0.1:1234', 'dsh-auth-x=1')
  assert.equal(headers.host, '127.0.0.1:1234')
  assert.equal(headers.origin, 'http://127.0.0.1:1234')
  assert.equal(headers.cookie, 'dsh-auth-x=1')
  assert.equal(headers.referer, undefined)
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers.connection, undefined)
  assert.equal(headers['content-type'], 'application/json')

  const response = downstreamResponseHeaders({
    'set-cookie': ['a=1', 'b=2'],
    'content-type': 'text/html',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    'content-encoding': 'gzip',
  })
  assert.deepEqual(response, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
})
