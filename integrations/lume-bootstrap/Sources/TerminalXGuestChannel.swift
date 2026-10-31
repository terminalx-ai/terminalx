// VM-scoped observation only. VZ supplies no remote process/account attestation.
import Foundation
import Darwin

enum TXGuestProtocol {
    // Internal candidate protocol port, not a caller-selected network endpoint.
    static let port: UInt32 = 49871

    static func observe(fd: Int32, launch: TerminalXBootstrapLaunch, view: TXOwnedVM) throws {
        try txRequire(launch.binding.version == 2)
        try TXWire.configureStream(fd)
        try launch.check(); try view.check()
        let op = launch.pins["operation"]!
        let bytes = try op.receipt("expected-helper.json")
        try txRequire(txDigest(bytes) == launch.binding.helperManifestSha256)
        let plan = try txObject(bytes, keys: ["version", "binding", "accountName", "accountHome", "macosMajor", "helperSha256", "runtimeSha256", "accountIntentDigest"])
        try txRequire(plan["version"] as? Int == 2 && plan["macosMajor"] as? Int == 26)
        let hello = try txObject(TXWire.read(fd), keys: ["version", "clientNonce"])
        try txRequire(hello["version"] as? Int == 1)
        let clientNonce = try txString(hello, "clientNonce")
        _ = try txHex(clientNonce)
        let challenge = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest,
            "ownerEpoch": launch.binding.ownerEpoch, "clientNonce": clientNonce,
            "serverNonce": txNonce(), "planSha256": txDigest(bytes)])
        // Durable single original actor, before publishing a challenge or probe.
        // Partial/lost attempts remain fenced forever; no replacement handshake.
        try op.writeNew("guest-observation-intent.json", challenge)
        try launch.pins["input"]!.writeNew("guest-probe.json", challenge)
        try launch.check(); try view.check()
        try TXWire.write(fd, txJSON(["challenge": challenge.base64EncodedString(), "hostPlan": bytes.base64EncodedString()]))
        let reply = try txObject(TXWire.read(fd), keys: ["challengeSha256", "claims"])
        try txRequire(txString(reply, "challengeSha256") == txDigest(challenge))
        guard let claims = reply["claims"] as? [String: Any] else { throw TXBootstrapError.refused }
        try txRequire(Set(claims.keys) == ["accountName", "accountHome", "uid", "osVersion", "osBuild", "helperSha256", "input", "output"])
        try txRequire(txString(claims, "accountName") == txString(plan, "accountName")
            && txString(claims, "accountHome") == txString(plan, "accountHome")
            && txString(claims, "helperSha256") == txString(plan, "helperSha256"))
        guard let uid = claims["uid"] as? UInt32 else { throw TXBootstrapError.refused }
        try txRequire(uid >= 501)
        let version = try txString(claims, "osVersion").split(separator: ".", omittingEmptySubsequences: false)
        let build = try txString(claims, "osBuild")
        try txRequire((1...3).contains(version.count) && version.first == "26"
            && version.allSatisfy { !$0.isEmpty && $0.count <= 3 && $0.utf8.allSatisfy { (48...57).contains($0) } }
            && !build.isEmpty && build.count <= 32 && build.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) })
        var nodes: [String] = []
        for role in ["input", "output"] {
            guard let node = claims[role] as? [String: Any], Set(node.keys) == ["device", "inode"],
                  let device = node["device"] as? UInt64, let inode = node["inode"] as? UInt64 else { throw TXBootstrapError.refused }
            try txRequire(inode > 0)
            nodes.append("\(device):\(inode)")
        }
        try txRequire(nodes[0] != nodes[1])
        // This proves this connection's challenge traversed the pinned shares;
        // it does NOT prove which guest process/account performed that transfer.
        try launch.check(); try view.check()
        try txRequire(op.receipt("guest-observation-intent.json") == challenge
            && launch.pins["input"]!.receipt("guest-probe.json") == challenge
            && launch.pins["output"]!.receipt("guest-mount-echo.json") == challenge)
        let observation = try txJSON(["version": 1, "bindingDigest": launch.bindingDigest,
            "ownerEpoch": launch.binding.ownerEpoch, "challengeSha256": txDigest(challenge),
            "claims": claims, "vmRouteObserved": true, "shareRoundTripObserved": true,
            "accountAuthenticated": false, "helperAuthenticated": false, "trustAccepted": false, "ready": false])
        try op.writeNew("guest-observation.json", observation)
        try launch.check(); try view.check()
        try TXWire.write(fd, observation)
        // No account-manifest writer, authorized_keys effect or Ready transition.
    }
}

#if !TERMINALX_BOOTSTRAP_FIXTURES
import Virtualization

/// Only the exact live runtime device can enter the protocol. The private host
/// capability is never sent through this listener or any guest share.
final class TXGuestListener: NSObject, VZVirtioSocketListenerDelegate, @unchecked Sendable {
    private let launch: TerminalXBootstrapLaunch
    private let view: TXOwnedVM
    private let device: VZVirtioSocketDevice
    private let listener = VZVirtioSocketListener()
    private let lock = NSLock()
    private var claimed = false
    private init(launch: TerminalXBootstrapLaunch, view: TXOwnedVM, device: VZVirtioSocketDevice) {
        self.launch = launch; self.view = view; self.device = device
        super.init()
        listener.delegate = self
    }
    @MainActor
    static func install(launch: TerminalXBootstrapLaunch, view: TXOwnedVM, service: DarwinVirtualizationService) throws -> TXGuestListener {
        try launch.check(); try view.check()
        let handle = service.virtualMachineHandle
        return try handle.queue.sync {
            try txRequire(handle.machine.state == .running && handle.machine.socketDevices.count == 1)
            guard let device = handle.machine.socketDevices.first as? VZVirtioSocketDevice else { throw TXBootstrapError.refused }
            let result = TXGuestListener(launch: launch, view: view, device: device)
            device.setSocketListener(result.listener, forPort: TXGuestProtocol.port)
            return result
        }
    }
    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard listener === self.listener, socketDevice === device,
              connection.destinationPort == TXGuestProtocol.port, !claimed else { return false }
        claimed = true
        let retained = TXGuestConnection(connection)
        DispatchQueue(label: "terminalx.bootstrap.guest-observation").async { [self, retained] in
            defer { retained.connection.close() }
            try? TXGuestProtocol.observe(fd: retained.connection.fileDescriptor, launch: launch, view: view)
        }
        return true
    }
}
private final class TXGuestConnection: @unchecked Sendable {
    let connection: VZVirtioSocketConnection
    init(_ connection: VZVirtioSocketConnection) { self.connection = connection }
}
#endif
