import Foundation
import WebKit

/// The saved bridge record. The cookie is the phone's device credential; it is
/// stored in the Keychain, never in UserDefaults.
struct StoredBridge: Codable, Equatable, Identifiable {
    let origin: String
    let name: String
    let cookie: String

    var id: String { origin }

    var url: URL? { URL(string: origin) }

    var host: String? { url?.host }
}

/// App-wide bridge state: Keychain-backed pairing plus the WebKit cookie store.
@MainActor
final class BridgeStore: ObservableObject {
    @Published private(set) var bridge: StoredBridge?
    @Published var lastUnpairedReason: String?
    @Published var saveError: String?

    init() {
        if let data = Keychain.load(),
           let decoded = try? JSONDecoder().decode(StoredBridge.self, from: data),
           URL(string: decoded.origin) != nil {
            bridge = decoded
        }
    }

    /// Persist a new pairing and switch the root view.
    @discardableResult
    func save(_ newBridge: StoredBridge) -> Bool {
        do {
            let data = try JSONEncoder().encode(newBridge)
            guard Keychain.save(data) else {
                saveError = "Could not save the pairing to the Keychain."
                return false
            }
            bridge = newBridge
            lastUnpairedReason = nil
            saveError = nil
            return true
        } catch {
            saveError = "Could not encode the pairing."
            return false
        }
    }

    /// Forget the pairing and remove the WebView data, including the cookie.
    func unpair(reason: String? = nil) async {
        bridge = nil
        Keychain.delete()
        lastUnpairedReason = reason
        await clearWebData()
    }

    /// Restore the Keychain cookie into WebKit when WebKit has none (for example
    /// after an app reinstall with a surviving Keychain item).
    func injectCookie(into dataStore: WKWebsiteDataStore = .default()) async {
        guard let bridge, let host = bridge.host, !host.isEmpty, !bridge.cookie.isEmpty else {
            return
        }
        let existing = await allCookies(in: dataStore)
        if existing.contains(where: { $0.name == "dsh-phone" && ($0.domain == host || $0.domain == ".\(host)") }) {
            return
        }
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: "dsh-phone",
            .value: bridge.cookie,
            .path: "/",
            .domain: host,
            .secure: "FALSE",
        ]
        properties[.expires] = Date().addingTimeInterval(365 * 24 * 60 * 60)
        guard let cookie = HTTPCookie(properties: properties) else { return }
        await setCookie(cookie, in: dataStore)
    }

    /// The `dsh-phone` cookie for one origin host, if WebKit has it.
    func readDeviceCookie(host: String, dataStore: WKWebsiteDataStore = .default()) async -> HTTPCookie? {
        let cookies = await allCookies(in: dataStore)
        return cookies.first {
            $0.name == "dsh-phone" && ($0.domain == host || $0.domain == ".\(host)")
        }
    }

    /// Clear every WebView cookie and cache owned by the app.
    func clearWebData() async {
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        await withCheckedContinuation { continuation in
            store.removeData(ofTypes: types, modifiedSince: .distantPast) {
                continuation.resume()
            }
        }
    }

    private func allCookies(in dataStore: WKWebsiteDataStore) async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            dataStore.httpCookieStore.getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
    }

    private func setCookie(_ cookie: HTTPCookie, in dataStore: WKWebsiteDataStore) async {
        await withCheckedContinuation { continuation in
            dataStore.httpCookieStore.setCookie(cookie) {
                continuation.resume()
            }
        }
    }
}
