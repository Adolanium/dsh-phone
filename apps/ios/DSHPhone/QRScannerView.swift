import AVFoundation
import SwiftUI
import VisionKit

/// Camera preview for QR-only scanning. On the Simulator (and any device
/// without a supported camera pipeline) the parent view shows the manual/paste
/// path instead of constructing the scanner.
struct QRScannerView: UIViewControllerRepresentable {
    @Binding var isScanning: Bool
    let onPayload: (String) -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        guard DataScannerViewController.isSupported else {
            return UIHostingController(rootView: Color.black)
        }
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {
        guard let scanner = controller as? DataScannerViewController else { return }
        if isScanning {
            context.coordinator.reset()
            try? scanner.startScanning()
        } else {
            scanner.stopScanning()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let parent: QRScannerView
        private var reported = false

        init(parent: QRScannerView) {
            self.parent = parent
        }

        func reset() {
            reported = false
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            report(from: addedItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            report(from: [item])
        }

        private func report(from items: [RecognizedItem]) {
            guard !reported else { return }
            for item in items {
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue,
                      !payload.isEmpty else {
                    continue
                }
                reported = true
                parent.isScanning = false
                parent.onPayload(payload)
                return
            }
        }
    }
}
