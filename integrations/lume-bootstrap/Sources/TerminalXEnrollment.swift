// TXGuestProtocol version 2: seeded-key enrollment (design "Enrollment
// protocol"). A valid proof establishes only that guest root in this exact VM
// holds the per-VM key the host seeded offline. It is not binary attestation
// or account consent: accountAuthenticated, trustAccepted and ready stay false.
// The key and session key never enter frames, shares, argv or logs.
import Foundation
import CryptoKit
import Darwin

struct TXEnrollmentBinding: Sendable {
    let bootstrapId: String
    let seedId: String
    let bindingDigest: String
    let ownerEpoch: String
    let seedReceiptSha256: String
}

enum TXEnrollment {
    // Distinct from the owner channel's prefix so tags never cross protocols.
    static let prefix = "terminalx-vm-enrollment-v2"
    static let claimsLimit = 16

    static func tag(_ key: SymmetricKey, _ domain: String, _ parts: [String]) -> String {
        var message = Data()
        for part in [prefix, domain] + parts {
            let bytes = Data(part.utf8)
            var length = UInt32(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { message.append(contentsOf: $0) }
            message.append(bytes)
        }
        return HMAC<SHA256>.authenticationCode(for: message, using: key)
            .map { String(format: "%02x", $0) }.joined()
    }
    // Both nonces salt the session; the challenge digest in the info binds it to
    // the binding, owner epoch, seed receipt and both identifiers.
    static func sessionKey(_ key: SymmetricKey, clientNonce: String, serverNonce: String, challengeSha256: String) throws -> SymmetricKey {
        let salt = try txHex(clientNonce) + txHex(serverNonce)
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: salt,
            info: Data("\(prefix) session \(challengeSha256)".utf8), outputByteCount: 32)
    }
    static func acceptance(_ challengeSha256: String) -> [String: Any] {
        ["accountAuthenticated": false, "challengeSha256": challengeSha256, "helperAuthenticated": true,
         "ready": false, "trustAccepted": false]
    }
    /// One attempt on a connected stream. `journal` durably records the
    /// challenge before it is sent; if it throws, nothing is sent.
    static func accept(fd: Int32, key: SymmetricKey, binding: TXEnrollmentBinding,
                       journal: (Data) throws -> Void) throws -> TXEnrollmentSession {
        try TXWire.configureStream(fd)
        let hello = try txObject(TXWire.read(fd), keys: ["bootstrapId", "clientNonce", "seedId", "version"])
        try txRequire(hello["version"] as? Int == 2 && txString(hello, "bootstrapId") == binding.bootstrapId
            && txString(hello, "seedId") == binding.seedId)
        let clientNonce = try txString(hello, "clientNonce")
        _ = try txHex(clientNonce)
        let serverNonce = txNonce()
        let challenge = try txJSON(["bindingDigest": binding.bindingDigest, "bootstrapId": binding.bootstrapId,
            "clientNonce": clientNonce, "ownerEpoch": binding.ownerEpoch, "seedId": binding.seedId,
            "seedReceiptSha256": binding.seedReceiptSha256, "serverNonce": serverNonce, "version": 2])
        try journal(challenge)
        try TXWire.write(fd, challenge)
        let proof = try txObject(TXWire.read(fd), keys: ["challengeSha256", "claims", "proof"])
        let challengeSha256 = txDigest(challenge)
        guard let claims = proof["claims"] as? [String: Any], claims.count <= claimsLimit,
              claims.values.allSatisfy({ $0 is String || $0 is NSNumber }) else { throw TXBootstrapError.refused }
        try txRequire(txString(proof, "challengeSha256") == challengeSha256)
        let expected = tag(key, "enrollment", [challengeSha256, txDigest(try txJSON(claims))])
        try txRequire(txEqualTag(expected, try txString(proof, "proof")))
        let session = TXEnrollmentSession(key: try sessionKey(key, clientNonce: clientNonce, serverNonce: serverNonce,
            challengeSha256: challengeSha256), challengeSha256: challengeSha256, claims: claims)
        try session.send(fd, acceptance(challengeSha256))
        return session
    }
}

/// Strictly sequenced frames, tagged per direction under the session key.
final class TXEnrollmentSession {
    private let key: SymmetricKey
    let challengeSha256: String
    let claims: [String: Any]
    private(set) var sent: UInt64 = 0
    private(set) var received: UInt64 = 0
    init(key: SymmetricKey, challengeSha256: String, claims: [String: Any]) {
        self.key = key; self.challengeSha256 = challengeSha256; self.claims = claims
    }
    func send(_ fd: Int32, _ body: [String: Any]) throws {
        let frameTag = TXEnrollment.tag(key, "frame", ["owner", String(sent), txDigest(try txJSON(body))])
        try TXWire.write(fd, try txJSON(["body": body, "seq": sent, "tag": frameTag]))
        sent += 1
    }
    /// The next helper frame, or a refusal on any gap, replay, tamper or shape change.
    func receive(_ fd: Int32) throws -> [String: Any] {
        let frame = try txObject(TXWire.read(fd), keys: ["body", "seq", "tag"])
        guard let body = frame["body"] as? [String: Any], let seq = frame["seq"] as? Int, seq >= 0,
              UInt64(seq) == received else { throw TXBootstrapError.refused }
        let expected = TXEnrollment.tag(key, "frame", ["helper", String(received), txDigest(try txJSON(body))])
        try txRequire(txEqualTag(expected, try txString(frame, "tag")))
        received += 1
        return body
    }
}

/// Admits one attempt at a time. A failed attempt spends one unit of a bounded
/// refusal budget and never claims. The first valid proof claims this VM's only
/// enrollment. Once claimed, or once the budget is spent (fenced for
/// inspection), nothing more is admitted.
final class TXEnrollmentGate: @unchecked Sendable {
    let limit: Int
    private let lock = NSLock()
    private var busy = false
    private var claimedState = false
    private var refusalCount = 0
    init(limit: Int) { self.limit = limit }
    func begin() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !busy, !claimedState, refusalCount < limit else { return false }
        busy = true
        return true
    }
    func finish(authenticated: Bool) {
        lock.lock(); defer { lock.unlock() }
        busy = false
        if authenticated { claimedState = true } else { refusalCount += 1 }
    }
    var state: (claimed: Bool, refusals: Int, fenced: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (claimedState, refusalCount, !claimedState && refusalCount >= limit)
    }
}
