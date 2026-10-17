import Foundation
import UIKit
import WebKit

/// Connection state shown in the thin top bar and the offline banner.
enum BridgeConnection: String {
    case connecting
    case online
    case offline
    case revoked

    var label: String {
        switch self {
        case .connecting: return "Connecting…"
        case .online: return "Connected"
        case .offline: return "Offline"
        case .revoked: return "Unpaired"
        }
    }
}

/// Owns the visible WebView, the connection probe, and the reconnect loop.
@MainActor
final class BridgeWebModel: NSObject, ObservableObject, WKNavigationDelegate {
    let bridge: StoredBridge

    @Published private(set) var connection: BridgeConnection = .connecting
    @Published private(set) var showRecovery = false
    @Published private(set) var isLoading = true
    @Published private(set) var pageTitle: String?
    @Published private(set) var lastError: String?

    private weak var webView: WKWebView?
    private weak var store: BridgeStore?
    private let probe = HealthProbe()
    private var retryTask: Task<Void, Never>?
    private var offlineSince: Date?
    private var isChecking = false
    private var started = false
    private var ready = false
    private var needsLoad = false
    private var pageLoadFailed = false

    init(bridge: StoredBridge) {
        self.bridge = bridge
        super.init()
    }

    /// Inject the Keychain cookie, load the UI, and run the first health check.
    func start(store: BridgeStore) async {
        self.store = store
        guard !started else { return }
        started = true
        await store.injectCookie()
        ready = true
        needsLoad = true
        if let webView {
            load(in: webView)
        }
        await check(store: store, scheduleRetry: true)
    }

    func attach(_ webView: WKWebView) {
        self.webView = webView
        webView.navigationDelegate = self
        if needsLoad {
            load(in: webView)
        }
    }

    func reload() {
        guard let webView else { return }
        load(in: webView)
    }

    /// Reload and probe immediately (the offline banner's Reload action).
    func retryNow(store: BridgeStore) async {
        reload()
        await check(store: store, scheduleRetry: true)
    }

    func check(store: BridgeStore, scheduleRetry: Bool = true) async {
        // A scenePhase-active callback can arrive before start() has injected
        // the Keychain cookie; never probe before the cookie is in WebKit.
        guard ready, !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        guard let origin = bridge.url else {
            markOffline(store: store, scheduleRetry: scheduleRetry)
            return
        }
        let health = await probe.check(origin: origin)
        switch health {
        case .online:
            markOnline()
        case .offline:
            lastError = "The bridge is unreachable."
            markOffline(store: store, scheduleRetry: scheduleRetry)
        case .revoked:
            await markRevoked(store: store)
        }
    }

    func stopRetries() {
        retryTask?.cancel()
        retryTask = nil
    }

    private func load(in webView: WKWebView) {
        guard let url = bridge.url else { return }
        isLoading = true
        var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30)
        request.setValue("DSHPhone/1.0", forHTTPHeaderField: "X-DSH-Phone-Client")
        webView.load(request)
    }

    private func markOnline() {
        connection = .online
        showRecovery = false
        offlineSince = nil
        lastError = nil
        stopRetries()
        // If the page itself never loaded (host down at launch), recover it
        // now. A page that did load is left alone; its WebSocket reconnects.
        if pageLoadFailed || webView?.url == nil {
            reload()
        }
    }

    private func markOffline(store: BridgeStore, scheduleRetry: Bool) {
        if offlineSince == nil {
            offlineSince = Date()
        }
        connection = .offline
        if let since = offlineSince, Date().timeIntervalSince(since) >= 30 {
            showRecovery = true
        }
        if scheduleRetry {
            startRetry(store: store)
        }
    }

    private func markRevoked(store: BridgeStore) async {
        connection = .revoked
        stopRetries()
        await store.unpair(reason: "This phone was unpaired.")
    }

    private func startRetry(store: BridgeStore) {
        guard retryTask == nil else { return }
        retryTask = Task { @MainActor [weak self] in
            var delay: UInt64 = 1_000_000_000
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: delay)
                if Task.isCancelled { break }
                guard let self else { break }
                await self.check(store: store, scheduleRetry: false)
                if self.connection == .online || self.connection == .revoked { break }
                delay = min(delay * 2, 10_000_000_000)
            }
            self?.retryTask = nil
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" {
            if url.host == bridge.url?.host {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
            }
            return
        }
        if scheme == "mailto" || scheme == "tel" {
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
            return
        }
        if scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode == 401 {
            Task { @MainActor [weak self] in
                guard let self, let store = self.store else { return }
                await self.markRevoked(store: store)
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        pageLoadFailed = false
        pageTitle = webView.title
        if connection == .connecting {
            connection = .online
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        pageLoadFailed = true
        lastError = error.localizedDescription
        if let store {
            markOffline(store: store, scheduleRetry: true)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        isLoading = false
        pageLoadFailed = true
        lastError = error.localizedDescription
        if let store {
            markOffline(store: store, scheduleRetry: true)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        lastError = "The web content process stopped."
        if let store {
            markOffline(store: store, scheduleRetry: true)
        }
    }
}
