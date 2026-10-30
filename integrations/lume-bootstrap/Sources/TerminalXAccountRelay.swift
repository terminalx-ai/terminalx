// Design "Account confirmation and effects", owner side. After enrollment the
// helper reports local personal accounts. Only the person's confirmation,
// recorded by the host and delivered over the MAC'd owner channel, is relayed
// back over the tagged session. The helper's acknowledgement is the only source
// of accountAuthenticated, and only for that one account; trust and readiness
// stay false. Every step is journaled exclusively and never re-chosen.
import Foundation
import Darwin

enum TXAccountRelay {
    static let relayKeys: Swift.Set<String> = ["version", "bindingDigest", "ownerEpoch", "confirmationSha256", "account",
        "relayed", "accountAuthenticated", "trustAccepted", "ready"]
    static let observationKeys: Swift.Set<String> = ["version", "bindingDigest", "ownerEpoch", "challengeSha256", "accounts",
        "helperAuthenticated", "accountAuthenticated", "trustAccepted", "ready"]

    /// A personal account exactly as the helper reports it.
    static func account(_ value: Any?) throws -> [String: Any] {
        guard let account = value as? [String: Any],
              Swift.Set(account.keys) == ["gid", "home", "homeDevice", "homeInode", "name", "uid"],
              let name = account["name"] as? String, let uid = account["uid"] as? Int, let gid = account["gid"] as? Int,
              let home = account["home"] as? String, let device = account["homeDevice"] as? Int,
              let inode = account["homeInode"] as? Int else { throw TXBootstrapError.refused }
        let bytes = Array(name.utf8)
        try txRequire(!bytes.isEmpty && bytes.count <= 32 && (97...122).contains(bytes[0])
            && bytes.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95].contains($0) }
            && (501..<65534).contains(uid) && gid > 0 && home == "/Users/\(name)" && device >= 0 && inode > 0)
        return account
    }

    /// Journals the helper's first session frame: `{accounts: [...]}`.
    static func observe(_ body: [String: Any], launch: TerminalXBootstrapLaunch, challengeSha256: String) throws -> Data {
        guard Swift.Set(body.keys) == ["accounts"], let list = body["accounts"] as? [Any], list.count <= 16 else {
            throw TXBootstrapError.refused
        }
        let accounts = try list.map(account)
        let record = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest, "ownerEpoch": launch.binding.ownerEpoch,
            "challengeSha256": challengeSha256, "accounts": accounts,
            "helperAuthenticated": true, "accountAuthenticated": false, "trustAccepted": false, "ready": false])
        try launch.pins["operation"]!.writeNew("account-observation.json", record)
        return record
    }

    /// Validates the host's confirmation against the journaled observation and
    /// journals it once. The same confirmation returns the same record (a lost
    /// reply); any other confirmation, for any account, is refused for good.
    static func record(_ confirmation: Data, launch: TerminalXBootstrapLaunch) throws -> Data {
        let operation = launch.pins["operation"]!
        let c = try txObject(confirmation, keys: ["version", "bindingDigest", "ownerEpoch", "observationSha256", "account",
            "parentSession", "parentTab", "parentConversation", "confirmationId"])
        try txRequire(c["version"] as? Int == 1 && txString(c, "bindingDigest") == launch.bindingDigest
            && txString(c, "ownerEpoch") == launch.binding.ownerEpoch)
        for id in [try txString(c, "parentSession"), try txString(c, "parentTab"), try txString(c, "confirmationId")] {
            try txRequire(UUID(uuidString: id) != nil)
        }
        let conversation = try txString(c, "parentConversation")
        try txRequire(!conversation.isEmpty && conversation.utf8.count <= 256 && conversation.utf8.allSatisfy { $0 >= 32 && $0 < 127 })
        let observation = try operation.receipt("account-observation.json")
        try txRequire(txString(c, "observationSha256") == txDigest(observation))
        let observed = try txObject(observation, keys: observationKeys)
        guard let accounts = observed["accounts"] as? [[String: Any]] else { throw TXBootstrapError.refused }
        let chosen = try account(c["account"])
        let encoded = try txJSON(chosen)
        try txRequire(try accounts.contains { try txJSON($0) == encoded })
        let digest = txDigest(confirmation)
        if let existing = try? operation.receipt("account-confirmation-relay.json") {
            try txRequire(txString(txObject(existing, keys: relayKeys), "confirmationSha256") == digest)
            return existing
        }
        let relay = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest, "ownerEpoch": launch.binding.ownerEpoch,
            "confirmationSha256": digest, "account": chosen, "relayed": true,
            "accountAuthenticated": false, "trustAccepted": false, "ready": false])
        try operation.writeNew("account-confirmation-relay.json", relay)
        return relay
    }

    /// The session frame for a journaled relay, in the helper's confirmation form.
    static func frame(_ relay: Data) throws -> [String: Any] {
        let r = try txObject(relay, keys: relayKeys)
        guard var account = r["account"] as? [String: Any] else { throw TXBootstrapError.refused }
        account["confirmed"] = true
        account["confirmationSha256"] = try txString(r, "confirmationSha256")
        return ["accountConfirmation": account]
    }

    /// Journals the helper's answer. Only an exact acknowledgement of this
    /// confirmation authenticates the account; trust and readiness stay false.
    static func answer(_ body: [String: Any], relay: Data, launch: TerminalXBootstrapLaunch) throws -> Data {
        let r = try txObject(relay, keys: relayKeys)
        let digest = try txString(r, "confirmationSha256")
        let confirmed: Bool
        if let ack = body["accountConfirmed"] as? [String: Any], body.count == 1, Swift.Set(ack.keys) == ["confirmationSha256"] {
            try txRequire(txString(ack, "confirmationSha256") == digest)
            confirmed = true
        } else if let refusal = body["accountRefused"] as? [String: Any], body.count == 1 {
            try txRequire(txString(refusal, "confirmationSha256") == digest)
            confirmed = false
        } else { throw TXBootstrapError.refused }
        let record = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest, "ownerEpoch": launch.binding.ownerEpoch,
            "confirmationSha256": digest, "account": r["account"]!, "outcome": confirmed ? "confirmed" : "refused",
            "accountAuthenticated": confirmed, "trustAccepted": false, "ready": false])
        try launch.pins["operation"]!.writeNew("account-confirmation-answer.json", record)
        return record
    }

    static let grantKeys: Swift.Set<String> = ["version", "bindingDigest", "ownerEpoch", "confirmationSha256", "answerSha256",
        "account", "keyReference", "publicKey", "parentSession", "parentTab", "parentConversation"]

    /// Validates the host's key grant against the confirmed account and journals
    /// it once. Only after the helper confirmed that account; only one ed25519
    /// public key with its original reference. The same grant returns the same
    /// record (a lost reply); a changed key, reference or account is refused for good.
    static func recordGrant(_ grant: Data, launch: TerminalXBootstrapLaunch) throws -> Data {
        let operation = launch.pins["operation"]!
        let g = try txObject(grant, keys: grantKeys)
        try txRequire(g["version"] as? Int == 1 && txString(g, "bindingDigest") == launch.bindingDigest
            && txString(g, "ownerEpoch") == launch.binding.ownerEpoch)
        let relay = try txObject(operation.receipt("account-confirmation-relay.json"), keys: relayKeys)
        let answerBytes = try operation.receipt("account-confirmation-answer.json")
        guard let answer = try JSONSerialization.jsonObject(with: answerBytes) as? [String: Any],
              answer["outcome"] as? String == "confirmed", answer["accountAuthenticated"] as? Bool == true,
              let account = relay["account"] as? [String: Any], let granted = g["account"] as? [String: Any] else {
            throw TXBootstrapError.refused
        }
        try txRequire(txString(g, "confirmationSha256") == txString(relay, "confirmationSha256")
            && txString(g, "answerSha256") == txDigest(answerBytes)
            && Swift.Set(granted.keys) == ["name", "uid"] && granted["name"] as? String == account["name"] as? String
            && granted["uid"] as? Int == account["uid"] as? Int)
        for id in [try txString(g, "keyReference"), try txString(g, "parentSession"), try txString(g, "parentTab")] {
            try txRequire(UUID(uuidString: id) != nil)
        }
        let parts = try txString(g, "publicKey").split(separator: " ", omittingEmptySubsequences: false)
        try txRequire(parts.count == 2 && parts[0] == "ssh-ed25519" && !parts[1].isEmpty && parts[1].utf8.count <= 128
            && parts[1].utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [43, 47, 61].contains($0) })
        let digest = txDigest(grant)
        if let existing = try? operation.receipt("key-grant-relay.json") {
            try txRequire(txString(txObject(existing, keys: grantRelayKeys), "grantSha256") == digest)
            return existing
        }
        let record = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest, "ownerEpoch": launch.binding.ownerEpoch,
            "grantSha256": digest, "keyReference": try txString(g, "keyReference"), "publicKey": try txString(g, "publicKey"),
            "account": granted, "relayed": true, "installed": false, "trustAccepted": false, "ready": false])
        try operation.writeNew("key-grant-relay.json", record)
        return record
    }
    static let grantRelayKeys: Swift.Set<String> = ["version", "bindingDigest", "ownerEpoch", "grantSha256", "keyReference",
        "publicKey", "account", "relayed", "installed", "trustAccepted", "ready"]

    /// The session frame for a journaled grant, in the helper's key grant form.
    static func grantFrame(_ relay: Data) throws -> [String: Any] {
        let r = try txObject(relay, keys: grantRelayKeys)
        return ["keyGrant": ["keyReference": try txString(r, "keyReference"), "publicKey": try txString(r, "publicKey")]]
    }

    /// Journals the helper's install result. Only the helper's own
    /// `publicKeyInstalled` for this reference counts as installed; an unknown
    /// outcome or refusal is recorded as such and never becomes success.
    static func keyResult(_ body: [String: Any], relay: Data, launch: TerminalXBootstrapLaunch) throws -> Data {
        let r = try txObject(relay, keys: grantRelayKeys)
        guard body.count == 1, let result = body["keyResult"] as? [String: Any],
              Swift.Set(result.keys) == ["keyReference", "stage"], let stage = result["stage"] as? String,
              ["publicKeyInstalled", "outcomeUnknown", "refused"].contains(stage) else { throw TXBootstrapError.refused }
        try txRequire(txString(result, "keyReference") == txString(r, "keyReference"))
        let record = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest, "ownerEpoch": launch.binding.ownerEpoch,
            "grantSha256": try txString(r, "grantSha256"), "keyReference": try txString(r, "keyReference"), "stage": stage,
            "installed": stage == "publicKeyInstalled", "trustAccepted": false, "ready": false])
        try launch.pins["operation"]!.writeNew("key-install-result.json", record)
        return record
    }
}
