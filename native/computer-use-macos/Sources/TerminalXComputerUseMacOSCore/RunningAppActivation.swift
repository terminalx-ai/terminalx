import Foundation

/// What is known about one running app instance, without AppKit.
public struct RunningAppInstance: Equatable, Sendable {
    public let pid: Int32
    public let bundleId: String?
    public let isTerminated: Bool

    public init(pid: Int32, bundleId: String?, isTerminated: Bool) {
        self.pid = pid
        self.bundleId = bundleId
        self.isTerminated = isTerminated
    }
}

/// Bringing a target app forward (`--restore-window`, clicks) activates the
/// exact running instance the selector resolved to, by pid, and never asks
/// LaunchServices for an app by bundle id.
///
/// Why: several builds can share a bundle id (TerminalX Dev builds all use
/// com.terminalx.next.dev). `open -b <bundle id>` let LaunchServices pick a
/// registered copy, and it launched a stale one with no environment, which
/// then took over the running app's control socket. Computer use never
/// launches an app: an instance that is not running is an error.
public enum RunningAppActivation {
    public enum Decision: Equatable, Sendable {
        /// Activate this running instance (NSRunningApplication(processIdentifier:)).
        case activate(pid: Int32)
        /// Do nothing and report this error; nothing is launched.
        case refuse(code: String, message: String)
    }

    public static let notRunningCode = "app_not_running"

    /// Decide what to activate for a selector that resolved to `targetPid`,
    /// given the instance running under that pid now (nil when none is).
    public static func decide(targetPid: Int32, name: String, current: RunningAppInstance?) -> Decision {
        guard let current, current.pid == targetPid, !current.isTerminated, targetPid > 0 else {
            return .refuse(code: notRunningCode, message: notRunningMessage(name: name, pid: targetPid))
        }
        return .activate(pid: targetPid)
    }

    /// For a name or bundle id selector: one of the instances already running,
    /// never a launch. The frontmost one when it matches, else the lowest pid
    /// (the longest running), so the choice is stable. Nil when none runs.
    public static func pickRunning(
        bundleId: String,
        among instances: [RunningAppInstance],
        frontmostPid: Int32? = nil
    ) -> RunningAppInstance? {
        let wanted = bundleId.lowercased()
        let running = instances.filter { !$0.isTerminated && $0.pid > 0 && $0.bundleId?.lowercased() == wanted }
        if let frontmostPid, let front = running.first(where: { $0.pid == frontmostPid }) {
            return front
        }
        return running.min { $0.pid < $1.pid }
    }

    public static func notRunningMessage(name: String, pid: Int32) -> String {
        "app '\(name)' (pid \(pid)) is no longer running; computer use never launches apps. Start it yourself, then run `terminalx computer list-apps` and retry with --app pid:<n>."
    }
}
