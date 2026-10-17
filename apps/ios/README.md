# DSH Phone — iOS app

A small SwiftUI shell that pairs with the DSH Phone Bridge and renders the **real
DeepSeek Harness web client** in a `WKWebView`. There is no native
reimplementation of sessions, tools, or approvals; the phone is a console for the
Desktop Host.

<p align="center">
  <img src="screenshots/bridgeview.png" alt="DSH Phone connected to the live DSH UI" width="390">
</p>

## Requirements

- Xcode 27+ with an iOS 17+ SDK.
- The `dsh-plugin-phone-bridge` Host plugin installed and running.
- Tailscale on both the Mac and the iPhone.
- An Apple team for device signing.

## Build and run

The generated `DSHPhone.xcodeproj` is committed. If you edit `project.yml`, run
`xcodegen generate` first.

```sh
cd apps/ios
open DSHPhone.xcodeproj
```

Set your team in **Signing & Capabilities**, choose your iPhone, and Run.

For the Simulator:

```sh
xcodebuild \
  -project DSHPhone.xcodeproj \
  -scheme DSHPhone \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro Max,OS=27.0' \
  -derivedDataPath build \
  build
```

The Simulator build uses ad-hoc signing. Do **not** disable code signing for a
real build: an unsigned app cannot save the device cookie to the Keychain.

## Pairing

1. In DSH, open **Settings → Phone**.
2. In the app, point the camera at the QR.
3. Or use **Enter code manually** / **Paste pairing link**.

The code is single-use and expires after 120 seconds. The app stores the server
origin, display name, and `dsh-phone` cookie in the Keychain and injects the
cookie into `WKWebsiteDataStore`.

The Simulator has no camera, so it shows the manual/paste fallback.

### Simulator debug seams

For automation, the Debug build accepts launch arguments:

```sh
# Pair without the iOS custom-scheme prompt.
URL="dshphone://pair?v=1&u=http%3A%2F%2F100.64.0.10%3A8787&c=CODE1234&n=Simulator"

xcrun simctl terminate booted com.adolanium.dshphone 2>/dev/null || true
xcrun simctl launch booted com.adolanium.dshphone -pairURL "$URL"

# Open the settings sheet directly.
xcrun simctl launch booted com.adolanium.dshphone -openSettings
```

## Behavior

- **PairView** — `DataScannerViewController` (QR only) where supported; manual
  and paste fallbacks on the Simulator or when camera access is unavailable.
- **BridgeView** — thin connection bar, full-screen `WKWebView`, reload, settings,
  offline banner with 1→10 s reconnect backoff and Reload/Unpair after 30 s.
- **Settings** — server origin, connection state, page title, app/iOS versions,
  Keychain cookie status, reload, unpair.
- **Revocation** — `/__session` → `401` clears the Keychain and returns to PairView.
- A page that loaded successfully is not auto-reloaded on foreground; a page that
  never loaded is reloaded when the Host returns.

## Files

| File | Role |
|---|---|
| `DSHPhoneApp.swift` | App entry and RootView |
| `PairView.swift` | Scanner/manual/paste, PairingSheet |
| `PairingWebView.swift` | Bootstrap page WKWebView and `dshphone://paired` interception |
| `PairingLink.swift` | Link parsing, code/origin normalization, bootstrap URL |
| `QRScannerView.swift` | VisionKit scanner wrapper |
| `BridgeView.swift` | Connection bar, WebView, offline banner |
| `BridgeWebModel.swift` | Navigation, health probe, reconnect loop, 401 handling |
| `BridgeWebView.swift` | WKWebView configuration and cookie store |
| `HealthProbe.swift` | Hidden `/__session` WebView |
| `BridgeStore.swift` | Keychain record, cookie injection, unpair |
| `Keychain.swift` | One generic-password item |
| `BridgeSettingsView.swift` | Server/connection/diagnostics sheet |

The app deliberately avoids `URLSession` for bridge traffic. Pairing and health
both run inside `WKWebView`s, so the only ATS exception is
`NSAllowsArbitraryLoadsInWebContent`; there is no process-wide arbitrary-loads
exception.

## Tests

```sh
xcodebuild \
  -project DSHPhone.xcodeproj \
  -scheme DSHPhone \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro Max,OS=27.0' \
  -derivedDataPath build \
  test
```

Five `PairingLink` tests cover parsing, code/origin normalization, bootstrap URL
fragments, and invalid links.

## Notes

- Target: iOS 17+, iPhone.
- Bundle id: `com.adolanium.dshphone`.
- No third-party dependencies.
- No push notifications. A running turn continues on the Desktop Host; only the
  phone’s view stops when the app backgrounds.
- Free provisioning expires after 7 days. A paid development team or AltStore /
  SideStore can re-sign automatically.
