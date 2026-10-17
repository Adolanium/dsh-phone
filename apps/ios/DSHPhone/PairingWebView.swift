import SwiftUI
import UIKit
import WebKit

/// A WKWebView that runs the bridge's `/__pair-bootstrap` page. The page POSTs
/// the code from the URL fragment and then navigates to `dshphone://paired`,
/// which this delegate intercepts before the system opens anything.
struct PairingWebView: UIViewRepresentable {
    let url: URL
    let originHost: String?
    let onPaired: () -> Void
    let onFailure: (String) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.applicationNameForUserAgent = "DSHPhone/1.0"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsLinkPreview = false
        webView.backgroundColor = .systemBackground
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // The bootstrap page loads once; no state-driven reload is needed.
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let parent: PairingWebView
        private var paired = false

        init(parent: PairingWebView) {
            self.parent = parent
        }

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
            if scheme == "dshphone" {
                decisionHandler(.cancel)
                if url.host?.lowercased() == "paired", !paired {
                    paired = true
                    parent.onPaired()
                }
                return
            }
            if scheme == "http" || scheme == "https" {
                if url.host == parent.originHost {
                    decisionHandler(.allow)
                } else {
                    decisionHandler(.cancel)
                    UIApplication.shared.open(url)
                }
                return
            }
            if scheme == "about" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.onFailure(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.onFailure(error.localizedDescription)
        }
    }
}
