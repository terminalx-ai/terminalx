# TerminalX changelog

## 0.2.7

Terminals are released when their tabs and sessions go away, a slow Keychain
call can no longer freeze the app, and small cloud UI findings are fixed.

### Terminals

- Closing an agent tab drops its terminal pane and scrollback instead of
  holding them until the session is deleted. A tab removed from the CLI or
  another client is released the same way. (#247)
- Deleting a session or workspace closes its shells in the window and the
  backend, and output that arrives after a pane is closed is dropped instead
  of starting a buffer nothing reads. Removing a session's worktree closes
  its shells. (#245)
- `terminalx status --json` reports terminal counters for the backend and the
  window, and a benchmark that runs in the real window measures throughput,
  typing echo and memory; see docs/TERMINAL-PERFORMANCE.md. No behaviour
  change for users. (#243)

### Accounts

- A slow or deadlocked Keychain call can no longer freeze the window. Every
  Keychain call goes through one gate, the account lock is never held across
  a Keychain or network call, workspace keys are read once per run and
  written only when they change, and cloud frames are queued off the main
  thread. (#246)

### Cloud UI

- Settings opens on General from the sidebar button instead of a blank page.
  Pending header chips such as "Resuming…" and "Starting…" carry an ellipsis.
  The mode picker hides its label rather than truncating it to a letter, the
  "Local" heading appears only over local projects, and a cloud session view
  stays on its tab when someone else adds a new one. (#251)

## 0.2.6

Cloud sessions stay connected after a workspace stops and restarts, and
organization role changes reach the app without a restart.

### Cloud sessions

- An open cloud session attaches to the workspace again after someone else
  stops and wakes it: the view reconnects, subscribes to sessions, tabs,
  terminals and the transcript again, and driver controls work on the new
  runtime. Looking at a workspace never wakes it. (#238)
- The session chip reads "Live" only while the transport is connected, shows
  "Stopping…" while a stop runs, then "Stopped", and "Reconnecting…" while a
  new attach is in progress. A turn that finished while the desktop was away
  no longer stays "Working". (#238)
- Stopping or archiving a workspace from the sidebar no longer closes a
  connection a session view still holds; the row reads Stopping at once. (#238)

### Organizations and sharing

- A demoted admin's role updates in the app: roles are re-read on launch, on
  focus, on refresh and whenever a cloud request is refused for lack of role.
  Menus, the "+" button and new-session actions follow the current role, and
  refusals explain that the role changed. (#239)
- The Members role select shows the saved role after a refused change, and
  the roster read is retried once after a transient failure. (#239)
- A member's empty organization explains that no cloud projects are shared
  yet. Workspaces that leave the list keep their last known names, new tabs
  are named by their agent until the first message, and narrow cloud session
  headers give way in a predictable order. (#239)

## 0.2.5

Cloud projects and agent sessions now live alongside local work in the desktop,
with workspace sharing, organization controls and runtime diagnostics.

### Cloud workspaces

- Create cloud workspaces from GitHub repositories and a first prompt, then
  browse projects, workspaces and agent sessions in the sidebar. Cloud sessions
  use the same conversation view, dashboard, notifications and keyboard
  navigation as local sessions. (#184, #191, #214, #215, #221, #224)
- Run agent tabs and interactive shell terminals in cloud workspaces. Browse,
  edit and search remote files, review Git changes, commit and create pull
  requests from the desktop. (#181, #185, #188, #190, #207, #211, #235)
- Share workspaces with organization members, see presence, exchange notes
  and hand over driver control. Sharing controls are available from the
  sidebar, with role and revocation states shown clearly. Revoked workspaces
  drop cached session rows, and member actions reflect current access. (#194, #234, #236)
- Manage organization members, invitations, GitHub repositories, compute
  limits, provider usage, workspace configuration, prompts, MCP and secrets
  in Account settings. (#179, #183, #184, #186)
- Archive and delete cloud workspaces with final checkpoints. Opening the app
  or dismissing a menu no longer wakes a stopped workspace, and running-limit
  errors explain what to change. (#193, #222, #229)
- Add administrator cloud diagnostics and redacted exports; improve runtime
  bootstrap, connection recovery, environment templates and agent first-run
  setup. (#177, #178, #192, #198, #201)

### Everyday fixes

- Recall earlier and later messages with Up/Down in the chat composer. (#231)
- Keep chat scrolling stable and prevent cloud content from pushing the app
  outside its window. Cloud terminals appear in the sidebar. (#174, #235)
- Avoid false stalled-session reports and keep a second TerminalX instance
  from disconnecting tabs in the first instance. (#226, #227)
- Clarify the Changes sidebar's scope and link to uncommitted files. (#175)
- Improve pairing QR readability and relay recovery. Companion source changes
  add guided scanning and agent conversation navigation; they require a
  separately updated mobile app. (#165, #171, #172, #173)

## 0.2.4

- Add recovery actions for stalled agent sessions. (#161)
- Name agent tabs from their first saved request, preserving custom names
  and giving existing unnamed conversations readable titles. (#159)
- Improve mobile conversation selection and access, with separate transcripts
  and drafts for each agent tab. These companion changes require an updated
  mobile app. (#159)
- Improve mobile reconnection across LAN and VPN changes by sharing multiple
  direct endpoints and the Mac's Bonjour address. Both desktop and companion
  need updating to use the new pairing offers. (#160)
- Restore the TerminalX Legacy icon across desktop and mobile, with a distinct
  orange D badge for development builds. (#157)
- Explain Claude Code's terminal diff sidebar and its `/diff` toggle in the
  Terminal view, including narrow panes. (#158)

## 0.2.3

- Choose whether website links open in the TerminalX browser or the system
  browser. Context-menu actions and ⇧⌘-click offer the alternate browser.
- Select the transcription microphone beside the composer mic, with the
  same saved preference available in Settings. Unavailable devices show the
  system-default fallback; selection is disabled during recording. (#137)
- Account settings support organization creation and selection, plus
  administrator provider onboarding with a native secure key dialog and
  explicit billing and organization-use consent. (#145)
- Clarify relay offline status and how relay pairing differs from local
  network pairing. (#146)
- Use `TERMINALX_HOME` as the canonical state-directory override, retaining
  `RACCOON_HOME` as a fallback for existing setups. (#150)
- Redact and aggregate workspace pull-request recovery errors.

## 0.2.2

Open ordinary folders as projects and follow chat links directly into the
workspace browser, editor or media viewer.

### Folder projects

- Open a folder without initializing Git. Agent sessions and terminals run
  in the selected directory, with files and editing available. Folder
  projects and their sessions survive restarts. (#136)
- Git-only actions are hidden for folder projects across workspace controls,
  issues, automations and the command palette. Existing Git projects retain
  their branch and worktree behavior. (#138)

### Chat links

- Web links open in the originating workspace browser. Text and Markdown
  files open in the editor, images in the media viewer, and other files and
  folders through native handlers. Relative paths, encoded filenames and
  line/column references keep their intended destination. (#139)
- Link context menus offer open, reveal and copy actions. Missing files,
  unsupported schemes and media failures display useful errors. (#140)

### Foundation and development

- Add the native Cloud Workspace provider client for authenticated provider
  discovery, setup, quotes, creation and lifecycle operations. Cloud
  Workspace setup and creation UI are still under development. (#141)
- Add an iOS Simulator helper and pairing/keychain troubleshooting notes.
  (#133)

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
