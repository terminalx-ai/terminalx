import Foundation
import Darwin

enum TerminalXBootstrapPolicy {
    static func validate(display: String, vnc: Bool, clipboard: Bool, detach: Bool, extras: Bool) throws {
        // The private VNC listener's bind contract is unverified. Disabling it
        // also makes secret distribution/logging unreachable; no proxy loophole.
        try txRequire(display == "none" && !vnc && !clipboard && !detach && !extras)
    }
}

/// Only inherited IPC establishes launch authority. Neither a pathname nor a
/// request-provided `proof` can construct this object. No command runs here.
final class TerminalXBootstrapLaunch: @unchecked Sendable {
    let binding: TXBinding
    let bindingDigest: String
    let pins: [String: TXPinnedPath]
    fileprivate let capability: Data
    private let inherited: TXDescriptor
    private var armed = false
    private init(binding: TXBinding, raw: Data, capability: Data, inherited: TXDescriptor) throws {
        self.binding = binding
        self.bindingDigest = txDigest(raw)
        self.capability = capability
        self.inherited = inherited
        var pins: [String: TXPinnedPath] = [:]
        for (role, pin) in binding.paths {
            pins[role] = try TXPinnedPath(pin, directory: ["operation", "storage", "vm", "input", "output"].contains(role))
        }
        self.pins = pins
        try check()
        try txRequire(pins["operation"]!.receipt("owner-intent.json") == raw)
        try pins["operation"]!.arm(startRecord())
        armed = true
    }
    static func receive(_ fd: Int32) throws -> TerminalXBootstrapLaunch {
        try txRequire(fd > STDERR_FILENO)
        let inherited = try TXDescriptor(fd)
        try TXWire.configure(fd, inherited: true)
        let packet = try txObject(TXWire.read(fd), keys: ["binding", "capability"])
        guard let raw = Data(base64Encoded: try txString(packet, "binding")),
              let secret = Data(base64Encoded: try txString(packet, "capability")) else { throw TXBootstrapError.refused }
        try txRequire(secret.count == 32 && raw.count <= 32 * 1024)
        let binding = try TXBinding.decode(raw)
        guard let exe = Bundle.main.executableURL else { throw TXBootstrapError.refused }
        var metadata = stat()
        try txRequire(lstat(exe.path, &metadata) == 0)
        let executable = try TXPinnedPath(TXPathPin(path: exe.path, device: UInt64(metadata.st_dev), inode: UInt64(metadata.st_ino)), directory: false)
        try txRequire(txDigest(executable.bytes(limit: 256 * 1024 * 1024)) == binding.executableSha256)
        return try TerminalXBootstrapLaunch(binding: binding, raw: raw, capability: secret, inherited: inherited)
    }
    func check() throws {
        for pin in pins.values { try pin.check() }
        try txRequire(txDigest(pins["config"]!.bytes(limit: 64 * 1024)) == binding.configSha256)
        try txRequire(txDigest(pins["operation"]!.receipt("owner-intent.json")) == bindingDigest)
        if armed { try txRequire(pins["operation"]!.receipt("owner-started.json") == startRecord()) }
    }
    private func startRecord() throws -> Data {
        try txJSON(["bindingDigest": bindingDigest, "epoch": binding.ownerEpoch, "ownerPid": getpid()])
    }
    func validateVM(configPath: String, diskPath: String, nvramPath: String, loadedConfig: Data) throws {
        try check()
        try txRequire(configPath == binding.paths["config"]!.path && diskPath == binding.paths["disk"]!.path
            && nvramPath == binding.paths["nvram"]!.path)
        // Refuse a stale in-memory config or ignored/unsupported config fields.
        let retained = try JSONSerialization.jsonObject(with: pins["config"]!.bytes(limit: 64 * 1024)) as? NSDictionary
        let loaded = try JSONSerialization.jsonObject(with: loadedConfig) as? NSDictionary
        try txRequire(retained != nil && loaded != nil && retained!.isEqual(loaded!))
    }
    func validateShares(_ actual: [(String, Bool)]) throws {
        try check()
        try txRequire(actual.count == 2)
        let expected = [(binding.paths["input"]!.path, true), (binding.paths["output"]!.path, false)]
        try txRequire(Set(actual.map { "\($0.0):\($0.1)" }) == Set(expected.map { "\($0.0):\($0.1)" }))
    }
    func validateMountedShares(_ actual: [(String, String, Bool)]) throws {
        try check()
        try txRequire(actual.count == 2)
        for (name, role, readOnly) in [("input", "input", true), ("receipt", "output", false)] {
            let matching = actual.filter { $0.0 == name && $0.1 == binding.paths[role]!.path && $0.2 == readOnly }
            try txRequire(matching.count == 1)
        }
    }
    func validateLease(_ fd: Int32) throws {
        var metadata = stat()
        try check()
        try txRequire(fstat(fd, &metadata) == 0 && UInt64(metadata.st_dev) == binding.paths["config"]!.device
            && UInt64(metadata.st_ino) == binding.paths["config"]!.inode)
    }
    fileprivate func announced(socket: TXPathPin) throws {
        let body = try txJSON(["bindingDigest": bindingDigest, "epoch": binding.ownerEpoch,
                               "socketDevice": socket.device, "socketInode": socket.inode,
                               "ownerPid": getpid(), "consoleAvailable": false])
        try TXWire.write(inherited.raw, txJSON(["payload": body.base64EncodedString(),
            "mac": txTag(capability, "launch", [txDigest(body)])]))
    }
}

/// No arbitrary observer callback or serialized VM proof can construct a view.
/// The real factory is in the VZ adapter; the only fake factory is compile-gated.
final class TXOwnedVM: @unchecked Sendable {
    private let observation: @Sendable () throws -> Void
    fileprivate init(observation: @escaping @Sendable () throws -> Void) { self.observation = observation }
    func check() throws { try observation() }
    #if TERMINALX_BOOTSTRAP_FIXTURES
    static func fixture(_ observation: @escaping @Sendable () throws -> Void) -> TXOwnedVM {
        TXOwnedVM(observation: observation)
    }
    #endif
}

final class TerminalXBootstrapOwner: @unchecked Sendable {
    private let launch: TerminalXBootstrapLaunch
    private let view: TXOwnedVM
    private let listenerHandle: TXDescriptor
    private var listener: Int32 { listenerHandle.raw }
    private let socket: TXPathPin
    private let state = NSLock()
    private var closed = false
    private var guestListener: AnyObject?
    // The original config lock's open description is held, never re-created.
    private let configLease: TXDescriptor
    private init(launch: TerminalXBootstrapLaunch, view: TXOwnedVM, configLease: Int32) throws {
        self.launch = launch
        self.view = view
        self.configLease = try TXDescriptor(dup(configLease))
        _ = fcntl(self.configLease.raw, F_SETFD, FD_CLOEXEC)
        var lease = stat()
        try txRequire(fstat(self.configLease.raw, &lease) == 0
            && UInt64(lease.st_dev) == launch.binding.paths["config"]!.device
            && UInt64(lease.st_ino) == launch.binding.paths["config"]!.inode)
        try launch.check()
        try view.check()
        let path = launch.binding.paths["operation"]!.path + "/owner.sock"
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        try txRequire(path.utf8.count < MemoryLayout.size(ofValue: address.sun_path))
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: Array(path.utf8) + [0])
        }
        var previous = stat()
        try txRequire(lstat(path, &previous) != 0 && errno == ENOENT)
        let listenerHandle = try TXDescriptor(Darwin.socket(AF_UNIX, SOCK_STREAM, 0))
        self.listenerHandle = listenerHandle
        let listener = listenerHandle.raw
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, size) }
        }
        try txRequire(bound == 0 && chmod(path, 0o600) == 0 && listen(listener, 4) == 0)
        _ = fcntl(listener, F_SETFD, FD_CLOEXEC)
        _ = fcntl(listener, F_SETFL, O_NONBLOCK)
        var metadata = stat()
        try txRequire(lstat(path, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFSOCK
            && metadata.st_uid == geteuid() && metadata.st_mode & 0o077 == 0 && metadata.st_nlink == 1)
        socket = TXPathPin(path: path, device: UInt64(metadata.st_dev), inode: UInt64(metadata.st_ino))
        try launch.check()
        try launch.announced(socket: socket)
    }
    private func check() throws {
        state.lock(); let closed = closed; state.unlock()
        try txRequire(!closed)
        try launch.check()
        try view.check()
        var metadata = stat()
        try txRequire(lstat(socket.path, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFSOCK
            && UInt64(metadata.st_dev) == socket.device && UInt64(metadata.st_ino) == socket.inode
            && metadata.st_uid == geteuid() && metadata.st_mode & 0o077 == 0 && metadata.st_nlink == 1)
    }
    func close() {
        state.lock(); closed = true; state.unlock()
        // No unlink, replacement, signal, VM action or claim of owner exit.
        _ = shutdown(listener, SHUT_RDWR)
    }
    private func connection(_ fd: Int32) throws {
        try TXWire.configure(fd)
        try check()
        let request = try txObject(TXWire.read(fd), keys: ["action", "bindingDigest", "clientNonce", "requestId"])
        let action = try txString(request, "action")
        let requestId = try txString(request, "requestId")
        let clientNonce = try txString(request, "clientNonce")
        _ = try txHex(clientNonce)
        try txRequire(UUID(uuidString: requestId) != nil && ["observe", "accountReceipt", "keyReceipt", "guestObservation"].contains(action)
            && txString(request, "bindingDigest") == launch.bindingDigest)
        let nonce = txNonce()
        let parts = [launch.bindingDigest, launch.binding.ownerEpoch, action, requestId, clientNonce, nonce]
        try TXWire.write(fd, txJSON(["serverNonce": nonce, "epoch": launch.binding.ownerEpoch,
                                    "mac": txTag(launch.capability, "owner", parts)]))
        let auth = try txObject(TXWire.read(fd), keys: ["mac"])
        try txRequire(txEqualTag(txString(auth, "mac"), txTag(launch.capability, "host", parts)))
        try check()
        let receipt: Data
        if launch.binding.version == 2 && ["accountReceipt", "keyReceipt"].contains(action) { throw TXBootstrapError.refused }
        switch action {
        case "guestObservation": receipt = try launch.pins["operation"]!.receipt("guest-observation.json")
        case "accountReceipt": receipt = try launch.pins["output"]!.receipt("account-receipt.json")
        case "keyReceipt": receipt = try launch.pins["output"]!.receipt("public-key-receipt.json")
        default: receipt = Data()
        }
        try check()
        let payload = try txJSON(["bindingDigest": launch.bindingDigest, "epoch": launch.binding.ownerEpoch,
            "requestId": requestId, "action": action, "receipt": receipt.base64EncodedString(),
            "receiptSha256": txDigest(receipt), "consoleAvailable": false, "ready": false])
        try TXWire.write(fd, txJSON(["payload": payload.base64EncodedString(),
                                    "mac": txTag(launch.capability, "receipt", parts + [txDigest(payload)])]))
    }
    private func serve(maximum: Int?) {
        var count = 0
        let fixtureDeadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        while maximum == nil || count < maximum! {
            if maximum != nil && DispatchTime.now().uptimeNanoseconds > fixtureDeadline { break }
            state.lock(); let closed = closed; state.unlock()
            if closed { break }
            var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            if poll(&descriptor, 1, 100) <= 0 { continue }
            let fd = accept(listener, nil, nil)
            if fd < 0 { continue }
            // Refusals never print request contents, capabilities or receipts.
            do { try connection(fd) } catch { }
            Darwin.close(fd)
            count += 1
        }
    }
    fileprivate static func start(launch: TerminalXBootstrapLaunch, view: TXOwnedVM, configLease: Int32) throws -> TerminalXBootstrapOwner {
        let owner = try TerminalXBootstrapOwner(launch: launch, view: view, configLease: configLease)
        DispatchQueue(label: "terminalx.bootstrap.owner").async { owner.serve(maximum: nil) }
        return owner
    }
    #if TERMINALX_BOOTSTRAP_FIXTURES
    static func fixture(launch: TerminalXBootstrapLaunch, view: TXOwnedVM, configLease: Int32, maximum: Int) throws {
        let owner = try TerminalXBootstrapOwner(launch: launch, view: view, configLease: configLease)
        owner.serve(maximum: maximum)
    }
    #endif
}

#if !TERMINALX_BOOTSTRAP_FIXTURES
import Virtualization

extension TerminalXBootstrapOwner {
    /// Runs in the actual VM-owning process. Neither RPC nor JSON can supply
    /// this VZ object, its queue, the live shares or the retained config lease.
    @MainActor
    static func attach(launch: TerminalXBootstrapLaunch, service: DarwinVirtualizationService, configLease: Int32) throws -> TerminalXBootstrapOwner {
        let handle = service.virtualMachineHandle
        let view = TXOwnedVM {
            try handle.queue.sync {
                try txRequire(handle.machine.state == .running)
                let devices = handle.machine.directorySharingDevices
                try txRequire(devices.count == 1)
                guard let fs = devices.first as? VZVirtioFileSystemDevice,
                      fs.tag == VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag,
                      let shares = fs.share as? VZMultipleDirectoryShare else { throw TXBootstrapError.refused }
                try launch.validateMountedShares(shares.directories.map { ($0.key, $0.value.url.path, $0.value.isReadOnly) })
            }
        }
        let owner = try start(launch: launch, view: view, configLease: configLease)
        if launch.binding.version == 2 {
            let guestView = TXOwnedVM { [weak owner] in
                guard let owner else { throw TXBootstrapError.refused }
                try owner.check()
            }
            owner.guestListener = try TXGuestListener.install(launch: launch, view: guestView, service: service)
        }
        return owner
    }
}
#endif
