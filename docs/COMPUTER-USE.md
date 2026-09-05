# Computer use

Agents running inside TerminalX can see and operate desktop apps through the
`terminalx computer …` command family: accessibility snapshots, per-window
screenshots, clicks, typing, key presses, scrolling, drags, and value writes.
The agent-facing contract is the one the `computer-use` skill already
teaches, so `terminalx skills get computer-use` prints the full guide and the
installed `~/.claude/skills/computer-use/SKILL.md` stub works unchanged.

## How it works

```
terminalx computer … ──control socket──▶ TerminalX app ──unix socket──▶ TerminalX Computer Use.app
   (any shell)                          src-tauri/src/computer/           native/computer-use-macos/
```

- The **helper** is a small signed macOS app bundle, "TerminalX Computer
  Use.app", built from the Swift package in `native/computer-use-macos` and
  shipped inside `Contents/Resources`. It reads the accessibility tree with
  `AXUIElement`, captures windows with ScreenCaptureKit, and synthesises
  input with `CGEvent`.
- macOS keys Accessibility and Screen Recording consent to the helper's code
  identity, not to whichever process asks. Granting them once to the helper
  is what lets a plain agent shell, whose own `screencapture` would be
  refused, drive desktop apps. Nothing in the app or the CLI needs the
  permissions itself, and no restart is required after a grant.
- The app spawns the helper on first use with `--agent <socket> --token-file
  <path>`, connects over a private unix socket, checks the handshake
  (`protocolVersion` 1 plus the capability matrix), and sends every request
  with the token on one JSON line. Requests time out after 60 s. On quit the
  app sends `terminate` and removes the socket directory; the helper also
  exits by itself when its owning socket hangs up, so no
  `terminalx-computer-use-macos` process outlives TerminalX.
- Screenshots come back as PNG bytes, re-scaled so the longest edge is at
  most 1280 px and the file at most 900 kB. The app writes them to a private
  temp directory and answers with `screenshot.path` and `scale`; window-local
  action coordinates are `screenshot pixels / scale`.

## Commands

```
terminalx computer permissions [--id accessibility|screenshots]
terminalx computer capabilities
terminalx computer list-apps
terminalx computer list-windows --app <name|bundle|pid:N>
terminalx computer get-app-state --app <app> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot]
terminalx computer click --app <app> (--element-index <n> | --x <x> --y <y>) [--click-count <n>] [--mouse-button left|right|middle] [--modifiers <chord>]
terminalx computer perform-secondary-action --app <app> --element-index <n> --action <name>
terminalx computer set-value --app <app> --element-index <n> (--value <text> | --value-stdin)
terminalx computer type-text --app <app> (--text <text> | --text-stdin)
terminalx computer press-key --app <app> --key <Return|Escape|Tab|ArrowDown|…>
terminalx computer hotkey --app <app> --key <CmdOrCtrl+A>
terminalx computer paste-text --app <app> (--text <text> | --text-stdin)
terminalx computer scroll --app <app> (--element-index <n> | --x --y) --direction up|down|left|right [--pages <n>]
terminalx computer drag --app <app> (--from-element-index/--to-element-index | --from-x/--from-y/--to-x/--to-y)
```

Every command takes `--json`; action commands share `--window-id` or
`--window-index`, `--restore-window`, and `--no-screenshot`. Secrets go in
through `--text-stdin` / `--value-stdin` so they never appear in `ps` or
shell history. Password managers are blocked (`app_blocked`), secure text
fields are never read, and modifier chords are atomic.

Every action returns a fresh snapshot plus `action.verification`: `verified`
when the changed value or focused text was read back (`set-value` on a text
field, and `type-text` when the focused field is readable), `unverified
(accessibility action unasserted)` when the accessibility call succeeded
without a post-state check, and `unverified (synthetic input)` for keyboard
and mouse events that could not be read back.

## Permissions

Settings → General → Computer use shows the Accessibility and Screen
Recording status of the helper with a Grant… button for each; the same
prompts open from `terminalx computer permissions --id accessibility` or
`--id screenshots`. "Reset permissions" clears the helper's rows with
`tccutil` so a stale denial can be re-prompted.

The dev build (`pnpm tauri:dev`) uses a helper with bundle id
`com.terminalx.next.dev.computer-use` and the display name "TerminalX Dev
Computer Use", so dev and release helpers get separate rows under Privacy &
Security. Signing with an Apple Development certificate (the build script
picks one up from the keychain when present) gives the helper a designated
requirement that survives rebuilds; an ad-hoc signature has to be re-granted
after every build. Tauri's ad-hoc signing of the outer `TerminalX.app` leaves
the nested helper's signature untouched (verified with `codesign -d -r-` on
a `pnpm tauri build` bundle), so the helper's identity does not rotate with
app builds.

## Building

`pnpm build:computer-macos [--dev]` runs `swift build -c release`, assembles
the `.app`, writes its `Info.plist` (`LSUIElement`, usage strings, bundle id),
and signs it. `pnpm tauri:dev` and `pnpm tauri build` run it first through
`beforeDevCommand` / `beforeBuildCommand`, and `bundle.resources` copies the
result into `Contents/Resources`. Set `TERMINALX_MAC_RELEASE=1` for the
hardened runtime and timestamp, `TERMINALX_COMPUTER_MACOS_UNIVERSAL=1` for an
arm64 + x86_64 binary, and `TERMINALX_COMPUTER_MACOS_SKIP=1` to skip the
step on a machine without Xcode.

At runtime the helper is looked up in this order:
`TERMINALX_COMPUTER_MACOS_HELPER_APP_PATH`, the app's resource directory,
`Contents/Resources` next to the executable, and (debug builds only)
`native/computer-use-macos/.build/release-dev` then `…/release`.

## Testing

- `cargo test computer` in `src-tauri`: framing, handshake, timeout and
  hang-up handling against a fake helper, argument validation, screenshot
  export, CLI parsing and output.
- `cargo test real_helper -- --ignored --nocapture`: drives the built helper
  for real (capabilities, app listing, error codes, clean shutdown).
- `pnpm test:computer-macos`: the Swift package's unit tests.
- `pnpm smoke:computer [-- --screenshot --actions --apps Finder,TextEdit]`:
  end-to-end through the CLI against a running TerminalX.

## Scope

The provider is selected by platform: the native helper on macOS 14+, AT-SPI
on Linux, and UI Automation on Windows 10/11. The CLI, result shapes, error
codes, validation and screenshot export are shared. An absent desktop runtime
reports `unsupported_capability` with reinstall/override instructions.
Browser automation is tracked separately in #101.


## Linux and Windows

The bundles include `computer-use-linux/runtime.py` or
`computer-use-windows/runtime.ps1`, copied unchanged from Legacy along with
their rendering tests. `TERMINALX_COMPUTER_DESKTOP_SCRIPT_PROVIDER_PATH` overrides
the runtime location; otherwise the provider checks Tauri's resource directory,
then `native/` in debug builds. The platform Tauri configs exclude the macOS
helper. The Swift build command exits successfully off macOS.

Each request runs `python3 -c <embedded-launcher> runtime.py <operation-file>` or PowerShell with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File runtime.ps1 <operation-file>`.
Windows prefers `powershell.exe` and falls back to `pwsh.exe`. Operation payloads
stay out of process arguments, in a private temporary directory (0700 directory,
0600 files on Unix; inherited user temp ACL on Windows). Success, parse errors,
spawn errors, and timeouts all remove the directory. A 30-second deadline sends
SIGTERM on Unix and escalates to SIGKILL after one second; Windows terminates
the child directly. The child is reaped before cleanup. Output is capped at 20 MiB.

Scripts are stateless. The provider caches up to 32 snapshots for two minutes,
without PNG data, under app query/name/pid and window selectors. Explicit session
or worktree namespaces remain separate; window indexes are always scoped to
an app. A cache miss rejects an element action before spawning any script.
`window_changed` retires stale window aliases. `set-value` verifies the refreshed
value using provider identity first, then index. Clipboard and synthetic input
retain their explicit unverified reasons.

Linux requires a graphical session with `XDG_RUNTIME_DIR` and
`DBUS_SESSION_BUS_ADDRESS`, plus `python3-gi gir1.2-atspi-2.0 at-spi2-core`.
Gdk/GdkPixbuf are required for screenshots. `xdotool` enables X11 hotkeys and
modifier clicks; `wl-copy`, `xclip` or `xsel` enables clipboard paste. Wayland
screenshots/hotkeys remain unsupported. Windows needs PowerShell 5.1 or 7 and
cannot reach elevated/UIPI-protected windows from a non-elevated app. Both
platforms capture desktop regions: use `--restore-window` and trust the tree
when pixels might be occluded. Settings → General → Computer use and
`terminalx computer permissions` show the same read-only prerequisites.

Windows control commands and hooks share authenticated JSON-lines over
`\\.\pipe\terminalx-<home-hash>`; the server refuses remote pipe clients.
Bundles include `.cmd` launchers next to `raccoon.exe`; Install CLI writes
`terminalx.cmd` and `tnx.cmd` to `~/.local/bin` without requiring symlink rights.
Add that directory to PATH, as with the Unix CLI installation.

Validation: `cargo test --lib computer::`, the three
`scripts/computer-use-*.test.mjs` safety suites, and the runtime render tests
run in CI. On a graphical Linux or Windows desktop with TerminalX running:

```sh
node scripts/computer-use-smoke.mjs --actions --apps "Text Editor"
node scripts/computer-use-smoke.mjs --actions --apps Notepad
```

Apple dictation and Keychain account persistence remain platform-specific
features. They are separate from the computer-use provider.

The embedded Linux launcher adds `Accessible.is_editable_text()` only when
missing from the local PyGObject binding, using the supported
`get_editable_text_iface()` API. This fixes value writes on Debian's AT-SPI
binding while keeping the Legacy runtime byte-for-byte unchanged. Its behavior
is covered by `native/computer-use-linux/launcher_test.py`.

On X11, the launcher uses `xdotool` when available for text and named keys.
Text travels through stdin (`type --file -`), never argv. Without `xdotool`,
GDK keysyms use AT-SPI symbolic events rather than hardware keycodes, and text
is emitted as symbolic events for older registries that reject composed strings.
Failures stop delivery without replaying partial text. Wayland keeps the
original composed-string path. The smoke script reads fresh state to verify
that typed and pasted text reached the editor, while retaining the public
unverified input metadata.
