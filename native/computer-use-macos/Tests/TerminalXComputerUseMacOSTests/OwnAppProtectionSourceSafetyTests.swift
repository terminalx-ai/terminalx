import XCTest

/// The helper's entry point is not linked into the tests, so these read its
/// source: they fail when a change opens a way around the own-app protection
/// or the peer check.
final class OwnAppProtectionSourceSafetyTests: XCTestCase {
    func testEveryActionResolvesItsTargetThroughTheProtectedPath() throws {
        let source = try agentEntrypointSource()
        let actions = ["click", "performSecondaryAction", "setValue", "typeText", "pressKey", "hotkey", "pasteText", "scroll", "drag"]
        for action in actions {
            let body = try functionBody(named: action, in: source)
            XCTAssertTrue(
                body.contains("try currentSnapshot(params: params)") || body.contains("try currentKeyboardSnapshot(params: params)"),
                "\(action) must take its target from currentSnapshot, which refuses TerminalX's own windows"
            )
        }
        let currentSnapshot = try functionBody(named: "currentSnapshot", in: source)
        XCTAssertTrue(currentSnapshot.contains("forAction: true"))
        // Refused before the window is restored: restoring already activates the app.
        let observe = try functionBody(named: "observe", in: source)
        let refusal = try XCTUnwrap(observe.range(of: "OwnAppProtection.errorCode"))
        let restore = try XCTUnwrap(observe.range(of: "try recoverWindow(app)"))
        XCTAssertLessThan(refusal.lowerBound, restore.lowerBound)
        XCTAssertTrue(observe.contains("screenshotWithheld: protection != nil"))
    }

    func testEverySyntheticKeyIsFenced() throws {
        let source = try agentEntrypointSource()
        // Synthetic keys go to whatever has the focus, so each path checks
        // the focus right before it posts.
        XCTAssertEqual(source.components(separatedBy: "fence: refuseKeyboardIntoProtectedApp").count - 1, 4)
        XCTAssertFalse(source.contains("Input.typeText(text, pid: snapshot.app.pid)"))
        for function in ["typeText", "pressKey", "pasteText"] {
            let body = try functionBody(named: function, in: source, prefix: "static func ")
            XCTAssertTrue(body.contains("try fence()"), function)
        }
    }

    func testTheHelperTrustsOnlyThePeerCheckAndTakesItsTokenFromAPipe() throws {
        let source = try agentEntrypointSource()
        XCTAssertFalse(source.contains("--token-file"), "a token on disk can be read by any process of the user")
        XCTAssertFalse(source.contains("contentsOfFile: tokenPath"))
        XCTAssertFalse(source.contains("isTrustedTerminalXApplication"), "a bundle id proves nothing about the peer")
        XCTAssertFalse(source.contains("parentProcessId("), "a child of TerminalX is not TerminalX")
        XCTAssertTrue(source.contains("trust.authorizedOwner(ofConnection: fd)"))
        XCTAssertTrue(source.contains("private let helperLauncherPid: pid_t = getppid()"))
        // The escape hatch is read in the handshake and nowhere else, and
        // never from the helper's own environment.
        XCTAssertEqual(source.components(separatedBy: "allowOwnWindowsForTests").count - 1, 1)
        XCTAssertFalse(source.contains("ALLOW_OWN_WINDOWS"))
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
