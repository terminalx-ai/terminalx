# TerminalX changelog

## Unreleased

### Chat messages that reached the terminal but were not sent

- A message sent from chat is submitted only after the agent CLI has read it.
  The Enter used to follow the pasted text after a fixed pause; a CLI too busy
  to look at its input for that long could take both at once and leave the
  message sitting in its input. (macOS and Linux; Windows keeps the pause.)
  (#403)
- A message the agent has not acknowledged within 20 seconds is flagged as
  "delivery could not be confirmed" instead of showing as working for five
  minutes, and a follow-up queued behind a turn is flagged if the agent never
  takes it once that turn ends. The terminal redrawing is no longer taken as
  proof the message was accepted. Nothing is typed or submitted again on its
  own: the notice says to press Enter in the terminal if the message is still
  there. (#403)
- Each stage of a message's delivery (ready, text written, Enter written,
  accepted or unconfirmed) is recorded with its timing in the tab's
  diagnostics file. No message text, paths or commands are recorded. (#403)

### Delete workspace from the chat

- Once a worktree's pull request has merged, the chat offers **Delete
  workspace** next to Commit, Create PR and Run it. It appears when the merge
  is noticed, with no new turn, and opens the same removal dialog as every
  other way of removing a workspace; nothing is removed from the chat. It is
  not offered in a project's main directory, for a pull request that is open,
  closed or could not be checked, with uncommitted or unpushed work, or while
  an agent turn runs in the workspace. Cloud sessions have it too, for a
  manager of the workspace: the worktree is read and removed by its own
  runtime (`workspace/1`), so a stopped or older workspace does not offer it
  until it is restarted. (#411)

### Floating chat window and quick chats

- A floating chat window: a small TerminalX window for asking an agent
  something, or opening a terminal, without attaching or choosing a project.
  It opens from any app with a system-wide shortcut (⌥⇧Space by default,
  changeable or off in Settings → Shortcuts), from the tray icon, from the
  main window and with `terminalx floating show`. It stays on top when
  pinned, remembers its size and position, and hides on Escape. Hiding it
  stops nothing. (#395)
- Quick chats: sessions with no project. Each runs in a scratch folder of its
  own, with no worktree or branch, and has everything a project session has:
  chat and terminal view, new terminals and agent tabs, attachments,
  dictation, permissions, and Continue in New Session. They are listed under
  Quick chats in the sidebar, in the Agent Dashboard and in the command
  palette. (#395)
- Point a quick chat at any folder without making it a project, or move it
  into a project with its history. Idle quick chats are deleted after 30 days
  by default (Settings → General). (#395)
- `terminalx sessions create --quick` starts a quick chat, and
  `sessions list --quick` lists them. (#395)
- A session open in both windows stays the same in both: rename, pin, archive
  and tab changes, terminals and their names, permission and question cards.
  Only one window sends a desktop notification. (#395)
- Sessions can be renamed from their menu in the sidebar. (#395)

## 0.2.8

Cloud workspaces gain a full composer, port previews, a local file mirror and
a CLI. Terminals are faster and recover after sleep, workspace removal is
safer, and the mobile companion can open cloud workspaces.

### Cloud workspaces

- Switch a cloud agent tab between chat and terminal view. The composer in a
  cloud tab supports slash commands, @-mentions and images, and Send again
  keeps a message's images. (#255, #304, #308, #309, #321, #332)
- Preview a workspace's ports privately: a Ports panel in the workspace view
  and a local port forwarder on the desktop. (#330, #338, #340)
- Keep an opt-in local mirror of a workspace's files. Files are staged,
  verified and published, never over a local change, and the copy is removed
  with access. (#334, #335, #336, #360)
- Members can create cloud workspaces and manage the ones they created. A
  plain driver cannot exceed their role through slash commands or shells.
  (#273, #297, #342)
- Manage cloud workspaces from the `terminalx` CLI with the app's own role
  checks. (#284)
- The full-window cloud page is gone; its features live in the sidebar, with
  repository and running-slot chips. Every organization's workspaces load in
  one request. (#268, #271, #272, #277, #283)
- After a stop and wake, a person's own terminal comes back to them, the
  agent terminal can be typed into again, and the key that wakes a workspace
  is never typed into the agent. A stopped workspace says when it was last
  saved, and the Stop dialog names what resume brings back. (#299, #301,
  #320, #344, #362, #377)
- Notices for a full workspace disk and low memory name the real cause and
  fit the reader's role. (#305, #306, #319)
- Repositories are cloned at launch when a workspace has no Environment
  image, also without a first prompt. A canceled create stops Git, a failed
  clone says what failed, and a failed checkout is retried. (#300, #323,
  #331, #339)
- Connect, replace and disconnect agent logins from the desktop. The first
  prompt's agent is checked on create and reads "needs sign-in" instead of
  Working. Pause or allow new machines and re-check a provider key; Hetzner
  is named as a supported provider. (#279, #281, #292, #293, #303)
- Tear down an organization's cloud, choose how long an archive is kept and
  export from the dialog. Setup keeps one record per organization across
  profile switches and retries. (#282, #314, #315, #328)
- Cloud model pickers use the workspace runtime's models, and the cloud
  editor picks up a file changed before it began watching. (#357, #365)

### Sessions and agents

- Claude models come from the CLI, with pinned versions, and issue sessions
  allow choosing the model and reasoning effort. (#261, #263, #368)
- Filter the sidebar by Unread and Needs you, for local and cloud sessions.
  (#285)
- Customize keyboard shortcuts in Settings. (#253)
- Website links in chat open in the system browser by default, with a
  browser choice. (#351, #355)
- The CLI can name and rename sessions and worktrees, and a new session
  worktree starts from the freshly fetched default branch. (#356, #359)
- Chat no longer shows false slow-start and timeout warnings, continuation
  delivery is confirmed, turns closed by the watcher complete, and a message
  sent from the terminal view shows in the chat view. (#274, #348, #350,
  #361)
- Dashboard cards stay readable in crowded columns, and Stats & Usage
  recovers when activity ownership changes. (#349, #376)

### Terminals

- Terminal output travels over a raw channel per pane with flow control,
  memory is bounded, input stays responsive, and terminal and chat views
  recover after the app is suspended. (#248, #352, #370, #371)
- Dropping a file on a terminal types its path. (#259)

### Workspaces and worktrees

- Workspaces have one removal path, and deleting a session deletes only that
  session along with the agent's own data for it. The clean-and-merged check
  recognises squash and rebase merges, and every workspace row shows its
  state and size on disk. (#264, #307, #312, #316)
- A worktree removal that fails is shown, keeps the session and can be
  retried. (#260)

### Settings

- Settings is a gear at the end of the sidebar's account row and opens on
  Account; asking for it again goes to the section asked for. A canceled
  GitHub connect stays canceled. (#269, #270, #280, #286)
- TerminalX Dev has its own sign-in scheme, separate from the release app.
  (#298)

### Mobile companion

These source changes require a separately updated mobile app.

- Open cloud workspaces, reconnect to cloud agent sessions and share them
  with presence, notes and the driver lease. (#294, #295)
- A paired computer shows its real name, with rename, reconnect and remove
  in its menu. (#310, #318)
- Conversations open at the latest content, sync incrementally and page by
  size; a session looks continuous across a trip to the home screen, and a
  backgrounded phone neither connects nor posts. (#327, #329, #366, #367,
  #369)

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
