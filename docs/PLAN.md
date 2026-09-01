# Raccoon — build plan

Raccoon is a desktop workbench for coding agents. It wraps the agent CLIs you
already have installed (Claude Code, Codex, and others over time) in a native
chat UI, gives every session its own git worktree, and lets one session hold
several tabs, each running a different agent against the same tree.

This file is the working plan. Each checkpoint ends in a runnable, committed
state. Tick boxes as they land; keep the "Verification" notes honest.

## Principles

1. **One event vocabulary.** Every harness maps its wire format onto the same
   normalized `AgentEvent` stream. The UI and the on-disk log never see raw
   protocol. Adding a harness = one parser + one mapper.
2. **The composer is never hidden.** The transcript is the only thing that
   scrolls; the composer is a `shrink-0` sibling below it. A test drives 300
   turns through the transcript and asserts the composer is still on screen.
3. **Sessions are worktrees.** Creating a session creates
   `<repo>/.raccoon/worktrees/<name>` on branch `raccoon/<name>`. Tabs inside a
   session share that tree. Settling a session offers to remove the tree.
4. **Processes are guarded.** Child spawns are stamped with an epoch and a
   kill generation; exits are matched by pid; PTY output is coalesced.
5. **Everything visual is verified with screenshots**, compared against the
   two reference apps at the same window size, and fixed before the checkpoint
   is committed.
6. **Clean room.** No code, asset, or name is taken from the reference apps.

## Architecture

```
src-tauri/src
  lib.rs             Tauri builder, command registry
  store/             ~/.raccoon: projects.json, sessions/index.json, sessions/<id>.jsonl
  events.rs          normalized AgentEvent (+ TS twin in src/types/events.ts)
  harness/
    host.rs          child spawn/write/kill with epoch + kill-gen guards
    claude/          parser.rs (wire→typed), mapper.rs (typed→AgentEvent), control.rs
    codex/           rpc.rs, parser.rs, mapper.rs
    acp/             generic Agent Client Protocol adapter (cursor-agent, others)
  session.rs         SessionManager: spawn/resume/queue/interrupt/status
  git.rs             worktrees, snapshots (temp-index write-tree), diffs, commit, push
  github.rs          gh-backed PR status/create
  pty.rs             PTY spawn with 8ms/32KB coalescing
  files.rs           in-memory file index + fuzzy search + watcher
  binpath.rs         CLI resolution incl. login-shell PATH
  notifications.rs  desktop banners, badge
src
  components/layout  AppShell, TitleBar, Sidebar, RightPanel
  components/chat    Transcript, TurnGroup, ToolCall, Markdown, Composer, pickers
  components/changes ChangesPanel, DiffView
  components/terminal, editor, settings, ui (primitives)
  lib/               transcript builder, streaming previews, theme, hotkeys
  hooks/             useSessions, useAgentEvents, useChanges, useHotkey
  animation/         raccoon sprite + idle/busy scenes
```

## Checkpoints

### C0 — Scaffold ✅
Tauri 2 + React 19 + Vite + Tailwind 4, overlay title bar, vibrancy, icon set.

### C1 — App shell and theme system ✅
- [x] Three-layer token system (`:root` aliases, `[data-mode]` ramp, `[data-theme][data-mode]` palette), four palettes, glass on macOS.
- [x] Title bar strip in every column with deep drag region; traffic-light inset.
- [x] Sidebar (collapsible, ⌘B), main column, right panel frame (⌘E).
- [x] Settings dialog (⌘,) with theme swatches and System/Light/Dark segmented control.
- [x] Hotkey registry with tooltips carrying keycaps.
- Verification: screenshot in dark + light; window drag works; no flash on launch.

### C2 — Rust core: store, projects, worktrees, event model ✅
- [x] `~/.raccoon` layout, atomic index writes, append-only JSONL logs.
- [x] Projects: add (folder picker), list, remove; canonicalized paths.
- [x] Worktree create/list/remove with lock handling and unpushed-commit check.
- [x] `AgentEvent` enum + TS types; `seq` ordering.
- [x] Child host with epoch/kill-gen guards, process-group kill escalation.
- Verification: `cargo test` covers store round-trips, worktree naming, event serde.

### C3 — Claude Code harness, end to end ✅
- [x] Spawn with stream-json in/out, `--permission-prompt-tool stdio`, session id minted by app, resume, worktree via app-created tree.
- [x] Parser + mapper with fixtures; deltas as previews, committed events win.
- [x] Permission requests → card → control_response; AskUserQuestion form.
- [x] Interrupt; model/permission switch in place; effort by respawn.
- [x] Sidebar session rows with status rail; new-session composer (project, agent, model, effort, mode).
- [x] Transcript v1: markdown, tool rows, thinking, working indicator.
- Verification: real session round-trip in the app; screenshots.

### C4 — Transcript polish and scroll guarantees ✅
- [x] Turn grouping, "Worked for Ns", collapsed tool groups, streaming tool preview.
- [x] Diff rendering for Edit/Write, code view for ranged Read, shell output.
- [x] Scroll pinning: wheel-up unpins, jump-to-bottom, ResizeObserver re-pin, `overflow-anchor: none`.
- [x] Windowed mount for long logs (newest N turns first, backfill above with anchored scrollTop).
- [x] Test: 300-turn transcript keeps composer visible and input focused (demo page, measured in Chromium).

### C5 — Tabs inside a session ✅
- [x] Session = worktree + tab list; tab = conversation bound to one harness.
- [x] Tab strip in main header, ⌘T new tab (agent picker), ⌘W close, ⌘⇧[ ] step, drag reorder.
- [x] Per-tab drafts and attachments; per-tab status; session status = fold of tabs.

### C6 — Codex harness ✅
- [x] `codex app-server` JSON-RPC client, handshake, thread/turn lifecycle, steering, interrupt with turn id.
- [x] Approval card from server-provided decisions; sandbox/approval mode pairs.
- [x] Subagent thread filtering; token usage ring from `last`.

### C7 — Composer extras ✅
- [x] Slash-command picker (from harness), `@file` mentions from the file index, `#issue` later.
- [x] Attachments: images (base64 block), files (mention), drag-drop, paste.
- [x] Queue while busy, send-as-steer where supported, Stop.
- [x] Context ring.

### C8 — Changes panel and git actions ✅
- [x] Per-turn tree snapshots; changes list with +/-; diff viewer (unified/split).
- [x] Repository view: uncommitted changes, history, commit + push.
- [ ] Handoff row (Commit / Create PR / Run server) as prompts (later, with the terminal).
- [x] PR panel via `gh` (status, checks, merge, create, mark ready).

### C9 — Terminal
- [x] PTY with coalesced output, xterm with fit + webgl, theme sync, OSC colour queries.
- [x] Terminal tabs inside a session; session terminal dock (⌘J), panes survive session switches.

### C10 — Files and editor
- [x] File tree in the right panel (Files, ⌘⌥4), fuzzy file search (⌘P), project text search (⌘⇧F).
- [x] CodeMirror editor tab with git gutter, save, external-change detection, unsaved-close guard.

### C11 — Notifications and attention
- [ ] Desktop banner when unfocused, in-app notice when focused elsewhere, nothing when on screen.
- [ ] Rail marks: green unread, amber waiting; dock badge; sounds (toggle).

### C12 — Raccoon animation
- [ ] Pixel raccoon sprite; idle scene in an empty session (forages, peeks, washes paws).
- [ ] Busy runner along the composer while a turn is in flight; stunned on the jump chevron.
- [ ] Toggle in settings; respects reduced motion.

### C13 — Worktree lifecycle
- [ ] Settle dialog after a session's PR merges or on request: delete worktree (with unpushed warning), keep, relocate session to project root.
- [ ] Archive / delete session (removes log, attachments, tree best effort).
- [ ] Fork session (copy log, lazy fork on first send).

### C14 — More harnesses
- [ ] Generic ACP adapter (cursor-agent, and any `acp` speaker).
- [ ] OpenCode over local HTTP+SSE.
- [ ] Availability probe; disabled rows with install hints.

### C15 — Settings, updater, usage
- [ ] Settings tabs: General, Appearance, Agents, Shortcuts, About.
- [ ] Updater plugin with channel; changelog surface.
- [ ] Claude/Codex usage windows in footer.

### C16 — Audit and hardening
- [ ] Side-by-side screenshots vs reference apps at 1360×860 and 1000×700.
- [ ] Long-session stress (1000 events/s), memory check, no dropped keystrokes.
- [ ] Light mode pass, keyboard-only pass, reduced-motion pass.

## Verification protocol

- `pnpm check` = vitest + tsc; `cargo test` + `cargo clippy -D warnings`.
- Native screenshots: `screencapture -x` of the running dev app, read back and
  compared against the reference apps launched at the same size.
- Interaction: `cliclick` for clicks/typing where a real webview is needed;
  Playwright against the Vite dev server for DOM-level assertions.
