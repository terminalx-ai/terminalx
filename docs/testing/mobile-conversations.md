# Mobile conversation selection — issue #132

## Native verification (2026-09-15)

Built and ran the standalone Release app on **iPhone 17 Pro Max, iOS 26.5**.
The build succeeded and the simulator Keychain entitlement check passed.
Paired to the running Mac with a one-time LAN code; Sessions reported a live,
end-to-end encrypted connection.

The Mac had Codex installed and Claude Code unavailable. The native fixture was
one running Codex conversation and a second idle Codex tab in the same worktree.
The second tab had no transcript, making accidental reuse of the first tab's
transcript visible. No test prompts or terminal commands were submitted.

| Check | Result |
| --- | --- |
| Separate list rows and per-tab statuses | Passed: Working and Idle rows for the same worktree |
| Agent-name search | Passed: `codex 132` returned both conversations |
| Open each conversation from its list row | Passed: correct selected tab and distinct transcript contents |
| Switch conversations inside the screen | Passed: correct selected tab and transcript |
| Separate chat drafts | Passed: draft A and draft B restored independently |
| Readable conversation names | Passed: Codex 1 and Codex 2 in both list and selector; no IDs displayed |
| Terminal access hidden | Passed: no Terminal view or Chat/Terminal switcher after selecting either agent |
| Relaunch and reconnect | Passed: reused saved pairing without a new code; both rows accessible and chat drafts restored |

Conversation labels use the tab's name when supplied by the Mac. Unnamed tabs
use the provider name; multiple unnamed tabs use readable numbering such as
Codex 1 and Codex 2. Duplicate custom names also get a number. The selector
scrolls the selected tab into view. Rebuilt and visually verified the final
naming and hidden Terminal controls on the simulator.

Terminal access is disabled pending fixes to its rendering and input. The
conversation screen mounts only Chat; permission guidance refers to the Mac.

Mixed Claude/Codex routing, permission responses, message action targets,
late transcript responses, removed tabs, host isolation, in-flight sends, and absence of terminal subscriptions are
covered by automated tests. Claude/Codex switching and actual action submissions
were not exercised against live providers in the simulator. Temporary test drafts
and the extra idle Codex tab were removed after verification; the simulator
remains paired.

## Checks

The shared Mac backend now derives a short title from each tab's first saved
user request (up to eight words / 48 characters), removing common request and
issue boilerplate. Titles persist in tab metadata for both desktop and mobile.
Existing unnamed tabs are backfilled; custom titles remain unchanged. Empty
conversations retain the provider fallback. This uses a local excerpt, with no
additional model request.

Title generation was verified through five Rust tests, including distinct tabs,
refreshes, custom names, attribution, and bounded log reads. The desktop sidebar
test verifies a generated title replaces the provider fallback without changing
selection. These backend changes were not installed over the running Mac app;
the simulator verification above used its existing backend and numbered fallbacks.

- `pnpm --dir mobile typecheck` — passed
- `pnpm --dir mobile test` — 37 tests passed
- `pnpm --dir mobile lint` — passed
- `cargo test --manifest-path src-tauri/Cargo.toml conversation_titles --lib` — 5 tests passed
- `pnpm exec vitest run src/components/layout/SidebarTree.test.tsx` — 3 tests passed
- `git diff --check` — passed

The default Xcode 26.6 installation could not resolve an iOS build destination.
The installed Xcode 27 beta recognized the iOS 26.5 simulator; the successful
build used that installation through a command-scoped `DEVELOPER_DIR`, followed by:

```sh
pnpm --dir mobile ios:simulator --device <iPhone-17-Pro-Max-iOS-26.5-UDID>
```
