/// The app this helper works for: the authenticated peer.
public struct ComputerUseOwner: Equatable, Sendable {
    public let pid: Int32
    public let bundleId: String?

    public init(pid: Int32, bundleId: String?) {
        self.pid = pid
        self.bundleId = bundleId
    }
}

/// TerminalX's own windows are the person's to operate: its confirmations and
/// its Settings switches are how they keep an agent in check. The helper never
/// acts on them, whether or not a confirmation is open, and never reads them:
/// no screenshot and no accessibility tree (a pairing code, an invite link or
/// another session's terminal would leak).
public enum OwnAppProtection {
    public static let errorCode = "own_app_protected"
    /// The released TerminalX app. No instance's helper acts on it, so an
    /// agent cannot start a second TerminalX and drive the person's app
    /// through that one's helper.
    public static let releaseAppBundleId = "com.terminalx.next"

    public enum Reason: Equatable, Sendable {
        /// The target is the app this helper works for.
        case owner
        /// The target is the released TerminalX app, owner or not.
        case releaseApp
    }

    /// Why `target` is off limits, or `nil` when it may be driven.
    ///
    /// The owner is matched by process id; its bundle id alone decides
    /// nothing, so another running build that shares the owner's bundle id
    /// (several Dev builds do) stays drivable. That is how TerminalX's own
    /// smoke tests drive a Dev build from a different instance.
    ///
    /// `ownWindowsAllowedForTests` lifts the owner rule only, see
    /// `honorsTestEscapeHatch`.
    public static func protectedReason(
        targetPid: Int32,
        targetBundleId: String?,
        owner: ComputerUseOwner?,
        ownWindowsAllowedForTests: Bool
    ) -> Reason? {
        if let targetBundleId, targetBundleId.lowercased() == releaseAppBundleId {
            return .releaseApp
        }
        if let owner, owner.pid == targetPid, !ownWindowsAllowedForTests {
            return .owner
        }
        return nil
    }

    /// The escape hatch for TerminalX's own UI tests: a test build of the app
    /// asks, in its handshake, to drive its own windows. Only a locally built
    /// helper listens; a released helper never does, whatever it is told.
    public static func honorsTestEscapeHatch(mode: HelperTrustMode, requested: Bool) -> Bool {
        requested && mode == .development
    }

    public static func actionRefusal(targetName: String) -> String {
        "computer use does not click, type or change anything in \(targetName)'s own windows: its confirmations and settings are the person's to operate. Ask the person to do it."
    }

    public static let keyboardRefusal =
        "keyboard input was stopped because a TerminalX window has the keyboard focus: its confirmations and settings are the person's to operate. Ask the person, then bring the target window forward and retry."

    public static let screenshotRefusal =
        "TerminalX's own windows are never screenshotted by computer use: a pairing code or a secret on screen would leak."

    public static let treeRefusal =
        "accessibility tree withheld: computer use does not read TerminalX's own windows. They show pairing codes, invite links and other sessions' terminals as plain text. Ask the person, or use the terminalx CLI for what it offers."
}
