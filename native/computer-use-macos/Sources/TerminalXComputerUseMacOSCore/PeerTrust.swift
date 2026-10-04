/// How this helper can tell that the process on the other end of its socket
/// is the TerminalX app, and not some other program running as the same user.
///
/// The helper holds the Accessibility and Screen Recording grants, and any
/// process of the same user can start a copy of it (TCC gives a copy started
/// from a shell the same grants). So the helper itself has to decide whom it
/// serves.
public enum HelperTrustMode: Equatable, Sendable {
    /// The helper is signed with a Developer ID (a release). The peer must be
    /// the TerminalX app signed by the same team: a code-signature check on the
    /// peer's audit token, which a child process of the app cannot satisfy.
    case developerID(teamID: String)
    /// The helper is ad-hoc or development signed (a local build). There is no
    /// signing identity to check the app against, so the launcher relationship
    /// is the only identity on offer.
    case development
    /// The helper could not confirm that the signature on disk is the code it
    /// is running. It serves nobody.
    case unverifiable
}

public enum PeerTrustDecision: Equatable, Sendable {
    case trusted
    case rejected(String)
}

public enum PeerTrust {
    /// The signing identifier of the released TerminalX app.
    public static let releaseAppIdentifier = "com.terminalx.next"

    /// The code requirement the peer must satisfy in a release: the TerminalX
    /// app, signed with a Developer ID of the team that signed this helper.
    /// `nil` when the team id is not a plain team id, so nothing unexpected is
    /// ever spliced into a requirement string.
    public static func appRequirement(teamID: String) -> String? {
        guard isTeamIdentifier(teamID) else { return nil }
        return "identifier \"\(releaseAppIdentifier)\" and \(developerIDRequirement(teamID: teamID)!)"
    }

    /// "Signed with a Developer ID of this team", for any identifier. The
    /// helper checks itself against this to learn which mode it is in.
    public static func developerIDRequirement(teamID: String) -> String? {
        guard isTeamIdentifier(teamID) else { return nil }
        return "anchor apple generic"
            + " and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
            + " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
            + " and certificate leaf[subject.OU] = \"\(teamID)\""
    }

    public static func isTeamIdentifier(_ value: String) -> Bool {
        value.utf8.count == 10 && value.utf8.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A)
        }
    }

    /// - Parameters:
    ///   - peerPid: the connecting process, from the socket's audit token
    ///     (`nil` when the kernel gave none).
    ///   - launcherPid: this helper's parent, read once at startup.
    ///   - peerSatisfiesAppRequirement: the result of checking the peer's
    ///     running code against `appRequirement`; only consulted in a release.
    public static func decide(
        mode: HelperTrustMode,
        peerPid: Int32?,
        launcherPid: Int32,
        peerSatisfiesAppRequirement: Bool
    ) -> PeerTrustDecision {
        guard let peerPid, peerPid > 1 else {
            return .rejected("the peer could not be identified")
        }
        // A helper started through LaunchServices (`open`) has launchd as its
        // parent: nobody is its launcher, so nobody may drive it.
        guard launcherPid > 1 else {
            return .rejected("this helper was not started by TerminalX")
        }
        // Being a child of TerminalX, or carrying its bundle id, is not
        // enough: every agent shell is a descendant of the app.
        guard peerPid == launcherPid else {
            return .rejected("the peer is not the process that started this helper")
        }
        switch mode {
        case .unverifiable:
            return .rejected("this helper could not verify its own signature")
        case .development:
            return .trusted
        case .developerID:
            return peerSatisfiesAppRequirement
                ? .trusted
                : .rejected("the peer is not the signed TerminalX app")
        }
    }
}
