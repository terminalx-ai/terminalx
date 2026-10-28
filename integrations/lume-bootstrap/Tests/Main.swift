// Disposable protocol process only. Never instantiates Virtualization or a VM.
import Foundation
import Darwin

@main struct FixtureMain {
    static func main() {
        do { try execute() } catch {
            FileHandle.standardError.write(Data("fixture refusal: \(error)\n".utf8))
            exit(2)
        }
    }
    static func execute() throws {
        if CommandLine.arguments.count == 15, CommandLine.arguments[1] == "run" {
            let a = CommandLine.arguments
            try txRequire(a[3] == "--display" && a[4] == "none" && a[5] == "--vnc" && a[6] == "disabled"
                && a[7] == "--storage" && a[9] == "--shared-dir" && a[11] == "--shared-dir" && a[13] == "--terminalx-bootstrap-fd")
            let cwd = FileManager.default.currentDirectoryPath
            let control = try txObject(Data(contentsOf: URL(fileURLWithPath: cwd + "/fixture-control.json")), keys: ["requests", "fault"])
            try txRequire(a[10] == cwd + "/input:ro" && a[12] == cwd + "/receipt:rw")
            try txRequire(Set(ProcessInfo.processInfo.environment.keys).isSubset(of: ["PATH", "HOME", "TMPDIR", "LC_ALL", "__CF_USER_TEXT_ENCODING"]))
            let observed = try txJSON(["argv": Array(a.dropFirst()), "environment": ProcessInfo.processInfo.environment])
            try observed.write(to: URL(fileURLWithPath: cwd + "/fixture-exec.json"), options: .withoutOverwriting)
            guard let fd = Int32(a[14]), let count = control["requests"] as? Int else { throw TXBootstrapError.refused }
            if try txString(control, "fault") == "beforeReceive" { return }
            try serve(fd, count, afterReceive: try txString(control, "fault") == "afterReceive")
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
        guard CommandLine.arguments.count == 3,
              let fd = Int32(CommandLine.arguments[1]), let requests = Int(CommandLine.arguments[2]),
              requests > 0 && requests < 100 else { throw TXBootstrapError.refused }
        try serve(fd, requests, afterReceive: false)
    }
    static func serve(_ fd: Int32, _ requests: Int, afterReceive: Bool) throws {
        let launch = try TerminalXBootstrapLaunch.receive(fd)
        if afterReceive { return }
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
        try TerminalXBootstrapOwner.fixture(launch: launch, view: view, configLease: lease, maximum: requests)
    }
}
