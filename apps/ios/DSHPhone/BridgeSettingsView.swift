import SwiftUI
import UIKit

/// Server, connection, and app diagnostics; also the unpair path.
struct BridgeSettingsView: View {
    let bridge: StoredBridge
    @ObservedObject var model: BridgeWebModel
    @EnvironmentObject private var store: BridgeStore
    @Environment(\.dismiss) private var dismiss
    @State private var showUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Name", value: bridge.name)
                    LabeledContent("Origin", value: bridge.origin)
                        .textSelection(.enabled)
                }

                Section("Connection") {
                    LabeledContent("Status", value: model.connection.label)
                    if model.isLoading {
                        LabeledContent("Page", value: "Loading…")
                    } else if let title = model.pageTitle, !title.isEmpty {
                        LabeledContent("Page", value: title)
                    }
                    if let error = model.lastError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Diagnostics") {
                    LabeledContent("App", value: appVersion)
                    LabeledContent("iOS", value: UIDevice.current.systemVersion)
                    LabeledContent("Device cookie", value: bridge.cookie.isEmpty ? "Missing" : "Saved in Keychain")
                }

                Section {
                    Button {
                        model.reload()
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                    Button(role: .destructive) {
                        showUnpair = true
                    } label: {
                        Label("Unpair", systemImage: "iphone.slash")
                    }
                }
            }
            .navigationTitle("DSH Phone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Unpair this phone?", isPresented: $showUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    Task {
                        await store.unpair()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The saved device credential will be removed from this phone. You will need a new pairing code to reconnect.")
            }
        }
    }

    private var appVersion: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }
}
