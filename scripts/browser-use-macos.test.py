#!/usr/bin/env python3
"""Live PRO-116 regression. Run with a framework-Python browser-use venv.

Uses temporary homes, an isolated visible Chrome, and only processes it starts.
See docs/BROWSER-USE-MACOS.md for prerequisites and the Rust PTY lifecycle test.
"""

import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import quote

STARTUP = Path(__file__).resolve().parents[1] / "src-tauri/src/harness/codex/browser_use_macos"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def environment(extra=None):
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if not os.environ.get("TERMINALX_BROWSER_USE_TEST_UNPATCHED"):
        env["PYTHONPATH"] = str(STARTUP) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env.update(extra or {})
    return env


def python(code, env=None, mcp=True):
    return subprocess.check_output(
        [sys.executable, "-c", code, *(["--cli-mcp"] if mcp else [])],
        env=env or environment(), text=True, timeout=20,
    ).strip()


def policy(pid):
    return json.loads(python(
        "import json; from AppKit import NSRunningApplication; "
        f"a=NSRunningApplication.runningApplicationWithProcessIdentifier_({pid}); "
        "print(json.dumps(None if a is None else [a.activationPolicy(),bool(a.isActive())]))"
    ))


class MCP:
    def __init__(self, env, log):
        self.process = subprocess.Popen(
            [sys.executable, "-c", "from browser_use.cli import main; main()", "--cli-mcp"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
        )
        self.lines = queue.Queue()
        self.next_id = 0

        def read():
            for line in self.process.stdout:
                self.lines.put(json.loads(line))
            self.lines.put(None)

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def initialize(self):
        self.call("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                "clientInfo": {"name": "pro116-test", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = self.call("tools/list", {})
        assert {t["name"] for t in tools["tools"]} >= {"browser_exec", "browser_screenshot"}

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, method, params):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        deadline = time.monotonic() + 30
        while True:
            message = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            assert message is not None, "MCP closed without replying"
            if message.get("id") == self.next_id:
                assert "error" not in message, message
                return message["result"]

    def close(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.reader.join(timeout=2)
            self.process.stdout.close()


@unittest.skipUnless(sys.platform == "darwin", "macOS Launch Services regression")
class BrowserUseMacOS(unittest.TestCase):
    def test_screen_detection_does_not_register_a_foreground_app(self):
        for _ in range(3):
            result = json.loads(python(
                "import json; from browser_use.browser.profile import get_display_size; "
                "from AppKit import NSRunningApplication; "
                "s=get_display_size(); a=NSRunningApplication.currentApplication(); "
                "print(json.dumps([s.width,s.height,a.activationPolicy(),bool(a.isActive())]))"
            ))
            self.assertGreater(result[0], 0)
            self.assertGreater(result[1], 0)
            self.assertEqual(result[2:], [2, False], "Python appeared in Dock/app switcher")

    def test_existing_sitecustomize_still_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "sitecustomize.py").write_text("import os; os.environ['PRO116_CUSTOMIZED']='yes'\n")
            env = environment()
            env["PYTHONPATH"] += os.pathsep + directory
            self.assertEqual(python("import os; print(os.environ['PRO116_CUSTOMIZED'])", env), "yes")

    def test_non_mcp_python_keeps_its_normal_app_policy(self):
        result = python(
            "from AppKit import NSScreen, NSRunningApplication; NSScreen.mainScreen().frame(); "
            "print(NSRunningApplication.currentApplication().activationPolicy())", mcp=False,
        )
        self.assertEqual(result, "0", "the startup hook must not hide unrelated Python applications")

    def test_multiple_mcp_helpers_and_a_usable_visible_browser(self):
        self.assertTrue(CHROME.exists(), "install Chrome for this live browser test")
        with tempfile.TemporaryDirectory(prefix="pro116-") as directory:
            root = Path(directory)
            env = environment({"BH_HOME": str(root / "harness"), "BH_RUNTIME_DIR": str(root / "runtime"),
                               "BH_RUNTIME_DIR_SHARED": "0", "ANONYMIZED_TELEMETRY": "false"})
            processes = []
            helpers = []
            with (root / "stderr.log").open("w+") as log:
                try:
                    chrome = subprocess.Popen([str(CHROME), f"--user-data-dir={root / 'chrome'}",
                        "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"],
                        stdout=log, stderr=log)
                    processes.append(chrome)
                    port_file = root / "chrome/DevToolsActivePort"
                    deadline = time.monotonic() + 20
                    while not port_file.exists():
                        self.assertIsNone(chrome.poll(), "isolated Chrome exited")
                        self.assertLess(time.monotonic(), deadline, "Chrome did not expose CDP")
                        time.sleep(.05)
                    env["BU_CDP_URL"] = "http://127.0.0.1:" + port_file.read_text().splitlines()[0]
                    # Own the daemon explicitly, instead of asking browser-use to
                    # discover or start a shared daemon from the user's home.
                    daemon = subprocess.Popen([sys.executable, "-m", "browser_harness.daemon"],
                                              env=env, stdout=log, stderr=log)
                    processes.append(daemon)
                    while not list((root / "runtime").glob("*.sock")):
                        self.assertIsNone(daemon.poll(), "isolated daemon exited")
                        self.assertLess(time.monotonic(), deadline, "daemon did not expose IPC")
                        time.sleep(.05)
                    for _ in range(3):
                        helper = MCP(env, log)
                        helpers.append(helper)
                        helper.initialize()
                        self.assertEqual(policy(helper.process.pid), [2, False])
                    page = "data:text/html," + quote('<title>PRO116_OK</title><input id="field"><p>Browser automation works</p>')
                    result = helpers[0].call("tools/call", {"name": "browser_exec", "arguments": {"code":
                        f"new_tab({page!r})\nprint(js('document.title'))\n"
                        "info=page_info(); assert info['w']>0 and info['h']>0\n"
                        "click_at_xy(20,18); type_text('typed')\n"
                        "print(js(\"document.getElementById('field').value\"))\n"
                        "from browser_use.browser.profile import get_display_size\n"
                        "s=get_display_size(); assert s.width>0 and s.height>0\nprint('SCREEN_OK')"}})
                    text = json.dumps(result)
                    for expected in ["PRO116_OK", "typed", "SCREEN_OK"]:
                        self.assertIn(expected, text)
                    self.assertNotIn("Traceback", text)
                    screenshot = helpers[0].call("tools/call", {"name": "browser_screenshot", "arguments": {"max_dim": 800}})
                    self.assertTrue(any(c["type"] == "image" and len(c["data"]) > 100 for c in screenshot["content"]))
                    self.assertEqual(policy(chrome.pid)[0], 0, "the browser window must remain a regular application")
                    for helper in helpers:
                        self.assertEqual(policy(helper.process.pid), [2, False])
                    helpers[0].close()
                    # A session closing must leave another session and the
                    # deliberately shared browser connection working.
                    self.assertIsNone(helpers[1].process.poll())
                    self.assertIsNone(daemon.poll())
                    self.assertIn("tools", helpers[1].call("tools/list", {}))
                except BaseException:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-6000:], file=sys.stderr)
                    raise
                finally:
                    for helper in helpers:
                        helper.close()
                    for process in reversed(processes):
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()


if __name__ == "__main__":
    unittest.main()
