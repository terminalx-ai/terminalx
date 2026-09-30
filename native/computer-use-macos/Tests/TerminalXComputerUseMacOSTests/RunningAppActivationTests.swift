import XCTest
@testable import TerminalXComputerUseMacOSCore

final class RunningAppActivationTests: XCTestCase {
    func testActivatesTheExactRunningInstanceByPid() {
        let current = RunningAppInstance(pid: 4242, bundleId: "com.terminalx.next.dev", isTerminated: false)
        XCTAssertEqual(RunningAppActivation.decide(targetPid: 4242, name: "TerminalX Dev", current: current), .activate(pid: 4242))
    }

    func testRefusesInsteadOfLaunchingWhenTheInstanceIsGone() {
        for current in [
            nil,
            RunningAppInstance(pid: 4242, bundleId: "com.terminalx.next.dev", isTerminated: true),
            // A different process now holds the pid lookup: never activate something else.
            RunningAppInstance(pid: 5151, bundleId: "com.terminalx.next.dev", isTerminated: false),
        ] {
            guard case let .refuse(code, message) = RunningAppActivation.decide(targetPid: 4242, name: "TerminalX Dev", current: current) else {
                return XCTFail("expected a refusal for \(String(describing: current))")
            }
            XCTAssertEqual(code, "app_not_running")
            XCTAssertTrue(message.contains("never launches"))
            XCTAssertTrue(message.contains("pid 4242"))
        }
    }

    func testBundleSelectorPicksAnAlreadyRunningInstance() {
        let instances = [
            RunningAppInstance(pid: 900, bundleId: "com.terminalx.next.dev", isTerminated: false),
            RunningAppInstance(pid: 300, bundleId: "com.terminalx.next.dev", isTerminated: true),
            RunningAppInstance(pid: 500, bundleId: "com.terminalx.next.dev", isTerminated: false),
            RunningAppInstance(pid: 100, bundleId: "com.apple.finder", isTerminated: false),
        ]
        // Stable: the longest-running live instance.
        XCTAssertEqual(RunningAppActivation.pickRunning(bundleId: "com.terminalx.next.dev", among: instances)?.pid, 500)
        // The frontmost one when it is an instance of that bundle.
        XCTAssertEqual(RunningAppActivation.pickRunning(bundleId: "COM.terminalx.next.dev", among: instances, frontmostPid: 900)?.pid, 900)
        XCTAssertEqual(RunningAppActivation.pickRunning(bundleId: "com.terminalx.next.dev", among: instances, frontmostPid: 100)?.pid, 500)
        // None running: nothing to pick, and nothing is launched.
        XCTAssertNil(RunningAppActivation.pickRunning(bundleId: "com.example.notrunning", among: instances))
    }

    func testTheHelperNeverAsksLaunchServicesForAnAppByBundleId() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/TerminalXComputerUseMacOS/main.swift"),
            encoding: .utf8
        )
        // Why: with several builds sharing a bundle id, LaunchServices launched a
        // stale copy that took over the running app's control socket.
        XCTAssertFalse(source.contains("\"-b\""))
        XCTAssertFalse(source.contains("openBundle("))
        XCTAssertFalse(source.contains("openApplication(withBundleIdentifier"))
        XCTAssertFalse(source.contains("launchApplication("))
        XCTAssertFalse(source.contains("urlForApplication(withBundleIdentifier"))
        XCTAssertFalse(source.contains("tell application id"))
        // The only /usr/bin/open-free way to raise the target: its own running instance.
        XCTAssertTrue(source.contains("NSRunningApplication(processIdentifier: app.pid)"))
        XCTAssertTrue(source.contains("RunningAppActivation.decide("))
    }
}
