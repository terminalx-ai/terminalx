# TerminalX changelog

## 0.2.1

Agents can now browse the web and operate desktop apps, conversations can
continue with a fresh Claude Code or Codex tab, and the file pane previews
images, audio and video. This release also improves usage reporting, editing
and everyday session controls.

### Browser and computer use

- A built-in browser with persistent profiles and an in-app browser pane.
  Agents can open and navigate tabs, inspect pages, click, fill forms, capture
  screenshots, read console and network activity, and evaluate JavaScript
  through the `terminalx` CLI. Browser runtime setup is in Settings. (#101)
- Desktop computer use through `terminalx computer`: discover apps and
  windows, read accessibility trees, capture screenshots, click, type, scroll,
  drag and set values. The bundled macOS helper owns the Accessibility and
  Screen Recording permissions, with grant and reset controls in Settings →
  General. The embedded computer-use guide teaches agents the commands. (#100)
- Linux AT-SPI and Windows UI Automation providers, platform prerequisite
  reporting, and Windows CLI launchers and control transport are included in
  the source. The downloadable installer for this release remains macOS on
  Apple Silicon; macOS computer use requires macOS 14 or later. (#117)

### Conversation continuation and attachments

- **Continue in New Session** opens a fresh Claude Code or Codex tab in the
  same workspace. Choose focused context or the full saved transcript while
  keeping the original conversation, branch and uncommitted files. Delivery
  feedback distinguishes launch failures from uncertain prompt delivery. (#109)
- Attach images to the first prompt of a new session using the same picker,
  paste and drag-and-drop controls as an existing conversation. (#95)
- Claude Code image prompts no longer appear twice in chat. (#91)
- The composer keeps a usable height after being hidden, switching views or
  waiting for fonts to load. (#90)
- Dictation preserves words spoken before a pause and appends the next
  utterance instead of replacing earlier text. (#72)

### Files and editing

- Open local images, audio and video from Files or Quick Open. Images support
  fit, actual size, zoom, dimensions and a transparency checkerboard; audio and
  video have native playback controls. Viewers are read-only, pause hidden
  playback and offer Reload when a file changes. Codec support depends on the
  system WebView. SVG and other text files remain editable. (#118)
- A styled editor Find/Replace bar, plus project-wide replace with previews,
  per-file and per-match exclusions, and support for open unsaved buffers.
  Use ⌘⇧F to search or ⌘⇧H to replace across the project. (#98)

### Usage and activity

- Stats & Usage shows its saved results immediately and refreshes in the
  background. Existing metrics remain visible and interactive during refresh;
  a failed refresh keeps the last successful snapshot and offers Retry. (#113)
- Lifetime agent activity is recorded independently of usage scans, survives
  workspace cleanup, and counts live work starts correctly. Pull request
  totals include discovered PRs.
- Claude's five-hour usage refreshes across reset boundaries, accepts changed
  live samples promptly, and interprets OAuth percentages correctly. Expired
  windows are marked stale while awaiting confirmation; manual refresh and
  retry feedback are available in usage details. (#119)
- The status bar shows account-level limits without Codex's per-model
  sub-limits or plan label. The Compact toggle now changes the presentation,
  and usage details show one row per agent. (#104, #105)
- The dashboard sidebar shows waiting, working and done totals. Claude Code
  uses the Anthropic starburst consistently across agent controls. (#114, #103)

### Workspace and interface fixes

- Deleting a workspace stops its agents and terminals and removes its sessions,
  transcripts and attachments. The confirmation shows the affected session
  count. Settling one session's worktree still preserves that session. (#89)
- Create shell terminals from the tab strip's **+** picker. (#88)
- New automations default to bypass permissions and retain the chosen mode
  when switching triggers, editing, pausing or running them. (#70)
- Sidebar hover actions no longer overlap project or workspace labels. (#94)
- Settings opens as a full page and returns to the previous view when closed.
  Its distinct Close button stays visible above scrolling content, including
  with transparent appearance enabled. (#86, #112)
- An optional **Enjoying TerminalX?** GitHub star reminder returns, with
  dismissal cooldowns and permanent suppression after a confirmed star. (#110)

### Distribution

- The macOS app, computer-use helper and DMG are signed with a Developer ID
  certificate. This release is not notarized. The signed updater archive is
  available through Settings → About → Check for updates.

## 0.2.0

TerminalX gets a phone, a command palette, automations, and an honest view
of what the agents are costing you.

### Companion app and accounts

- Optional TerminalX account sign-in from the sidebar or Settings → Account.
  Sign-in goes through the deployed console with PKCE and returns on
  `terminalx://auth/callback`; credentials live in the Keychain and every
  local workflow keeps working without an account.
- Pair a phone in Settings → Devices, over the relay or entirely on the LAN.
  Pairing is end-to-end encrypted and bound to this Mac's identity; unclaimed
  invites expire and superseded credentials are discarded.
- The companion sees this Mac's sessions and tabs, follows the transcript and
  terminal live, posts notes, promotes a note into a prompt, answers
  permission requests, and sends write-gated terminal input. The Mac stays the
  only copy of the session; the phone keeps a bounded cache and nothing is
  stored in the cloud. ([docs/MOBILE.md](docs/MOBILE.md),
  [docs/ACCOUNTS.md](docs/ACCOUNTS.md))
- Attachments travel with the message on both desktop and phone, and survive
  a failed send.

### Automations

- An Automations workspace: define an automation, run it from a GitHub
  issue, and watch each run land in its own worktree and session. Runs are
  persisted and listed in a full-screen table — trigger, status, timing,
  worktree, result or pull request.

### Navigation

- A global command palette (⌘K) for jumping to a session, opening a file,
  running an app command, or typing a task or workspace name straight in;
  it hands focus back to wherever you were.
- One sidebar for getting around: projects, workspaces, sessions, agent
  tabs and shell tabs sit in a single expandable tree, and Files is the one
  file browser. The separate workspace column and the ⌘⇧E explorer pane are
  gone; keyboard navigation, workspace provenance and terminal lifetimes are
  unchanged.
- Shell terminals are now tabs inside the session, alongside agent tabs,
  instead of a dock at the bottom. Terminal scrollback is retained within a
  bound so a freshly attached companion can replay recent output.
- Stats and Usage (⌘⇧U): a full-area view of local analytics — which
  agents ran, for how long, and what they used — plus Codex credit
  balances and reset times. Everything is computed on this Mac from its own
  transcripts.
- Agent icons are recognizable and accessible in every picker and tab.

### Workspaces and sessions

- Workspaces can be renamed.
- Delete is offered for clean, merged workspaces; sessions refresh after a
  worktree is removed and a deleted workspace's session provenance is kept.
- Projects stay focused when clicked, and the file tree no longer shows the
  previous project's files after a switch.
- New sessions default to the bypass permission mode.
- Codex tabs replay a fresh rollout after the session starts and no longer
  echo image prompts twice.

### Dictation

- The microphone and speech permission prompts are deferred until the first
  time dictation actually starts; opening the composer or Settings no longer
  touches either.

### Identity

- Settings is now a full page instead of a dialog. It replaces the workspace
  while open, and the back button returns to exactly the view that opened it.
- The app now ships as TerminalX while retaining the `com.terminalx.next`
  bundle identifier. It registers `terminalx://` and still recognizes
  `terminalx-next://` links in code for compatibility. Development builds use
  the separate TerminalX Dev identity and the existing "D" badge; the release
  keeps its badged icon too. The command-line tool and first-party skill now
  install as `terminalx` and `terminalx-cli`; `tnx` remains an alias.
- Claude tabs now run the real interactive CLI in a terminal, and the chat is a
  view of that one process: the transcript is read from the CLI's own session
  file, status and permission cards come from its hooks, and ⌘⇧T flips between
  chat and terminal without stopping anything or waiting for a turn to end.
  ([docs/PTY-FIRST.md](docs/PTY-FIRST.md))
- Codex tabs work the same way: the real `codex` TUI in the tab, its rollout
  read into the chat, and its hooks — installed in a Codex home TerminalX
  manages so your own `~/.codex` is never edited — carrying status and approvals, with
  "Ask every time" now asking about every tool rather than only the ones Codex
  would have stopped for.
- Claude Code and Codex are the agents TerminalX offers; Cursor and
  OpenCode are no longer listed in the pickers or in Settings → Agents.
  Sessions and tabs already running on them open and work exactly as before.
- New automations start in "Bypass permissions" whether they are created from
  Automations or from an issue label, and no longer inherit the mode last used
  for an interactive session. Switching the trigger between Schedule and
  GitHub issues keeps whatever mode is selected, and editing, pausing,
  re-enabling or running an automation never rewrites its saved mode. The
  editor shows what bypassing means for the chosen agent whenever that mode
  is selected; issue descriptions are still quoted as untrusted context.

## 0.1.0

First runnable build, assembled checkpoint by checkpoint.

- Sessions are git worktrees; each session holds tabs, and each tab is an agent conversation.
- Claude Code over stream-json, Codex over its app-server, Cursor over ACP, OpenCode over its local server.
- Streaming transcript with tool calls, diffs, permission cards and question cards; follow pin that never hides the composer.
- Composer with `@` file mentions, `/` slash commands, image drop and paste, queued follow-ups while a turn runs.
- Right panel: changes for the last turn or the whole session, repository status and history, pull requests through the GitHub CLI, and a file tree.
- Terminal dock (⌘J) with shells in the session's checkout that survive switching sessions.
- Editor tabs with a gutter against HEAD, save, and a banner when the file changes on disk; ⌘P quick open and ⌘⇧F project search.
- Notifications graded by attention: desktop banner, in-app notice, or just the tone; dock badge.
- A pixel raccoon that potters about an empty session and runs along the composer while an agent works.
- Worktree lifecycle: settle after a merge, fork a session, guarded delete.
- Themes (den, slate, moss, ember) with light and dark modes and window vibrancy.
- Terminal view for any agent tab (⌘⇧T): the same conversation in the agent's own CLI, and back again with the transcript caught up.
- Dictation from either composer — the new-session box and the one inside a session (⌘⇧D) — using the Mac's own on-device speech recognition; nothing is downloaded and audio never leaves the machine.
- Optional local transcription models (Parakeet, Nemotron, Canary, Whisper) downloaded on demand in Settings → Transcription, plus a microphone picker and mute-while-recording.
- File explorer beside the transcript (⌘⇧E) with Material file icons, git status badges, keyboard navigation and a right-click menu.
- Issues from GitHub and Linear (⌘I): browse, read, and start a session on one; the worktree is named after the issue and the header links back to it.
- Files open in an editor pane beside the chat with their own tabs; markdown renders as a preview with a Source toggle.
- Projects rail with mascots, colours and logos; workspaces (every checkout, including worktrees made outside the app) listed with their sessions; workspace delete guarded by pushed state and pull-request status.
- Agent dashboard (⌘⇧A): every session across every project in three columns — needs you, working, done — with the last thing said on each card, search, filters and keyboard navigation.
- Codex offers the models your account can actually run, read from the CLI itself rather than hard-coded; a session still on a retired model is moved to the current one and told so.
