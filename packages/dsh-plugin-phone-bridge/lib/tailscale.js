/**
 * Tailnet address discovery for the phone bridge.
 *
 * The listener must bind exactly one address inside Tailscale's CGNAT range
 * (`100.64.0.0/10`). Nothing here falls back to `0.0.0.0`, a LAN address, or
 * loopback: an address outside the tailnet is a configuration error, not a
 * reason to expose the Host somewhere else.
 *
 * Discovery order:
 *   1. `tailscale status --json` — the authoritative `Self.TailscaleIPs` and
 *      `Self.DNSName` (MagicDNS, trailing dot stripped).
 *   2. `os.networkInterfaces()` — the `utun`/Tailscale interface carries the
 *      same 100.64/10 literal, so a status call that fails or reports a stale
 *      state can still be survived.
 *
 * Everything is injectable so the package's tests never need a real tailnet.
 */
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** First address of Tailscale's CGNAT range: 100.64.0.0. */
const TAILNET_FIRST = 0x64400000
/** Last address of Tailscale's CGNAT range: 100.127.255.255. */
const TAILNET_LAST = 0x647fffff

/**
 * Whether a value is an IPv4 literal inside `100.64.0.0/10` (Tailscale's
 * shared address range). IPv6 tailnet addresses are intentionally not accepted
 * as bind addresses in this release; the listener speaks one IPv4 literal.
 * @param value - candidate address text.
 * @returns true only for a canonical, in-range IPv4 literal.
 */
export function isTailnetIPv4(value) {
  if (typeof value !== 'string') return false
  const parts = value.trim().split('.')
  if (parts.length !== 4) return false
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false
  const octets = parts.map(Number)
  if (octets.some((octet) => octet > 255)) return false
  const numeric = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  return numeric >= TAILNET_FIRST && numeric <= TAILNET_LAST
}

/**
 * Assert that a bind address is a tailnet literal, with a message that names
 * the violated invariant instead of a generic EADDRNOTAVAIL later.
 * @param address - address the listener is about to bind.
 * @returns the address, unchanged.
 * @throws when the address is outside `100.64.0.0/10`.
 */
export function assertTailnetAddress(address) {
  if (!isTailnetIPv4(address)) {
    throw new Error(`phone-bridge: refusing to bind ${JSON.stringify(address)}: not an IPv4 address in 100.64.0.0/10`)
  }
  return address
}

/**
 * Candidate Tailscale executables, most specific first. The macOS App Store
 * build keeps its CLI inside the app bundle; Windows and Linux install it on
 * PATH. `DSH_TAILSCALE_BIN` wins so a non-standard install can be pointed at
 * explicitly.
 * @param env - environment to read.
 * @param platform - `process.platform` value.
 * @returns de-duplicated executable candidates.
 */
export function tailscaleBinaries(env = process.env, platform = process.platform) {
  const candidates = []
  if (typeof env.DSH_TAILSCALE_BIN === 'string' && env.DSH_TAILSCALE_BIN.trim() !== '') {
    candidates.push(env.DSH_TAILSCALE_BIN.trim())
  }
  if (platform === 'darwin') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  } else if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    candidates.push(win32.join(programFiles, 'Tailscale', 'tailscale.exe'))
    candidates.push(win32.join(programFilesX86, 'Tailscale', 'tailscale.exe'))
  } else {
    candidates.push('/usr/bin/tailscale')
    candidates.push('/usr/local/bin/tailscale')
    candidates.push('/opt/homebrew/bin/tailscale')
  }
  candidates.push('tailscale')
  return [...new Set(candidates)]
}

/**
 * Extract the bind address and display name from one already-parsed
 * `tailscale status --json` document.
 * @param status - parsed status document.
 * @returns IPv4 tailnet address (when present), MagicDNS name without the
 *   trailing dot, backend state, and CLI version.
 */
export function parseTailscaleStatus(status) {
  const self = status !== null && typeof status === 'object' && status.Self !== null && typeof status.Self === 'object'
    ? status.Self
    : {}
  const advertised = [
    ...(Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []),
    ...(Array.isArray(status?.TailscaleIPs) ? status.TailscaleIPs : []),
  ]
  const ip = advertised.find(isTailnetIPv4)
  const dnsName = typeof self.DNSName === 'string' && self.DNSName.trim() !== ''
    ? self.DNSName.trim().replace(/\.+$/u, '')
    : undefined
  return {
    ip: typeof ip === 'string' ? ip : undefined,
    dnsName: dnsName === '' ? undefined : dnsName,
    backendState: typeof status?.BackendState === 'string' ? status.BackendState : undefined,
    version: typeof status?.Version === 'string' ? status.Version : undefined,
  }
}

/**
 * Find the first non-internal 100.64/10 IPv4 address in an interface table.
 * @param interfaces - `os.networkInterfaces()` shape.
 * @returns the address, or undefined.
 */
export function findTailnetInterface(interfaces) {
  for (const addresses of Object.values(interfaces ?? {})) {
    for (const entry of addresses ?? []) {
      const family = entry.family
      const isV4 = family === 'IPv4' || family === 4
      if (isV4 && entry.internal !== true && isTailnetIPv4(entry.address)) return entry.address
    }
  }
  return undefined
}

/**
 * Resolve the tailnet address and MagicDNS name.
 *
 * Never throws and never returns a non-tailnet address: when Tailscale is
 * absent or offline the result says so, and the caller decides whether to wait.
 * @param options - injectable dependencies for tests.
 * @returns a discovery record with `connected`, `ip`, `dnsName`, `source`, and
 *   a human-readable `error` when nothing was found.
 */
export async function resolveTailnet(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    interfaces = networkInterfaces(),
    exec = execFileAsync,
    timeoutMs = 4000,
  } = options
  const attempts = []

  for (const binary of tailscaleBinaries(env, platform)) {
    let stdout
    try {
      const result = await exec(binary, ['status', '--json'], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      })
      stdout = typeof result === 'string' ? result : result?.stdout
    } catch (error) {
      attempts.push(describeExecFailure(binary, error))
      continue
    }
    let status
    try {
      status = JSON.parse(stdout)
    } catch {
      attempts.push(`${binary}: status output was not JSON`)
      continue
    }
    const parsed = parseTailscaleStatus(status)
    if (parsed.ip !== undefined) {
      return {
        connected: true,
        ip: parsed.ip,
        dnsName: parsed.dnsName,
        backendState: parsed.backendState,
        version: parsed.version,
        source: 'tailscale-cli',
      }
    }
    attempts.push(`${binary}: Tailscale is ${parsed.backendState ?? 'not reporting'} with no 100.64.0.0/10 IPv4 address`)
  }

  const fallback = findTailnetInterface(interfaces)
  if (fallback !== undefined) {
    return {
      connected: true,
      ip: fallback,
      dnsName: undefined,
      backendState: undefined,
      version: undefined,
      source: 'network-interface',
    }
  }

  return {
    connected: false,
    error: attempts[0] ?? 'no 100.64.0.0/10 IPv4 interface and no Tailscale CLI output',
    attempts,
  }
}

/**
 * One-line, secret-free description of a failed status invocation.
 * @param binary - executable that was tried.
 * @param error - execFile rejection.
 * @returns diagnostic text safe to log.
 */
function describeExecFailure(binary, error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  if (code === 'ENOENT') return `${binary}: not found`
  if (code === 'ETIMEDOUT' || error?.killed === true) return `${binary}: timed out`
  return `${binary}: ${code ?? 'failed to run'}`
}
