"""Loaded after the installer helpers and run as root by exact-ID exec (#978).

seal: stores the host's verified artifact, delivered on stdin, as the sealed
runtime. Root never reads a file the guest account can write.

rpc: proves the sealed inode still holds the digest the host expects, drops to
the dedicated account and executes that same descriptor. This process never
reads stdin, so the host key stays in the pipe until the verified runtime
reads it; on any refusal it is never read at all.
"""
import base64
import ctypes
import errno
import socket
import threading

ACCOUNT = OWNER


def worker_account(owner):
    entry = pwd.getpwnam("cua")
    require(entry.pw_uid not in (0, owner["uid"]) and entry.pw_gid not in (0, owner["gid"])
            and entry.pw_dir == "/home/cua", "Distinct nonroot worker identity required")
    require([p.pw_name for p in pwd.getpwall() if p.pw_uid == entry.pw_uid] == ["cua"],
            "Worker UID is shared")
    groups = grp.getgrall()
    primary = [g for g in groups if g.gr_gid == entry.pw_gid]
    require(len(primary) == 1 and primary[0].gr_name == "cua"
            and not any("cua" in g.gr_mem and g.gr_gid != entry.pw_gid for g in groups),
            "Worker supplementary privileges are forbidden")
    for path in (pathlib.Path("/"), pathlib.Path("/home")):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "Unsafe worker home ancestor")
    info = pathlib.Path(entry.pw_dir).lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == entry.pw_uid
            and info.st_gid == entry.pw_gid and not info.st_mode & 0o022,
            "Unsafe worker home")
    return entry


def drop_worker_privileges(entry):
    # Explicitly clear retained and ambient capability state, including unusual
    # root bootstrap configurations. no_new_privs prevents later setuid/file-cap
    # elevation by the sealed worker or any provider it launches.
    libc = ctypes.CDLL(None, use_errno=True)
    def prctl(option, value=0):
        result = libc.prctl(ctypes.c_int(option), ctypes.c_ulong(value),
                            ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0))
        require(result >= 0, "Worker privilege hardening failed")
        return result
    prctl(8, 0)  # PR_SET_KEEPCAPS
    prctl(47, 4)  # PR_CAP_AMBIENT / PR_CAP_AMBIENT_CLEAR_ALL
    os.setgroups([])
    os.setresgid(entry.pw_gid, entry.pw_gid, entry.pw_gid)
    os.setresuid(entry.pw_uid, entry.pw_uid, entry.pw_uid)
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Caps(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32),
                    ("inheritable", ctypes.c_uint32)]
    header, caps = Header(0x20080522, 0), (Caps * 2)()
    require(libc.capset(ctypes.byref(header), caps) == 0, "Worker capabilities could not be cleared")
    require(libc.capget(ctypes.byref(header), caps) == 0
            and all(c.effective == c.permitted == c.inheritable == 0 for c in caps),
            "Worker capabilities remain")
    prctl(38, 1)  # PR_SET_NO_NEW_PRIVS
    require(prctl(39) == 1, "Worker no_new_privs is unavailable")
    require(os.getresuid() == (entry.pw_uid,) * 3 and os.getresgid() == (entry.pw_gid,) * 3
            and not os.getgroups(), "Worker privilege drop failed")
    try:
        os.setuid(0)
    except PermissionError:
        return
    raise ValueError("Worker privilege drop is reversible")


def worker_exec(runtime_fd, channel_fd, lifetime_fd, entry, execute=os.execve):
    """Child-only: no key reads, no shell, only the fixed sealed worker role."""
    # Save sources above the destinations before overwriting any fd. This also
    # handles a bootstrap invoked with closed stdio or an executable at fd3/4.
    saved = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 5)
             for fd in (runtime_fd, channel_fd, lifetime_fd)]
    executable, channel, lifetime = saved
    null = os.open("/dev/null", os.O_RDWR | os.O_NOFOLLOW)
    info = os.fstat(null)
    require(stat.S_ISCHR(info.st_mode) and info.st_rdev == os.makedev(1, 3), "Null device required")
    for fd in (0, 1, 2):
        os.dup2(null, fd, inheritable=True)
    os.dup2(channel, 3, inheritable=True)
    os.dup2(lifetime, 4, inheritable=True)
    # Enumerate before closing; the enumeration fd is already closed by listdir.
    # No inherited host pipe, owner token, socket or lifetime write end survives.
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd > 4 and fd != executable:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    drop_worker_privileges(entry)
    os.chdir(entry.pw_dir)
    os.umask(0o077)
    execute(executable, [str(SEALED), "local-vm-worker"],
            {"HOME": entry.pw_dir, "USER": "cua", "LOGNAME": "cua",
             "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"})
    raise ValueError("Sealed worker did not execute")


class WorkerLaunch:
    """Original child relationship, never reconstructed from a stored PID.

    The caller owns channel and lifetime. Closing lifetime requests shutdown;
    only waitpid on this retained child proves its exit. The versioned handshake
    and unknown-outcome fencing belong to the owner/worker protocol above this.
    """
    def __init__(self, pid, channel, lifetime):
        self.pid, self.channel, self.lifetime = pid, channel, lifetime
        self.status = None

    def poll(self):
        if self.status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = status
        return self.status

    def close(self):
        self.channel.close()
        if self.lifetime is not None:
            os.close(self.lifetime)
            self.lifetime = None


class WorkerBootstrapFailed(ValueError):
    def __init__(self, child):
        super().__init__("Owner bootstrap failed; retained child exit remains unproven")
        self.child = child


def launch_worker(expected):
    """Internal single-threaded bootstrap scaffold; NO production caller.

    Root validates and forks the sealed cua role, then irreversibly becomes the
    owner before returning any IPC endpoints. No public runtime action enables
    this. Startup remains gated until protocol/lifecycle acceptance is complete.
    """
    require(os.getuid() == os.geteuid() == 0 and threading.active_count() == 1,
            "Single-threaded root bootstrap required")
    require(isinstance(expected, str) and len(expected) == 64
            and all(c in "0123456789abcdef" for c in expected), "Verified runtime digest required")
    owner = account()
    entry = worker_account(owner)
    runtime_fd = open_sealed(expected)
    channel = child_channel = None
    lifetime_read = lifetime_write = None
    try:
        channel, child_channel = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        lifetime_read, lifetime_write = os.pipe2(os.O_CLOEXEC)
        pid = os.fork()
        if pid == 0:
            try:
                worker_exec(runtime_fd, child_channel.fileno(), lifetime_read, entry)
            finally:
                os._exit(127)
        child_channel.close()
        child_channel = None
        os.close(lifetime_read)
        lifetime_read = None
        result = WorkerLaunch(pid, channel, lifetime_write)
        channel = lifetime_write = None
        try:
            drop_to_account()
            require(os.getuid() == owner["uid"] and os.getgid() == owner["gid"],
                    "Owner identity changed during bootstrap")
        except BaseException as error:
            result.close()
            # Keep the original waitpid relationship even on a partial drop.
            # EOF is a shutdown request, never exit proof or permission to replay.
            raise WorkerBootstrapFailed(result) from error
        return result
    finally:
        os.close(runtime_fd)
        for stream in (channel, child_channel):
            if stream is not None:
                stream.close()
        for fd in (lifetime_read, lifetime_write):
            if fd is not None:
                os.close(fd)


def runtime_main(argv, stdin, execute=os.execve, drop=drop_to_account):
    require(len(argv) == 1 and len(argv[0]) <= 4096, "Bounded runtime envelope required")
    header = json.loads(base64.b64decode(argv[0], validate=True))
    expected = header.get("runtimeSha256")
    require(isinstance(expected, str) and len(expected) == 64
            and all(c in "0123456789abcdef" for c in expected), "Verified runtime digest required")
    require(os.geteuid() == SEALED_OWNER, "The sealed runtime is managed as root")
    if header.get("action") == "seal":
        require(set(header) == {"action", "runtimeSha256", "bytes"} and isinstance(header["bytes"], int)
                and 64 <= header["bytes"] <= LIMIT, "Unknown seal fields")
        data = stdin.read(header["bytes"] + 1)
        require(len(data) == header["bytes"], "Incomplete or oversized artifact input")
        return {"status": seal(data, expected), "path": str(SEALED), "runtimeSha256": expected}
    require(header.get("action") == "rpc" and set(header) == {"action", "runtimeSha256"},
            "Unknown runtime action")
    fd = open_sealed(expected)
    try:
        entry = drop()
        os.chdir(entry.pw_dir)
        env = {"HOME": entry.pw_dir, "USER": ACCOUNT, "LOGNAME": ACCOUNT,
               "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        # Execute the same verified inode after the irreversible owner privilege drop.
        execute(fd, [str(SEALED), "local-vm-rpc", "-"], env)
        raise ValueError("Sealed runtime did not execute")
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": runtime_main(sys.argv[1:], sys.stdin.buffer)},
                         separators=(",", ":")))
    except Exception as error:
        # Exit 0, like `local-vm-rpc`: the host reads this refusal's reason
        # from the reply, where a failing exit would replace it with a generic one.
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
