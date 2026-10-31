// Disposable protocol process only. Never instantiates Virtualization or a VM.
import Foundation
import CryptoKit
import Darwin

@main struct FixtureMain {
    static func main() {
        do { try execute() } catch {
            FileHandle.standardError.write(Data("fixture refusal: \(error)\n".utf8))
            exit(2)
        }
    }
    static func execute() throws {
        if CommandLine.arguments.count == 4, CommandLine.arguments[2] == "guest-observe",
           let control = Int32(CommandLine.arguments[1]), let guest = Int32(CommandLine.arguments[3]) {
            let launch = try TerminalXBootstrapLaunch.receive(control)
            let view = TXOwnedVM.fixture {
                let path = launch.binding.paths["operation"]!.path + "/fixture-view.json"
                let data = try txObject(Data(contentsOf: URL(fileURLWithPath:path)), keys:["running", "shares"])
                try txRequire(data["running"] as? Bool == true)
                guard let values = data["shares"] as? [[String:Any]] else { throw TXBootstrapError.refused }
                try launch.validateMountedShares(values.map {
                    guard let ro = $0["readOnly"] as? Bool else { throw TXBootstrapError.refused }
                    return (try txString($0,"name"),try txString($0,"path"),ro)
                })
            }
            // Repeated connection on this one fixture descriptor exercises the
            // durable fence; real VZ delegate also rejects a competing actor.
            for _ in 0..<2 {
                do { try TXGuestProtocol.observe(fd:guest,launch:launch,view:view) }
                catch { FileHandle.standardError.write(Data("guest fixture refusal: \(error)\n".utf8)); break }
            }
            return
        }
        // <control-fd> guest-enroll <guest-fd>...: the real version-3 service, as
        // the VZ listener drives it, over each inherited stream in order.
        if CommandLine.arguments.count >= 4, CommandLine.arguments[2] == "guest-enroll",
           let control = Int32(CommandLine.arguments[1]) {
            let launch = try TerminalXBootstrapLaunch.receive(control)
            let operation = launch.binding.paths["operation"]!.path
            let view = TXOwnedVM.fixture {
                let data = try txObject(Data(contentsOf: URL(fileURLWithPath: operation + "/fixture-view.json")), keys: ["running", "shares"])
                try txRequire(data["running"] as? Bool == true)
            }
            let service = try TXEnrollmentService(launch: launch)
            for argument in CommandLine.arguments.dropFirst(3) {
                guard let fd = Int32(argument) else { throw TXBootstrapError.refused }
                if let attempt = service.admit() { service.run(fd: fd, attempt: attempt, view: view) }
                close(fd)
            }
            let state = service.gate.state
            print(String(decoding: try txJSON(["claimed": state.claimed, "refusals": state.refusals, "fenced": state.fenced,
                "sessionRetained": service.session != nil]), as: UTF8.self))
            return
        }
        // ssh-policy: the fixed options Lume's system ssh and scp fallback use.
        if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "ssh-policy" {
            print(String(decoding: try txJSON(["arguments": TerminalXSSHPolicy.arguments]), as: UTF8.self))
            return
        }
        // publish <owned directory> <count> <size>: the real TXPinnedPath.writeNew
        // for enrollment-attempt-N.json records, for reader-race and path tests.
        if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "publish",
           let count = Int(CommandLine.arguments[3]), let size = Int(CommandLine.arguments[4]) {
            let path = CommandLine.arguments[2]
            var metadata = stat()
            try txRequire(lstat(path, &metadata) == 0)
            let directory = try TXPinnedPath(TXPathPin(path: path, device: UInt64(metadata.st_dev), inode: UInt64(metadata.st_ino)), directory: true)
            for index in 0..<count {
                try directory.writeNew("enrollment-attempt-\(index).json", Data(repeating: UInt8(65 + index), count: size))
            }
            print(String(decoding: try txJSON(["written": count]), as: UTF8.self))
            return
        }
        // run <name> ... [--shared-dir input:ro --shared-dir receipt:rw] --terminalx-bootstrap-fd <fd>:
        // version 3 passes no share; versions 1 and 2 pass exactly these two.
        if [11, 15].contains(CommandLine.arguments.count), CommandLine.arguments[1] == "run" {
            let a = CommandLine.arguments
            try txRequire(a[3] == "--display" && a[4] == "none" && a[5] == "--vnc" && a[6] == "disabled"
                && a[7] == "--storage" && a[a.count - 2] == "--terminalx-bootstrap-fd")
            let cwd = FileManager.default.currentDirectoryPath
            let control = try txObject(Data(contentsOf: URL(fileURLWithPath: cwd + "/fixture-control.json")), keys: ["requests", "fault"])
            var shares: [(String, Bool)] = []
            if a.count == 15 {
                try txRequire(a[9] == "--shared-dir" && a[11] == "--shared-dir"
                    && a[10] == cwd + "/input:ro" && a[12] == cwd + "/receipt:rw")
                shares = [(cwd + "/input", true), (cwd + "/receipt", false)]
            }
            try txRequire(Set(ProcessInfo.processInfo.environment.keys).isSubset(of: ["PATH", "HOME", "TMPDIR", "LC_ALL", "__CF_USER_TEXT_ENCODING"]))
            let observed = try txJSON(["argv": Array(a.dropFirst()), "environment": ProcessInfo.processInfo.environment])
            try observed.write(to: URL(fileURLWithPath: cwd + "/fixture-exec.json"), options: .withoutOverwriting)
            guard let fd = Int32(a[a.count - 1]), let count = control["requests"] as? Int else { throw TXBootstrapError.refused }
            if try txString(control, "fault") == "beforeReceive" { return }
            try serve(fd, count, afterReceive: try txString(control, "fault") == "afterReceive", shares: shares)
            return
        }
        if CommandLine.arguments.count == 3, CommandLine.arguments[2] == "wire-backpressure",
           let fd = Int32(CommandLine.arguments[1]) {
            try TXWire.configure(fd, inherited: true)
            var size: Int32 = 1024
            try txRequire(setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size)) == 0)
            try TXWire.write(fd, Data(repeating: 65, count: 256 * 1024))
            return
        }
        // enroll-gate <0600 config path> <refusal limit> <fd>...: each inherited
        // stream is one attempt through the same gate. The key is read from the
        // private config file, never argv; output carries digests and states only.
        if CommandLine.arguments.count >= 5, CommandLine.arguments[1] == "enroll-gate",
           let limit = Int(CommandLine.arguments[3]) {
            let path = CommandLine.arguments[2]
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            try txRequire((attributes[.posixPermissions] as? Int) == 0o600)
            let config = try txObject(Data(contentsOf: URL(fileURLWithPath: path)), keys: ["key", "bootstrapId", "seedId",
                "bindingDigest", "ownerEpoch", "seedReceiptSha256", "journal"])
            let key = SymmetricKey(data: try txHex(txString(config, "key")))
            let binding = TXEnrollmentBinding(bootstrapId: try txString(config, "bootstrapId"), seedId: try txString(config, "seedId"),
                bindingDigest: try txString(config, "bindingDigest"), ownerEpoch: try txString(config, "ownerEpoch"),
                seedReceiptSha256: try txString(config, "seedReceiptSha256"))
            let journal = try txString(config, "journal")
            let gate = TXEnrollmentGate(limit: limit)
            for (index, argument) in CommandLine.arguments.dropFirst(4).enumerated() {
                guard let fd = Int32(argument) else { throw TXBootstrapError.refused }
                defer { close(fd) }
                var result: [String: Any] = ["attempt": index]
                if !gate.begin() {
                    result["admitted"] = false
                } else {
                    result["admitted"] = true
                    do {
                        let session = try TXEnrollment.accept(fd: fd, key: key, binding: binding) {
                            try $0.write(to: URL(fileURLWithPath: "\(journal)/challenge-\(index).json"), options: .withoutOverwriting)
                        }
                        gate.finish(authenticated: true)
                        result["authenticated"] = true
                        result["challengeSha256"] = session.challengeSha256
                        result["claims"] = session.claims
                        do {
                            let body = try session.receive(fd)
                            try session.send(fd, ["echo": body])
                        } catch { result["sessionError"] = "\(error)" }
                        result["sent"] = session.sent
                        result["received"] = session.received
                    } catch {
                        gate.finish(authenticated: false)
                        result["authenticated"] = false
                        result["error"] = "\(error)"
                    }
                }
                print(String(decoding: try txJSON(result), as: UTF8.self))
            }
            let state = gate.state
            print(String(decoding: try txJSON(["claimed": state.claimed, "refusals": state.refusals, "fenced": state.fenced]), as: UTF8.self))
            return
        }
        // <control-fd> <requests> guest <guest-fd> <wait-seconds>: the owner
        // channel and a version-3 enrollment session in one owner, as in a VM.
        if CommandLine.arguments.count == 6, CommandLine.arguments[3] == "guest",
           let fd = Int32(CommandLine.arguments[1]), let requests = Int(CommandLine.arguments[2]),
           let guest = Int32(CommandLine.arguments[4]), let wait = Double(CommandLine.arguments[5]) {
            try serve(fd, requests, afterReceive: false, guest: (guest, wait))
            return
        }
        guard CommandLine.arguments.count == 3,
              let fd = Int32(CommandLine.arguments[1]), let requests = Int(CommandLine.arguments[2]),
              requests > 0 && requests < 100 else { throw TXBootstrapError.refused }
        try serve(fd, requests, afterReceive: false)
    }
    static func serve(_ fd: Int32, _ requests: Int, afterReceive: Bool, guest: (Int32, Double)? = nil,
                      shares: [(String, Bool)]? = nil) throws {
        let launch = try TerminalXBootstrapLaunch.receive(fd)
        if afterReceive { return }
        // As the patched `run` checks its --shared-dir list before starting the VM.
        if let shares { try launch.validateShares(shares) }
        try launch.validateVM(configPath: launch.binding.paths["config"]!.path,
            diskPath: launch.binding.paths["disk"]!.path, nvramPath: launch.binding.paths["nvram"]!.path,
            loadedConfig: launch.pins["config"]!.bytes(limit: 64 * 1024))
        let operation = launch.binding.paths["operation"]!.path
        let view = TXOwnedVM.fixture {
            // Only a test binary has this factory. No live guest/account access.
            let bytes = try Data(contentsOf: URL(fileURLWithPath: operation + "/fixture-view.json"))
            let object = try txObject(bytes, keys: ["running", "shares"])
            try txRequire(object["running"] as? Bool == true)
            guard let values = object["shares"] as? [[String: Any]] else { throw TXBootstrapError.refused }
            let shares = try values.map { value -> (String, String, Bool) in
                guard let readOnly = value["readOnly"] as? Bool else { throw TXBootstrapError.refused }
                return (try txString(value, "name"), try txString(value, "path"), readOnly)
            }
            try launch.validateMountedShares(shares)
        }
        let lease = launch.pins["config"]!.fd
        try txRequire(flock(lease, LOCK_EX | LOCK_NB) == 0)
        try TerminalXBootstrapPolicy.validate(display: "none", vnc: false, clipboard: false, detach: false, extras: false)
        for index in 0..<5 {
            var denied = false
            do {
                try TerminalXBootstrapPolicy.validate(display: index == 0 ? "native" : "none", vnc: index == 1,
                    clipboard: index == 2, detach: index == 3, extras: index == 4)
            } catch { denied = true }
            try txRequire(denied)
        }
        var enrollment: TXEnrollmentService?
        if let (guestFd, wait) = guest {
            let service = try TXEnrollmentService(launch: launch, confirmationWait: wait)
            enrollment = service
            Thread {
                if let attempt = service.admit() { service.run(fd: guestFd, attempt: attempt, view: view) }
                close(guestFd)
            }.start()
        }
        try TerminalXBootstrapOwner.fixture(launch: launch, view: view, configLease: lease, maximum: requests, enrollment: enrollment)
    }
}
