import SwiftUI
import WebKit

/// The real DSH web client, filling the area below the thin connection bar.
struct BridgeWebView: UIViewRepresentable {
    let model: BridgeWebModel

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "DSHPhone/1.0"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = model
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.scrollView.refreshControl = nil
        webView.backgroundColor = .systemBackground
        webView.isOpaque = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        model.attach(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // The model owns navigation; SwiftUI updates need no imperative work.
    }
}
