#!/usr/bin/env python3
"""Read-only CLI compatibility probe; no account, turn, or provider API request.

Codex parses an isolated hooks.json through hooks/list. Claude's native bundle
is inspected for its positive timeout schema and command-hook millisecond cap;
this is static evidence, not a real Claude permission round-trip.
"""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time


def codex_probe(program):
    with tempfile.TemporaryDirectory(prefix="tx467-hook-config-") as directory:
        root = Path(directory)
        seconds = 2_147_483
        events = ["PreToolUse", "PermissionRequest"]
        (root / "hooks.json").write_text(json.dumps({"hooks": {
            event: [{"hooks": [{"type": "command", "command": "/usr/bin/true", "timeout": seconds}]}]
            for event in events
        }}))
        env = {"HOME": directory, "CODEX_HOME": directory, "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
               "TERM": "dumb", "NO_COLOR": "1"}
        process = subprocess.Popen([program, "app-server"], cwd=directory, env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        try:
            requests = [
                {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "tx467-hook-probe", "version": "0.0.0"}}},
                {"method": "initialized", "params": {}},
                {"id": 2, "method": "hooks/list", "params": {}},
            ]
            process.stdin.write(b"".join(json.dumps(request).encode() + b"\n" for request in requests))
            process.stdin.flush()
            deadline = time.monotonic() + 15
            buffer = b""
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while time.monotonic() < deadline:
                    if not selector.select(0.1):
                        continue
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("Codex exited before hooks/list replied")
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        reply = json.loads(line)
                        if reply.get("id") != 2:
                            continue
                        assert "error" not in reply, reply.get("error")
                        groups = reply["result"]["data"]
                        assert all(not group["errors"] and not group["warnings"] for group in groups)
                        hooks = [hook for group in groups for hook in group["hooks"]]
                        assert {hook["eventName"] for hook in hooks} == {"preToolUse", "permissionRequest"}
                        assert all(hook["timeoutSec"] == seconds and hook["enabled"] for hook in hooks)
                        print("Codex: both deciding hooks accept 2147483 seconds without warnings; no model invoked")
                        return
            raise TimeoutError("Codex hooks/list exceeded 15 seconds")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def claude_probe(program):
    code = Path(program).resolve().read_bytes()
    assert b'positive().optional().describe("Timeout in seconds for this specific command")' in code
    # Check the command runner's actual clamp and resolve its minified constant.
    clamps = re.findall(rb'Math\.min\([A-Za-z_$][\w$]*\.timeout\*1000,([A-Za-z_$][\w$]*)\)', code)
    assert any(re.search(rb'\b' + re.escape(name) + rb'=2147483647\b', code) for name in clamps)
    print("Claude static inspection: positive seconds schema; command-hook timer capped at 2147483647 milliseconds")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", default=shutil.which("codex"))
    parser.add_argument("--claude", default=shutil.which("claude"))
    args = parser.parse_args()
    if not args.codex or not args.claude:
        parser.error("name both installed CLIs; this probe installs nothing")
    codex_probe(args.codex)
    claude_probe(args.claude)
