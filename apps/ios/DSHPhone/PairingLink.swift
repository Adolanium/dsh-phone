import Foundation

/// A parsed `dshphone://pair?v=1&u=…&c=…&n=…` payload.
///
/// The origin is the listener URL the phone will load; the code is the
/// short-lived pairing secret. The Host launch token is never part of this
/// payload.
struct PairingLink: Identifiable, Equatable {
    let origin: URL
    let code: String
    let name: String

    var id: String { "\(origin.absoluteString)|\(code)" }

    init(origin: URL, code: String, name: String) {
        self.origin = origin
        self.code = code
        self.name = name
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == "dshphone",
              url.host?.lowercased() == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems else {
            return nil
        }
        let values = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        guard values["v"] == "1",
              let rawOrigin = values["u"],
              let origin = Self.normalizeOrigin(rawOrigin),
              let code = Self.normalizeCode(values["c"] ?? "") else {
            return nil
        }
        self.origin = origin
        self.code = code
        self.name = Self.sanitizeName(values["n"])
    }

    /// Build a link from manual entry.
    static func manual(origin: String, code: String, name: String) -> PairingLink? {
        guard let url = normalizeOrigin(origin), let normalized = normalizeCode(code) else {
            return nil
        }
        return PairingLink(origin: url, code: normalized, name: sanitizeName(name))
    }

    /// The bootstrap URL loaded in the pairing WKWebView. The code lives in the
    /// fragment, so the bridge never receives it in a request line.
    var bootstrapURL: URL? {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/__pair-bootstrap"
        components.query = nil
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encodedCode = code.addingPercentEncoding(withAllowedCharacters: allowed) ?? code
        let encodedName = name.addingPercentEncoding(withAllowedCharacters: allowed) ?? name
        components.percentEncodedFragment = "c=\(encodedCode)&n=\(encodedName)"
        return components.url
    }

    /// Normalize a pasted origin, defaulting to port 8787 for plain HTTP.
    static func normalizeOrigin(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let lower = text.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            text = "http://" + text
        }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host,
              !host.isEmpty else {
            return nil
        }
        if components.port == nil && scheme == "http" {
            components.port = 8787
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    /// Normalize a Crockford base32 code: upper-case, drop separators, map
    /// O→0 and I/L→1, and require exactly eight allowed characters.
    static func normalizeCode(_ raw: String) -> String? {
        let stripped = raw.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        let mapped = stripped
            .replacingOccurrences(of: "O", with: "0")
            .replacingOccurrences(of: "I", with: "1")
            .replacingOccurrences(of: "L", with: "1")
        let allowed = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        guard mapped.count == 8, mapped.allSatisfy({ allowed.contains($0) }) else {
            return nil
        }
        return mapped
    }

    /// Keep the display name printable and bounded.
    static func sanitizeName(_ value: String?) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "iPhone" : String(trimmed.prefix(64))
    }

    /// Simulator/test seam: `-pairURL <dshphone://pair?…>` on the launch
    /// arguments presents the pairing flow without the custom-scheme prompt.
    static var debugLaunchLink: PairingLink? {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-pairURL"),
              arguments.indices.contains(index + 1),
              let url = URL(string: arguments[index + 1]) else {
            return nil
        }
        return PairingLink(url: url)
        #else
        return nil
        #endif
    }
}
