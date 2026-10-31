#!/usr/bin/env python3
"""Render the reviewable candidate from exact retained upstream source; no install."""
import difflib
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
BASE = "3350f504014c85416009a90fcb339fe556ce02fc"
PINS = {
    "Package.swift": "2c0520b2c097ace92be3a8312c7a3ca722141f825e9281807df7a9396a42cb7b",
    "src/Commands/Run.swift": "f7946c96b086115f92ea3dde118249417624ccb1e94c211fe7c9a4c5e38c229e",
    "src/LumeController.swift": "dc492065d56dec99ac1e6224c03f0486eb3252e088b44a47cdeac052cb82edcb",
    "src/VM/VM.swift": "fef4b8760d61947078575931a37bda0b2625104363f915c8a0d46712696b5b15",
    "src/Virtualization/VMVirtualizationService.swift": "93b81a4d30d5cfe15ee893ba675d9b0fb2a4ac9b1976cb7dee976708847c88e0",
}

def render(base):
    original = {}
    for path, digest in PINS.items():
        data = (base / path).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"Not the pinned Lume source: {path}")
        original[path] = data.decode()
    changed = dict(original)
    def edit(path, old, new, count=1):
        if changed[path].count(old) != count:
            raise ValueError(f"Upstream seam differs: {path}: {old[:80]}")
        changed[path] = changed[path].replace(old, new)

    run = "src/Commands/Run.swift"
    edit(run, "    private var parsedNetworkMode: NetworkMode? {", '''    // Candidate-only private launch channel. Never a token, URL or proof in argv.
    @Option(name: .customLong("terminalx-bootstrap-fd"), help: .hidden)
    var terminalXBootstrapFD: Int32?

    private var parsedNetworkMode: NetworkMode? {''')
    edit(run, "    func validate() throws {", '''    func validate() throws {
        if terminalXBootstrapFD != nil {
            try TerminalXBootstrapPolicy.validate(
                display: DisplayMode.resolve(requested: display, noDisplay: noDisplay).rawValue,
                vnc: vnc.isEnabled, clipboard: clipboard, detach: detach,
                extras: mount != nil || recoveryMode || !usbStorageDevices.isEmpty || !additionalDisks.isEmpty
                    || diskPath != nil || nvramPath != nil || network != nil || vncPort != 0 || vncPassword != nil)
        }''')
    edit(run, "            vncPolicy: vnc\n", "            vncPolicy: vnc,\n            terminalXBootstrapFD: terminalXBootstrapFD\n")

    controller = "src/LumeController.swift"
    edit(controller, "        telemetryTransport: TelemetryTransport = .cli\n    ) async throws {\n        let normalizedName = normalizeVMName(name: name)", '''        telemetryTransport: TelemetryTransport = .cli,
        terminalXBootstrapFD: Int32? = nil
    ) async throws {
        let bootstrap = try terminalXBootstrapFD.map { try TerminalXBootstrapLaunch.receive($0) }
        if bootstrap != nil {
            try TerminalXBootstrapPolicy.validate(display: (displayMode ?? (noDisplay ? .none : .vnc)).rawValue,
                vnc: vncPolicy.isEnabled, clipboard: clipboard, detach: false,
                extras: mount != nil || recoveryMode || !(usbMassStoragePaths ?? []).isEmpty
                    || !(additionalDiskPaths ?? []).isEmpty || networkMode != nil || diskPath != nil
                    || nvramPath != nil || vncPort != 0 || vncPassword != nil)
            // No image auto-pull, normalization/rebinding or implicit storage.
            try txRequire(!name.isEmpty && name.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 })
            try txRequire(storage?.hasPrefix("/") == true)
            try txRequire(storage! + "/" + name == bootstrap!.binding.paths["vm"]!.path)
        }
        let normalizedName = normalizeVMName(name: name)''')
    edit(controller, "            SharedVM.shared.setVM(name: normalizedName, vm: vm)\n            try await vm.run(", "            if bootstrap == nil { SharedVM.shared.setVM(name: normalizedName, vm: vm) }\n            try await vm.run(")
    edit(controller, "                vncPolicy: vncPolicy)\n            Logger.info(\"VM started successfully\"", "                vncPolicy: vncPolicy, terminalXBootstrap: bootstrap)\n            Logger.info(\"VM started successfully\"")
    edit(controller, '            SharedVM.shared.removeVM(name: normalizedName)\n            Logger.error("Failed to run VM"', '            if bootstrap == nil { SharedVM.shared.removeVM(name: normalizedName) }\n            Logger.error("Failed to run VM"')

    vm = "src/VM/VM.swift"
    edit(vm, "    private var clipboardWatcher: ClipboardWatcher?", "    private var terminalXBootstrapMode = false\n    private var terminalXBootstrapOwner: TerminalXBootstrapOwner?\n    private var clipboardWatcher: ClipboardWatcher?")
    edit(vm, "        vncPolicy: VNCPolicy = .enabled\n    ) async throws {", "        vncPolicy: VNCPolicy = .enabled,\n        terminalXBootstrap bootstrap: TerminalXBootstrapLaunch? = nil\n    ) async throws {")
    edit(vm, "        // Defense in depth: the CLI", '''        terminalXBootstrapMode = bootstrap != nil
        if let bootstrap {
            try TerminalXBootstrapPolicy.validate(display: displayMode.rawValue, vnc: vncPolicy.isEnabled,
                clipboard: clipboard, detach: false, extras: mount != nil || recoveryMode
                    || !(usbMassStoragePaths ?? []).isEmpty || !(additionalDiskPaths ?? []).isEmpty
                    || networkMode != nil || vncPort != 0 || vncPassword != nil)
            try txRequire(getOSType() == "macOS")
            try bootstrap.validateVM(configPath: vmDirContext.dir.configPath.path,
                diskPath: vmDirContext.diskPath.path, nvramPath: vmDirContext.nvramPath.path,
                loadedConfig: JSONEncoder().encode(vmDirContext.config))
            try bootstrap.validateShares(sharedDirectories.map { ($0.hostPath, $0.readOnly) })
        }
        // Defense in depth: the CLI''')
    edit(vm, "            // Try to forcibly clear the lock before giving up", "            // Bootstrap never clears/replaces an unproven owner's run lease.\n            if bootstrap != nil { throw VMError.alreadyRunning(vmDirContext.name) }\n\n            // Try to forcibly clear the lock before giving up")
    edit(vm, '        Logger.info("Successfully acquired lock", metadata: ["name": vmDirContext.name])', '        try bootstrap?.validateLease(fileHandle.fileDescriptor)\n        Logger.info("Successfully acquired lock", metadata: ["name": vmDirContext.name])')
    edit(vm, '''            try? FileManager.default.removeItem(
                at: lumeConfigDir.appendingPathComponent("vnc.env"))
            var allSharedDirectories = sharedDirectories''', '''            if bootstrap == nil {
                try? FileManager.default.removeItem(at: lumeConfigDir.appendingPathComponent("vnc.env"))
            }
            var allSharedDirectories = sharedDirectories''', count=1)
    # All three branches in the main run method are guarded; unrelated legacy
    # USB/recovery run code remains unchanged and is inadmissible in this mode.
    start = changed[vm].index("    func run(")
    end = changed[vm].index("    private func showNativeDisplay()", start)
    body = changed[vm][start:end]
    assert body.count("if vncPolicy.isEnabled {") == 2
    body = body.replace("if vncPolicy.isEnabled {", "if bootstrap == nil && vncPolicy.isEnabled {")
    body = body.replace("let config = try createVMVirtualizationServiceContext(", "var config = try createVMVirtualizationServiceContext(")
    body = body.replace("            virtualizationService = try virtualizationServiceFactory(config)", "            config.terminalXBootstrapMode = bootstrap != nil\n            try bootstrap?.check()\n            virtualizationService = try virtualizationServiceFactory(config)")
    body = body.replace("                saveNoVNCSessionData(sharedDirectories: sharedDirectories)", "                if bootstrap == nil { saveNoVNCSessionData(sharedDirectories: sharedDirectories) }")
    body = body.replace("            try await service.start()", "            try bootstrap?.check()\n            try await service.start()\n            if let bootstrap {\n                guard let owned = service as? DarwinVirtualizationService else { throw TXBootstrapError.refused }\n                terminalXBootstrapOwner = try TerminalXBootstrapOwner.attach(launch: bootstrap, service: owned, configLease: fileHandle.fileDescriptor)\n            }")
    body = body.replace("            if Self.shouldStartClipboardWatcher(", "            if bootstrap == nil && Self.shouldStartClipboardWatcher(")
    body = body.replace("            if NativeApplicationLoop.isActive {", "            if bootstrap == nil && NativeApplicationLoop.isActive {")
    body = body.replace("            if let port = vncPortValue, let password = vncPasswordValue {", "            if bootstrap == nil, let port = vncPortValue, let password = vncPasswordValue {")
    changed[vm] = changed[vm][:start] + body + changed[vm][end:]
    edit(vm, "    private func showNativeDisplay() async {", "    private func showNativeDisplay() async {\n        guard !terminalXBootstrapMode else { return }")
    edit(vm, "    private func startClipboardWatcherIfNeeded() async {", "    private func startClipboardWatcherIfNeeded() async {\n        guard !terminalXBootstrapMode else { return }")
    for signature in ["    private func addSharedFolder(_ url: URL, readOnly: Bool) async throws {", "    private func copyFilesToGuestDesktop(_ urls: [URL]) async throws {"]:
        edit(vm, signature, signature + "\n        try txRequire(!terminalXBootstrapMode)")
    edit(vm, "        removeShutdownSignalHandlers()", "        terminalXBootstrapOwner?.close()\n        terminalXBootstrapOwner = nil\n        removeShutdownSignalHandlers()")
    edit(vm, "        if !activeVNCPolicy.isEnabled {", "        if !activeVNCPolicy.isEnabled && !terminalXBootstrapMode {")

    service = "src/Virtualization/VMVirtualizationService.swift"
    edit(service, "    let networkMode: NetworkMode\n}", "    let networkMode: NetworkMode\n    var terminalXBootstrapMode: Bool = false\n}")
    edit(service, "            withLiveUpdatePlaceholder: true\n        )", "            withLiveUpdatePlaceholder: !config.terminalXBootstrapMode\n        )")
    edit(service, "        if !directorySharingDevices.contains(where: {", "        if !config.terminalXBootstrapMode && !directorySharingDevices.contains(where: {")
    edit(service, "        vzConfig.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]", "        vzConfig.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]\n        if config.terminalXBootstrapMode { vzConfig.socketDevices = [VZVirtioSocketDeviceConfiguration()] }", count=2)
    result = []
    for path in PINS:
        if original[path] != changed[path]:
            result.extend(difflib.unified_diff(original[path].splitlines(True), changed[path].splitlines(True), fromfile="a/libs/lume/"+path, tofile="b/libs/lume/"+path))
    for path in sorted((HERE/"Sources").glob("*.swift")):
        result.extend(difflib.unified_diff([], path.read_text().splitlines(True), fromfile="/dev/null", tofile="b/libs/lume/src/TerminalXBootstrap/"+path.name))
    return "".join(result)

if __name__ == "__main__":
    candidate = render(Path(sys.argv[1]))
    (HERE/"bootstrap.patch").write_text(candidate)
    (HERE/"upstream.json").write_text(json.dumps({"repository":"https://github.com/trycua/cua", "commit":BASE, "profileAdopted":False, "upstreamFileSha256":PINS, "candidatePatchSha256":hashlib.sha256(candidate.encode()).hexdigest()},indent=2)+"\n")
