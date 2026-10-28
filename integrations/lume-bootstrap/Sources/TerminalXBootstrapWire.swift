// TerminalX restricted Lume candidate. No dependency/profile is adopted by this source.
import Foundation
import CryptoKit
import Darwin

enum TXBootstrapError: Error { case refused; case refusedAt(String, UInt) }
func txRequire(_ condition: Bool, file: String = #fileID, line: UInt = #line) throws {
    guard condition else { throw TXBootstrapError.refusedAt(file, line) }
}
func txDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
func txHex(_ value: String, bytes: Int = 32) throws -> Data {
    try txRequire(value.count == bytes * 2 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
    return Data(stride(from: 0, to: value.count, by: 2).map {
        let start = value.index(value.startIndex, offsetBy: $0)
        return UInt8(value[start..<value.index(start, offsetBy: 2)], radix: 16)!
    })
}
func txJSON(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
}
func txObject(_ data: Data, keys: Set<String>) throws -> [String: Any] {
    try txRequire(data.count <= 256 * 1024)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw TXBootstrapError.refused
    }
    // Canonical wire encoding also refuses duplicate keys and alternate spellings.
    try txRequire(Set(object.keys) == keys && txJSON(object) == data)
    return object
}
func txString(_ object: [String: Any], _ key: String) throws -> String {
    guard let result = object[key] as? String else { throw TXBootstrapError.refused }
    return result
}
func txTag(_ secret: Data, _ domain: String, _ parts: [String]) -> String {
    var message = Data()
    for part in ["terminalx-lume-owner-v1", domain] + parts {
        let bytes = Data(part.utf8)
        var length = UInt32(bytes.count).bigEndian
        withUnsafeBytes(of: &length) { message.append(contentsOf: $0) }
        message.append(bytes)
    }
    return HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: secret))
        .map { String(format: "%02x", $0) }.joined()
}
func txEqualTag(_ a: String, _ b: String) -> Bool {
    guard let a = try? txHex(a), let b = try? txHex(b) else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}
func txNonce() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    arc4random_buf(&bytes, bytes.count)
    return bytes.map { String(format: "%02x", $0) }.joined()
}

enum TXWire {
    static func configure(_ fd: Int32, inherited: Bool = false) throws {
        var kind: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        try txRequire(getsockopt(fd, SOL_SOCKET, SO_TYPE, &kind, &length) == 0 && kind == SOCK_STREAM)
        var uid = uid_t(0), gid = gid_t(0)
        try txRequire(getpeereid(fd, &uid, &gid) == 0 && uid == geteuid())
        if inherited {
            var pid = pid_t(0)
            length = socklen_t(MemoryLayout<pid_t>.size)
            try txRequire(fd > STDERR_FILENO && getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0 && pid == getppid())
        }
        try txRequire(fcntl(fd, F_SETFD, FD_CLOEXEC) == 0)
        let flags = fcntl(fd, F_GETFL)
        try txRequire(flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0)
        var yes: Int32 = 1
        try txRequire(setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0)
    }
    private static func wait(_ fd: Int32, _ event: Int16, _ deadline: UInt64) throws {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            try txRequire(now < deadline)
            var descriptor = pollfd(fd: fd, events: event, revents: 0)
            let result = poll(&descriptor, 1, Int32(max(1, (deadline - now) / 1_000_000)))
            if result < 0 && errno == EINTR { continue }
            try txRequire(result == 1 && descriptor.revents & event != 0)
            return
        }
    }
    private static func read(_ fd: Int32, _ count: Int, _ deadline: UInt64) throws -> Data {
        var result = Data(count: count)
        var offset = 0
        while offset < count {
            try wait(fd, Int16(POLLIN), deadline)
            let read = result.withUnsafeMutableBytes {
                Darwin.recv(fd, $0.baseAddress!.advanced(by: offset), count - offset, 0)
            }
            if read < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            try txRequire(read > 0)
            offset += read
        }
        return result
    }
    static func read(_ fd: Int32) throws -> Data {
        let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
        let prefix = try read(fd, 4, deadline)
        let count = prefix.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        try txRequire(count > 0 && count <= 256 * 1024)
        return try read(fd, Int(count), deadline)
    }
    static func write(_ fd: Int32, _ data: Data) throws {
        try txRequire(!data.isEmpty && data.count <= 256 * 1024)
        var count = UInt32(data.count).bigEndian
        var bytes = withUnsafeBytes(of: &count) { Data($0) }
        bytes.append(data)
        let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
        var offset = 0
        while offset < bytes.count {
            try wait(fd, Int16(POLLOUT), deadline)
            let written = bytes.withUnsafeBytes {
                Darwin.send(fd, $0.baseAddress!.advanced(by: offset), bytes.count - offset, 0)
            }
            if written < 0 && [EINTR, EAGAIN, EWOULDBLOCK].contains(errno) { continue }
            try txRequire(written > 0)
            offset += written
        }
    }
}
