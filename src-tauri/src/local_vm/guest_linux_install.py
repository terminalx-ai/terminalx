"""TerminalX-owned installer protocol, delivered by exact-ID Docker/Podman exec.

Account provisioning is restricted to the explicit installation account action.
The immutable lock inode and terminal receipt prove mutation completion; a PID
or elapsed time is never installation evidence. Fixture entrypoints are supplied
by tests, never by production stdin, argv or environment.
"""
import grp
import subprocess
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


OWNER = "terminalx-owner"
OWNER_HOME = pathlib.Path("/var/lib/terminalx-owner")


def safe_owner_ancestors():
    for path in (pathlib.Path("/"), pathlib.Path("/var"), pathlib.Path("/var/lib")):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "Unsafe owner home ancestor: " + str(path))


def locked_owner_login():
    fd = os.open("/etc/shadow", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "Unsafe shadow database")
        entries = [line.rstrip("\n").split(":") for line in stream if line.startswith(OWNER + ":")]
    require(len(entries) == 1 and len(entries[0]) == 9 and entries[0][1].startswith(("!", "*")),
            "Owner login must remain locked")


def account(provision=False):
    require(platform.system() == "Linux", "Linux guest required")
    safe_owner_ancestors()
    for name in ("identity.json", "account-binding.json", "runtime", "bin/terminalx-serve"):
        require(not os.path.lexists(pathlib.Path("/home/cua/.terminalx-local") / name),
                "Shared-account installation requires a new isolated container")
    require(not os.path.lexists("/home/cua/.terminalx-installs"),
            "Shared-account installation history requires a new isolated container")
    worker = pwd.getpwnam("cua")
    require(worker.pw_uid != 0 and worker.pw_gid != 0, "Nonroot worker required")
    try:
        entry = pwd.getpwnam(OWNER)
    except KeyError:
        require(provision and os.geteuid() == 0, "Dedicated owner account is unavailable")
        require(not os.path.lexists(OWNER_HOME), "Refusing to adopt an existing owner home")
        try:
            grp.getgrnam(OWNER)
        except KeyError:
            pass
        else:
            raise ValueError("Refusing to adopt an existing owner group")
        subprocess.run(["/usr/sbin/useradd", "--system", "--user-group", "--no-create-home",
                        "--home-dir", str(OWNER_HOME), "--shell", "/usr/sbin/nologin", OWNER],
                       check=True, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, close_fds=True,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        entry = pwd.getpwnam(OWNER)
        OWNER_HOME.mkdir(mode=0o700)
        os.chown(OWNER_HOME, entry.pw_uid, entry.pw_gid)
        sync_directory(OWNER_HOME.parent)
    require(entry.pw_uid not in (0, worker.pw_uid) and entry.pw_gid not in (0, worker.pw_gid)
            and entry.pw_dir == str(OWNER_HOME) and entry.pw_shell == "/usr/sbin/nologin",
            "Dedicated nonroot owner identity required")
    locked_owner_login()
    require(sum(p.pw_name == OWNER for p in pwd.getpwall()) == 1, "Owner name is ambiguous")
    require([p.pw_name for p in pwd.getpwall() if p.pw_uid == entry.pw_uid] == [OWNER],
            "Owner UID is shared")
    require(not any(p.pw_name != OWNER and p.pw_gid == entry.pw_gid for p in pwd.getpwall()),
            "Owner primary group is shared")
    groups = grp.getgrall()
    require(sum(g.gr_name == OWNER for g in groups) == 1, "Owner group name is ambiguous")
    primary = [g for g in groups if g.gr_gid == entry.pw_gid]
    require(len(primary) == 1 and primary[0].gr_name == OWNER and not primary[0].gr_mem,
            "Owner group is shared or changed")
    require(not any(OWNER in g.gr_mem for g in groups), "Owner supplementary groups are forbidden")
    info = OWNER_HOME.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == entry.pw_uid
            and info.st_gid == entry.pw_gid and stat.S_IMODE(info.st_mode) == 0o700,
            "Private owner home required")
    architecture = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    require(architecture is not None, "Unsupported guest architecture")
    return {"name": OWNER, "uid": entry.pw_uid, "gid": entry.pw_gid, "home": str(OWNER_HOME),
            "homeDevice": info.st_dev, "homeInode": info.st_ino, "architecture": architecture}


def drop_to_account():
    require(os.getuid() == os.geteuid() == 0, "Root owner launcher required")
    observed = account()
    os.setgroups([])
    os.setgid(observed["gid"])
    os.setuid(observed["uid"])
    require(os.getuid() == os.geteuid() == observed["uid"]
            and os.getgid() == os.getegid() == observed["gid"] and not os.getgroups(),
            "Owner privilege drop failed")
    try:
        os.setuid(0)
    except PermissionError:
        return pwd.getpwnam(OWNER)
    raise ValueError("Privilege drop is reversible")


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


# The only runtime the host key reaches (#978). Root owns every component from
# SEALED_ROOT down and nothing is writable by group or other, so the guest
# account, and any worker running as it, cannot replace the inode or a parent.
# Fixtures rebind these three names to a disposable directory they own.
SEALED_ROOT = pathlib.Path("/")
SEALED = pathlib.Path("/opt/terminalx-local/bin/terminalx-serve")
SEALED_OWNER = 0


def sealed_directories():
    require(SEALED.is_absolute() and SEALED_ROOT in SEALED.parents, "Sealed runtime outside its root")
    return [path for path in reversed(SEALED.parents) if path == SEALED_ROOT or SEALED_ROOT in path.parents]


def check_sealed_directory(path):
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == SEALED_OWNER and not info.st_mode & 0o022,
            "Sealed runtime directory is writable by the guest account: " + str(path))


def open_sealed(expected):
    """Descriptor of the sealed runtime, proven to hold the host's verified artifact."""
    for directory in sealed_directories():
        check_sealed_directory(directory)
    fd = os.open(SEALED, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == SEALED_OWNER and stat.S_IMODE(info.st_mode) == 0o555,
                "Sealed runtime is not a root-owned read-only file")
        hasher = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
        require(hasher.hexdigest() == expected, "Sealed runtime does not match the host's verified artifact")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def seal(data, expected):
    """Store the host's verified artifact as the sealed runtime. Never replaces one."""
    require(digest(data) == expected, "Delivered artifact changed")
    for directory in sealed_directories():
        if directory != SEALED_ROOT and not os.path.lexists(directory):
            os.mkdir(directory, 0o755)
            os.chmod(directory, 0o755)
            sync_directory(directory.parent)
        check_sealed_directory(directory)
    if not os.path.lexists(SEALED):
        temporary = SEALED.parent / (".seal-" + str(uuid.uuid4()))
        write_new(temporary, data, 0o555)
        os.chmod(temporary, 0o555)
        os.replace(temporary, SEALED)
        sync_directory(SEALED.parent)
    os.close(open_sealed(expected))  # an existing different runtime fails closed here
    return "sealed"


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
    require(set(binding) == {"target", "environmentId", "generation", "architecture", "account", "hostKeySha256"},
            "Invalid installation binding")
    require(isinstance(binding["hostKeySha256"], str) and len(binding["hostKeySha256"]) == 64
            and all(c in "0123456789abcdef" for c in binding["hostKeySha256"]), "Invalid host key digest")
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
    identity = {"environmentId": binding["environmentId"], "generation": binding["generation"], "protocol": 1,
                "account": binding["account"], "hostKeySha256": binding["hostKeySha256"]}
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
                        "generation": intent["binding"]["generation"], "protocol": 1, "account": observed,
                        "hostKeySha256": intent["binding"]["hostKeySha256"]}
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
    require(os.getuid() == os.geteuid() == 0, "Root installer required")
    if header == {"action": "account"}:
        require(not sys.stdin.buffer.read(1), "Unexpected account input")
        return account(provision=True)
    observed = account()
    drop_to_account()
    intent = validate(header, observed)
    data = None
    if header["action"] == "install":
        data = sys.stdin.buffer.read(intent["bytes"] + 1)
        require(len(data) == intent["bytes"], "Incomplete or oversized artifact input")
    else:
        require(not sys.stdin.buffer.read(1), "Unexpected receipt input")
    return transact(OWNER_HOME, observed, header, data)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": main()}, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
        sys.exit(1)
