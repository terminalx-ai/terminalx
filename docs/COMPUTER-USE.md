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

Phase 1 is macOS 14 and newer. The provider trait and the CLI do not assume
macOS; on other platforms every command reports `unsupported_capability`.
Linux (AT-SPI) and Windows (UIAutomation) providers are a later phase.
Browser automation is tracked separately in #101.
