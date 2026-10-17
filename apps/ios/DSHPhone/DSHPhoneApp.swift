import SwiftUI

@main
struct DSHPhoneApp: App {
    @StateObject private var store = BridgeStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}

/// Paired → the real DSH UI; unpaired → the scanner/manual pairing flow.
struct RootView: View {
    @EnvironmentObject private var store: BridgeStore
    @State private var incomingLink: PairingLink? = PairingLink.debugLaunchLink

    var body: some View {
        Group {
            if let bridge = store.bridge {
                BridgeView(bridge: bridge)
                    .id(bridge.origin)
            } else {
                PairView(incomingLink: $incomingLink)
            }
        }
        .onOpenURL { url in
            guard store.bridge == nil, let link = PairingLink(url: url) else {
                return
            }
            incomingLink = link
        }
    }
}
