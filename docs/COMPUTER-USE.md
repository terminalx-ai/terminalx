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
- The app spawns the helper on first use with `--agent <socket> --token-fd 3`,
  hands it a per-launch token on an inherited pipe (never a file), connects
  over a private unix socket, checks the handshake (`protocolVersion` 1 plus
  the capability matrix), and sends every request with the token on one JSON
  line. The helper serves only the process that started it; see
  [Security](#security). Requests time out after 60 s. On quit the
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
`--window-index`, `--restore-window`, and `--no-screenshot`.
`--restore-window` activates the exact running instance the `--app` selector
resolved to (`NSRunningApplication(processIdentifier:)` on macOS). It never
opens an app by bundle id through LaunchServices and never launches an app
that is not running (`app_not_running`): when several builds share a bundle id
(TerminalX Dev), `open -b` used to launch a stale registered copy that took
over the running app's control socket. A name or bundle id selector picks a
running instance (the frontmost, else the longest running); use `pid:N` to
choose one. Secrets go in
through `--text-stdin` / `--value-stdin` so they never appear in `ps` or
shell history. Password managers are blocked (`app_blocked`), secure text
fields are never read, and modifier chords are atomic.

Every action returns a fresh snapshot plus `action.verification`: `verified`
when the changed value or focused text was read back (`set-value` on a text
field, and `type-text` when the focused field is readable), `unverified
(accessibility action unasserted)` when the accessibility call succeeded
without a post-state check, and `unverified (synthetic input)` for keyboard
and mouse events that could not be read back.

## Security

Who is kept out, and from what. The attacker considered here is an agent that
TerminalX itself runs: a process with a shell, the person's user id, and
TerminalX as its ancestor. It is not root and cannot change a signed app.

**What the helper refuses (macOS).**

- *Whom it serves.* Only the process that started it, checked on the socket
  peer's audit token. A released helper (signed with a Developer ID) also
  requires that process to be the TerminalX app signed by the same team:
  `identifier "com.terminalx.next"` plus the team's Developer ID certificate,
  verified against the code the peer is running. Being a child of TerminalX,
  or carrying its bundle id, earns nothing. So an agent that connects to the
  app's helper is refused even with the token, a copy of the helper that an
  agent starts refuses the agent, and a copy started through LaunchServices
  (`open`) has no launcher and serves nobody. A helper that cannot confirm its
  own signature serves nobody.
- *The token.* It travels on a pipe only the helper inherits. There is no
  token file to read.
- *TerminalX's own windows.* Every action (click, type, key, hotkey, paste,
  set-value, secondary action, scroll, drag) whose target is the app that
  started the helper answers `own_app_protected`, always, not only while a
  confirmation is open. The match is by process id, so the app's dialogs and
  sheets are covered and a build without a bundle id (`tauri dev`) is too.
  The released app (`com.terminalx.next`) is refused as a target by every
  instance's helper, so a second TerminalX started by an agent cannot press
  buttons in the person's app. Another running Dev build stays drivable from
  a different instance (that is how the smoke tests work), even when it shares
  a bundle id with the driver.
- *Keys that would land on TerminalX.* Synthetic keys go to whatever has the
  keyboard focus. Before every key the helper checks the focused and the
  frontmost app and stops with `own_app_protected` if it is a protected one.
  Synthetic clicks were already fenced to the target window.
- *Reading.* The accessibility tree of TerminalX's own windows can still be
  read (secure text fields are never read). Its windows are never
  screenshotted: `screenshotStatus` says `skipped` with reason
  `own_app_protected`, so a pairing QR code or a secret on screen does not
  leave as pixels. Text the app shows in clear is still in the tree.
- The app also answers `own_app_protected` itself for `--app pid:<its own
  pid>` on every platform, and keeps answering `confirmation_pending` for
  every action while one of its questions is open.

**The escape hatch, for TerminalX's own UI tests only.** A debug build of the
app started with `TERMINALX_COMPUTER_USE_TEST_ALLOW_OWN_WINDOWS=1` may drive
its own windows. The app reads the variable from its own environment, once,
and passes the request in the helper handshake. A child process cannot set it
for the app, no `terminalx computer` request carries it, a release build of
the app does not read it, and a released helper ignores it. It never lifts
the rule for the released app. Starting another test build with it set only
lets that build drive itself.

**What a local build cannot promise.** A helper that is ad-hoc or development
signed has no signing identity to check the app against, so it trusts its
launcher, whoever that is; and an agent with a shell on a development machine
can rebuild the helper anyway. Dev builds can no longer borrow the released
helper (`TERMINALX_COMPUTER_MACOS_HELPER_APP_PATH` pointing into
`/Applications`): it refuses a peer that is not the released app. A Dev
instance can also be driven by another Dev instance.

**What is outside the app's control.** None of the above stops software that
drives the screen without the helper:

- macOS attributes a process started from a TerminalX terminal to TerminalX
  for privacy permissions. If *TerminalX itself* has been given Accessibility
  or Screen Recording in System Settings, every program an agent runs has
  them too and can post events or read the screen directly (measured: an
  unsigned test binary run from an agent shell reported
  `AXIsProcessTrusted() == true`, and `false` once started with the
  responsibility disclaimed). TerminalX does not need either permission for
  itself; only "TerminalX Computer Use" should be listed. Remove TerminalX
  from both lists if it is there.
- `osascript` / System Events, or any other app the person has granted
  Accessibility, can press the same buttons.
- For the same reason a copy of the helper started from an agent shell is
  granted Accessibility by macOS; the peer check above is what stops it being
  used, not the permission system.

Closing those needs the system: a way for an app to mark a window or control
as not operable by synthetic input and accessibility clients (as secure text
entry does for reading keystrokes), or a per-process rather than
per-responsible-app Accessibility grant. Until then the person's switch and
their answer are a control against mistakes and against agents that use
TerminalX's own tools, not a boundary against arbitrary software running as
them.

Linux and Windows have no privileged helper: the provider runs the platform
accessibility API as the user, which an agent can call just as well. Only the
`pid:<own pid>` refusal and the confirmation pause apply there.

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
- `pnpm test:computer-macos`: the Swift package's unit tests, including who
  the helper serves (`PeerTrustTests`) and which targets it refuses
  (`OwnAppProtectionTests`).
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
