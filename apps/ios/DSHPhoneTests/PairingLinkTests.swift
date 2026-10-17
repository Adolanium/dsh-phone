import XCTest
@testable import DSHPhone

final class PairingLinkTests: XCTestCase {
    func testParsesTheQRPayload() throws {
        let url = try XCTUnwrap(URL(string: "dshphone://pair?v=1&u=http%3A%2F%2F100.64.0.10%3A8787&c=K7QM2X9R&n=Desk"))
        let link = try XCTUnwrap(PairingLink(url: url))
        XCTAssertEqual(link.origin.absoluteString, "http://100.64.0.10:8787")
        XCTAssertEqual(link.code, "K7QM2X9R")
        XCTAssertEqual(link.name, "Desk")
    }

    func testManualEntryAddsTheDefaultPortAndNormalizesTheCode() throws {
        let link = try XCTUnwrap(PairingLink.manual(origin: "100.64.0.10", code: "k7qm-2x9r", name: "My iPhone"))
        XCTAssertEqual(link.origin.absoluteString, "http://100.64.0.10:8787")
        XCTAssertEqual(link.code, "K7QM2X9R")
        XCTAssertEqual(link.name, "My iPhone")
    }

    func testCrockfordSubstitutionsAndInvalidCodes() {
        XCTAssertEqual(PairingLink.normalizeCode("O0I1L2AB"), "001112AB")
        XCTAssertNil(PairingLink.normalizeCode("ABCDEFGU"))
        XCTAssertNil(PairingLink.normalizeCode("1234"))
        XCTAssertNil(PairingLink.manual(origin: "http://host:8787", code: "bad", name: ""))
    }

    func testBootstrapURLKeepsTheCodeInTheFragment() throws {
        let link = try XCTUnwrap(PairingLink.manual(origin: "http://100.64.0.10:8787", code: "K7QM2X9R", name: "My iPhone"))
        let url = try XCTUnwrap(link.bootstrapURL)
        XCTAssertEqual(url.path, "/__pair-bootstrap")
        XCTAssertEqual(url.host, "100.64.0.10")
        XCTAssertEqual(url.port, 8787)
        XCTAssertEqual(url.fragment, "c=K7QM2X9R&n=My%20iPhone")
        XCTAssertNil(url.query)
    }

    func testRejectsForeignSchemesAndVersions() {
        XCTAssertNil(PairingLink(url: URL(string: "https://pair?v=1&u=http%3A%2F%2Fhost%3A8787&c=K7QM2X9R")!))
        XCTAssertNil(PairingLink(url: URL(string: "dshphone://pair?v=2&u=http%3A%2F%2Fhost%3A8787&c=K7QM2X9R")!))
        XCTAssertNil(PairingLink(url: URL(string: "dshphone://pair?v=1&c=K7QM2X9R")!))
    }
}
