import Foundation
import XCTest
@testable import TerminalXComputerUseMacOSCore

final class WindowActivationSettlingTests: XCTestCase {
    func testAlreadyActiveWindowReturnsImmediatelyWithoutSleeping() {
        var sleeps: [Int] = []

        let outcome = WindowActivationSettling.settle(
            sleepOutsideLock: { sleeps.append($0) },
            probe: { true }
        )

        XCTAssertEqual(outcome, WindowActivationSettling.Outcome(settled: true, attempts: 1, waitedMs: 0))
        XCTAssertTrue(sleeps.isEmpty)
    }

    func testSettlesAdaptivelyAndSleepsOutsideLock() {
        let lock = NSLock()
        var sleeps: [Int] = []
        var wasUnlockedDuringSleep: [Bool] = []
        var attempts = 0

        lock.lock()
        let outcome = WindowActivationSettling.settle(
            timeoutMs: 250,
            intervalMs: 15,
            sleepOutsideLock: { interval in
                lock.unlock()
                defer { lock.lock() }
                sleeps.append(interval)
                let acquired = lock.try()
                wasUnlockedDuringSleep.append(acquired)
                if acquired {
                    lock.unlock()
                }
            },
            probe: {
                attempts += 1
                return attempts >= 3
            }
        )
        let stillLockedAfter = !lock.try()
        lock.unlock()

        XCTAssertEqual(outcome, WindowActivationSettling.Outcome(settled: true, attempts: 3, waitedMs: 30))
        XCTAssertEqual(sleeps, [15, 15])
        XCTAssertEqual(wasUnlockedDuringSleep, [true, true])
        XCTAssertTrue(stillLockedAfter)
    }

    func testStopsAtClampedTimeoutWhenWindowNeverSettles() {
        var sleeps: [Int] = []

        let outcome = WindowActivationSettling.settle(
            timeoutMs: 40,
            intervalMs: 15,
            sleepOutsideLock: { sleeps.append($0) },
            probe: { false }
        )

        XCTAssertEqual(outcome, WindowActivationSettling.Outcome(settled: false, attempts: 4, waitedMs: 40))
        XCTAssertEqual(sleeps, [15, 15, 10])
    }
}
