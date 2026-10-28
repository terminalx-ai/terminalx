import Foundation
import Darwin

struct TXPathPin: Codable, Equatable {
    let path: String
    let device: UInt64
    let inode: UInt64
}
final class TXDescriptor: @unchecked Sendable {
    let raw: Int32
    init(_ raw: Int32) throws { try txRequire(raw >= 0); self.raw = raw }
    deinit { Darwin.close(raw) }
}

// Retained descriptors, never a caller-selected path on a control request.
final class TXPinnedPath: @unchecked Sendable {
    let pin: TXPathPin
    private let descriptor: TXDescriptor
    var fd: Int32 { descriptor.raw }
    private let directory: Bool
    init(_ pin: TXPathPin, directory: Bool) throws {
        self.pin = pin
        self.directory = directory
        try txRequire(pin.path.hasPrefix("/") && pin.path.utf8.allSatisfy { $0 >= 32 && $0 < 127 })
        descriptor = try TXDescriptor(Darwin.open(pin.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (directory ? O_DIRECTORY : 0)))
        try check()
    }
    func check() throws {
        var opened = stat(), named = stat()
        try txRequire(fstat(fd, &opened) == 0 && lstat(pin.path, &named) == 0)
        let type = directory ? S_IFDIR : S_IFREG
        try txRequire(opened.st_mode & S_IFMT == type && named.st_mode & S_IFMT == type)
        try txRequire(UInt64(opened.st_dev) == pin.device && UInt64(opened.st_ino) == pin.inode)
        try txRequire(opened.st_dev == named.st_dev && opened.st_ino == named.st_ino)
        try txRequire(opened.st_uid == geteuid() && opened.st_mode & (directory ? 0o077 : 0o022) == 0)
        try txRequire(directory || opened.st_nlink == 1)
        guard let canonical = realpath(pin.path, nil) else { throw TXBootstrapError.refused }
        defer { free(canonical) }
        try txRequire(String(cString: canonical) == pin.path)
    }
    func bytes(limit: Int) throws -> Data {
        try check()
        let data = try Self.read(fd, limit: limit)
        try check()
        return data
    }
    static func read(_ fd: Int32, limit: Int) throws -> Data {
        var metadata = stat()
        try txRequire(fstat(fd, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFREG
            && metadata.st_nlink == 1 && metadata.st_uid == geteuid()
            && metadata.st_mode & 0o022 == 0 && metadata.st_size >= 0 && metadata.st_size <= limit)
        var bytes = Data(count: Int(metadata.st_size))
        var offset = 0
        while offset < bytes.count {
            let remaining = bytes.count - offset
            let count = bytes.withUnsafeMutableBytes {
                pread(fd, $0.baseAddress!.advanced(by: offset), remaining, off_t(offset))
            }
            try txRequire(count > 0)
            offset += count
        }
        var after = stat()
        try txRequire(fstat(fd, &after) == 0 && after.st_size == metadata.st_size
            && after.st_uid == metadata.st_uid && after.st_nlink == 1 && after.st_mode & 0o022 == 0
            && after.st_mtimespec.tv_sec == metadata.st_mtimespec.tv_sec
            && after.st_mtimespec.tv_nsec == metadata.st_mtimespec.tv_nsec)
        return bytes
    }
    func receipt(_ name: String) throws -> Data {
        try txRequire(directory && ["account-receipt.json", "public-key-receipt.json", "owner-intent.json", "owner-started.json"].contains(name))
        try check()
        let child = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        try txRequire(child >= 0)
        defer { Darwin.close(child) }
        let data = try Self.read(child, limit: 64 * 1024)
        var opened = stat(), named = stat()
        try txRequire(fstat(child, &opened) == 0 && fstatat(fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0
            && opened.st_ino == named.st_ino && opened.st_dev == named.st_dev
            && named.st_mode & S_IFMT == S_IFREG && named.st_mode & 0o077 == 0
            && named.st_uid == geteuid() && opened.st_nlink == 1)
        try check()
        return data
    }
    func arm(_ bytes: Data) throws {
        try check()
        let file = try TXDescriptor(openat(fd, "owner-started.json", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        let written = bytes.withUnsafeBytes { Darwin.write(file.raw, $0.baseAddress, $0.count) }
        try txRequire(written == bytes.count && fsync(file.raw) == 0 && fsync(fd) == 0)
        try check()
        // Any prefix/missing result is fenced by O_EXCL on a later attempt.
    }
}

struct TXBinding: Codable {
    let version: Int
    let macosMajor: Int
    let bootstrapId: String
    let ownerEpoch: String
    let nonce: String
    let environmentId: String
    let generation: String
    let vmFingerprint: String
    let restoreSha256: String
    let runtimeSha256: String
    let helperManifestSha256: String
    let executableSha256: String
    let parentSession: String
    let parentTab: String
    let parentConversation: String
    let inputShareId: String
    let outputShareId: String
    let configSha256: String
    let paths: [String: TXPathPin]
    static let roles: Set<String> = ["operation", "storage", "vm", "config", "disk", "nvram", "input", "output"]
    static let keys: Set<String> = ["version", "macosMajor", "bootstrapId", "ownerEpoch", "nonce", "environmentId", "generation", "vmFingerprint", "restoreSha256", "runtimeSha256", "helperManifestSha256", "executableSha256", "parentSession", "parentTab", "parentConversation", "inputShareId", "outputShareId", "configSha256", "paths"]
    static func decode(_ bytes: Data) throws -> Self {
        let object = try txObject(bytes, keys: keys)
        guard let paths = object["paths"] as? [String: [String: Any]] else { throw TXBootstrapError.refused }
        try txRequire(Set(paths.keys) == roles)
        for pin in paths.values { try txRequire(Set(pin.keys) == ["path", "device", "inode"]) }
        let binding = try JSONDecoder().decode(Self.self, from: bytes)
        try txRequire(binding.version == 1 && binding.macosMajor == 26 && !binding.parentConversation.isEmpty && binding.parentConversation.utf8.count <= 256
            && binding.parentConversation.utf8.allSatisfy { $0 >= 32 && $0 < 127 })
        for id in [binding.bootstrapId, binding.ownerEpoch, binding.environmentId, binding.generation,
                   binding.parentSession, binding.parentTab, binding.inputShareId, binding.outputShareId] {
            try txRequire(UUID(uuidString: id) != nil)
        }
        for hash in [binding.nonce, binding.vmFingerprint, binding.restoreSha256, binding.runtimeSha256,
                     binding.helperManifestSha256, binding.executableSha256, binding.configSha256] { _ = try txHex(hash) }
        try txRequire(binding.inputShareId != binding.outputShareId
            && Set(binding.paths.values.map { "\($0.device):\($0.inode)" }).count == roles.count)
        let vm = binding.paths["vm"]!.path
        try txRequire(URL(fileURLWithPath: vm).deletingLastPathComponent().path == binding.paths["storage"]!.path)
        for (role, name) in [("config", "config.json"), ("disk", "disk.img"), ("nvram", "nvram.bin")] {
            try txRequire(binding.paths[role]!.path == vm + "/" + name)
        }
        let operation = binding.paths["operation"]!.path
        try txRequire(binding.paths["input"]!.path == operation + "/input"
            && binding.paths["output"]!.path == operation + "/receipt"
            && !vm.hasPrefix(operation + "/") && !operation.hasPrefix(vm + "/"))
        return binding
    }
}
