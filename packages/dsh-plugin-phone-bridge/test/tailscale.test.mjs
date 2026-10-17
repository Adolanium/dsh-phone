import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertTailnetAddress,
  findTailnetInterface,
  isTailnetIPv4,
  parseTailscaleStatus,
  resolveTailnet,
  tailscaleBinaries,
} from '../lib/tailscale.js'

test('isTailnetIPv4 accepts only 100.64.0.0/10', () => {
  assert.equal(isTailnetIPv4('100.64.0.0'), true)
  assert.equal(isTailnetIPv4('100.64.0.10'), true)
  assert.equal(isTailnetIPv4('100.127.255.255'), true)
  assert.equal(isTailnetIPv4('100.63.255.255'), false)
  assert.equal(isTailnetIPv4('100.128.0.0'), false)
  assert.equal(isTailnetIPv4('10.0.0.1'), false)
  assert.equal(isTailnetIPv4('127.0.0.1'), false)
  assert.equal(isTailnetIPv4('100.64.1'), false)
  assert.equal(isTailnetIPv4('100.64.1.2.3'), false)
  assert.equal(isTailnetIPv4('100.64.1.256'), false)
  assert.equal(isTailnetIPv4(undefined), false)
})

test('assertTailnetAddress refuses anything outside the range', () => {
  assert.equal(assertTailnetAddress('100.64.0.10'), '100.64.0.10')
  assert.throws(() => assertTailnetAddress('0.0.0.0'), /refusing to bind/)
  assert.throws(() => assertTailnetAddress('192.168.1.10'), /100\.64\.0\.0\/10/)
})

test('parseTailscaleStatus prefers the IPv4 tailnet address and trims the MagicDNS dot', () => {
  const parsed = parseTailscaleStatus({
    BackendState: 'Running',
    Version: '1.102.3',
    Self: {
      DNSName: 'desk.tail-example.ts.net.',
      TailscaleIPs: ['fd7a:115c:a1e0::1', '100.64.0.10'],
    },
  })
  assert.deepEqual(parsed, {
    ip: '100.64.0.10',
    dnsName: 'desk.tail-example.ts.net',
    backendState: 'Running',
    version: '1.102.3',
  })
})

test('parseTailscaleStatus tolerates a stopped backend', () => {
  assert.deepEqual(parseTailscaleStatus({ BackendState: 'Stopped', Self: {} }), {
    ip: undefined,
    dnsName: undefined,
    backendState: 'Stopped',
    version: undefined,
  })
  assert.deepEqual(parseTailscaleStatus(null), {
    ip: undefined,
    dnsName: undefined,
    backendState: undefined,
    version: undefined,
  })
})

test('resolveTailnet reads the CLI first', async () => {
  const calls = []
  const result = await resolveTailnet({
    env: { DSH_TAILSCALE_BIN: '/fake/tailscale' },
    platform: 'linux',
    interfaces: { utun6: [{ family: 'IPv4', address: '100.64.9.9', internal: false }] },
    exec: async (binary, args, options) => {
      calls.push({ binary, args, options })
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Version: '1.102.3',
          Self: { DNSName: 'desk.tail.ts.net.', TailscaleIPs: ['100.64.0.10'] },
        }),
        stderr: '',
      }
    },
  })
  assert.equal(result.connected, true)
  assert.equal(result.ip, '100.64.0.10')
  assert.equal(result.dnsName, 'desk.tail.ts.net')
  assert.equal(result.source, 'tailscale-cli')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binary, '/fake/tailscale')
  assert.deepEqual(calls[0].args, ['status', '--json'])
  assert.equal(calls[0].options.timeout, 4000)
})

test('resolveTailnet falls back to the tailnet interface', async () => {
  const result = await resolveTailnet({
    env: {},
    platform: 'linux',
    interfaces: {
      en0: [{ family: 'IPv4', address: '10.100.102.4', internal: false }],
      utun6: [{ family: 'IPv4', address: '100.64.0.10', internal: false }],
    },
    exec: async () => {
      const error = new Error('spawn tailscale ENOENT')
      error.code = 'ENOENT'
      throw error
    },
  })
  assert.equal(result.connected, true)
  assert.equal(result.ip, '100.64.0.10')
  assert.equal(result.source, 'network-interface')
})

test('resolveTailnet reports offline when neither source has a tailnet address', async () => {
  const result = await resolveTailnet({
    env: {},
    platform: 'linux',
    interfaces: { en0: [{ family: 'IPv4', address: '10.100.102.4', internal: false }] },
    exec: async () => {
      const error = new Error('spawn tailscale ENOENT')
      error.code = 'ENOENT'
      throw error
    },
  })
  assert.equal(result.connected, false)
  assert.match(result.error, /not found/)
  assert.ok(Array.isArray(result.attempts))
})

test('findTailnetInterface ignores internal and non-tailnet addresses', () => {
  assert.equal(findTailnetInterface({
    lo0: [{ family: 'IPv4', address: '100.64.1.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.2', internal: false }],
  }), undefined)
  assert.equal(findTailnetInterface({
    utun: [{ family: 4, address: '100.64.1.1', internal: false }],
  }), '100.64.1.1')
})

test('tailscaleBinaries puts the explicit override first and includes the macOS app CLI', () => {
  const darwin = tailscaleBinaries({ DSH_TAILSCALE_BIN: '/opt/custom/tailscale' }, 'darwin')
  assert.equal(darwin[0], '/opt/custom/tailscale')
  assert.ok(darwin.includes('/Applications/Tailscale.app/Contents/MacOS/Tailscale'))
  assert.equal(darwin.at(-1), 'tailscale')
  const windows = tailscaleBinaries({ ProgramFiles: 'C:\\PF' }, 'win32')
  assert.ok(windows.includes('C:\\PF\\Tailscale\\tailscale.exe'))
})
