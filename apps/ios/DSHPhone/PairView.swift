import AVFoundation
import SwiftUI
import UIKit
import VisionKit

/// The unpaired launch screen: camera scan, manual code, or a pasted link.
struct PairView: View {
    @EnvironmentObject private var store: BridgeStore
    @Environment(\.scenePhase) private var scenePhase
    @Binding var incomingLink: PairingLink?

    @State private var cameraStatus: CameraStatus = .checking
    @State private var isScanning = true
    @State private var showManual = false
    @State private var activeLink: PairingLink?
    @State private var errorMessage: String?

    private enum CameraStatus {
        case checking
        case granted
        case denied
        case unavailable
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    header
                    if let reason = store.lastUnpairedReason {
                        banner(reason)
                    }
                    scannerCard
                    actionButtons
                    Text("Pairing needs the listener address shown in DSH → Settings → Phone. The code is single-use and expires in two minutes.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 8)
                }
                .padding(20)
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarHidden(true)
        }
        .sheet(isPresented: $showManual) {
            ManualPairSheet { link in
                start(link)
            }
        }
        .fullScreenCover(item: $activeLink, onDismiss: { isScanning = true }) { link in
            PairingSheet(link: link) { cookie in
                handlePaired(link: link, cookie: cookie)
            }
            .environmentObject(store)
        }
        .onAppear {
            consume(incomingLink)
        }
        .onChange(of: incomingLink) { _, _ in
            consume(incomingLink)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await refreshCameraStatus() }
            }
        }
        .task {
            await refreshCameraStatus()
        }
        .alert("Pairing failed", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "iphone")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(.tint)
                .padding(14)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
            Text("DSH Phone")
                .font(.largeTitle.weight(.semibold))
            Text("Connect to your DeepSeek Harness host over Tailscale.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 12)
    }

    @ViewBuilder
    private var scannerCard: some View {
        switch cameraStatus {
        case .checking:
            placeholderCard {
                ProgressView()
                Text("Checking the camera…")
                    .foregroundStyle(.secondary)
            }
        case .granted:
            ZStack(alignment: .bottom) {
                QRScannerView(isScanning: $isScanning) { payload in
                    handlePayload(payload)
                }
                Text("Point the camera at the QR in Settings → Phone")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(.bottom, 12)
            }
            .frame(height: 310)
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.primary.opacity(0.08)))
        case .denied:
            placeholderCard {
                Image(systemName: "camera.badge.ellipsis")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                Text("Camera access is off")
                    .font(.headline)
                Text("Allow camera access to scan the QR, or use the manual code below.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(.bordered)
            }
        case .unavailable:
            placeholderCard {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 36))
                    .foregroundStyle(.secondary)
                Text("Scanning isn’t available here")
                    .font(.headline)
                Text("The Simulator has no camera. Enter the pairing code or paste the pairing link instead.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func placeholderCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 10) {
            content()
        }
        .frame(maxWidth: .infinity, minHeight: 190)
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.primary.opacity(0.06)))
    }

    private var actionButtons: some View {
        VStack(spacing: 10) {
            Button {
                showManual = true
            } label: {
                Label("Enter code manually", systemImage: "keyboard")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Button {
                pasteLink()
            } label: {
                Label("Paste pairing link", systemImage: "doc.on.clipboard")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    private func banner(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    private func pasteLink() {
        let text = (UIPasteboard.general.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            errorMessage = "The clipboard is empty. Copy a dshphone://pair link first."
            return
        }
        guard let url = URL(string: text), let link = PairingLink(url: url) else {
            errorMessage = "That clipboard text is not a DSH Phone pairing link."
            return
        }
        start(link)
    }

    private func consume(_ link: PairingLink?) {
        guard let link else { return }
        incomingLink = nil
        start(link)
    }

    private func handlePayload(_ payload: String) {
        guard let url = URL(string: payload), let link = PairingLink(url: url) else {
            errorMessage = "That QR is not a DSH Phone pairing code."
            isScanning = true
            return
        }
        start(link)
    }

    private func start(_ link: PairingLink) {
        guard activeLink == nil else { return }
        isScanning = false
        activeLink = link
    }

    private func handlePaired(link: PairingLink, cookie: HTTPCookie) {
        let bridge = StoredBridge(origin: link.origin.absoluteString, name: link.name, cookie: cookie.value)
        if !store.save(bridge) {
            errorMessage = store.saveError ?? "Could not save the pairing."
            activeLink = nil
            isScanning = true
        }
    }

    @MainActor
    private func refreshCameraStatus() async {
        guard DataScannerViewController.isSupported else {
            cameraStatus = .unavailable
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraStatus = .granted
        case .denied, .restricted:
            cameraStatus = .denied
        case .notDetermined:
            let granted = await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    continuation.resume(returning: granted)
                }
            }
            cameraStatus = granted ? .granted : .denied
        @unknown default:
            cameraStatus = .denied
        }
    }
}

/// Manual server URL + pairing code entry.
struct ManualPairSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onPair: (PairingLink) -> Void

    @State private var server = ""
    @State private var code = ""
    @State private var name = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://100.x.y.z:8787", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.URL)
                    Text("Use the listener address shown in Settings → Phone.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Server")
                }

                Section {
                    TextField("K7QM2X9R", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(.title3, design: .monospaced))
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Eight characters; spaces and hyphens are ignored.")
                }

                Section {
                    TextField("iPhone", text: $name)
                        .textInputAutocapitalization(.words)
                } header: {
                    Text("Name")
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Enter code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pair") { pair() }
                }
            }
            .onSubmit(pair)
        }
    }

    private func pair() {
        guard let link = PairingLink.manual(origin: server, code: code, name: name) else {
            error = "Enter a valid server URL and an 8-character pairing code."
            return
        }
        onPair(link)
        dismiss()
    }
}

/// Runs the bridge bootstrap page and extracts the device cookie on success.
struct PairingSheet: View {
    let link: PairingLink
    let onPaired: (HTTPCookie) -> Void

    @EnvironmentObject private var store: BridgeStore
    @Environment(\.dismiss) private var dismiss
    @State private var status: Status = .pairing
    @State private var error: String?

    private enum Status: Equatable {
        case pairing
        case finishing
        case failed
    }

    var body: some View {
        NavigationStack {
            ZStack {
                if let url = link.bootstrapURL {
                    PairingWebView(
                        url: url,
                        originHost: link.origin.host,
                        onPaired: { finish() },
                        onFailure: { message in
                            guard status == .pairing else { return }
                            status = .failed
                            error = message
                        }
                    )
                    .ignoresSafeArea(edges: .bottom)
                } else {
                    Color(.systemGroupedBackground)
                    Text("Invalid pairing link.")
                        .foregroundStyle(.secondary)
                }

                if status == .finishing {
                    overlay {
                        ProgressView()
                        Text("Finishing pairing…")
                            .font(.subheadline)
                    }
                } else if status == .failed {
                    overlay {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 28))
                            .foregroundStyle(.orange)
                        Text("Pairing failed")
                            .font(.headline)
                        Text(error ?? "The bridge did not complete the pairing.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Close") { dismiss() }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .navigationTitle("Pairing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func overlay<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 12) {
            content()
        }
        .padding(24)
        .frame(maxWidth: 280)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
        .padding()
    }

    private func finish() {
        guard status == .pairing else { return }
        status = .finishing
        Task { @MainActor in
            guard let host = link.origin.host else {
                status = .failed
                error = "The pairing link has no server host."
                return
            }
            for _ in 0..<12 {
                if let cookie = await store.readDeviceCookie(host: host) {
                    onPaired(cookie)
                    dismiss()
                    return
                }
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
            status = .failed
            error = "The bridge did not return a device cookie. Close this sheet and pair again."
        }
    }
}
