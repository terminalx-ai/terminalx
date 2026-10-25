#!/usr/bin/env python3
"""Opt-in AppKit lifetime regression, ONLY in an allocated disposable macOS guest.

Unlike headless tests, this starts the real helper's menu-bar event loop. It never
launches the desktop app or reads an existing store. Pass a built, signed helper.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def request(root, command, params):
    token = (root / "store/run/control.token").read_text().strip()
    with socket.socket(socket.AF_UNIX) as stream:
        stream.settimeout(2)
        stream.connect(str(root / "store/run/hooks.sock"))
        frame = dict(id=str(uuid.uuid4()), token=token, command=command, params=params)
        stream.sendall((json.dumps(frame) + "\n").encode())
        with stream.makefile("rb") as response:
            result = json.loads(response.readline())
    if not result["ok"]:
        raise RuntimeError(result["error"]["code"])
    return result["result"]


def exercise(binary, root, mode):
    root.mkdir(mode=0o700)
    for name in ("home", "store", "claude", "tmp"):
        (root / name).mkdir(mode=0o700)
    env = {
        "HOME": str(root / "home"), "TERMINALX_HOME": str(root / "store"),
        "CLAUDE_CONFIG_DIR": str(root / "claude"), "TMPDIR": str(root / "tmp"),
        "ZDOTDIR": str(root / "home"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "SHELL": "/bin/zsh", "LANG": "en_US.UTF-8",
        "TERMINALX_LOCAL_DESKTOP": "1",
        "TERMINALX_LOCAL_APPLICATION": "com.terminalx.next.issue467.dev",
    }
    with (root / "owner.log").open("wb") as log:
        child = subprocess.Popen(
            [str(binary), "--runtime-kind", "local", "--data-dir", str(root / "store"),
             "--idle-grace-seconds", "2"], env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=log, start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 15
            while True:
                if child.poll() is not None:
                    raise AssertionError("helper exited before authenticated readiness")
                try:
                    status = request(root, "status", {})
                    break
                except (OSError, ValueError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise AssertionError("helper never became ready") from None
                    time.sleep(0.05)
            assert status["pid"] == child.pid and status["localRuntime"]["nativeTray"]
            started = time.monotonic()
            if mode == "stop-all":
                request(root, "runtime.attach", {"protocol": 1})
                request(root, "runtime.stopAll", {"epoch": status["localRuntime"]["epoch"]})
            # No mouse, keyboard, menu action or injected event may help the
            # owner exit: shutdown must wake its own AppKit run loop.
            try:
                code = child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                raise AssertionError(f"{mode}: backend shutdown did not exit AppKit") from None
            assert code == 0, f"{mode}: unexpected helper exit {code}"
            try:
                request(root, "status", {})
            except (OSError, ValueError, RuntimeError):
                pass
            else:
                raise AssertionError("exited owner still serves commands")
            return dict(mode=mode, pid=child.pid, exit=code,
                        elapsedSeconds=time.monotonic() - started)
        finally:
            # Only this fixture's newly created process group is eligible.
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("helper", type=Path)
    parser.add_argument("--allocated-disposable-guest", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin" or not args.allocated_disposable_guest:
        parser.error("requires an explicitly allocated disposable macOS guest; never run on the host")
    binary = args.helper.resolve(strict=True)
    root = Path(tempfile.mkdtemp(prefix="tx467-native-", dir="/tmp"))
    result = dict(helperSha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                  evidenceRoot=str(root), cases=[])
    try:
        for mode in ("idle", "stop-all"):
            result["cases"].append(exercise(binary, root / mode, mode))
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
