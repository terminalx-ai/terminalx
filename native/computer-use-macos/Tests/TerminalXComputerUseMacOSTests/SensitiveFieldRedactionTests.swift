import XCTest
@testable import TerminalXComputerUseMacOSCore

final class SensitiveFieldRedactionTests: XCTestCase {
    func testSensitiveMetadataClassificationCoversSecureRolesAndKeywords() {
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXSecureTextField"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", title: "Master Password"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", description: "Enter passcode"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", placeholder: "6-digit verification code"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", placeholder: "One-time code"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", identifier: "api_secret_input"))
        XCTAssertTrue(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", title: "Enter PIN"))
        XCTAssertFalse(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", title: "Shipping address"))
        XCTAssertFalse(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", title: "Search repositories"))
        XCTAssertFalse(SensitiveFieldRedaction.isSensitiveMetadata(role: "AXTextField", title: "Spinning wheel"))
    }

    func testRedactVerificationReplacesPlaintextExpectedAndActualPreview() {
        let raw: [String: Any] = [
            "state": "unverified",
            "reason": "value_mismatch",
            "expected": "guess123",
            "actualPreview": "hunter2-real-secret",
        ]
        let redacted = SensitiveFieldRedaction.redactVerification(raw, isSensitive: true)
        XCTAssertEqual(redacted["state"] as? String, "unverified")
        XCTAssertEqual(redacted["reason"] as? String, "redacted_sensitive_field")
        XCTAssertEqual(redacted["expected"] as? String, SensitiveFieldRedaction.redactedPlaceholder)
        XCTAssertEqual(redacted["actualPreview"] as? String, SensitiveFieldRedaction.redactedPlaceholder)

        let untouched = SensitiveFieldRedaction.redactVerification(raw, isSensitive: false)
        XCTAssertEqual(untouched["actualPreview"] as? String, "hunter2-real-secret")
        XCTAssertEqual(untouched["reason"] as? String, "value_mismatch")
    }

    func testRedactedSensitiveVerificationHelperNeverExposesPlaintext() {
        let verified = SensitiveFieldRedaction.redactedSensitiveVerification(property: "selection", verified: true)
        XCTAssertEqual(verified["state"] as? String, "verified")
        XCTAssertEqual(verified["property"] as? String, "selection")
        XCTAssertEqual(verified["actualPreview"] as? String, "[redacted]")

        let unverified = SensitiveFieldRedaction.redactedSensitiveVerification(property: "value", verified: false)
        XCTAssertEqual(unverified["state"] as? String, "unverified")
        XCTAssertEqual(unverified["reason"] as? String, "redacted_sensitive_field")
        XCTAssertEqual(unverified["actualPreview"] as? String, "[redacted]")
    }

    func testMainEntrypointRedactsSelectionAndVerificationReadbacksAndChecksCoordinateBounds() throws {
        let source = try agentEntrypointSource()

        let setValueBody = try functionBody(named: "setValue", in: source)
        XCTAssertTrue(setValueBody.contains("isSensitiveElement(record.element)"))
        XCTAssertTrue(setValueBody.contains("SensitiveFieldRedaction.redactedSensitiveVerification"))
        XCTAssertTrue(setValueBody.contains("SensitiveFieldRedaction.redactVerification"))

        let replaceBody = try functionBody(named: "replaceSelection", in: source, prefix: "static func ")
        XCTAssertTrue(replaceBody.contains("!isSensitiveElement(element)"))
        XCTAssertTrue(replaceBody.contains("SensitiveFieldRedaction.redactVerification"))

        let selectionVerificationBody = try functionBody(named: "selectionVerification", in: source, prefix: "static func ")
        XCTAssertTrue(selectionVerificationBody.contains("if isSensitiveElement(element)"))
        XCTAssertTrue(selectionVerificationBody.contains("SensitiveFieldRedaction.redactedSensitiveVerification"))

        let coordBody = try functionBody(named: "coordinatePoint", in: source, prefix: "private func ")
        XCTAssertTrue(coordBody.contains("out of window bounds"))
    }

    private func functionBody(named name: String, in source: String, prefix: String = "private func ") throws -> String {
        let start = try XCTUnwrap(source.range(of: "\(prefix)\(name)("), "missing \(name)")
        let rest = source[start.upperBound...]
        let end = rest.range(of: "\n    }\n")?.lowerBound ?? rest.endIndex
        return String(rest[..<end])
    }

    private func agentEntrypointSource() throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("TerminalXComputerUseMacOS")
            .appendingPathComponent("main.swift")
        return try String(contentsOf: mainPath, encoding: .utf8)
    }
}
