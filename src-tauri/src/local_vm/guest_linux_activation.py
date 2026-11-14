"""Loaded after the installer helpers. One retained activation per installation.

The supervisor owns a Popen child, never a recovered PID. Its lease descriptor
is inherited by that child, so supervisor loss cannot prove runtime exit.
Reconciliation observes only; cancellation is a retained request to the original
supervisor. Missing history or an uncertain spawn is never replayed.
"""
import base64
import contextlib
import subprocess
import time


@contextlib.contextmanager
def activation_lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077 and info.st_nlink == 1, "Unsafe activation lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield lock


def activation_context(home, observed, header):
    require(set(header) == {"action", "activationId", "installation"}, "Unknown activation fields")
    require(header["action"] in ("start", "status", "cancel"), "Unsupported activation action")
    require(str(uuid.UUID(header["activationId"])) == header["activationId"], "Invalid activation identity")
    installation = header["installation"]
    require(installation["action"] == "receipt", "Original installation receipt required")
    result = transact(home, observed, installation)
    require(result.get("receipt", {}).get("status") == "installed", "Installation completion unproven")
    directory = home / ".terminalx-local/runtime"
    return directory, {"activationId": header["activationId"], "installation": installation}


def retained_activation(path, binding):
    value = json.loads(read(path, 64 * 1024))
    require(value["binding"] == binding and value["version"] == 1, "Activation target/account/artifact changed")
    return value


def lease_held(path):
    # Absence is not exit proof. This inode is never removed or replaced.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, "r+b") as lease:
        info = os.fstat(lease.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077 and info.st_nlink == 1, "Unsafe owner lease")
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return False
        except BlockingIOError:
            return True


def activation_observe(home, observed, header):
    directory, binding = activation_context(home, observed, header)
    path = directory / "activation.json"
    with activation_lock(directory / "activation.lock"):
        if not path.exists():
            require(header["action"] == "cancel" and not (directory / "activation-owner.lock").exists(),
                    "Original activation receipt missing; outcome remains unknown")
            # Tombstone prevents a delayed original start, without signaling anything.
            value = {"version": 1, "binding": binding, "status": "canceled", "instance": None,
                     "cancelRequested": True, "exitProof": "canceledBeforeSpawn"}
            write_new(path, canonical(value))
        else:
            value = retained_activation(path, binding)
            if header["action"] == "cancel" and value["status"] not in ("exited", "canceled"):
                value["cancelRequested"] = True
                replace_receipt(path, value)
        held = lease_held(directory / "activation-owner.lock") if value["instance"] else False
        terminal = value["status"] in ("exited", "canceled") and not held
        return {"receipt": value, "ownerLeaseHeld": held, "terminal": terminal}


def activation_supervise(home, observed, header, spawn=subprocess.Popen, pause=time.sleep):
    directory, binding = activation_context(home, observed, header)
    path = directory / "activation.json"
    lease = None
    try:
        with activation_lock(directory / "activation.lock"):
            if path.exists():
                # Duplicate detached delivery never creates a second child.
                return retained_activation(path, binding)
            # A serving or previously initialized owner has its own lifecycle.
            # Never replace it, even if a PID or socket appears absent.
            require(not (directory / "run").exists() and not (directory / "local-vm-guest").exists(),
                    "Existing runtime ownership/history requires its original lifecycle")
            lease_path = directory / "activation-owner.lock"
            fd = os.open(lease_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            lease = os.fdopen(fd, "r+b")
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            sync_directory(directory)
            value = {"version": 1, "binding": binding, "status": "outcomeUnknown",
                     "instance": str(uuid.uuid4()), "cancelRequested": False}
            write_new(path, canonical(value))  # precedes process creation
            base = home / ".terminalx-local"
            env = {"HOME": str(home), "USER": "cua", "LOGNAME": "cua",
                   "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                   "TERMINALX_LINUX_ACTIVATION": header["activationId"],
                   "TERMINALX_LINUX_INSTANCE": value["instance"]}
            child = spawn([str(base / "bin/terminalx-serve"), "--data-dir", str(directory),
                           "--runtime-kind", "local"], cwd=home, env=env,
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          close_fds=True, pass_fds=(lease.fileno(),), start_new_session=True)
            value["status"] = "running"  # process exists; not serving or Ready
            replace_receipt(path, value)
        termination_sent = False
        while True:
            # Popen retains the original child relationship; no PID lookup/reuse.
            code = child.poll()
            with activation_lock(directory / "activation.lock"):
                current = retained_activation(path, binding)
                require(current["instance"] == value["instance"], "Original supervisor instance changed")
                if code is not None:
                    current.update(status="canceled" if current["cancelRequested"] else "exited",
                                   exitCode=code, exitProof="originalChildWait")
                    replace_receipt(path, current)
                    return current
                if current["cancelRequested"] and not termination_sent:
                    child.terminate()
                    termination_sent = True
            # No timeout/kill escalation. If TERM fails, retain the original fence.
            pause(0.2)
    finally:
        if lease:
            lease.close()


def activation_main():
    require(len(sys.argv) == 2 and len(sys.argv[1]) <= 32 * 1024, "Bounded activation envelope required")
    header = json.loads(base64.b64decode(sys.argv[1], validate=True))
    home, observed = pathlib.Path("/home/cua"), account()
    if header["action"] == "start":
        return activation_supervise(home, observed, header)
    return activation_observe(home, observed, header)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": activation_main()}, separators=(",", ":")))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
        sys.exit(1)
