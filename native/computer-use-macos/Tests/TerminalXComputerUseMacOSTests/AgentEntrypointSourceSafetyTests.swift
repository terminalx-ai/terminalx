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
        XCTAssertTrue(handleConnection.contains("while let line = readLine(from: fd) {\n            let loopAction: ConnectionLoopAction = autoreleasepool {"))

        let boundedStart = try XCTUnwrap(source.range(of: "private func boundedPngData("))
        let boundedEnd = try XCTUnwrap(
            source.range(of: "private func resizePng(", range: boundedStart.upperBound..<source.endIndex)
        )
        let boundedPng = source[boundedStart.lowerBound..<boundedEnd.lowerBound]
        XCTAssertGreaterThanOrEqual(boundedPng.components(separatedBy: "autoreleasepool {").count - 1, 2)
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
