import Foundation

/// Shared sensitive/password-field classification and verification readback
/// redaction used by `AXSnapshotReader`, `setValue`, and `TextInput`.
///
/// Ensures agents cannot recover redacted password/passcode/PIN/secret values
/// through tree summaries, `Cmd+A` selection readbacks, `replaceSelection`, or
/// `setValue` verification readbacks.
public enum SensitiveFieldRedaction {
    public static let redactedPlaceholder = "[redacted]"

    public static let sensitiveTerms: [String] = [
        "secure",
        "password",
        "passcode",
        "secret",
        "verification code",
        "one-time code",
    ]

    public static let topLevelAncestorRoles: Set<String> = [
        "AXApplication",
        "AXWindow",
        "AXSheet",
        "AXDialog",
    ]

    public static func isSensitiveMetadata(
        role: String,
        subrole: String? = nil,
        title: String? = nil,
        description: String? = nil,
        placeholder: String? = nil,
        identifier: String? = nil
    ) -> Bool {
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            return true
        }
        let haystack = [
            role,
            subrole ?? "",
            title ?? "",
            description ?? "",
            placeholder ?? "",
            identifier ?? "",
        ]
        .joined(separator: " ")
        .lowercased()
        if sensitiveTerms.contains(where: { haystack.contains($0) }) {
            return true
        }
        return haystack.range(of: #"(^|[^a-z0-9])pin([^a-z0-9]|$)"#, options: .regularExpression) != nil
    }

    public static func redactedSensitiveVerification(
        property: String? = nil,
        verified: Bool = false
    ) -> [String: Any] {
        if verified, let property {
            return [
                "state": "verified",
                "property": property,
                "actualPreview": redactedPlaceholder,
            ]
        }
        return [
            "state": "unverified",
            "reason": "redacted_sensitive_field",
            "actualPreview": redactedPlaceholder,
        ]
    }

    public static func redactVerification(
        _ verification: [String: Any],
        isSensitive: Bool
    ) -> [String: Any] {
        guard isSensitive else {
            return verification
        }
        var redacted = verification
        if redacted["expected"] != nil {
            redacted["expected"] = redactedPlaceholder
        }
        redacted["actualPreview"] = redactedPlaceholder
        if (redacted["state"] as? String) == "unverified",
           (redacted["reason"] as? String) == "value_mismatch" {
            redacted["reason"] = "redacted_sensitive_field"
        }
        return redacted
    }
}
