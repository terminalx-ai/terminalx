import XCTest
@testable import TerminalXComputerUseMacOSCore

final class PeerTrustTests: XCTestCase {
    private let release = HelperTrustMode.developerID(teamID: "AQ6323SP66")

    func testAReleaseHelperServesOnlyTheSignedAppThatStartedIt() {
        XCTAssertEqual(
            PeerTrust.decide(mode: release, peerPid: 142, launcherPid: 142, peerSatisfiesAppRequirement: true),
            .trusted
        )
    }

    func testAReleaseHelperRefusesItsLauncherWhenThatIsNotTheSignedApp() {
        // An agent that starts its own copy of the helper is its launcher,
        // but it is a shell, not the TerminalX app.
        XCTAssertEqual(
            PeerTrust.decide(mode: release, peerPid: 9001, launcherPid: 9001, peerSatisfiesAppRequirement: false),
            .rejected("the peer is not the signed TerminalX app")
        )
    }

    func testAChildOfTheAppIsNotTheApp() {
        // The agent's shell (pid 9001) connects to the helper that TerminalX
        // (pid 142) started. Its parent being TerminalX earns it nothing.
        for mode in [release, .development] {
            XCTAssertEqual(
                PeerTrust.decide(mode: mode, peerPid: 9001, launcherPid: 142, peerSatisfiesAppRequirement: false),
                .rejected("the peer is not the process that started this helper"),
                "\(mode)"
            )
        }
    }

    func testAnotherSignedAppInstanceCannotBorrowThisHelper() {
        XCTAssertEqual(
            PeerTrust.decide(mode: release, peerPid: 777, launcherPid: 142, peerSatisfiesAppRequirement: true),
            .rejected("the peer is not the process that started this helper")
        )
    }

    func testAHelperStartedThroughLaunchServicesServesNobody() {
        // `open -n` makes launchd the parent: there is no launcher to be.
        for peer: Int32 in [1, 142, 9001] {
            for mode in [release, .development] {
                XCTAssertEqual(
                    PeerTrust.decide(mode: mode, peerPid: peer, launcherPid: 1, peerSatisfiesAppRequirement: true),
                    peer > 1
                        ? .rejected("this helper was not started by TerminalX")
                        : .rejected("the peer could not be identified")
                )
            }
        }
    }

    func testAPeerWithoutAnAuditTokenIsRefused() {
        for mode in [release, .development, .unverifiable] {
            XCTAssertEqual(
                PeerTrust.decide(mode: mode, peerPid: nil, launcherPid: 142, peerSatisfiesAppRequirement: true),
                .rejected("the peer could not be identified")
            )
        }
    }

    func testALocalBuildFallsBackToTheLauncherRelationship() {
        XCTAssertEqual(
            PeerTrust.decide(mode: .development, peerPid: 142, launcherPid: 142, peerSatisfiesAppRequirement: false),
            .trusted
        )
    }

    func testAHelperThatCannotVerifyItselfServesNobody() {
        XCTAssertEqual(
            PeerTrust.decide(mode: .unverifiable, peerPid: 142, launcherPid: 142, peerSatisfiesAppRequirement: true),
            .rejected("this helper could not verify its own signature")
        )
    }

    func testTheAppRequirementNamesTheAppTheTeamAndADeveloperIDCertificate() throws {
        let requirement = try XCTUnwrap(PeerTrust.appRequirement(teamID: "AQ6323SP66"))
        XCTAssertEqual(
            requirement,
            "identifier \"com.terminalx.next\" and anchor apple generic"
                + " and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
                + " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
                + " and certificate leaf[subject.OU] = \"AQ6323SP66\""
        )
        // The helper's own bundle id is not the app's.
        XCTAssertFalse(requirement.contains("computer-use"))
    }

    func testNothingButATeamIdentifierIsSplicedIntoARequirement() {
        for bad in ["", "AQ6323SP6", "AQ6323SP666", "aq6323sp66", "AQ6323SP6\"", "\" or true ", "AQ6323 P66"] {
            XCTAssertNil(PeerTrust.appRequirement(teamID: bad), bad)
            XCTAssertNil(PeerTrust.developerIDRequirement(teamID: bad), bad)
        }
    }
}
