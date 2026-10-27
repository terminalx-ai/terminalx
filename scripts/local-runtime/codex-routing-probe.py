#!/usr/bin/env python3
"""Opt-in real Codex routing regression, called by the PTY harness test.

Uses a disposable Codex home, fixture credentials and a loopback-only provider.
No real account, remote model or user daemon is used. Hook receipts, not terminal
text, establish which launch owns fresh and resumed conversations.
"""
import argparse
import json
import os
from pathlib import Path
import pty
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time


def rpc_hooks(program, env, root):
    process = subprocess.Popen([program, "app-server"], env=env, cwd=root,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL)
    try:
        for request in [
            {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "tx638-probe", "version": "1"}}},
            {"method": "initialized", "params": {}},
            {"id": 2, "method": "hooks/list", "params": {}},
        ]:
            process.stdin.write(json.dumps(request).encode() + b"\n")
        process.stdin.flush()
        buffer = b""
        deadline = time.monotonic() + 15
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if not selector.select(0.1):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    response = json.loads(line)
                    if response.get("id") == 2:
                        assert "result" in response, response
                        return response["result"]
        raise AssertionError("Codex did not return hook hashes")
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def receipt(command, env, root, output):
    previous = output.read_text().splitlines() if output.exists() else []
    master, slave = pty.openpty()
    process = subprocess.Popen(command, env=env, cwd=root, stdin=slave,
                               stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    try:
        deadline = time.monotonic() + 25
        with selectors.DefaultSelector() as selector:
            selector.register(master, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                lines = output.read_text().splitlines() if output.exists() else []
                if len(lines) > len(previous):
                    return json.loads(lines[-1])
                if process.poll() is not None:
                    raise AssertionError(f"Codex exited with {process.returncode} before its SessionStart receipt")
                if selector.select(0.1):
                    # Minimal terminal protocol response; no conversation or
                    # status is inferred from rendered terminal output.
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        continue
                    if b"\x1b[6n" in chunk:
                        os.write(master, b"\x1b[1;1R")
        raise AssertionError("No SessionStart hook receipt within 25 seconds")
    finally:
        # The npm entry point may own a native TUI child. This process group
        # was created for the probe; ending just the wrapper leaves writers.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(master)


def stop_private_daemon(program, env, root):
    try:
        subprocess.run([program, "app-server", "daemon", "stop"], env=env, cwd=root,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        pass
    finally:
        # A broken daemon may not finish graceful shutdown. Only executables
        # installed beneath this test's unique temporary home belong to us.
        rows = subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True).splitlines()
        owned = []
        for row in rows:
            pid, executable = row.strip().split(None, 1)
            if Path(executable).is_relative_to(root):
                owned.append(int(pid))
        for pid in owned:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        # Let the kernel finish closing files before TemporaryDirectory walks
        # the home; otherwise a stopped writer can race its directory removal.
        time.sleep(0.2)


def run(args):
    with tempfile.TemporaryDirectory(prefix="tx638-codex-routing-") as directory:
        root = Path(directory).resolve()
        output = root / "receipts.jsonl"
        hook = root / "record-hook.py"
        hook.write_text('''import json, os, sys
from pathlib import Path
payload = json.load(sys.stdin)
with (Path(__file__).parent / "receipts.jsonl").open("a") as f:
    f.write(json.dumps({"tab": os.environ.get("RACCOON_TAB_ID"), "socket": os.environ.get("RACCOON_HOOK_SOCKET"), "session": payload.get("session_id")}) + "\\n")
print("{}")
''')
        hooks = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": shlex.join([sys.executable, str(hook)])}]}]}}
        (root / "hooks.json").write_text(json.dumps(hooks))
        (root / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "disposable-routing-test"}))
        config = '''model = "routing-fixture"
model_provider = "routing-fixture"
cli_auth_credentials_store = "file"
[model_providers.routing-fixture]
name = "Loopback routing test; no model"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
[notice]
hide_full_access_warning = true
'''
        config += f'\n[projects.{json.dumps(str(root))}]\ntrust_level = "trusted"\n'
        (root / "config.toml").write_text(config)
        env = {"HOME": str(root), "CODEX_HOME": str(root), "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
               "TERM": "xterm-256color", "SHELL": "/bin/sh", "RACCOON_TAB_ID": "retired-tab",
               "RACCOON_HOOK_SOCKET": str(root / "retired.sock")}
        for group in rpc_hooks(args.codex, env, root)["data"]:
            for entry in group["hooks"]:
                config += f'\n[hooks.state.{json.dumps(entry["key"])}]\ntrusted_hash = {json.dumps(entry["currentHash"])}\n'
        (root / "config.toml").write_text(config)
        try:
            subprocess.run([args.codex, "app-server", "daemon", "start"], env=env, cwd=root,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=True)
            current = {**env, "RACCOON_TAB_ID": "current-tab", "RACCOON_HOOK_SOCKET": str(root / "current.sock")}
            fresh = receipt(shlex.split(args.fresh_command) + ["--no-alt-screen", "Routing probe"], current, root, output)
            assert fresh["tab"] == "current-tab", f"fresh session inherited daemon routing: {fresh}"
            assert fresh["socket"] == current["RACCOON_HOOK_SOCKET"], fresh
            assert fresh["session"], "SessionStart must identify the provider conversation"
            resumed = {**current, "RACCOON_TAB_ID": "resumed-tab"}
            command = [fresh["session"] if a == "fixture-resume-id" else a for a in shlex.split(args.resume_command)]
            back = receipt(command + ["--no-alt-screen", "Routing probe"], resumed, root, output)
            assert back["tab"] == "resumed-tab", f"resumed session inherited daemon routing: {back}"
            assert back["socket"] == current["RACCOON_HOOK_SOCKET"], back
            assert back["session"] == fresh["session"], "resume must preserve the provider conversation"
            print("Fresh and resumed Codex SessionStart hooks use their own launch routing while a stale private daemon is running")
        finally:
            # Only the daemon created above, in this throwaway home. The real
            # managed home and its shared daemon are never addressed.
            stop_private_daemon(args.codex, env, root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True)
    parser.add_argument("--fresh-command", required=True)
    parser.add_argument("--resume-command", required=True)
    run(parser.parse_args())
