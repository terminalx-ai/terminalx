# browser-use MCP helpers on macOS (PRO-116)

TerminalX adapts the **managed Codex home's** browser-use stdio MCP configuration
on macOS. It prepends an app-owned Python startup directory to that server's
`PYTHONPATH`. Before browser-use imports AppKit, the startup module sets
`LSBackgroundOnly` in the process's main bundle information. An existing
`sitecustomize` still runs, and existing server arguments, environment variables,
timeouts, and additional Python import paths are retained.
Package requirements with extras, such as `browser-use[cli]==0.13.11`, receive
the same startup handling as plain browser-use requirements.

The startup module checks for `--cli-mcp`; other Python commands, the shared
browser-harness daemon, and deliberately opened Chrome windows retain their
normal activation behavior. Other MCP servers and non-macOS configurations are
unchanged. No installed Python files, app bundle plists, or user Codex
configuration files are modified. Already-running helpers need their session
restarted to pick up the change.

## Reproduced cause and ownership

On 24 October 2026, fresh processes using Homebrew framework Python 3.12.9 and
browser-use 0.13.11 reproduced the issue independently of existing sessions:

- Plain Python: no Launch Services registration.
- `from AppKit import NSScreen`: no registration.
- `NSScreen.mainScreen().frame()`: regular application (`activationPolicy=0`).
- The same query after the startup change: prohibited/background application
  (`activationPolicy=2`, inactive), with the same 1728 × 1117 display size.
- A fresh Codex 0.162.1 app-server thread launching browser-use through `uv`
  reproduced the regular Python app too. The MCP server had a separate process
  group, but terminating Codex closed its pipe and both uv and Python exited.

The trigger is browser-use's import-time
[`get_display_size()`](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/profile.py)
calling AppKit from a bundled Python interpreter. An unbundled Python interpreter
can already be background-only, so testing with just any Python 3.12 can miss it.
Apple documents the background application classification through
[`LSBackgroundOnly`](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html)
and [`NSApplicationActivationPolicy`](https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum).

The long-term fix belongs in **browser-use's macOS CLI/MCP startup**, before the
screen query, or in its screen-discovery implementation if that can avoid app
registration. This change is a scoped TerminalX integration workaround that
works with the affected installed release. It can be removed once supported
upstream releases pass the same regression without it. Setting `LSUIElement=1`
as a shell environment variable was tested and did not prevent registration.

## Process lifetime

Single-tab close and restart already close the Codex PTY, causing the owned MCP
stdio pipes to close even when uv uses a separate process group. No global
process-name sweep or Python-wide termination is necessary. The app's final
`RunEvent::Exit` now also closes agent PTYs and headless children: Cmd+Q/relaunch
can bypass the window-destruction handler that previously owned that cleanup.

The browser-harness daemon may be shared by several MCP clients. It is not a
session-owned stdio helper and must not be killed simply because one client
closes. The live tests explicitly verify that the surviving session and shared
browser connection keep working.

## Live regression commands

The regular Rust tests cover configuration scoping, existing settings, startup
installation, and idempotence. The following opt-in tests need a logged-in macOS
desktop, Codex, uv, Homebrew framework Python 3.12, browser-use 0.13.11, and Chrome.
No model turn or provider credentials are needed. They create only temporary
Codex homes and an isolated Chrome profile, and clean up their own processes.

First create a disposable environment (or use an existing affected browser-use
venv). `uv` caches this version for the offline Rust test:

```sh
uv tool run --python /opt/homebrew/opt/python@3.12/bin/python3.12 \
  --from 'browser-use[cli]==0.13.11' python scripts/browser-use-macos.test.py -v
```

The Python test verifies three fresh screen probes, an existing `sitecustomize`,
normal non-MCP Python activation, and three concurrent MCP clients. Through real
MCP calls it opens a page, reads the title, detects the viewport, clicks and types
into an input, detects the screen, and captures a screenshot. All MCP helpers stay inactive with
policy 2; the visible browser keeps policy 0. Closing a client leaves another
client and the isolated shared daemon working.

To demonstrate that the test catches the original bug, run just the screen
probe with `TERMINALX_BROWSER_USE_TEST_UNPATCHED=1`; it fails with policy 0 instead
of 2. Do not set that variable for the passing verification.

```sh
cd src-tauri
TERMINALX_BROWSER_USE_PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12 \
  cargo test --lib real_codex_helpers_stay_background_and_exit_only_with_their_session \
  -- --ignored --nocapture
```

The Rust test runs real Codex app-server processes **inside TerminalX's PTYs**,
using the actual managed configuration adapter and uv/browser-use. It launches
both plain and `[cli]` package requirements, keeps a second session alive during
three open/close or restart cycles, checks the helpers' native activation
policies, checks that only the closed session's
helpers exit, then exercises the same `kill_all` operation used at app exit.
The Rust test requires framework Python intentionally, so a standalone Python
cannot produce a misleading pass.

## Verification record

On macOS 26.3.1 (Apple silicon), with Homebrew Python 3.12.9, uv 0.9.18,
browser-use 0.13.11, and Codex 0.162.1:

- The four Python live tests passed, including visible Chrome input and screenshots.
- The explicit Rust live PTY lifecycle test passed with plain and `[cli]`
  package requirements (three close/restart cycles while a second session
  remained active, then shutdown of both).
- `pnpm exec tsc --noEmit` passed.
- `pnpm vitest run --maxWorkers=2` passed: 285 files, 3,352 tests. An unchanged
  sign-in polling test failed in the initial unrestricted review-fix run; its
  focused rerun and the complete two-worker rerun both passed.
- `cargo clippy --all-targets -- -D warnings` passed.
- `cargo test` passed: 2,220 unit tests and eight integration tests. The standard
  run skips 15 opt-in tests; the new browser-use lifecycle test was run explicitly.

Quit coverage exercises the same terminal shutdown operation called by the
final-exit handler; it does not automate the native Cmd+Q gesture. No existing
user sessions or shared browser daemons were stopped during verification.
