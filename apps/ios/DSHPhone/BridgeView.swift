import SwiftUI

/// The paired console: a thin connection bar over the real DSH web client.
struct BridgeView: View {
    let bridge: StoredBridge

    @EnvironmentObject private var store: BridgeStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: BridgeWebModel
    @State private var showSettings: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-openSettings")
        #else
        return false
        #endif
    }()
    @State private var showUnpair = false

    init(bridge: StoredBridge) {
        self.bridge = bridge
        _model = StateObject(wrappedValue: BridgeWebModel(bridge: bridge))
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack(alignment: .bottom) {
                BridgeWebView(model: model)
                if model.connection == .offline {
                    offlineBanner
                }
            }
        }
        .task {
            await model.start(store: store)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await model.check(store: store) }
            case .background:
                model.stopRetries()
            default:
                break
            }
        }
        .sheet(isPresented: $showSettings) {
            BridgeSettingsView(bridge: bridge, model: model)
                .environmentObject(store)
        }
        .alert("Unpair this phone?", isPresented: $showUnpair) {
            Button("Unpair", role: .destructive) {
                Task { await store.unpair() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The saved device credential will be removed from this phone.")
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            connectionPill
            Spacer(minLength: 8)
            Button {
                model.reload()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: 34, height: 34)
            }
            .accessibilityLabel("Reload")
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: 34, height: 34)
            }
            .accessibilityLabel("Bridge settings")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.systemBackground))
        .overlay(alignment: .bottom) {
            Divider()
        }
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connectionColor)
                .frame(width: 7, height: 7)
            Text(model.connection.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(connectionColor.opacity(0.12), in: Capsule())
        .contentShape(Capsule())
        .onTapGesture {
            Task { await model.check(store: store) }
        }
        .accessibilityLabel("Connection: \(model.connection.label). Tap to check now.")
    }

    private var connectionColor: Color {
        switch model.connection {
        case .online: return .green
        case .connecting: return .orange
        case .offline: return .red
        case .revoked: return .gray
        }
    }

    private var offlineBanner: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Reconnecting…")
                    .font(.subheadline.weight(.medium))
                Spacer()
            }
            if model.showRecovery {
                HStack(spacing: 10) {
                    Button("Reload") {
                        Task { await model.retryNow(store: store) }
                    }
                    .buttonStyle(.bordered)
                    Button("Unpair") {
                        showUnpair = true
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding()
    }
}
