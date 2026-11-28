import Foundation

public enum KeyboardInputSafety {
    public enum FocusFailure: Equatable {
        case targetNotFocused
        case targetNotFocusedAfterRestore
    }

    /// Throttles cross-process AX focus checks inside `Input.typeText` (P-80):
    /// always checks before the first UTF-16 code unit, then every `maxCharactersBetweenChecks`
    /// units or `maxIntervalSeconds` (whichever comes first).
    public struct TypingFenceThrottle: Equatable {
        public static let defaultMaxCharactersBetweenChecks = 24
        public static let defaultMaxIntervalSeconds: TimeInterval = 0.05

        public let maxCharactersBetweenChecks: Int
        public let maxIntervalSeconds: TimeInterval
        private var charactersSinceLastCheck = 0
        private var lastCheckTime: TimeInterval?

        public init(
            maxCharactersBetweenChecks: Int = defaultMaxCharactersBetweenChecks,
            maxIntervalSeconds: TimeInterval = defaultMaxIntervalSeconds
        ) {
            self.maxCharactersBetweenChecks = max(1, maxCharactersBetweenChecks)
            self.maxIntervalSeconds = max(0, maxIntervalSeconds)
        }

        public mutating func shouldCheckFence(now: TimeInterval) -> Bool {
            guard let lastCheckTime else {
                self.lastCheckTime = now
                self.charactersSinceLastCheck = 1
                return true
            }
            if charactersSinceLastCheck >= maxCharactersBetweenChecks
                || (now - lastCheckTime) >= maxIntervalSeconds
            {
                self.lastCheckTime = now
                self.charactersSinceLastCheck = 1
                return true
            }
            charactersSinceLastCheck += 1
            return false
        }
    }

    public static func syntheticInputFocusFailure(targetWindowFocused: Bool, restoreWindowRequested: Bool) -> FocusFailure? {
        guard !targetWindowFocused else {
            return nil
        }
        return restoreWindowRequested ? .targetNotFocusedAfterRestore : .targetNotFocused
    }
}
