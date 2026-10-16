import Foundation

/// Which bundle the setup window's drag tile may offer (#480).
///
/// The helper runs from a copy in Application Support that any process of
/// the person's user can replace. Whatever the person drags into System
/// Settings is what macOS grants, so the tile must never offer that copy.
/// TerminalX passes the helper shipped inside the app with `--drag-source`,
/// and the tile offers it only if its code is exactly the code running here
/// (the same cdhash): macOS then records the helper's own identity, which
/// the copy satisfies. Anything else, including no argument, means no tile.
public enum DragSource {
    public static let argument = "--drag-source"

    /// The value after `--drag-source`, if any.
    public static func path(in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: argument), index + 1 < arguments.count else {
            return nil
        }
        let value = arguments[index + 1]
        return value.isEmpty ? nil : value
    }

    /// Offer the candidate only when both hashes are known and equal.
    public static func accepts(candidateCdhash: Data?, ownCdhash: Data?) -> Bool {
        guard let candidateCdhash, let ownCdhash, !ownCdhash.isEmpty else {
            return false
        }
        return candidateCdhash == ownCdhash
    }
}
