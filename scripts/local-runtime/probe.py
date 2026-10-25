#!/usr/bin/env python3
"""Baseline real serve lifecycle probe; not desktop #467 acceptance.

Usage: python3 scripts/local-runtime/probe.py /absolute/path/to/terminalx-serve
No installed app or existing store is used. No provider is launched.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time


def wait_for(description, predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError(f"Timed out: {description}")


def lines(path):
    records = []
    for line in path.read_text().splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # The process may still be writing its ready line.
    return records


def call(endpoint, token):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(5)
        stream.connect(str(endpoint))
        request = {"id": "probe", "command": "status", "params": {}, "token": token}
        stream.sendall(json.dumps(request).encode() + b"\n")
        with stream.makefile("rb") as response:
            line = response.readline(1024 * 1024)
    return json.loads(line)


# A short-lived launcher starts the runtime with no inherited UI pipes and exits.
LAUNCHER = """
import json, subprocess, sys
with open(sys.argv[1], 'w') as out, open(sys.argv[2], 'w') as err:
    child = subprocess.Popen(sys.argv[3:], stdout=out, stderr=err,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    print(json.dumps({'pid': child.pid}), flush=True)
"""


def launch(binary, root, env, number):
    output = root / f"runtime-{number}.jsonl"
    error = root / f"runtime-{number}.log"
    parent = subprocess.run(
        [sys.executable, "-c", LAUNCHER, str(output), str(error), str(binary),
         "--data-dir", str(root / "data"), "--runtime-kind", "local"],
        env=env, capture_output=True, text=True, timeout=10, check=True,
    )
    runtime_pid = json.loads(parent.stdout)["pid"]

    def exited():
        try:
            os.kill(runtime_pid, 0)
            return False
        except ProcessLookupError:
            return True

    try:
        ready = wait_for("runtime readiness", lambda: next(
            (entry for entry in lines(output) if entry.get("type") == "ready"), None))
        token_path = root / "data/run/control.token"
        token = wait_for("published token", lambda: token_path.read_text().strip()
                         if token_path.exists() else None)
        endpoint = ready["socket"]
        for _ in range(3):
            result = call(endpoint, token)
            assert result["ok"] is True
            assert result["result"]["pid"] == runtime_pid
            assert result["result"]["runtimeKind"] == "local"
            time.sleep(0.1)
        assert call(endpoint, "wrong-token")["ok"] is False
        os.kill(runtime_pid, signal.SIGTERM)
        wait_for("graceful stop", lambda: any(
            entry.get("type") == "stopped" and entry.get("ok") is True
            for entry in lines(output)))
        wait_for("runtime exit", exited)
        return endpoint, token
    finally:
        if not exited():
            os.killpg(runtime_pid, signal.SIGTERM)
            try:
                wait_for("runtime cleanup", exited, seconds=10)
            except AssertionError:
                os.killpg(runtime_pid, signal.SIGKILL)
                wait_for("forced runtime cleanup", exited)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    binary = parser.parse_args().binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="tx467-", dir="/tmp") as directory:
        root = Path(directory).resolve()
        for name in ("home", "data", "claude", "codex", "tmp"):
            (root / name).mkdir(mode=0o700)
        # Never inherit app endpoints, cloud configuration or API credentials.
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh",
            "HOME": str(root / "home"), "TERMINALX_HOME": str(root / "data"),
            "CLAUDE_CONFIG_DIR": str(root / "claude"), "CODEX_HOME": str(root / "codex"),
            "TMPDIR": str(root / "tmp"), "LANG": "en_US.UTF-8",
        }
        first = launch(binary, root, env, 1)
        second = launch(binary, root, env, 2)
        assert first[0] != second[0], "restart reused per-launch socket"
        assert first[1] != second[1], "restart reused credentials"
        process = subprocess.Popen(
            [str(binary), "--data-dir", str(root / "data"), "--self-test"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        try:
            stdout, _ = process.communicate(timeout=30)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate()
        assert process.returncode == 0, "built-in PTY self-test failed"
        records = [json.loads(line) for line in stdout.splitlines()]
        assert any(entry.get("type") == "self-test" and entry.get("pty") == "ok"
                   for entry in records), "PTY output was not verified"
        assert any(entry.get("type") == "stopped" and entry.get("ok") is True
                   for entry in records), "self-test did not stop successfully"
    print("PASS: launcher exit, authenticated reconnect, wrong-token rejection, "
          "SIGTERM, fresh restart credentials, real PTY self-test")
    print("NOT TESTED: desktop quit/update, agents/prompts, stop-all RPC, idle exit, tray")


if __name__ == "__main__":
    main()
