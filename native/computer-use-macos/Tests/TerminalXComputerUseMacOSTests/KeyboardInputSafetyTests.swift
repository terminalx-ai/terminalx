import XCTest
@testable import TerminalXComputerUseMacOSCore

final class KeyboardInputSafetyTests: XCTestCase {
    func testSyntheticInputRequiresFocusedTargetWindow() {
        let cases: [(focused: Bool, restoreWindow: Bool, expectedFailure: KeyboardInputSafety.FocusFailure?)] = [
            (focused: true, restoreWindow: false, expectedFailure: nil),
            (focused: true, restoreWindow: true, expectedFailure: nil),
            (focused: false, restoreWindow: false, expectedFailure: .targetNotFocused),
            (focused: false, restoreWindow: true, expectedFailure: .targetNotFocusedAfterRestore),
        ]

        for testCase in cases {
            XCTAssertEqual(
                KeyboardInputSafety.syntheticInputFocusFailure(
                    targetWindowFocused: testCase.focused,
                    restoreWindowRequested: testCase.restoreWindow
                ),
                testCase.expectedFailure
            )
        }
    }

    func testTypingFenceThrottleChecksFirstUnitThenEveryNUnitsOrInterval() {
        var throttle = KeyboardInputSafety.TypingFenceThrottle(
            maxCharactersBetweenChecks: 24,
            maxIntervalSeconds: 0.05
        )
        var checks: [Int] = []
        // Simulate 100 fast characters (0.1ms apart = 10ms total): should check at 0, 24, 48, 72, 96.
        for i in 0..<100 {
            if throttle.shouldCheckFence(now: 10.0 + Double(i) * 0.0001) {
                checks.append(i)
            }
        }
        XCTAssertEqual(checks, [0, 24, 48, 72, 96])

        // Simulate slow typing where 60ms elapses between chars: time budget triggers check before 24 chars.
        var slowThrottle = KeyboardInputSafety.TypingFenceThrottle(
            maxCharactersBetweenChecks: 24,
            maxIntervalSeconds: 0.05
        )
        XCTAssertTrue(slowThrottle.shouldCheckFence(now: 100.0))
        XCTAssertFalse(slowThrottle.shouldCheckFence(now: 100.02))
        XCTAssertFalse(slowThrottle.shouldCheckFence(now: 100.04))
        XCTAssertTrue(slowThrottle.shouldCheckFence(now: 100.055))
        XCTAssertFalse(slowThrottle.shouldCheckFence(now: 100.06))
    }
}
