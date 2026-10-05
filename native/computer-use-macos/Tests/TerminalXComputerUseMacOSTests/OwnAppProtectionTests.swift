import XCTest
@testable import TerminalXComputerUseMacOSCore

final class OwnAppProtectionTests: XCTestCase {
    private let releaseOwner = ComputerUseOwner(pid: 142, bundleId: "com.terminalx.next")
    private let devOwner = ComputerUseOwner(pid: 500, bundleId: "com.terminalx.next.dev")
    private let unbundledOwner = ComputerUseOwner(pid: 600, bundleId: nil)

    private func reason(
        pid: Int32,
        bundle: String?,
        owner: ComputerUseOwner?,
        tests: Bool = false
    ) -> OwnAppProtection.Reason? {
        OwnAppProtection.protectedReason(
            targetPid: pid,
            targetBundleId: bundle,
            owner: owner,
            ownWindowsAllowedForTests: tests
        )
    }

    func testTheAppThatStartedTheHelperIsNeverATarget() {
        XCTAssertEqual(reason(pid: 142, bundle: "com.terminalx.next", owner: releaseOwner), .releaseApp)
        XCTAssertEqual(reason(pid: 500, bundle: "com.terminalx.next.dev", owner: devOwner), .owner)
    }

    func testADevBuildWithoutABundleIdIsMatchedByItsPid() {
        // `tauri dev` runs a bare binary: the process id is all there is.
        XCTAssertEqual(reason(pid: 600, bundle: nil, owner: unbundledOwner), .owner)
        // The confirmation dialog and its sheet belong to the same process,
        // whatever bundle id the window server reports for them.
        XCTAssertEqual(reason(pid: 500, bundle: nil, owner: devOwner), .owner)
    }

    func testAnotherBuildSharingTheOwnersBundleIdStaysDrivable() {
        // The smoke tests drive a Dev build from a different TerminalX
        // instance; several Dev builds share one bundle id.
        XCTAssertNil(reason(pid: 501, bundle: "com.terminalx.next.dev", owner: devOwner))
        XCTAssertNil(reason(pid: 501, bundle: "com.terminalx.next.dev", owner: releaseOwner))
        XCTAssertNil(reason(pid: 601, bundle: nil, owner: unbundledOwner))
        XCTAssertNil(reason(pid: 700, bundle: "dev.terminalx.smoke-a", owner: releaseOwner))
    }

    func testTheReleasedAppIsOffLimitsToEveryInstancesHelper() {
        // A second TerminalX started by an agent must not be a way to press
        // buttons in the person's app.
        XCTAssertEqual(reason(pid: 142, bundle: "com.terminalx.next", owner: devOwner), .releaseApp)
        XCTAssertEqual(reason(pid: 142, bundle: "COM.TerminalX.Next", owner: devOwner), .releaseApp)
        XCTAssertEqual(
            reason(pid: 142, bundle: "com.terminalx.next", owner: ComputerUseOwner(pid: 143, bundleId: "com.terminalx.next")),
            .releaseApp
        )
        XCTAssertEqual(reason(pid: 142, bundle: "com.terminalx.next", owner: nil), .releaseApp)
    }

    func testOtherAppsAreNotProtected() {
        XCTAssertNil(reason(pid: 77, bundle: "com.apple.finder", owner: releaseOwner))
        XCTAssertNil(reason(pid: 77, bundle: nil, owner: releaseOwner))
        // The helper's own bundle id is not the app.
        XCTAssertNil(reason(pid: 78, bundle: "com.terminalx.next.computer-use", owner: releaseOwner))
    }

    func testTheTestEscapeHatchLiftsOnlyTheOwnerRule() {
        XCTAssertNil(reason(pid: 500, bundle: "com.terminalx.next.dev", owner: devOwner, tests: true))
        XCTAssertNil(reason(pid: 600, bundle: nil, owner: unbundledOwner, tests: true))
        XCTAssertEqual(reason(pid: 142, bundle: "com.terminalx.next", owner: releaseOwner, tests: true), .releaseApp)
        XCTAssertEqual(reason(pid: 142, bundle: "com.terminalx.next", owner: devOwner, tests: true), .releaseApp)
    }

    func testOnlyALocallyBuiltHelperHonorsTheEscapeHatch() {
        XCTAssertTrue(OwnAppProtection.honorsTestEscapeHatch(mode: .development, requested: true))
        XCTAssertFalse(OwnAppProtection.honorsTestEscapeHatch(mode: .development, requested: false))
        XCTAssertFalse(OwnAppProtection.honorsTestEscapeHatch(mode: .developerID(teamID: "AQ6323SP66"), requested: true))
        XCTAssertFalse(OwnAppProtection.honorsTestEscapeHatch(mode: .unverifiable, requested: true))
    }
}
