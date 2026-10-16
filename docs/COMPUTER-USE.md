# Computer use

Agents running inside TerminalX can see and operate desktop apps through the
`terminalx computer …` command family: accessibility snapshots, per-window
screenshots, clicks, typing, key presses, scrolling, drags, and value writes.
The agent-facing contract is the one the `computer-use` skill already
teaches, so `terminalx skills get computer-use` prints the full guide and the
installed `~/.claude/skills/computer-use/SKILL.md` stub works unchanged.

## How it works

```
terminalx computer … ──control socket──▶ TerminalX app ──unix socket──▶ TerminalX Computer Use Helper.app
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
- The helper runs from a copy outside the app, at
  `~/Library/Application Support/TerminalX/computer-use-helper/<key>/TerminalX Computer Use Helper.app`
  (`<key>` is derived from where the bundled helper is, so each build on a
  Mac has its own). macOS charges a Screen Recording check to the outermost
  app bundle around the executable, so a helper inside `TerminalX.app`
  could take screenshots only while TerminalX itself held Screen Recording,
  and its Grant button asked for TerminalX (#480). See
  [Where the helper runs](#where-the-helper-runs).
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
  app's helper is refused even with the token, a copy of *this* helper that an
  agent starts refuses the agent, and a copy started through LaunchServices
  (`open`) has no launcher and serves nobody. A helper that cannot confirm its
  own signature serves nobody. None of this is true of helpers from older
  versions; see "Older helpers" below.
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
- *Reading.* Nothing of TerminalX's own windows is read. There is no
  screenshot (`screenshotStatus` says `skipped` with reason
  `own_app_protected`) and no accessibility tree: `treeText` holds one line
  saying it is withheld and there are no element indexes. The windows show
  the phone pairing code, invite links and other sessions' terminals as plain
  text, so the tree is not served at all rather than filtered. `list-windows`
  still lists the windows with their titles, and `--restore-window` does
  nothing to them: looking never activates, raises or unminimises the app.
  The same holds for the released app seen from another instance. A Dev build
  seen from a different instance is not protected and is read in full.
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

**Older helpers (0.2.8 and earlier).** macOS keys a permission to an app's
signing identity, not its version. Helpers released before this change are
signed as `com.terminalx.next.computer-use`, trust whoever starts them, and
have no own-window rule. They are public. While one of them still has
Accessibility, any program can run a copy and press TerminalX's buttons with
it, whatever version of TerminalX is installed. So:

- this helper has a new identity, `com.terminalx.next.computer-use.v2`
  (`…dev.computer-use.v2` for dev builds), and a new name, "TerminalX Computer
  Use Helper" (the old one is "TerminalX Computer Use"), so the two rows can
  be told apart in System Settings. The old permission does not apply to it;
  people who granted before grant Accessibility and Screen Recording once
  more;
- at every launch and again before every helper start, never on the main
  thread, the app runs `tccutil reset Accessibility` and `tccutil reset ScreenCapture` for
  the old ids (no administrator password is needed for one's own entries).
  Nothing on disk records that it ran: a record could be forged by an agent
  to switch the removal off, and an old helper can be granted again at any
  time. Each tool gets ten seconds;
- `tccutil` only resets an app LaunchServices can still find, and after an
  update the old helper is no longer on disk. When the plain reset is refused
  the app writes a stub bundle that does nothing and declares the old id,
  under `~/Library/Application Support/TerminalX/old-helper-removal`
  (LaunchServices ignores bundles in temporary directories), registers it
  with `lsregister -f`, resets, then unregisters and deletes it whatever
  happened. Each stub goes in a folder with a random name that is created
  new; a symlink at the base, the folder or the bundle is refused. A stub
  left registered by a crash is unregistered and deleted at the next run,
  once it is more than five minutes old;
- which ids are cleared depends on the app's own bundle id, not on how it was
  compiled: only `com.terminalx.next` clears the released helper's old id;
  every build clears the old dev id. A Dev or local build therefore never
  breaks an older installed TerminalX on the same Mac;
- if the removal still fails, this launch says so in Settings → General →
  Computer use and in `terminalx computer capabilities` / `permissions`
  (`warning`, and `legacyHelper.removed: false`), with the steps to remove
  "TerminalX Computer Use" by hand; it is tried again at the next launch;
- the app refuses to start a helper that declares an old id, and the build
  script refuses to build one and checks both the plist and the signed
  identifier.

**A helper from 0.2.8 or earlier keeps working for whoever starts it for as
long as it is granted.** The app removes that grant each time it starts and
each time it starts the helper, so the exposure is bounded, not closed: until
then the old row can be put back, by the person or by an agent (for
example by opening an old helper's own permission window and getting the
person to approve it). Only "TerminalX Computer Use Helper" should ever be
approved. That the stub reset removes a row created by a Developer ID signed
helper has been verified with scratch ids only, not yet on a signed build.

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
  responsibility disclaimed). **TerminalX itself must not hold Accessibility
  or Screen Recording.** It never asks for either (it declares no usage
  string for them and calls neither API; its only privacy prompts are the
  microphone and speech recognition for dictation), so an entry for
  "TerminalX" was added by hand. Only "TerminalX Computer Use Helper" should be
  listed; remove TerminalX from both lists. Settings says so too.
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

## Where the helper runs

tccd decides whose permission a check is with two different rules
(measured on macOS 27 with scratch bundles; tccd's `AUTHREQ_SUBJECT` log
line names the subject):

| Check from a disclaimed helper inside `Outer.app` | Subject |
|---|---|
| Accessibility (`AXIsProcessTrusted`) | the helper's own bundle id |
| Screen Recording (`CGPreflightScreenCaptureAccess`, and the request behind Grant) | `Outer.app`'s bundle id (`BUNDLE_ATTRIBUTION: … resolves to attributed bundle: …/Outer.app/`) |

The responsibility disclaim is honoured (an undisclaimed child is charged to
the app that runs the terminal; a disclaimed one is not), but for Screen
Recording tccd then resolves the executable to the outermost enclosing app.
It does so for every place inside a bundle that was tried: `Contents/Resources`,
`Contents/Helpers`, `Contents/Library/LoginItems` (where `SMAppService` login
items live), `Contents/Library/Helpers`, `Contents/MacOS`, `Contents/Frameworks`
and `Contents/XPCServices`, and for a launch through LaunchServices (`open`)
as well. A helper outside any app bundle is charged to itself for both.

So the app copies the bundled helper to Application Support and runs the
copy, for the agent session, the status probe and the Grant and Reset
buttons alike. A helper that is not inside an app (`pnpm tauri:dev`,
`.build/release-dev`) runs where it is.

**Keeping the copy current** (`helper_install.rs`). The copy is compared with
the bundled helper (names, kinds, modes, contents and symlink targets) before
every helper start, and before a status or permission request at most every
ten seconds. When they differ, a new copy is written beside it and renamed
into place. The folders it lives in must be plain folders (a symlink is
refused), a copy location inside an app bundle is refused, installs are
serialised in the process and across processes (`flock` on a lock file in the
base folder), and copies whose bundled helper no longer exists (a moved or
deleted app, an App Translocation mount) are removed. Each copy's folder
records which bundled helper it copies. None of this is a security
boundary: the folder is writable by the person's user, and so by an agent.

**Which code the app runs** (`code_identity.rs`). The app never trusts the
copy's files. Before each start it validates the *bundled* helper's signature
(strictly, every architecture, nested code included) and reads its signing
identifier and code directory hash. It then requires of every helper process:

- `identifier "<the bundled helper's>" and cdhash H"<the bundled helper's>"`:
  the exact build, so an older signed helper is refused too;
- for the released app (`com.terminalx.next`): the identifier
  `com.terminalx.next.computer-use.v2` and a Developer ID of the team that
  signed the app. A released app that cannot read its own team accepts no
  helper;
- no pre-PRO-90 identity.

Every helper process (the agent session, the status probe, the setup window)
is spawned directly with the responsibility disclaim and
`POSIX_SPAWN_START_SUSPENDED`. The app checks the code running in that
suspended child by pid (an unreaped child, so the pid cannot be reused) and
only then resumes it. Otherwise it kills it before it ran a single
instruction, so a swapped copy never sees the token or the app's environment,
cannot answer a status probe, and cannot show a setup window. An agent session
is checked a second time once connected: the socket's peer (its audit token,
`LOCAL_PEERTOKEN`) must be the child just started and must still run the
expected code. The helper's location is resolved again before every start,
so a restart after the helper died is checked the same way. "Reset
permissions" clears the rows of the identifier read from the bundled helper's
signature, never one read from the copy, and only a `….computer-use.v2` id.
`tccutil` refuses an id LaunchServices cannot resolve, and the helper is no
longer opened through LaunchServices, so when a reset fails the app
registers the bundled helper inside TerminalX.app (`lsregister -f`, never the
copy) and tries once more.

**The drag tile.** The setup window's drag tile is what the person drags into
System Settings, and macOS grants whatever was dropped. The app therefore
passes the helper *inside the app* with `--drag-source`. The setup window
offers it only if its signature is intact and its cdhash equals the running
helper's own. Otherwise there is no tile, and the window says to add the
helper from `TerminalX.app › Contents › Resources` with +.

**What remains.** All of this rests on the bundled helper inside
`TerminalX.app`. If an agent can modify `/Applications/TerminalX.app` itself
(macOS's App Management protection decides that), it could replace the
bundled helper with an older signed one and the copy would follow. That was
true of the in-app helper before #480 as well; the signed-build checklist
records whether it is possible.

## Permissions

Settings → General → Computer use shows the Accessibility and Screen
Recording status of the helper with a Grant… button for each; the same
prompts open from `terminalx computer permissions --id accessibility` or
`--id screenshots`. "Reset permissions" clears the helper's rows with
`tccutil` so a stale denial can be re-prompted.

The dev build (`pnpm tauri:dev`) uses a helper with bundle id
`com.terminalx.next.dev.computer-use.v2` and the display name "TerminalX Dev
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

## Signed-build checklist (PRO-90)

That the stub reset removes a row created by a Developer ID signed helper
cannot be checked without one. On the first signed build, on a Mac where
0.2.8 was granted computer use:

1. Before updating, note the "TerminalX Computer Use" rows under Accessibility
   and Screen Recording. Save the 0.2.8 helper as a **zip** outside
   `/Applications`: a loose `.app` keeps the old id resolvable and hides the
   stub path.
2. Update in place and start TerminalX.
3. Read the log: "permissions of older helpers removed", or "macOS would not
   remove the permissions of older helpers".
4. Run `tccutil reset Accessibility com.terminalx.next.computer-use` by hand.
   Exit 64 ("No such bundle identifier") means macOS no longer resolves the
   old id, so the stub path is what ran at launch.
5. Confirm both old rows are gone from Accessibility and Screen Recording.
6. Unzip the saved helper and run it from a shell with `--permission-status`:
   it must report Accessibility `not-granted`.
7. Grant both permissions to "TerminalX Computer Use Helper" in Settings →
   General → Computer use, then run `terminalx computer capabilities`: both
   `granted`, no `nextStep`, no `warning`. This is also the first end-to-end
   run of the Developer ID peer requirement.
8. `terminalx computer get-app-state --app TerminalX` returns no tree, no
   elements and no screenshot, and does not raise the window.

## Signed-build checklist (#480)

Screen Recording attribution can only be shown on a Developer ID build. On
the owner's Mac, without granting anything to TerminalX itself:

1. In System Settings → Privacy & Security → Screen & System Audio Recording,
   remove **TerminalX** if it is listed. Leave "TerminalX Computer Use
   Helper" as it is. Accessibility lists only the helper.
2. Install the build and start TerminalX. In a TerminalX terminal run
   `terminalx computer capabilities --json`.
3. Check the copy exists and is the bundled code:
   `ls ~/Library/Application\ Support/TerminalX/computer-use-helper/*/` shows
   one "TerminalX Computer Use Helper.app" (and a `source` file), and `codesign -dr - <that app>`
   prints the same designated requirement as
   `codesign -dr - "/Applications/TerminalX.app/Contents/Resources/TerminalX Computer Use Helper.app"`.
4. `ps -o pid,command -ax | grep terminalx-computer-use-macos` shows the
   agent helper running from the Application Support path.
5. If the helper row is on: step 2 reports Accessibility and screenshots both
   `granted`, no `nextStep`; `terminalx computer get-app-state --app Finder`
   returns a screenshot.
6. If screenshots say `not-granted` (the row is off, or absent), open
   Settings → General → Computer use and press Grant… for Screen Recording.
   The macOS prompt must name **"TerminalX Computer Use Helper"**, not
   "TerminalX", and no TerminalX row may appear in Screen & System Audio
   Recording afterwards. Turn the helper row on yourself, then repeat step 5.
7. From a TerminalX terminal, an unsigned probe that prints
   `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()` reports
   `false` and `false`.
8. Optional, to see the attribution itself: run
   `/usr/bin/log stream --level debug --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_SUBJECT"'`
   while doing step 2. The screen-capture request's subject is
   `com.terminalx.next.computer-use.v2`, not `com.terminalx.next`.
9. The copy is valid code: `codesign --verify --deep --strict --verbose=2 <copy>`
   says "valid on disk" and "satisfies its Designated Requirement", and
   `spctl --assess --type execute --verbose <copy>` says "accepted" with
   source "Notarized Developer ID". Note any App Management prompt
   ("TerminalX would like to modify apps" / "was prevented from modifying
   apps") when TerminalX first creates the copy, and after updating
   TerminalX, when it replaces it.
10. The drag tile. Press Grant… for Screen Recording with the helper row
    removed. The floating panel shows a tile. Drag it into the list (it is the
    helper inside `TerminalX.app`, not the copy). Then repeat step 5: the row
    created from the in-app helper must be the one the copy satisfies
    (screenshots `granted`). If it is not, say so in #480: the tile must then
    be removed.
11. A swapped copy is refused. In a TerminalX terminal (an agent's
    position):
    - check whether the shell can write to `/Applications/TerminalX.app`:
      `touch /Applications/TerminalX.app/Contents/Resources/x480 && rm /Applications/TerminalX.app/Contents/Resources/x480`.
      Record whether macOS allowed it;
    - check whether it can write to the copy (it can; that is expected);
    - replace the copy's executable (`cp /usr/bin/true "<copy>/Contents/MacOS/terminalx-computer-use-macos"`),
      kill the running helper (`pkill -f terminalx-computer-use-macos`), and run
      `terminalx computer list-apps`. It works, and
      `cmp "<copy>/Contents/MacOS/terminalx-computer-use-macos" "/Applications/TerminalX.app/Contents/Resources/TerminalX Computer Use Helper.app/Contents/MacOS/terminalx-computer-use-macos"`
      shows the copy was put back before the restart. A swap that lands
      between that comparison and the start is refused by the code check
      before it runs; the unit tests cover that race, which cannot be timed by
      hand.
12. Reset. In Settings → Computer Use, press "Reset permissions". It
    succeeds without "No such bundle identifier", both helper rows are gone,
    and the TerminalX row (if any) is untouched. Grant both again afterwards
    for the steps above.

## Testing

- `cargo test computer` in `src-tauri`: framing, handshake, timeout and
  hang-up handling against a fake helper, argument validation, screenshot
  export, CLI parsing and output, the helper copy outside the app
  (`helper_install`), and which code may run as the helper: suspended start,
  the pid and socket-peer checks, re-resolution at a restart, and real
  ad-hoc signatures whose cdhash differs (`code_identity`, `macos_native`,
  `permissions`).
- `cargo test real_helper -- --ignored --nocapture`: drives the built helper
  for real (capabilities, app listing, error codes, clean shutdown).
- `pnpm test:computer-macos`: the Swift package's unit tests, including who
  the helper serves (`PeerTrustTests`), which targets it refuses
  (`OwnAppProtectionTests`), and what the drag tile may offer
  (`DragSourceTests`).
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
