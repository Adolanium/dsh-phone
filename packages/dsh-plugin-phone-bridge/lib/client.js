/**
 * dsh-plugin-phone-bridge — browser half.
 *
 * Contributes the Settings → Phone page. It talks only to the loopback admin
 * routes with the `x-dsh-phone-admin: 1` header; the tailnet listener rejects
 * `/phone-bridge/*`, so this page is the only UI that can read the pairing code
 * or the device list.
 *
 * Plain JavaScript on purpose: the Host serves this file as the package's
 * `dsh.client` bundle, so it is hand-written in the module-loader factory form
 * instead of being compiled from JSX.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-phone-bridge',
  factory: (require) => {
    'use strict'

    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const jsx = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs
    const Fragment = jsxRuntime.Fragment
    const Button = primitives.Button
    const Modal = primitives.Modal
    const Pill = primitives.Pill
    const IconRefresh = primitives.IconRefreshOutlineRegular
    const IconTrash = primitives.IconTrashOutlineRegular
    const IconCopy = primitives.IconCopyOutlineRegular

    /** Locale namespace owned by this plugin. */
    const NS = 'plugin.phoneBridge'

    /** Loopback admin prefix registered by lib/routes.js. */
    const ADMIN = '/phone-bridge'

    /** Header required by every admin route. */
    const ADMIN_HEADER = 'x-dsh-phone-admin'

    const en = {
      nav: 'Phone',
      title: 'Phone Bridge',
      intro: 'Open this DeepSeek Harness Host on your iPhone over Tailscale.',
      'status.title': 'Status',
      'status.listening': 'Listening',
      'status.offline': 'Tailscale offline',
      'status.error': 'Error',
      'status.starting': 'Starting',
      'status.stopped': 'Stopped',
      'status.refresh': 'Refresh',
      'status.tailscale': 'Tailscale',
      'status.address': 'Listener',
      'status.upstream': 'Host port',
      'status.devices': 'Paired devices',
      'status.version': 'Plugin',
      'status.unknown': 'Unknown',
      'status.loading': 'Loading…',
      'status.notConnected': 'Tailscale is not connected. The bridge retries automatically.',
      'status.errorDetail': 'Last error',
      'pair.title': 'Pair a phone',
      'pair.intro': 'Open DSH Phone on your iPhone and scan this code. The code is single-use and expires in two minutes.',
      'pair.qrAlt': 'Pairing QR code',
      'pair.code': 'Pairing code',
      'pair.expires': 'Expires in {time}',
      'pair.expired': 'Code expired. Generating a new one…',
      'pair.newCode': 'New code',
      'pair.copy': 'Copy',
      'pair.copied': 'Copied',
      'pair.loading': 'Generating the pairing code…',
      'pair.unavailable': 'Pairing is unavailable until the bridge is listening and the device store is loaded.',
      'pair.qrError': 'The QR image could not be loaded. Use the code below.',
      'devices.title': 'Devices',
      'devices.empty': 'No phone has been paired yet.',
      'devices.unavailable': 'Devices are unavailable until the bridge is listening and the device store is loaded.',
      'devices.paired': 'Paired {date}',
      'devices.lastSeen': 'Last seen {date}',
      'devices.never': 'Never used',
      'devices.revoke': 'Revoke',
      'devices.revokeAll': 'Revoke all',
      'devices.confirmTitle': 'Revoke device?',
      'devices.confirmBody': '“{name}” will lose access immediately. You can pair it again with a new code.',
      'devices.confirmAllTitle': 'Revoke all devices?',
      'devices.confirmAllBody': 'Every paired phone will lose access immediately.',
      'devices.confirm': 'Revoke',
      'devices.cancel': 'Cancel',
      'devices.revoking': 'Revoking…',
      'devices.error': 'The device could not be revoked.',
      'diagnostics.title': 'Diagnostics',
      'diagnostics.summary': 'Show technical details',
      'error.status': 'Could not load the bridge status.',
      'error.rotate': 'Could not create a new pairing code.',
      'error.revoke': 'The device could not be revoked.',
    }

    const zh = {
      nav: '手机',
      title: '手机桥接',
      intro: '通过 Tailscale 在 iPhone 上打开此 DeepSeek Harness 主机。',
      'status.title': '状态',
      'status.listening': '正在监听',
      'status.offline': 'Tailscale 未连接',
      'status.error': '错误',
      'status.starting': '正在启动',
      'status.stopped': '已停止',
      'status.refresh': '刷新',
      'status.tailscale': 'Tailscale',
      'status.address': '监听地址',
      'status.upstream': '主机端口',
      'status.devices': '已配对设备',
      'status.version': '插件版本',
      'status.unknown': '未知',
      'status.loading': '正在加载…',
      'status.notConnected': 'Tailscale 未连接。桥接会自动重试。',
      'status.errorDetail': '最近错误',
      'pair.title': '配对手机',
      'pair.intro': '在 iPhone 上打开 DSH Phone 并扫描此二维码。配对码仅可使用一次，两分钟后过期。',
      'pair.qrAlt': '配对二维码',
      'pair.code': '配对码',
      'pair.expires': '{time} 后过期',
      'pair.expired': '配对码已过期，正在生成新的…',
      'pair.newCode': '新配对码',
      'pair.copy': '复制',
      'pair.copied': '已复制',
      'pair.loading': '正在生成配对码…',
      'pair.unavailable': '桥接正在监听且设备存储加载完成前无法配对。',
      'pair.qrError': '无法加载二维码图片，请使用下方的配对码。',
      'devices.title': '设备',
      'devices.empty': '尚未配对任何手机。',
      'devices.unavailable': '桥接正在监听且设备存储加载完成前，设备列表不可用。',
      'devices.paired': '配对时间 {date}',
      'devices.lastSeen': '最近活动 {date}',
      'devices.never': '从未使用',
      'devices.revoke': '撤销',
      'devices.revokeAll': '全部撤销',
      'devices.confirmTitle': '撤销设备？',
      'devices.confirmBody': '“{name}”将立即失去访问权限。你可以使用新的配对码重新配对。',
      'devices.confirmAllTitle': '撤销全部设备？',
      'devices.confirmAllBody': '所有已配对的手机将立即失去访问权限。',
      'devices.confirm': '撤销',
      'devices.cancel': '取消',
      'devices.revoking': '正在撤销…',
      'devices.error': '无法撤销该设备。',
      'diagnostics.title': '诊断',
      'diagnostics.summary': '显示技术详情',
      'error.status': '无法加载桥接状态。',
      'error.rotate': '无法生成新的配对码。',
      'error.revoke': '无法撤销该设备。',
    }

    const styles = {
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        maxWidth: 720,
        paddingBottom: 24,
      },
      heading: {
        margin: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 20,
        fontWeight: 600,
        lineHeight: 1.3,
      },
      intro: {
        margin: '6px 0 0',
        color: 'var(--dsw-alias-label-secondary, #777)',
        fontSize: 14,
        lineHeight: 1.5,
      },
      card: {
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        padding: 16,
      },
      cardHeader: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 10,
      },
      cardTitle: {
        margin: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 15,
        fontWeight: 600,
        lineHeight: 1.4,
      },
      cardDescription: {
        margin: '2px 0 0',
        color: 'var(--dsw-alias-label-secondary, #777)',
        fontSize: 13,
        lineHeight: 1.5,
      },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        padding: '7px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.18))',
        fontSize: 13,
        lineHeight: 1.5,
      },
      label: {
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary, #777)',
      },
      value: {
        minWidth: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        textAlign: 'right',
        overflowWrap: 'anywhere',
      },
      secondary: {
        color: 'var(--dsw-alias-label-secondary, #777)',
        fontSize: 13,
        lineHeight: 1.5,
      },
      error: {
        border: '0.5px solid color-mix(in srgb, #d14343 35%, transparent)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'color-mix(in srgb, #d14343 9%, transparent)',
        color: '#d14343',
        padding: '10px 12px',
        fontSize: 13,
        lineHeight: 1.5,
      },
      statusLine: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      qrFrame: {
        boxSizing: 'border-box',
        flex: '0 0 auto',
        width: 280,
        height: 280,
        padding: 12,
        borderRadius: 12,
        boxShadow: '0 0 0 0.5px var(--dsw-alias-border-secondary, rgba(127,127,127,.25))',
        background: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      },
      qrImage: {
        display: 'block',
        width: 256,
        height: 256,
      },
      pairBody: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 20,
        flexWrap: 'wrap',
      },
      pairInfo: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 8,
        flex: '1 1 220px',
        minWidth: 210,
      },
      codeRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      code: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 24,
        fontWeight: 600,
        letterSpacing: '0.18em',
        lineHeight: 1.2,
      },
      mutedLabel: {
        color: 'var(--dsw-alias-label-secondary, #777)',
        fontSize: 12,
        lineHeight: 1.4,
      },
      deviceRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.18))',
      },
      deviceName: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 14,
        fontWeight: 500,
        lineHeight: 1.4,
      },
      diagnostics: {
        border: '0.5px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        padding: '12px 16px',
      },
      summary: {
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #777)',
        fontSize: 13,
        lineHeight: 1.5,
        userSelect: 'none',
      },
      pre: {
        margin: '10px 0 0',
        padding: 10,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
        color: 'var(--dsw-alias-label-secondary, #777)',
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: 240,
        overflow: 'auto',
      },
    }

    /**
     * Fetch one admin route with the required header.
     * @param path - admin path.
     * @param init - fetch options.
     * @returns the Response.
     */
    async function adminFetch(path, init) {
      const options = init === undefined ? {} : init
      const headers = Object.assign({}, options.headers, { [ADMIN_HEADER]: '1' })
      return fetch(path, Object.assign({}, options, {
        headers,
        cache: 'no-store',
        credentials: 'same-origin',
      }))
    }

    /**
     * Fetch and parse one admin JSON route.
     * @param path - admin path.
     * @param init - fetch options.
     * @returns the parsed body.
     */
    async function adminJson(path, init) {
      const response = await adminFetch(path, init)
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const message = body !== undefined && typeof body === 'object'
          ? (body.message || body.code)
          : undefined
        const error = new Error(typeof message === 'string' && message !== '' ? message : `HTTP ${String(response.status)}`)
        error.code = body !== undefined && typeof body === 'object' ? body.code : undefined
        error.status = response.status
        throw error
      }
      return body
    }

    /** Format a timestamp for the device list. */
    function formatDate(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    /** Format a remaining lifetime as m:ss. */
    function formatCountdown(milliseconds) {
      const total = Math.max(0, Math.ceil(Number(milliseconds) / 1000))
      return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
    }

    /** Map a classified admin failure to a localized sentence. */
    function friendlyError(error, t) {
      if (error === undefined || error === null) return t('error.status')
      if (error.code === 'store-unavailable' || error.code === 'store-write-failed' || error.code === 'pairing-unavailable') {
        return t('pair.unavailable')
      }
      if (error.code === 'listener-offline') return t('status.notConnected')
      if (error.code === 'missing-admin-header' || error.code === 'forbidden-origin' || error.code === 'forbidden-host') {
        return t('error.status')
      }
      return typeof error.message === 'string' && error.message !== '' ? error.message : t('error.status')
    }

    /** A settings card with a title, optional description, and header action. */
    function Card({ title, description, action, children }) {
      return jsxs('section', {
        style: styles.card,
        children: [
          jsxs('div', {
            style: styles.cardHeader,
            children: [
              jsxs('div', {
                style: { minWidth: 0 },
                children: [
                  jsx('h3', { style: styles.cardTitle, children: title }),
                  description === undefined || description === null
                    ? null
                    : jsx('p', { style: styles.cardDescription, children: description }),
                ],
              }),
              action === undefined || action === null ? null : action,
            ],
          }),
          children,
        ],
      })
    }

    /** One label/value line in the status card. */
    function StatusRow({ label, value }) {
      return jsxs('div', {
        style: styles.row,
        children: [
          jsx('span', { style: styles.label, children: label }),
          jsx('span', { style: styles.value, children: value }),
        ],
      })
    }

    /** Connection state pill with a colored dot. */
    function StatusPill({ state, t }) {
      const color = state === 'listening'
        ? '#1f9d55'
        : state === 'offline'
          ? '#b7791f'
          : state === 'error'
            ? '#d14343'
            : '#8a8a8a'
      return jsx(Pill, {
        children: jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 6 },
          children: [
            jsx('span', {
              style: {
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: color,
              },
            }),
            jsx('span', { children: t(`status.${state}`) }),
          ],
        }),
      })
    }

    /** Confirmation modal for one device or all devices. */
    function RevokeDialog({ request, busy, t, onCancel, onConfirm }) {
      if (request === null) return null
      const all = request.kind === 'all'
      const title = all ? t('devices.confirmAllTitle') : t('devices.confirmTitle')
      const body = all
        ? t('devices.confirmAllBody')
        : t('devices.confirmBody', { name: request.device.name })
      const footer = jsxs(Fragment, {
        children: [
          jsx(Button, {
            variant: 'outline',
            disabled: busy,
            onClick: onCancel,
            children: t('devices.cancel'),
          }),
          jsx(Button, {
            variant: 'primary',
            disabled: busy,
            onClick: onConfirm,
            children: busy ? t('devices.revoking') : t('devices.confirm'),
          }),
        ],
      })
      return jsx(Modal, {
        open: true,
        onClose: busy ? () => {} : onCancel,
        closeLabel: t('devices.cancel'),
        title,
        footer,
        children: jsx('p', { style: { margin: 0, fontSize: 14, lineHeight: 1.6 }, children: body }),
      })
    }

    /** Settings → Phone. */
    function PhoneSection({ t }) {
      const tr = typeof t === 'function' ? t : (key) => key
      const [status, setStatus] = React.useState(null)
      const [devices, setDevices] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [qrSrc, setQrSrc] = React.useState(null)
      const [qrError, setQrError] = React.useState(false)
      const [revoke, setRevoke] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      const inFlight = React.useRef(false)

      const refresh = React.useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
          const next = await adminJson(`${ADMIN}/status`)
          setStatus(next)
          setError(null)
          if (next !== null && typeof next === 'object' && next.auth !== undefined && next.auth.ready === true) {
            try {
              const list = await adminJson(`${ADMIN}/devices`)
              setDevices(Array.isArray(list.devices) ? list.devices : [])
            } catch {
              // The status card remains useful even if the device list fails.
            }
          } else {
            setDevices([])
          }
        } catch (failure) {
          setError(failure)
        } finally {
          inFlight.current = false
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        let stopped = false
        const tick = () => {
          if (!stopped) void refresh()
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [refresh])

      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      const auth = status !== null && typeof status === 'object' ? status.auth : undefined
      const pairing = auth !== undefined && auth !== null ? auth.pairing : undefined
      const pairingCode = pairing !== undefined && pairing !== null ? pairing.code : undefined
      const expiresAt = pairing !== undefined && pairing !== null && typeof pairing.expiresAt === 'string'
        ? Date.parse(pairing.expiresAt)
        : Number.NaN
      const remaining = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0
      const state = status !== null && typeof status === 'object' && typeof status.state === 'string'
        ? status.state
        : 'starting'
      const listener = status !== null && typeof status === 'object' ? status.listener : undefined
      const tailnet = status !== null && typeof status === 'object' ? status.tailnet : undefined

      React.useEffect(() => {
        let cancelled = false
        setQrError(false)
        if (typeof pairingCode !== 'string' || pairingCode === '') {
          setQrSrc(null)
          return () => {
            cancelled = true
          }
        }
        void (async () => {
          try {
            const response = await adminFetch(`${ADMIN}/qr.svg`)
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
            const svg = await response.text()
            if (cancelled) return
            setQrSrc(`data:image/svg+xml;base64,${btoa(svg)}`)
          } catch {
            if (cancelled) return
            setQrSrc(null)
            setQrError(true)
          }
        })()
        return () => {
          cancelled = true
        }
      }, [pairingCode])

      const rotate = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const result = await adminJson(`${ADMIN}/rotate`, { method: 'POST' })
          if (result !== null && typeof result === 'object' && result.pairing !== undefined) {
            setStatus((previous) => {
              if (previous === null || typeof previous !== 'object') return previous
              return Object.assign({}, previous, {
                auth: Object.assign({}, previous.auth, { pairing: result.pairing }),
              })
            })
          }
          await refresh()
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy(false)
        }
      }

      const confirmRevoke = async () => {
        if (busy || revoke === null) return
        setBusy(true)
        setError(null)
        try {
          const body = revoke.kind === 'all' ? { all: true } : { id: revoke.device.id }
          await adminJson(`${ADMIN}/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          setRevoke(null)
          await refresh()
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy(false)
        }
      }

      const copyCode = async () => {
        if (typeof pairingCode !== 'string' || pairingCode === '') return
        try {
          await navigator.clipboard.writeText(pairingCode)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // Clipboard access is optional.
        }
      }

      const statusMessage = error !== null
        ? friendlyError(error, tr)
        : status !== null && state !== 'listening'
          ? state === 'offline'
            ? tr('status.notConnected')
            : state === 'error' && status.lastError !== undefined && status.lastError !== null
              ? status.lastError.message || tr('error.status')
              : undefined
          : undefined

      const tailscaleText = tailnet === undefined || tailnet === null
        ? tr('status.unknown')
        : typeof tailnet.dnsName === 'string' && tailnet.dnsName !== ''
          ? `${tailnet.dnsName} (${tailnet.ip})`
          : tailnet.ip
      const listenerText = listener === undefined || listener === null
        ? '—'
        : `${listener.address}:${String(listener.port)}`
      const upstreamPort = status !== null && status.traffic !== undefined && status.traffic !== null && status.traffic.upstream !== undefined
        ? status.traffic.upstream.upstreamPort
        : undefined
      const deviceCount = auth !== undefined && auth !== null ? auth.deviceCount : 0
      const deviceListReady = auth !== undefined && auth !== null && auth.ready === true
      const canPair = status !== null && state === 'listening' && deviceListReady && typeof pairingCode === 'string' && pairingCode !== ''
      const pairUnavailable = state === 'offline'
        ? tr('status.notConnected')
        : state === 'starting'
          ? tr('pair.loading')
          : tr('pair.unavailable')
      const devicesUnavailable = state === 'offline'
        ? tr('status.notConnected')
        : state === 'starting'
          ? tr('pair.loading')
          : tr('devices.unavailable')

      let diagnosticsText = ''
      if (status !== null && typeof status === 'object') {
        diagnosticsText = JSON.stringify({
          version: status.version,
          state: status.state,
          tailnet: status.tailnet,
          listener: status.listener,
          deviceCount: auth !== undefined && auth !== null ? auth.deviceCount : undefined,
          upstreamPort,
          traffic: status.traffic === undefined || status.traffic === null
            ? undefined
            : {
                requests: status.traffic.requests,
                errors: status.traffic.errors,
                upstream401s: status.traffic.upstream401s,
                reauths: status.traffic.reauths,
              },
          lastError: status.lastError,
          recent: Array.isArray(status.recent)
            ? status.recent.slice(-10).map((entry) => ({ at: entry.at, event: entry.event, code: entry.code }))
            : [],
        }, null, 2)
      }

      const statusCard = jsx(Card, {
        title: tr('status.title'),
        action: jsxs('div', {
          style: styles.statusLine,
          children: [
            jsx(StatusPill, { state, t: tr }),
            jsx(Button, {
              variant: 'ghost',
              size: 'sm',
              icon: jsx(IconRefresh, { size: 14 }),
              disabled: busy,
              onClick: () => { void refresh() },
              children: tr('status.refresh'),
            }),
          ],
        }),
        children: loading && status === null
          ? jsx('p', { style: styles.secondary, children: tr('status.loading') })
          : jsxs(Fragment, {
              children: [
                jsx(StatusRow, { label: tr('status.tailscale'), value: tailscaleText }),
                jsx(StatusRow, { label: tr('status.address'), value: listenerText }),
                jsx(StatusRow, { label: tr('status.upstream'), value: upstreamPort === undefined ? '—' : String(upstreamPort) }),
                jsx(StatusRow, { label: tr('status.devices'), value: String(deviceCount) }),
                jsx(StatusRow, { label: tr('status.version'), value: status !== null && status.version !== undefined ? String(status.version) : '—' }),
                status !== null && status.lastError !== undefined && status.lastError !== null
                  ? jsx(StatusRow, { label: tr('status.errorDetail'), value: status.lastError.message || status.lastError.code || '—' })
                  : null,
              ],
            }),
      })

      const pairCard = jsx(Card, {
        title: tr('pair.title'),
        description: tr('pair.intro'),
        action: jsx(Button, {
          variant: 'primary',
          size: 'sm',
          icon: jsx(IconRefresh, { size: 14 }),
          disabled: busy || !canPair,
          style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
          onClick: () => { void rotate() },
          children: tr('pair.newCode'),
        }),
        children: status === null
          ? jsx('p', { style: styles.secondary, children: loading ? tr('pair.loading') : tr('pair.unavailable') })
          : !canPair
            ? jsx('p', { style: styles.secondary, children: pairUnavailable })
            : jsxs('div', {
                style: styles.pairBody,
                children: [
                  jsx('div', {
                    style: styles.qrFrame,
                    children: qrError
                      ? jsx('span', { style: { color: '#777', fontSize: 12, textAlign: 'center' }, children: tr('pair.qrError') })
                      : qrSrc !== null
                        ? jsx('img', { src: qrSrc, alt: tr('pair.qrAlt'), width: 256, height: 256, style: styles.qrImage })
                        : jsx('span', { style: { color: '#777', fontSize: 12 }, children: tr('pair.loading') }),
                  }),
                  jsxs('div', {
                    style: styles.pairInfo,
                    children: [
                      jsx('div', { style: styles.mutedLabel, children: tr('pair.code') }),
                      jsxs('div', {
                        style: styles.codeRow,
                        children: [
                          jsx('code', { style: styles.code, children: pairingCode }),
                          jsx(Button, {
                            variant: 'ghost',
                            size: 'sm',
                            icon: jsx(IconCopy, { size: 14 }),
                            onClick: () => { void copyCode() },
                            children: copied ? tr('pair.copied') : tr('pair.copy'),
                          }),
                        ],
                      }),
                      jsx('div', {
                        style: styles.secondary,
                        role: 'status',
                        children: remaining <= 0 ? tr('pair.expired') : tr('pair.expires', { time: formatCountdown(remaining) }),
                      }),
                    ],
                  }),
                ],
              }),
      })

      const devicesCard = jsx(Card, {
        title: tr('devices.title'),
        action: devices.length > 0
          ? jsx(Button, {
              variant: 'outline',
              size: 'sm',
              icon: jsx(IconTrash, { size: 14 }),
              disabled: busy,
              style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
              onClick: () => setRevoke({ kind: 'all' }),
              children: tr('devices.revokeAll'),
            })
          : null,
        children: !deviceListReady
          ? jsx('p', { style: styles.secondary, children: devicesUnavailable })
          : devices.length === 0
            ? jsx('p', { style: styles.secondary, children: tr('devices.empty') })
            : jsx('div', {
                children: devices.map((device) => {
                  const paired = formatDate(device.createdAt)
                  const seen = device.lastSeenAt === undefined || device.lastSeenAt === null || device.lastSeenAt === ''
                    ? tr('devices.never')
                    : tr('devices.lastSeen', { date: formatDate(device.lastSeenAt) })
                  return jsxs('div', {
                    style: styles.deviceRow,
                    children: [
                      jsxs('div', {
                        style: { minWidth: 0 },
                        children: [
                          jsx('div', { style: styles.deviceName, children: device.name }),
                          jsx('div', {
                            style: styles.secondary,
                            children: `${tr('devices.paired', { date: paired })} · ${seen}`,
                          }),
                        ],
                      }),
                      jsx(Button, {
                        variant: 'ghost',
                        size: 'sm',
                        icon: jsx(IconTrash, { size: 14 }),
                        disabled: busy,
                        onClick: () => setRevoke({ kind: 'device', device }),
                        children: tr('devices.revoke'),
                      }),
                    ],
                  })
                }),
              }),
      })

      return jsxs('div', {
        style: styles.section,
        children: [
          jsxs('header', {
            children: [
              jsx('h2', { style: styles.heading, children: tr('title') }),
              jsx('p', { style: styles.intro, children: tr('intro') }),
            ],
          }),
          statusMessage === undefined ? null : jsx('div', { style: styles.error, role: 'alert', children: statusMessage }),
          statusCard,
          pairCard,
          devicesCard,
          jsxs('details', {
            style: styles.diagnostics,
            children: [
              jsx('summary', { style: styles.summary, children: tr('diagnostics.summary') }),
              jsx('pre', { style: styles.pre, children: diagnosticsText }),
            ],
          }),
          jsx(RevokeDialog, {
            request: revoke,
            busy,
            t: tr,
            onCancel: () => setRevoke(null),
            onConfirm: () => { void confirmRevoke() },
          }),
        ],
      })
    }

    /** Required browser services. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the Settings → Phone section.
     * @param ctx - browser Cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'phone-bridge: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'phone',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, PhoneSection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.internals = {
      formatCountdown,
      friendlyError,
    }
    return module.exports
  },
})
