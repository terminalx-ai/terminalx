# Phase 2/3 feature batch: run plan

Written 2026-11-22 against main at `933115cc`. The plan TerminalX reads is `plan.json` in this folder.
Run id: `01a2041c-7f8b-7b61-8ed6-053cba69c9cc`, stored as `planned`. It is not started: the owner starts it.

## Why the pieces are cut by layer

Every ready ticket adds shortcut actions, and most add a pref, a Tauri command or both. Those all
land in the same few files (`src/lib/shortcuts.ts`, `src/lib/prefs.ts`, the settings registry,
`src-tauri/src/lib.rs`, `commands.rs`, `session.rs`, `src/lib/api.ts`). A run gives each file one
owner, so one piece per ticket cannot work. The cut is:

1. `registries` first: the shortcut actions, prefs and settings rows for all seven tickets.
2. `backend` next: the Rust commands and API wrappers for the four tickets that need any.
3. Three UI pieces side by side, each merging the tickets that edit the same components.

At most three pieces run at once (the run's limit is four).

## Pieces

| Order | Piece | Tickets | Owns (summary; full list in `plan.json`) | Waits on |
| -- | -- | -- | -- | -- |
| 1 | `registries` | 208, 216, 232, 236, 242, 247 (definitions only) | `src/lib/shortcuts.ts`, `hotkeys.ts`, `prefs.ts`, `settingsSections.ts`, `src/components/settings/settingsRegistry.tsx` and snapshot, `ShortcutsTab.tsx`, `scripts/webkit/shortcuts.mjs` | none |
| 2 | `backend` | 216, 224, 236, 247 (Rust and wrappers) | `src-tauri/src/lib.rs`, `commands.rs`, `session.rs`, `session_fork.rs`, `session_reset.rs`, `open_in.rs`, `configuration_commands.rs`, `harness/`, `store/index.rs`, `store/settings*`, `fixtures/`, `local_runtime/`, `remote/server.rs`, `schemas/`, `src/lib/api.ts`, `sessionBackend.ts`, `sessions.ts`, `src/types/session.ts`, `scripts/webkit/tauri-stub.js`, `docs/PTY-FIRST.md` | registries |
| 3 | `composer` | 208, 216 (UI), 224 (UI) | `src/components/chat/Composer.tsx`, `composer/`, `PickerMenu.tsx`, `useFileMention.tsx`, `HeldQueueTray.tsx`, `ModelSwitch.tsx`, `src/components/mcp/`, `src/components/session/NewSessionView.tsx`, `src/lib/localCommands.ts`, `mcpStatus.ts`, `pickers.ts`, WebKit checks `composer-controls`, `composer-menus`, `mcp-servers`, `new-session-completion` | backend |
| 3 | `chat-tab` | 232 (missing parts), 236 (UI) | `src/components/chat/TurnBlock.tsx`, `Chat.tsx`, `disclosures.tsx`, `ReadAloudBar.tsx`, `ForkNotice.tsx`, `src/components/session/TabMenu.tsx`, `TabStrip.tsx`, `TabView.tsx`, `RecoveryBanner.tsx`, `src/components/settings/ExperimentalSettings.tsx`, `src/lib/experimentalSettings.ts`, `transcriptCopy.ts`, `readAloud.ts`, `packages/portable/src/recovery.ts`, WebKit checks `chat-actions`, `tab-fork` | backend |
| 3 | `changes-files` | 242 (missing parts), 247 (UI) | `src/components/layout/RightPanel.tsx`, `src/components/editor/ReviewStackPane.tsx`, `DiffEditorPane.tsx`, `EditorToolbar.tsx`, `src/components/changes/ChangesPanel.tsx`, `ScopePicker.tsx`, `ReviewComments.tsx`, `DiffOptions.tsx`, `DiffPane.tsx`, `ReviewMenu.tsx`, `src/components/files/FileTreeView.tsx`, `src/components/chat/ChatLink.tsx`, `src/components/session/SessionView.tsx`, `src/components/openIn/`, `src/lib/openIn.ts`, `reviewPrompt.ts`, WebKit checks `diff-keys-review`, `open-in`, `diff-options` | backend |

## What each piece must pass before it counts as done

- Typecheck: `pnpm exec tsc --noEmit`.
- The piece's own vitest files, then the root vitest run (`pnpm test`).
- Rust tests of the touched modules (`backend` only): `harness::claude::transcript`, `harness::settings`,
  `harness::mcp_status`, `session_fork`, `open_in::`, `store::settings`.
- The WebKit layout check of each changed screen: `pnpm build && node scripts/webkit/<check>.mjs`.
- A notes file, `docs/runs/phase-2-3-batch/<piece>-notes.md`: each acceptance line with the test that
  proves it, and each deliberate difference from the screens.
- A review of the diff against those acceptance lines and against "no mock data, no control without a
  working handler".

After each merge the lead's checkout runs `tsc --noEmit` and the root vitest run.

## Design screens

Workers cannot open Superdesign links. The 64 screens linked from the 20 tickets are rendered at
1440 px wide in `~/.claude/reference/chief-of-staff/runs/phase-2-3-batch/screens/` (outside the
repository; `index.json` maps each draft to its file). Each brief names the files to read.

## What the lead does after the merge

- Add the new WebKit checks to `scripts/webkit/run-all.mjs` (CI runs that list): `composer-menus`,
  `mcp-servers`, `new-session-completion`, `chat-actions`, `tab-fork`, `diff-keys-review`, `open-in`.
- `CHANGELOG.md`.
- Any edit a piece names in `notDone` because it fell in another piece's file (most likely a prop
  from `TabView.tsx` to the composer for the placeholder states).
- Compare each built screen with its PNG before opening pull requests.

## Before starting: three things to settle

1. **Budget.** The estimate is $48–85 in API-equivalent dollars; the run's limit is $15 or 25 points
   (Settings → Orchestrator). At those limits the run pauses during `backend`.
2. **Disk.** 11 GiB were free when this was written. Earlier runs used about 5 GB per worker that
   builds Rust. `backend` builds Rust alone; the three UI pieces build only the front end.
3. **Checks on the base.** The done-checks were not run on main first. The root vitest run has had
   load-only timing failures on this Mac; "accept base failures" is on, which covers a failure that
   also fails on the starting commit.

## Left out

Not ready:

| Ticket | Reason |
| -- | -- |
| PRO-253 | Main went another way since the ticket was written: Create PR and Commit and push are done natively by the header button (`branch_step.rs`), while the ticket asks for agent prompts. Needs a decision on which path stays. |
| PRO-255 | Open product decision in the ticket: whether branch rename is on by default. |
| PRO-289 | Open product decision in the ticket: whether the "Rename tab" dialog stays. Narrow; one answer frees it. |
| PRO-301 | Two open decisions in the ticket: the keys for the light/dark shortcut and the list of accent colours. |
| PRO-302 | Open decision in the ticket: shortcuts only, or every setting. Narrow; one answer frees it. |
| PRO-305 | Dependency not built: the desktop cannot reach the server's name change (`PUT /users/me` takes web sign-in only). Needs a desktop route in terminalx-server first, which a piece of this run cannot own. Its other dependency, the GitHub identity on Account, is not on main either. |
| PRO-312 | Two open product decisions in the ticket: whether the price confirmation step stays, and whether Local VM is a place a session runs. |
| PRO-313 | Dependencies not built: workspace numbers, a setup script for cloud workspaces, and a start log a plain member may read (the server gives the log to managers only). |
| PRO-321 | Claimed on the Mac mini (comment of 2026-11-15) and its code is in terminalx-server, not this repository. |

Ready, held for the next run:

| Ticket | Reason |
| -- | -- |
| PRO-213, PRO-219, PRO-238 | Low priority, and all three edit `Composer.tsx` and the files `backend` owns. Adding them would make `composer` six tickets and `backend` seven. |
| PRO-257 | Low priority, large, low confidence in its own estimate, and its Rust would also go through `backend`. Only PRO-253 shares its panel files, so it can run alone later. |
