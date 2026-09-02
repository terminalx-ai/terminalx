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
5. **Everything visual is verified with screenshots**, read back at
   1360×860 and 1000×700 and checked against native macOS conventions —
   window chrome, traffic-light inset, sidebar and panel proportions, focus
   rings — and fixed before the checkpoint is committed.
6. **Nothing is borrowed.** Every line of code, every asset and every name in
   this repository is written for it.

## Architecture

```
src-tauri/src
  main.rs            binary entry point; `raccoon hook <Event>` before Tauri starts
  lib.rs             Tauri builder, command registry, module list
  commands.rs        every #[tauri::command]: validate, call a module, stringify the error
  events.rs          normalized AgentEvent (+ TS twin in src/types/events.ts)
  session.rs         SessionManager: one runtime per tab, numbering and persisting events
  store/
    mod.rs           the $RACCOON_HOME layout
    index.rs         sessions/index.json — one entry per session, holding its tabs
    projects.rs      projects.json — repo roots the reader has attached
    settings.rs      settings.json — what Rust needs before the webview exists
  harness/
    mod.rs           the harness list, availability, HIDDEN_HARNESSES
    host.rs          child spawn/write/kill with epoch + kill-gen guards
    tui.rs           what the two PTY-first harnesses share (paste, readiness, tails)
    claude/          pty.rs, transcript.rs, mapper.rs, trust.rs, commands.rs
                     + fixtures/interactive_session.jsonl
    codex/           pty.rs, rollout.rs, home.rs (managed CODEX_HOME), appserver.rs,
                     models.rs + fixtures/rollout.jsonl, fixtures/model_list.json
    acp/             generic Agent Client Protocol adapter — hidden
    opencode/        local HTTP+SSE adapter — hidden
  hooks.rs           the hook bridge: unix socket, parked permission requests
  pty.rs             terminal PTYs with 8ms/32KB output coalescing
  git.rs             worktrees, snapshots (temp-index write-tree), diffs, commit, push
  workspaces.rs      every checkout a project has, whoever made it
  github.rs          gh-backed PR status/create
  issues.rs          GitHub (gh) and Linear (GraphQL) issues in one shape
  files.rs           in-memory file index + fuzzy search + watcher
  summaries.rs       last prompt and reply per session, read backwards, for the dashboard
  models.rs          the model list per harness: ids, labels, efforts, defaults
  names.rs           worktree names: adjective-color-animal
  binpath.rs         CLI resolution incl. login-shell PATH
  dictation.rs       microphone to text, out as events
  transcription/     catalog.rs (models on offer), download.rs, engine.rs, audio.rs
src
  App.tsx            routes the whole app off the session store
  components/layout    AppShell, TitleBar, Sidebar, ProjectRail, WorkspaceColumn, RightPanel
  components/session   SessionView, NewSessionView, TabStrip, TabView, settle/delete dialogs
  components/chat      Chat, TurnBlock, ToolCallRow, Markdown, DiffBlock, Composer,
                       PickerMenu, AskCards, Dictation
  components/changes   ChangesPanel, DiffPane, FileList, RepoPanel, PrPanel
  components/files     ExplorerPane, FileTree, FileTreeView, FileTypeIcon
  components/editor    EditorPane, EditorSplit, QuickOpen, ProjectSearch
  components/dashboard AgentDashboard, AgentCard
  components/issues    IssuesView
  components/terminal  TerminalView, TerminalDock
  components/settings  SettingsDialog, TranscriptionTab
  components/raccoon   pixel sprite + idle/busy scenes
  components/ui        button, dialog, menu, controls, tooltip, Toasts
  lib/               api (every invoke), transcript builder, sessions store, theme,
                     hotkeys, prefs, diff, dashboard, summaries, dictation, repo
  types/             events.ts, session.ts — the TS twins of the Rust shapes
  styles/            tokens.css (three-layer token system), app.css
  demo/              the synthetic-transcript page the scroll tests drive
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
- [x] The model list comes from the CLI's own `model/list`, not from us: which models a ChatGPT account may run is the account's to say. Cached per process, refreshed when the picker opens, with a built-in list if the CLI cannot be asked.

### C7 — Composer extras ✅
- [x] Slash-command picker (from harness), `@file` mentions from the file index, `#issue` later.
- [x] Attachments: images (base64 block), files (mention), drag-drop, paste.
- [x] Queue while busy, send-as-steer where supported, Stop.
- [x] Context ring.

### C8 — Changes panel and git actions ✅
- [x] Per-turn tree snapshots; changes list with +/-; diff viewer (unified/split).
- [x] Repository view: uncommitted changes, history, commit + push.
- [x] Handoff row (Commit / Create PR / Run it) as one-click prompts after a turn that touched files.
- [x] PR panel via `gh` (status, checks, merge, create, mark ready).

### C9 — Terminal ✅
- [x] PTY with coalesced output, xterm with fit + webgl, theme sync, OSC colour queries.
- [x] Terminal tabs inside a session; session terminal dock (⌘J), panes survive session switches.

### C10 — Files and editor ✅
- [x] File tree in the right panel (Files, ⌘⌥4), fuzzy file search (⌘P), project text search (⌘⇧F).
- [x] CodeMirror editor tab with git gutter, save, external-change detection, unsaved-close guard.

### C11 — Notifications and attention ✅
- [x] Desktop banner when unfocused, in-app notice when focused elsewhere, nothing when on screen.
- [x] Rail marks: green unread, amber waiting; dock badge; sounds (toggle).

### C12 — Raccoon animation ✅
- [x] Pixel raccoon sprite; idle scene in an empty session (walks, sits, washes paws, glances, peeks).
- [x] Busy runner along the composer while a turn is in flight; stunned on the jump chevron.
- [x] Toggle in settings; respects reduced motion.

### C13 — Worktree lifecycle ✅
- [x] Settle dialog after a session's PR merges or on request: delete worktree (with unpushed warning), keep, relocate session to project root.
- [x] Archive / delete session (confirm names what is lost; removes log, attachments, tree best effort).
- [x] Fork session (new worktree at the branch tip, copied log, Claude conversation forked on first send).

### C14 — More harnesses ✅
> **Both of these are hidden and neither has ever been exercised live.**
> Since phase 3 of the PTY-first work the UI offers Claude Code and Codex
> only, so no tab made from here on can reach either adapter. Both were built
> against a published protocol and are covered by unit tests on fixtures; no
> end-to-end conversation has ever run through either one. Treat them as
> unproven code that is still compiled in, not as working features.

- [x] Generic ACP adapter (cursor-agent, and any `acp` speaker): handshake, authenticate, new/load session, prompt, updates, permission and fs requests. Hidden, and never exercised live: the one live attempt reached the sign-in step and stopped there (machine not logged in to Cursor).
- [x] OpenCode over local HTTP+SSE: server as the tab's child, event pump, HTTP actions. Hidden, and never exercised live: built against the documented API and unit-tested on fixtures, but the installed 0.1.150 server never finished starting here, so no conversation has ever gone through it.
- [x] Availability probe; disabled rows with install hints.
- [x] **Cursor and OpenCode are hidden, headless, not offered.** Since phase 3
      of the PTY-first work the UI lists Claude Code and Codex only: neither
      appears in the new-session picker, the new-tab menu, Settings → Agents
      or the model picker. Their adapters, their model entries and every tab
      already on one are untouched and still run, hand-off and all. One list,
      `HIDDEN_HARNESSES` in `src-tauri/src/harness/mod.rs`, is the switch.

### C15 — Settings, updater, usage ✅
- [x] Settings tabs: General, Appearance, Agents (installed CLIs, paths, capabilities, re-check), Shortcuts, About.
- [x] Updater plugin with channel; changelog surface (CHANGELOG.md rendered in About). Signing key at `~/.tauri/raccoon.key`; the endpoint in tauri.conf.json is a placeholder until a release feed exists.
- [x] Claude/Codex usage windows in footer.

### C16 — Audit and hardening ✅
- [x] Screenshots read back against native macOS conventions at 1360×860 and 1000×700 (sidebar, transcript, composer and panel all hold their layout at both sizes; traffic lights, drag region and focus rings behave as a native window's).
- [x] Long-session stress: demo page `?turns=200&live=1&stream=1000` sustains ~830 deltas/s with ~1 long task/s (max 72 ms) after chunking the streaming preview; composer stays visible and typed text arrives intact.
- [x] Light mode pass (session, editor, terminal), keyboard pass (focus rings on tabs, rows, composer); reduced motion honoured through `prefers-reduced-motion` in the raccoon scene and runner (code path, not toggled system-wide).

### Explorer ✅
- [x] Explorer column beside the transcript (⌘⇧E, header button, resizable, persisted), the checkout as a lazy tree with Material file and folder icons loaded after first paint.
- [x] Git status in the tree: tinted names with A/M/D/R badges, a dot on folders holding changes, refreshed on agent status changes and a gentle poll.
- [x] Keyboard walk (arrows, Home/End, Enter), right-click menu: Open, Reveal in Finder, Copy path, Copy relative path, Mention in composer.
- [x] The right panel's Files tab uses the same tree.
### Editor pane ✅
- [x] Files open in a pane beside the transcript (tab bar, resizable from its left edge, collapsible to a strip) instead of replacing the chat; the composer stays put.
- [x] Markdown opens as a rendered preview with a Preview | Source toggle (⌘⇧P); jumps from search open source at the line. ⌘⌥W closes every file; ⌘W closes the file or the agent tab depending on which was last focused.

### C17 — Issues as tasks ✅
- [x] GitHub issues through `gh` (repo from origin; open, assigned-to-me, search) and Linear through its GraphQL API with a stored key (teams, assigned-to-me, search).
- [x] Issues view (⌘I) with detail column; Start session creates a worktree named after the issue (`raccoon/eng-42-fix-login`) and sends the issue as the first prompt; the session header links back.
- [x] Settings → Integrations: Linear key (validated, stored owner-only), GitHub CLI status.

### PTY-first tabs (Claude) ✅
- [x] A Claude tab is one process: the interactive CLI in a PTY. The chat is a
      projection of it — the CLI's own transcript file, tailed and decoded into
      the existing payloads — and the composer writes keystrokes into the same
      PTY (bracketed paste, then the Enter a beat later).
- [x] Status and permissions come from the CLI's hooks: `--settings` points every
      hook at the Raccoon binary as `raccoon hook <Event>`, which forwards the
      payload over a unix socket under the Raccoon home. `PermissionRequest`
      parks there until the chat's card is answered and replies with the
      decision the CLI expects.
- [x] Chat ↔ terminal is a view flag with the pane still mounted underneath;
      nothing is stopped, resumed or reconciled, and the button is never refused.
- [x] The headless Claude engine, its wire parser and `tab_reconcile` are gone.
      Codex, ACP and OpenCode are unchanged; phase 2 is Codex, phase 3 the
      cleanup. Written up in [PTY-FIRST.md](PTY-FIRST.md).
- [x] Phase 2: a Codex tab is the interactive `codex` TUI in the same PTY-first
      shape — its rollout tailed, its hooks (in a `CODEX_HOME` Raccoon owns and
      trusts) carrying status and approvals, `PreToolUse` gating every tool in
      "Ask every time" — and the headless Codex engine and its hand-off are
      gone. ACP and OpenCode stay headless; see the phases in
      [PTY-FIRST.md](PTY-FIRST.md).
- [x] Phase 3: Claude Code and Codex are the only agents offered. Cursor (ACP)
      and OpenCode keep their engines, their models and their existing tabs,
      but are hidden from every list, so the hand-off is a path no tab made
      from here on can take and ⌘⇧T is a view flag for every new tab.

## Verification protocol

- Four checks, all of which must pass before a checkpoint is committed:
  `pnpm exec tsc --noEmit`, `pnpm vitest run`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test`.
  `pnpm check` runs the first two together; `pnpm test` runs vitest alone.
- Native screenshots: `screencapture -x` of the running dev app, read back at
  1360×860 and 1000×700 and checked against native macOS conventions.
- Interaction: `cliclick` for clicks/typing where a real webview is needed;
  Playwright against the Vite dev server for DOM-level assertions.

### Dictation ✅
- [x] Mic button in both composers — the new-session box and the one inside a session (⌘⇧D): microphone → Apple's speech recogniser, on-device when supported, partial text live in the draft, each finished phrase appended. Info.plist carries the microphone and speech usage strings.

### Terminal view ✅
- [x] ⌘⇧T flips an agent tab between the transcript and the agent's own CLI in a
      terminal. For Claude that is now a view flag over one process, not a
      hand-off: see **PTY-first tabs** below. Codex is the same since phase 2,
      and since phase 3 they are the only agents offered, so the toggle is a
      view flag for every tab that can still be made. A tab left on ACP or
      OpenCode still hands off — the headless child is stopped and the CLI
      resumes the conversation in the terminal — and that switch is still
      refused mid-turn.
- [x] Local models: a compiled-in catalog (Parakeet, Nemotron, Canary, Whisper Small, Whisper Large v3 Turbo) downloaded from Hugging Face with checksum verification into `~/.raccoon/models`, run through transcribe-cpp with Metal; the loaded model stays warm between dictations.
- [x] Settings → Transcription: model cards with speed/accuracy, download progress, delete; microphone device picker; mute while recording.
### Workspaces and projects ✅
- [x] Sidebar is a project rail plus a workspace column: every checkout of a project (root, Raccoon worktrees, worktrees made elsewhere) with +/− and unpushed counts, sessions grouped under their workspace, Sessions | Explorer tabs.
- [x] Sessions can start inside an existing workspace; the new-session form sits at the bottom with project, agent, model, effort and permission pills.
- [x] Project menu: rename, logo, colour, pixel mascot, pin, reveal, refresh, archive, remove. Global and per-project refresh.
- [x] Deleting a workspace checks uncommitted files, unpushed commits and the branch's pull request; merged and clean is called out as safe.

### Agent dashboard ✅
- [x] Full-area Agents view (⌘⇧A, or the rail entry under Issues, which carries
      an amber count of sessions waiting on you and a green count of ones that
      finished unread) with three columns — Needs you, Working, Done — each
      scrolling on its own, stacking under 760px of room.
- [x] Cards carry the session, its checkout and issue, the last prompt and the
      last reply — or, for a waiting session, what it is waiting on — with a
      card menu for Open, Stop and Archive, and ↑/↓, ←/→ and Enter to walk them.
- [x] `session_summaries` reads each session's log **backwards** in 64 KB blocks
      for those snippets, so opening the dashboard costs a block per session
      rather than a transcript; the frontend caches by session and status and
      re-reads on any status change and every 30 s.
