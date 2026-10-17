# dsh-plugin-phone-bridge

Host and browser halves of **DSH Phone Bridge**. The Host opens exactly one
listener on this machine's Tailscale address and reverse-proxies HTTP and
WebSocket traffic into the **running** DeepSeek Harness Desktop Host's loopback
web server. The browser half contributes **Settings → Phone**.

The iPhone app lives in [`apps/ios`](../../apps/ios/README.md).

## Install

From the repo root:

```sh
sh scripts/install-dev.sh
```

This links the package into `~/.dsh/profiles/desktop/node_modules` and adds the
Loader entry. Restart DeepSeek Harness when no turn or job is running. Open
**Settings → Phone** to pair a phone.

Set `DSH_PHONE_BRIDGE_LOG=1` in the Host environment to mirror structured JSON
logs to stderr.

## Configuration

```yaml
- id: phone-bridge
  name: dsh-plugin-phone-bridge
  config:
    port: 8787
    retryMs: 15000
    # bindAddress: 100.64.0.10   # must be in 100.64.0.0/10
    # storePath: /custom/phone-bridge.json
    # dshHome: /custom/.dsh
```

`port` defaults to `8787`. `bindAddress` must resolve to an IPv4 address inside
Tailscale's `100.64.0.0/10` range; the plugin fails closed otherwise. The device
store defaults to `~/.dsh/storages/phone-bridge.json`, mode `0600`, hashes only.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /__health` | none (tailnet only) | secret-free host/version, 1 req/s/source |
| `POST /__pair` | pairing code | `204` + one-year `dsh-phone` cookie |
| `GET /__pair-bootstrap` | none (tailnet only) | page that POSTs the code from its URL fragment |
| `GET /__session` | device cookie | `200` live / `401` missing or revoked |
| everything else | device cookie | proxied to the Host |
| `/phone-bridge/status`, `devices`, `qr.svg`, `rotate`, `revoke` | loopback + admin header | Settings backend |

Admin routes require `x-dsh-phone-admin: 1`, a loopback source, and a known
Origin; they emit no CORS headers. `qr.svg` renders the versioned
`dshphone://pair?…` payload. Revoking a device also destroys every upgraded
WebSocket it owns.

## Security

- The listener binds one asserted `100.64.0.0/10` literal. No wildcard, LAN, or
  loopback fallback.
- The Host launch token never enters a log, status object, HTTP response, QR, or
  store.
- The Host cookie is minted in-process, injected only upstream, and every
  upstream `Set-Cookie` is stripped.
- Device tokens are 32 random bytes; the store keeps SHA-256 hashes only.
- Pairing codes are 8 Crockford base32 characters, valid for 120 s, single use,
  hashed in memory with a random salt, and rate-limited (five failures per
  minute per source, 15-minute lockout).
- `/__pair-bootstrap` keeps the pairing code in the URL fragment. The app posts
  it to `/__pair`; the code is not in a request line or log.
- `/__health`, `/__pair`, and `/__pair-bootstrap` are the only unauthenticated
  tailnet endpoints. `/phone-bridge/*` returns `404` on the tailnet listener.

## Tests

```sh
node --test
```

The 80-test suite covers proxy headers, cookie minting and invalidation, 401
replay, WebSocket upgrades, per-device socket eviction, half-open teardown,
revoke-during-handshake, the device gate, pairing lifecycle and lockout, the
store, admin guards, QR payload/SVG, bootstrap/session, and client registration.
It uses a mock upstream and needs no tailnet.

## License

MIT © [Adolanium](https://github.com/Adolanium)
