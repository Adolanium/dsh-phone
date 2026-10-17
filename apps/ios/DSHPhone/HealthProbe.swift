import Foundation
import WebKit

/// The three outcomes the app needs from a foreground check.
enum BridgeHealth {
    case online
    case offline
    case revoked
}

/// A hidden `WKWebView` that loads `/__session` with the saved device cookie.
///
/// This deliberately avoids `URLSession`: the bridge is plain HTTP inside
/// Tailscale, and a WebView health check needs no ATS exception beyond
/// `NSAllowsArbitraryLoadsInWebContent`.
@MainActor
final class HealthProbe: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<BridgeHealth, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var finished = false

    func check(origin: URL, timeout: TimeInterval = 3) async -> BridgeHealth {
        cancel()
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.finished = false

            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .default()
            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.navigationDelegate = self
            self.webView = webView

            guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
                finish(.offline)
                return
            }
            components.path = "/__session"
            components.query = nil
            guard let url = components.url else {
                finish(.offline)
                return
            }

            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = timeout
            webView.load(request)

            timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.finish(.offline)
            }
        }
    }

    func cancel() {
        finish(.offline)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard navigationResponse.isForMainFrame else {
            decisionHandler(.allow)
            return
        }
        if let response = navigationResponse.response as? HTTPURLResponse {
            if response.statusCode == 401 {
                finish(.revoked)
            } else if (200..<300).contains(response.statusCode) {
                finish(.online)
            } else {
                finish(.offline)
            }
        } else {
            finish(.offline)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.offline)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.offline)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.offline)
    }

    private func finish(_ health: BridgeHealth) {
        guard !finished else { return }
        finished = true
        timeoutTask?.cancel()
        timeoutTask = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
        continuation?.resume(returning: health)
        continuation = nil
    }
}
