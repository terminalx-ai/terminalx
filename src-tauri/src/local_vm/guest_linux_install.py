"""TerminalX-owned installer protocol, delivered by exact-ID Docker/Podman exec.

No account creation, shell, subprocess, daemon, provider login or service start.
The immutable lock inode and terminal receipt prove mutation completion; a PID
or elapsed time is never installation evidence. Fixture entrypoints are supplied
by tests, never by production stdin, argv or environment.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import pwd
import stat
import sys
import uuid

LIMIT = 512 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def account():
    entry = pwd.getpwnam("cua")
    home = pathlib.Path("/home/cua")
    info = home.lstat()
    require(platform.system() == "Linux", "Linux guest required")
    require(entry.pw_dir == str(home) and os.getuid() == os.geteuid() == entry.pw_uid != 0,
            "Dedicated nonroot cua account required")
    require(os.getgid() == os.getegid() == entry.pw_gid and info.st_uid == entry.pw_uid,
            "Dedicated account ownership changed")
    require(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022, "Unsafe account home")
    architecture = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    require(architecture is not None, "Unsupported guest architecture")
    return {"name": "cua", "uid": entry.pw_uid, "gid": entry.pw_gid, "home": str(home),
            "homeDevice": info.st_dev, "homeInode": info.st_ino, "architecture": architecture}


def private_directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
            "Private owned directory required")


def read(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                "Private owned regular file required")
        data = stream.read(maximum + 1)
    require(len(data) <= maximum, "Retained file exceeds its bound")
    return data


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def replace_receipt(path, value):
    temporary = path.parent / ("receipt-" + str(uuid.uuid4()))
    write_new(temporary, canonical(value))
    os.replace(temporary, path)
    sync_directory(path.parent)


def validate(header, observed):
    require(set(header) == {"action", "requestDigest", "inputDigest", "intent"}, "Unknown installer fields")
    require(header["action"] in ("install", "receipt"), "Unknown installer action")
    for key in ("requestDigest", "inputDigest"):
        require(isinstance(header[key], str) and len(header[key]) == 64
                and all(c in "0123456789abcdef" for c in header[key]), "Invalid request digest")
    intent = header["intent"]
    require(digest(canonical(intent)) == header["inputDigest"], "Changed installer intent")
    require(set(intent) == {"binding", "profileId", "sourceCommit", "runtimeSha256", "protocol", "bytes"},
            "Unknown artifact intent")
    binding = intent["binding"]
    require(set(binding) == {"target", "environmentId", "generation", "architecture", "account"},
            "Invalid installation binding")
    require(binding["account"] == observed and binding["architecture"] == observed["architecture"],
            "Guest account or architecture changed")
    for key in ("environmentId", "generation"):
        require(str(uuid.UUID(binding[key])) == binding[key], "Invalid timeline identity")
    target = binding["target"]
    require(set(target) == {"kind", "runtime", "id"} and target["kind"] == "linuxContainer"
            and target["runtime"] in ("docker", "podman") and len(target["id"]) == 64
            and all(c in "0123456789abcdef" for c in target["id"]), "Exact container identity required")
    require(intent["protocol"] == 1 and 64 <= intent["bytes"] <= LIMIT, "Incompatible runtime profile")
    require(len(intent["runtimeSha256"]) == 64 and all(c in "0123456789abcdef" for c in intent["runtimeSha256"]),
            "Invalid artifact digest")
    return intent


def installed(home, intent):
    base = home / ".terminalx-local"
    for directory in (base, base / "bin", base / "runtime"):
        private_directory(directory)
    binding = intent["binding"]
    identity = {"environmentId": binding["environmentId"], "generation": binding["generation"], "protocol": 1, "account": binding["account"]}
    require(json.loads(read(base / "identity.json", 4096)) == identity, "Installed timeline changed")
    require(json.loads(read(base / "account-binding.json", 4096)) == binding["account"], "Installed account changed")
    data = read(base / "bin/terminalx-serve", intent["bytes"])
    require(len(data) == intent["bytes"] and digest(data) == intent["runtimeSha256"], "Installed artifact changed")
    return identity


def transact(home, observed, header, binary=None, after_intent=lambda: None):
    """Pure filesystem seam used by disposable fixtures; production home is fixed."""
    intent = validate(header, observed)
    directory = home / ".terminalx-installs"
    private_directory(directory, create=header["action"] == "install")
    # Never unlink/replace this lock file, including after errors or recovery.
    flags = os.O_RDWR | os.O_NOFOLLOW
    if header["action"] == "install":
        flags |= os.O_CREAT
    fd = os.open(directory / "installer.lock", flags, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                "Invalid installer lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt_path = directory / (header["requestDigest"] + ".json")
        if receipt_path.exists():
            receipt = json.loads(read(receipt_path, 64 * 1024))
            require(receipt["requestDigest"] == header["requestDigest"]
                    and receipt["inputDigest"] == header["inputDigest"] and receipt["intent"] == intent,
                    "Retained installer request changed")
            # Retrying install is observation only, never continuation/replay.
        else:
            require(header["action"] == "install", "Original installer receipt is unavailable")
            require(not any(directory.glob("*.json")) and not (home / ".terminalx-local").exists(),
                    "Existing guest installation/history prevents fresh installation")
            require(binary is not None and len(binary) == intent["bytes"]
                    and digest(binary) == intent["runtimeSha256"], "Delivered artifact changed")
            machine = 62 if observed["architecture"] == "x64" else 183
            require(binary[:7] == b"\x7fELF\x02\x01\x01" and binary[7] in (0, 3)
                    and int.from_bytes(binary[16:18], "little") in (2, 3)
                    and int.from_bytes(binary[18:20], "little") == machine
                    and int.from_bytes(binary[20:24], "little") == 1
                    and int.from_bytes(binary[52:54], "little") == 64, "Wrong native Linux artifact")
            receipt = {"version": 1, "requestDigest": header["requestDigest"], "inputDigest": header["inputDigest"],
                       "intent": intent, "status": "outcomeUnknown"}
            write_new(receipt_path, canonical(receipt))
            after_intent()  # Tests can interrupt here; production never supplies a callback.
            base = home / ".terminalx-local"
            base.mkdir(mode=0o700)
            sync_directory(home)
            for name in ("bin", "runtime"):
                (base / name).mkdir(mode=0o700)
            identity = {"environmentId": intent["binding"]["environmentId"],
                        "generation": intent["binding"]["generation"], "protocol": 1, "account": observed}
            write_new(base / "identity.json", canonical(identity))
            write_new(base / "account-binding.json", canonical(observed))
            write_new(base / "bin/terminalx-serve", binary, 0o700)
            installed(home, intent)
            receipt["status"] = "installed"
            replace_receipt(receipt_path, receipt)
        require(header["action"] == "receipt" or receipt["status"] == "installed", "Uncertain install is never replayed")
        if receipt["status"] != "installed":
            return {"receipt": receipt, "status": "fenced"}
        identity = installed(home, intent)
        # A separate receipt invocation acquires the original lock only after
        # the writer has finished all mutations. No PID/timeout inference.
        return {"receipt": receipt, "account": observed, "identity": identity,
                "runtimeSha256": intent["runtimeSha256"], "protocol": 1,
                "exitProof": {"kind": "terminalReceiptUnderExclusiveLock",
                              "requestDigest": header["requestDigest"], "inputDigest": header["inputDigest"]}}


def main():
    line = sys.stdin.buffer.readline(16 * 1024 + 1)
    require(len(line) <= 16 * 1024 and line.endswith(b"\n"), "Bounded installer header required")
    header = json.loads(line)
    observed = account()
    if header == {"action": "account"}:
        require(not sys.stdin.buffer.read(1), "Unexpected account input")
        return observed
    intent = validate(header, observed)
    data = None
    if header["action"] == "install":
        data = sys.stdin.buffer.read(intent["bytes"] + 1)
        require(len(data) == intent["bytes"], "Incomplete or oversized artifact input")
    else:
        require(not sys.stdin.buffer.read(1), "Unexpected receipt input")
    return transact(pathlib.Path("/home/cua"), observed, header, data)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": main()}, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
        sys.exit(1)
