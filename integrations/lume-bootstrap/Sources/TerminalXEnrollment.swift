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
    /// challenge before it is sent; `commit` durably records a verified proof
    /// before the helper is told it was accepted. If either throws, the helper
    /// receives nothing further.
    static func accept(fd: Int32, key: SymmetricKey, binding: TXEnrollmentBinding,
                       journal: (Data) throws -> Void,
                       commit: (TXEnrollmentSession) throws -> Void = { _ in }) throws -> TXEnrollmentSession {
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
        try commit(session)
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

/// The restricted owner's version-3 enrollment for one launch. The key comes
/// only from the private operation directory (`enrollment.key`, owner-only),
/// never from the binding, argv, a share or a frame. Every admitted attempt
/// journals its challenge; a verified proof writes the one enrollment receipt
/// before the helper is accepted. The receipt holds digests and states, never
/// the key, and never claims account authentication, trust or readiness.
final class TXEnrollmentService: @unchecked Sendable {
    static let refusalLimit = 8
    static let attemptNames = Swift.Set((0...refusalLimit).map { "enrollment-attempt-\($0).json" })
    let gate = TXEnrollmentGate(limit: refusalLimit)
    private let launch: TerminalXBootstrapLaunch
    private let key: SymmetricKey
    private let binding: TXEnrollmentBinding
    private let lock = NSLock()
    private var attempts = 0
    private var retained: TXEnrollmentSession?
    private let confirmationWait: Double
    private let relayed = DispatchSemaphore(value: 0)

    /// `confirmationWait` bounds how long the session waits for the person.
    init(launch: TerminalXBootstrapLaunch, confirmationWait: Double = 6 * 3600) throws {
        self.confirmationWait = confirmationWait
        try txRequire(launch.binding.version == 3)
        guard let seedId = launch.binding.seedId, let receipt = launch.binding.seedReceiptSha256 else {
            throw TXBootstrapError.refused
        }
        let stored = try launch.pins["operation"]!.receipt("enrollment.key")
        guard let text = String(data: stored, encoding: .utf8) else { throw TXBootstrapError.refused }
        key = SymmetricKey(data: try txHex(text))
        binding = TXEnrollmentBinding(bootstrapId: launch.binding.bootstrapId, seedId: seedId,
            bindingDigest: launch.bindingDigest, ownerEpoch: launch.binding.ownerEpoch, seedReceiptSha256: receipt)
        self.launch = launch
    }
    /// The attempt number for an admitted connection, or nil once claimed,
    /// fenced or while another attempt is in flight.
    func admit() -> Int? {
        guard gate.begin() else { return nil }
        lock.lock(); defer { lock.unlock() }
        attempts += 1
        return attempts - 1
    }
    /// The verified session, retained for the authenticated relay that consumes it.
    var session: TXEnrollmentSession? {
        lock.lock(); defer { lock.unlock() }
        return retained
    }
    func run(fd: Int32, attempt: Int, view: TXOwnedVM) {
        let operation = launch.pins["operation"]!
        var committed = false
        var finished = false
        do {
            try launch.check(); try view.check()
            let session = try TXEnrollment.accept(fd: fd, key: key, binding: binding, journal: {
                try operation.writeNew("enrollment-attempt-\(attempt).json", $0)
            }, commit: { session in
                try self.launch.check(); try view.check()
                try operation.writeNew("enrollment.json", txJSON(["version": 2, "bindingDigest": self.binding.bindingDigest,
                    "ownerEpoch": self.binding.ownerEpoch, "bootstrapId": self.binding.bootstrapId, "seedId": self.binding.seedId,
                    "seedReceiptSha256": self.binding.seedReceiptSha256, "attempt": attempt,
                    "challengeSha256": session.challengeSha256, "claimsSha256": txDigest(try txJSON(session.claims)),
                    "helperAuthenticated": true, "accountAuthenticated": false, "trustAccepted": false, "ready": false]))
                committed = true
            })
            lock.lock(); retained = session; lock.unlock()
            gate.finish(authenticated: true)
            finished = true
            try converse(fd: fd, session: session, view: view)
        } catch {
            // A durable receipt claims even if the acceptance reply was lost: the
            // enrollment is never repeated or replaced, and its session is gone.
            // Later journals record how far the account conversation got.
            if !finished { gate.finish(authenticated: committed) }
        }
    }
    /// Wakes the session once the host journals a relay.
    func relayRecorded() { relayed.signal() }
    /// After enrollment: journal the helper's account observation, wait for the
    /// person's confirmation to be journaled by the owner channel, relay it over
    /// the session, and journal the helper's answer. Nothing here chooses.
    private func converse(fd: Int32, session: TXEnrollmentSession, view: TXOwnedVM) throws {
        let operation = launch.pins["operation"]!
        _ = try TXAccountRelay.observe(try session.receive(fd), launch: launch, challengeSha256: session.challengeSha256)
        let deadline = DispatchTime.now() + confirmationWait
        var relay = try? operation.receipt("account-confirmation-relay.json")
        while relay == nil {
            try txRequire(DispatchTime.now() < deadline)
            _ = relayed.wait(timeout: .now() + 1)
            relay = try? operation.receipt("account-confirmation-relay.json")
        }
        try launch.check(); try view.check()
        try session.send(fd, TXAccountRelay.frame(relay!))
        let answer = try TXAccountRelay.answer(try session.receive(fd), relay: relay!, launch: launch)
        // A key is granted only for an account the helper confirmed.
        guard (try JSONSerialization.jsonObject(with: answer) as? [String: Any])?["outcome"] as? String == "confirmed" else { return }
        var grant = try? operation.receipt("key-grant-relay.json")
        while grant == nil {
            try txRequire(DispatchTime.now() < deadline)
            _ = relayed.wait(timeout: .now() + 1)
            grant = try? operation.receipt("key-grant-relay.json")
        }
        try launch.check(); try view.check()
        try session.send(fd, TXAccountRelay.grantFrame(grant!))
        let result = try TXAccountRelay.keyResult(try session.receive(fd), relay: grant!, launch: launch)
        // Only after the helper's own install: the guest's existing public host key.
        guard (try JSONSerialization.jsonObject(with: result) as? [String: Any])?["stage"] as? String == "publicKeyInstalled" else { return }
        let observation = try TXAccountRelay.hostKey({ try session.receive(fd) }, result: result, deadline: deadline, launch: launch)
        // Stage 9: the final report is committed, so acknowledge exactly it and
        // journal what the helper says it removed.
        try launch.check(); try view.check()
        let acknowledgement = try TXAccountRelay.acknowledgeRetirement(observation, challengeSha256: session.challengeSha256,
            launch: launch)
        try session.send(fd, try TXAccountRelay.retirementFrame(acknowledgement))
        _ = try TXAccountRelay.retirementReport(try session.receive(fd), acknowledgement: acknowledgement, launch: launch)
    }
}
