---
name: computer-use
description: >-
  Use TerminalX's computer-use CLI to inspect and operate local desktop app windows
  through accessibility trees, screenshots, and safe UI actions. Use for
  desktop app interaction: list apps/windows, get app state, read visible UI,
  click controls, type, press keys, scroll, drag, set values, or perform
  accessibility actions. Also use for browser windows, webviews, TerminalX app UI,
  or other desktop UI. Triggers include "computer use", "terminalx computer", "read
  Spotify", "read Slack", "control/click/read in a desktop app", and "get app
  state".
---

# Computer Use

Use this skill for desktop UI through `terminalx computer`. When the requested target is a website or web app, operate the desktop browser app/window that contains the page.

## Preconditions

- Use the executable you resolved for this session (`terminalx`, or `tnx`, or the app's
  `Contents/MacOS/terminalx`). Every example below writes `terminalx`; substitute the executable
  you chose. Do not create a shell variable or fall through to another executable.
- Prefer `--json`; see Screenshots below for image output.
- Do not push, submit forms, send messages, buy items, delete data, change account settings, or expose secrets unless the user explicitly asked for that action.
- If an app contains sensitive content, read only what the user requested.
- Run `terminalx computer capabilities --json` to check this platform's provider and supported operations. macOS 14+ uses the bundled "TerminalX Computer Use Helper" helper, which holds the Accessibility and Screen Recording grants. Linux uses AT-SPI (`python3-gi gir1.2-atspi-2.0 at-spi2-core`) in a desktop session; Windows uses UI Automation through Windows PowerShell 5.1 or PowerShell 7. `terminalx computer permissions` lists the platform's prerequisites.
- On Linux and Windows, action payloads pass through a short-lived local operation file, so avoid sending secrets unless the user explicitly asked.
- Linux and Windows screenshots capture a desktop region. Use `--restore-window` so another window does not cover the target region; if you cannot take focus, trust the tree over potentially occluded pixels.
- Linux window targets use `--window-index`; bundle ids and `--window-id` are unsupported. Use the returned app name or `pid:<n>`. Wayland screenshots and hotkeys remain unsupported; use the tree and semantic actions. X11 hotkeys and modifier clicks need `xdotool`, which also enables reliable text/key synthesis on older AT-SPI; clipboard paste needs `wl-copy`, `xclip`, or `xsel`.
- Windows UI Automation needs no permission grant, but a non-elevated app cannot reach elevated or UIPI-protected windows.

```text
terminalx status --json
terminalx computer capabilities --json
```

## Core Loop

```text
terminalx computer list-apps --json
terminalx computer get-app-state --app com.spotify.client --json
terminalx computer click --app com.spotify.client --element-index 42 --json
```

Use the fresh state returned by each action for the next element index. Element indexes are the numeric labels shown in the tree; they may be sparse when noisy sections are omitted, so never infer valid indexes from `elementCount` or "Visible elements." Element indexes are short-lived and go stale after delays, navigation, focus changes, scrolling, window changes, or app re-rendering.

In `--json` output, read the accessibility tree and action indexes from `result.snapshot.treeText`; `elementCount` is only a count and must not be used to infer indexes.

## App Selectors

Prefer bundle IDs from `list-apps`; names are acceptable when unambiguous. Use `pid:<number>` only when bundle ID or name matching is ambiguous, or when the app has no bundle ID (a binary run outside an app bundle, such as a dev build). When several running copies share one bundle ID (TerminalX Dev builds, for example), target the one you mean with `pid:<n>` from `list-apps`.

`--restore-window` (and a click, which brings its window forward) activates the exact running instance the selector resolved to, by pid. Computer use never launches an app and never asks macOS to open one by bundle ID, so it cannot start a second or stale copy. A name or bundle ID picks an instance that is already running; a target that is not running is an `app_not_running` error.

```text
terminalx computer get-app-state --app "Microsoft Edge" --json
terminalx computer get-app-state --app Spotify --json
terminalx computer get-app-state --app pid:12345 --json
```

For apps with multiple windows or ambiguous titles, run `list-windows` first. Prefer `--window-id <id>` when the listed id is not `none`; otherwise use `--window-index <n>`. Once you choose a window, pass the same selector to `get-app-state` and later actions until the target window changes.

## Commands

```text
terminalx computer permissions --json
terminalx computer capabilities --json
terminalx computer list-apps --json
terminalx computer list-windows --app <app> --json
terminalx computer get-app-state --app <app> --json
terminalx computer get-app-state --app <app> --restore-window --json
terminalx computer click --app <app> --element-index <index> --json
terminalx computer click --app <app> --x 100 --y 100 --json
terminalx computer click --app <app> --x 100 --y 100 --modifiers CmdOrCtrl+Shift --json
terminalx computer click --app <app> --element-index <index> --mouse-button right --json
terminalx computer click --app <app> --element-index <index> --mouse-button middle --json
terminalx computer perform-secondary-action --app <app> --element-index <index> --action <name> --json
terminalx computer set-value --app <app> --element-index <index> --value "text" --json
terminalx computer type-text --app <app> --text "text" --json
terminalx computer press-key --app <app> --key Return --json
terminalx computer hotkey --app <app> --key CmdOrCtrl+A --json
terminalx computer paste-text --app <app> --text "text" --json
terminalx computer scroll --app <app> (--element-index <index> | --x <x> --y <y>) --direction down --json
terminalx computer drag --app <app> --from-element-index <index> --to-element-index <index> --json
terminalx computer drag --app <app> --from-x 100 --from-y 100 --to-x 300 --to-y 300 --json
```

Every action command also accepts `--window-id <id>` or `--window-index <n>`, `--restore-window`, and `--no-screenshot`.

Use `--no-screenshot` only when pixels are not needed. Use `--text-stdin` or `--value-stdin` for sensitive text so payloads do not land in shell history or `ps` output:

```bash
printf '%s' "$TEXT" | terminalx computer set-value --app <app> --element-index <index> --value-stdin --json
```

## Action Rules

- Read every action's verification separately from whether its provider call succeeded:
  - `verified` means the changed value was read back.
  - `unverified (accessibility action unasserted)` means the accessibility call succeeded but no post-state assertion was made.
  - `unverified (synthetic input)` means input was fired into the void and is unverifiable.
  - Missing verification metadata is unverified, including responses from older runtimes.
- Prefer semantic actions: `set-value` for editable fields, `click` for controls, `perform-secondary-action` only for listed action names.
- After any UI-changing action, use the returned state or rerun `get-app-state` before choosing the next element index.
- Use `type-text` only after focusing a field and confirming the app has a focused text receiver; synthetic keyboard delivery is reported as unverified, so inspect the returned state before assuming text landed.
- Use `press-key` for single/navigation keys such as Return, Escape, Tab, and arrows. Use `hotkey` only for one modifier chord plus one key, such as `CmdOrCtrl+A` or `CmdOrCtrl+Shift+P`; prefer `CmdOrCtrl+...` for cross-platform combos.
- Use `click --modifiers <chord>` for modifier-clicks. Never synthesize separate modifier-down and modifier-up commands around a click; interruption can leave a modifier logically held.
- Some actions work in background apps, but this is app-dependent. If success does not change the UI, refresh state and choose a more semantic action or restore/focus the window.
- Prefer `set-value` for text fields that expose values; it can report verified value writes when the provider can read the refreshed value.
- Coordinates are window-local; use coordinates from the latest screenshot/state for the same target window.
- Password managers are blocked (`app_blocked`); secure text fields are never read.
- Raw computer use protects TerminalX's own windows: `get-app-state` withholds the AX tree and screenshot, and raw clicks, keys, typing, coordinates, scroll, drag and secondary actions return `own_app_protected`. `--restore-window` does not lift this. Explicitly authorized session controls are available through the scoped semantic `computer self-ui` route below. Other sessions, pairing codes, tokens, Settings and person-only decisions are never included in that view. Another running TerminalX Dev build can still be driven by `pid:<n>` as before.
- TerminalX's own confirmations are the person's to answer. While one is open, every action on any app answers `confirmation_pending`; reading state still works. Never answer one, and never turn on a TerminalX setting that grants an agent more power.
  What this protects: `terminalx computer` and this version's computer-use helper will not operate TerminalX's confirmations or settings, and on macOS this helper serves only the TerminalX app itself, not an agent that connects to it or starts its own copy of it. What it does not: a helper from an older TerminalX (0.2.8 or earlier) serves whoever starts it for as long as "TerminalX Computer Use" (the old name; the current helper is "TerminalX Computer Use Helper") has Accessibility in System Settings. TerminalX tries to remove that permission each time it starts and says so in `capabilities` (`warning`) when it could not; it can be put back before the next start; `osascript` / System Events; and any program at all when TerminalX itself has been granted Accessibility. Do not look for such a way around; ask the person.

## Screenshots

`get-app-state` and actions request screenshots by default unless `--no-screenshot` is
passed. A successful capture is written to a private temporary file and reported at
`result.screenshot.path` (pretty output prints the same path); the file is kept for 24 hours.
If that path is absent, use the inline base64 `result.screenshot.data`.

Use the tree for indexes/actions and the screenshot for visual confirmation; failed capture usually means hidden, minimized, off-screen, or permission-blocked.

Coordinates passed to `click`, `scroll`, and `drag` are window-local action coordinates. If the screenshot reports `scale` other than `1`, convert visual screenshot pixels before acting:

```text
action_x = screenshot_pixel_x / screenshot.scale
action_y = screenshot_pixel_y / screenshot.scale
```

Prefer element indexes or element frames from the tree when available. Use raw screenshot-derived coordinates only after checking the latest screenshot scale and window size.

## App Notes

Browsers: for Edge, Chrome, Safari, and similar browser windows, set the address/search field directly, then press Return. Do not assume raw typing went to the address bar. Use `--restore-window` when the browser is not already frontmost. Large tab strips may show only the active tab plus an "inactive browser tabs omitted" marker; treat that as intentional noise reduction and operate on the current page/address bar unless the user asked to manage tabs.

For browser-hosted forms such as Gmail compose, verify the focused UI element after each field action. Page text fields can expose accessibility actions without moving DOM focus; if a click or `set-value` does not change the focused receiver, use `Tab` / `Shift+Tab` from a known focused field or window-local coordinates from a fresh screenshot. Prefer `paste-text` into the verified focused field for draft bodies, then inspect the returned state before continuing.

```text
terminalx computer get-app-state --app "Microsoft Edge" --restore-window --json
terminalx computer set-value --app "Microsoft Edge" --element-index <addressBarIndex> --value "test123" --json
terminalx computer press-key --app "Microsoft Edge" --key Return --json
```

Spotify: refresh after playback clicks; the UI often changes asynchronously.

Slack: the accessibility tree may be shallow while the screenshot contains useful information. Reading visible Slack UI is fine when requested; sending messages or triggering workflows still needs explicit permission.

## Errors

- `app_not_found`: run `list-apps` and retry with the returned app name or `pid:<n>` (or a bundle ID on macOS). If the target is a web app such as Gmail, choose the desktop browser app/window that contains it; do not retry `terminalx computer ... --app Gmail` unchanged because `terminalx computer` app selectors refer to desktop apps, not website names.
- `app_not_running`: the targeted instance quit, and computer use never launches apps. Ask the reader to start it (or start it yourself only if asked), then run `list-apps` and retry with the new `pid:<n>`.
- `app_blocked`: stop; the target is intentionally blocked from computer-use.
- `own_app_protected`: raw self-app access stays protected. For approved session controls, use `computer self-ui authorize` and the resulting grant; for existing-session Autopilot, prefer `pipelines start <session-or-tab> [--adopt-pr]`. A missing, revoked, expired, wrong-window or insufficient self-UI grant requires a new explicit approval or a narrower command. Never use alternative raw-input or private-state routes.
- `confirmation_pending`: stop and wait for the person; only they can answer a TerminalX confirmation. Do not retry in a loop.
- `window_not_found` / `window_stale`: run `list-windows`, choose a current selector, then rerun `get-app-state`.
- `window_not_focused`: retry once with `--restore-window`; if the message says restore was already requested, stop retrying restore and bring the app forward manually or check permissions. For editable fields prefer `set-value`, then inspect before assuming keyboard input worked.
- `element_not_found`: index is stale; run `get-app-state` again.
- `unsupported_capability`: the provider or platform cannot do that action; use a semantic alternative. If the message names missing Linux packages, install those packages. If the runtime script was not found, reinstall TerminalX. If the message says the helper app was not found, ask the reader to reinstall TerminalX (or, in a development checkout, run `pnpm build:computer-macos` and restart the app).
- `action_not_supported`: inspect the element's listed actions and retry with one of those names, or use click/set-value when appropriate.
- `value_not_settable`: the element cannot accept direct value writes; focus it and use keyboard input only when the returned state can be inspected.
- `element_not_clickable`: the element has no actionable frame; use a parent/child element with a frame or choose window-local coordinates from the latest screenshot.
- `invalid_argument`: fix the command flags; do not retry the same command unchanged.
- `action_timeout`: inspect current state before retrying, then use a simpler semantic action or `--no-screenshot` if observation is slow.
- `screenshot_failed`: use `--no-screenshot` if tree state is enough; if the message names Screen Recording or screenshots permission, run `terminalx computer permissions --id screenshots --json`.
- `accessibility_error`: run `terminalx computer capabilities --json`; if the message names Accessibility permission, run `terminalx computer permissions --id accessibility --json`.
- After an update that replaced the helper, both permissions are missing once: `terminalx computer capabilities` lists `permissions` and a `nextStep`. Ask the person to grant them to "TerminalX Computer Use Helper" in TerminalX Settings > General > Computer use; you cannot. Never ask them to approve "TerminalX Computer Use" (without "Helper"): that is the old helper.
- `permission_denied`: run `terminalx computer permissions --json`, or `terminalx computer permissions --id accessibility --json` / `--id screenshots --json` when the message names one permission, let the reader use the setup UI, then retry. TerminalX does not need a restart after a grant.
- Empty tree or no screenshot: app may have no visible window, be minimized, or need permissions.

## Next Action

Confirm TerminalX status unless already checked, then run `terminalx computer capabilities --json`. For website or web-app targets such as Gmail, identify the desktop browser app/window that contains the page, then get that target app state with `terminalx computer get-app-state --app <app> --json`.


## Authorized TerminalX session controls

The supported self-UI route uses named semantic controls in the main window. It does not relax
the native provider's raw own-app protection. `capabilities` reports both `ownAppProtection`
and `supports.safety.selfUi`. No Accessibility or Screen Recording permission is needed for
this semantic route. It is supported by the desktop, including its background local owner;
a cloud-only/headless runtime has no session UI to operate.

Use the original session and author tab ids from `sessions show`/`tabs list`. When the user
has authorized this workflow, request one bounded grant; the person approves it in TerminalX:

```text
terminalx computer self-ui authorize --session <exact-session-id> --tab <exact-author-tab-id> \
  --window main --actions open-autopilot,toggle-merge,toggle-conflicts,start-autopilot,adopt-pr \
  --seconds 300 --json
```

`--actions` is a comma-separated subset of those five controls. Inspection of the permitted
session is included. The duration is 1–900 seconds (default 300). The response's `grant.id`
is an opaque handle; use it only for this task. Grants live in memory, expire without renewal,
and are lost on app restart. Refusal, dismissal and timeout grant nothing. Computer actions
and self-UI requests are suspended while a human-only confirmation is pending. Do not answer
that confirmation for the person or attempt to grant access through a file edit.

```text
terminalx computer self-ui click <grant-id> --window main --control open-autopilot --json
terminalx computer self-ui snapshot <grant-id> --window main --json
terminalx computer self-ui click <grant-id> --window main --control toggle-merge --json
terminalx computer self-ui click <grant-id> --window main --control start-autopilot --json
terminalx computer self-ui revoke <grant-id> --json
```

`open-autopilot` selects only the authorized session/tab and opens Branch > Autopilot. The
snapshot contains only that panel's control IDs, enabled/checked state, pipeline ID and pipeline state.
`toggle-merge` is **Merge when green**, `toggle-conflicts` is **Resolve conflicts automatically**,
`start-autopilot` is **Turn on autopilot**, and `adopt-pr` is **Adopt existing PR**. For an already
open reviewed PR, use `adopt-pr` instead of `start-autopilot`, or use the simpler direct command:

```text
terminalx pipelines start <original-author-tab-id> --adopt-pr --json
```

Adoption keeps the original session, branch and PR, waits for the author to become idle and
runs TerminalX's independent review on the exact head. No new author, duplicate PR or history
rewrite is involved. Existing TerminalX review history is retained; an external review alone
does not grant a TerminalX merge verdict. See the CLI guide for launch switches and recovery.

A successful self-UI action returns `actor: agent`, `verified: true` and the observed state.
The screenshot status is `skipped` with reason `scoped_semantic_ui`. No full-window pixels,
DOM/AX text, transcript, title, pairing code, token or unrelated private session is captured.
Clicks invoke the scoped control handler with agent attribution; pipeline history records
`selfUi`, not `person`. Unsupported controls are refused, including merge overrides,
review-round extensions, Settings and every confirmation/approval button. A modal blocks
session controls. A hidden panel or different visible session/tab returns `window_stale`;
re-open the authorized panel or inspect before continuing. A timeout does not prove that an
action failed: inspect the pipeline before retrying activation.

The access banner lets the person revoke all grants immediately; `revoke` removes the named
grant and cancels pending requests. Expiry/revocation/wrong-window/action-scope failures return
`own_app_protected` with this supported recovery. Native code revalidates a grant before an
activation; late UI replies cannot revive it. Revocation stops future actions; it does not
undo an action already admitted or stop a pipeline that has already started. To halt that
pipeline, use its ordinary Stop control or `pipelines stop`.
