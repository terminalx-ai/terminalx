import XCTest

final class AgentEntrypointSourceSafetyTests: XCTestCase {
    func testAgentEntrypointDoesNotUnlinkCallerSuppliedPaths() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("TerminalXComputerUseMacOS")
            .appendingPathComponent("main.swift")
        let source = try String(contentsOf: mainPath, encoding: .utf8)

        // Why: --agent accepts caller-supplied paths; deleting them in the
        // helper can remove user files if argument validation is bypassed.
        XCTAssertFalse(source.contains("unlink(tokenPath)"))
        XCTAssertFalse(source.contains("unlink(socketPath)"))
    }

    func testSyntheticModifiersHaveGuaranteedReleaseAndModifiedClicksUseFlags() throws {
        let source = try agentEntrypointSource()

        XCTAssertTrue(source.contains("var pressedModifiers: [KeyModifier] = []"))
        XCTAssertTrue(source.contains(
            """
            defer {
                        for modifier in pressedModifiers.reversed() {
                            flags.remove(modifier.flag)
                            try? keyEvent(modifier.keyCode, down: false, flags: flags, pid: pid)
            """
        ))
        XCTAssertTrue(source.contains("event.flags = flags\n        event.postToPid(pid)"))
    }

    func testSocketWorkerAndPngResizeUseAutoreleasepools() throws {
        let source = try agentEntrypointSource()
        let handleConnectionStart = try XCTUnwrap(source.range(of: "private func handleConnection("))
        let handleConnectionEnd = try XCTUnwrap(
            source.range(of: "private func disconnectSession(", range: handleConnectionStart.upperBound..<source.endIndex)
        )
        let handleConnection = source[handleConnectionStart.lowerBound..<handleConnectionEnd.lowerBound]
        XCTAssertTrue(handleConnection.contains("let reader = BufferedSocketLineReader(fileDescriptor: fd)"))
        XCTAssertTrue(handleConnection.contains("let loopAction: ConnectionLoopAction = autoreleasepool {"))
        // S-51: unauthorized peer sockets are closed immediately before constructing reader / reading.
        let guardPeerRange = try XCTUnwrap(handleConnection.range(of: "guard let peerOwner else {\n            return\n        }"))
        let readerRange = try XCTUnwrap(handleConnection.range(of: "BufferedSocketLineReader(fileDescriptor: fd)"))
        XCTAssertLessThan(guardPeerRange.lowerBound, readerRange.lowerBound)
        // P-80: no 1-byte-at-a-time read(fd, &byte, 1) loop remains.
        XCTAssertFalse(source.contains("read(fd, &byte, 1)"))

        let boundedStart = try XCTUnwrap(source.range(of: "private func boundedPngData("))
        let boundedEnd = try XCTUnwrap(
            source.range(of: "private func resizePng(", range: boundedStart.upperBound..<source.endIndex)
        )
        let boundedPng = source[boundedStart.lowerBound..<boundedEnd.lowerBound]
        XCTAssertGreaterThanOrEqual(boundedPng.components(separatedBy: "autoreleasepool {").count - 1, 2)
        // P-77: pre-downscales before first PNG encode and uses analytical scale policy (no 0.85 linear step).
        XCTAssertTrue(boundedPng.contains("ScreenshotScalePolicy.initialScale("))
        XCTAssertTrue(boundedPng.contains("ScreenshotScalePolicy.nextScale("))
        XCTAssertFalse(boundedPng.contains("scale *= 0.85"))
    }

    func testS51ListWindowsOmitsProtectedAppsAndBlockedBundlesCoverBuiltInPasswordManagers() throws {
        let source = try agentEntrypointSource()
        let listWindowsStart = try XCTUnwrap(source.range(of: "private func listWindows("))
        let listWindowsEnd = try XCTUnwrap(
            source.range(of: "private func appByPid(", range: listWindowsStart.upperBound..<source.endIndex)
        )
        let listWindows = source[listWindowsStart.lowerBound..<listWindowsEnd.lowerBound]
        let protectedCheck = try XCTUnwrap(listWindows.range(of: "protectedReason(pid: app.pid, bundleId: app.bundleId) != nil"))
        let captureCall = try XCTUnwrap(listWindows.range(of: "WindowCapture.candidates(pid: app.pid)"))
        XCTAssertLessThan(protectedCheck.lowerBound, captureCall.lowerBound)
        XCTAssertTrue(source.contains("OwnAppProtection.isBlockedBundleId("))
        // P-80: typeText throttles intra-call AX focus checks while keeping try fence().
        let typeTextStart = try XCTUnwrap(source.range(of: "static func typeText("))
        let typeTextEnd = try XCTUnwrap(
            source.range(of: "static func pressKey(", range: typeTextStart.upperBound..<source.endIndex)
        )
        let typeText = source[typeTextStart.lowerBound..<typeTextEnd.lowerBound]
        XCTAssertTrue(typeText.contains("TypingFenceThrottle()"))
        XCTAssertTrue(typeText.contains("try fence()"))
    }

    func testMacOSPerfOptimizationsAreWiredInEntrypoint() throws {
        let source = try agentEntrypointSource()
        // P-15: no unconditional 400ms sleep; adaptive settling unlocks providerLock.
        XCTAssertFalse(source.contains("Thread.sleep(forTimeInterval: 0.4)"))
        XCTAssertTrue(source.contains("WindowActivationSettling.settle("))
        XCTAssertTrue(source.contains("externalLock.unlock()\n            defer { externalLock.lock() }"))
        // P-15: tab-strip compaction gated before child AX IPCs; direct kAXVisibleRowsAttribute query.
        XCTAssertTrue(source.contains("SnapshotRenderHeuristics.shouldInspectTabStripCompaction(parent: parent, childCount: children.count)"))
        XCTAssertTrue(source.contains("copyArray(parent, kAXVisibleRowsAttribute as String)"))
        // P-15: action pre-flight avoids full TreeRenderer crawl.
        let actionSnapshotStart = try XCTUnwrap(source.range(of: "private func buildActionSnapshot("))
        let actionSnapshotEnd = try XCTUnwrap(
            source.range(of: "private func buildSnapshot(", range: actionSnapshotStart.upperBound..<source.endIndex)
        )
        let actionSnapshot = source[actionSnapshotStart.lowerBound..<actionSnapshotEnd.lowerBound]
        XCTAssertFalse(actionSnapshot.contains("TreeRenderer("))
        XCTAssertTrue(actionSnapshot.contains("revalidatedElementRecord("))
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
