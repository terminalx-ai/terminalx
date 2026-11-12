# TerminalX changelog

## Unreleased

- Experimental: a session can lead an orchestration run. The lead writes a plan
  of pieces (`terminalx runs create --from plan.json`), each with a brief, the
  files it owns, what it depends on and the check that proves it done, and
  `terminalx runs start` starts a worker session for every piece whose
  dependencies are done: its own worktree and branch cut from the lead's, the
  piece's model and effort, and a brief built from the piece. A plan is refused,
  naming the piece, when two pieces own the same file, a dependency loops, a piece
  has no done-check or there are more pieces than the limit (8 by default). A
  done-check is a command run in the worker's worktree or a point for a reviewer
  to confirm; a piece needs a command unless it says why review alone can check it. By
  default a run waits until you approve its plan in the session's new Run view,
  where you can also edit or discard it; no command approves one. Workers start
  in bypass unless the repository or the plan says otherwise, and never push,
  merge or deploy: deny rules are handed to the agent at launch, TerminalX checks
  every tool call, and the worker's git sends a push nowhere. Turn it on under
  Settings → Experimental → Orchestration runs; the limits are in Settings →
  Orchestrator and per repository. (PRO-274)

- Experimental: an orchestration run picks each piece's model and effort from
  the piece's kind. Every piece of a plan names a kind (`search`, `logs`,
  `scoped-code`, `code`, `refactor`, `research`, `review`, `verify`), and a
  routing table gives each kind a model tier and an effort, with one column for
  Claude Code workers and one for Codex workers: small (Haiku, Luna) for
  searching and reading logs, mid (Sonnet, Terra) for bounded changes and
  checks, large (Opus, Sol) for everyday engineering, top (Fable, Astra) for
  refactors and research. The table names tiers, not versions, so a new release
  takes its place; a tier with no installed model falls back to the lead's
  model, and the piece says so. A plan may still name a model or an effort for
  a piece. Edit the table under Settings → Orchestrator, and per repository in
  its own settings.

  A piece that reports `failed` or `partial`, or whose done-check fails
  (`terminalx runs check-failed`), is tried again without being asked: first
  with the failure text and one more level of effort (never past high), then one
  model tier up at one effort level lower. Each try is a fresh worker that is
  told what the one before fell short on, and after three tries the piece is
  blocked and goes back to the lead with what was tried. The Run view shows
  every try with its model, effort, cost and outcome. (PRO-275)

- Experimental: with Orchestration runs on, a lead's workers sit under it in the
  sidebar, whatever worktree they run in, each named by its piece with its
  model's tier and its piece's state mark. Fold a lead and its row keeps what
  matters: pieces done out of total, how many workers are running, a Needs
  approval or Needs you mark with how many wait on you, and a worker's unread
  mark. Hover it for the pieces that are not done. Clicking a lead opens its
  run. The Run view's costs follow each worker's usage as it changes, still
  counting every try a piece took, and set the run's spend against its dollar
  budget; a Needs you list there names a blocked piece, a worker waiting
  on an answer or spend past the budget, each opening the worker it is about.
  Sessions that no other session started look as before. (PRO-281)

- Each release also uploads its notarized DMG as `TerminalX-latest-aarch64.dmg`
  and lists it in `SHA256SUMS`, so
  [one link](https://github.com/terminalx-ai/terminalx/releases/latest/download/TerminalX-latest-aarch64.dmg)
  always downloads the newest build.
  The release pipeline (`scripts/release/`, described in docs/RELEASING.md) is
  now in the repository. It publishes nothing unless notarization, stapling and
  the secret scan pass. (PRO-148)

- Branch prefixes and local launch environment can now inherit shared repository
  configuration, local overrides and managed locks. Settings → General → Layered
  configuration shows sources and offers explicit repository saves. Shared values
  require native consent tied to the repository and file contents; changed files
  need approval again. CLI and paired phones can inspect redacted sources. Setup
  and archive scripts and files to copy are not read from the shared file yet.

- Sidebar rows show change counts, command/server activity and the current
  window's unsent prompt previews. Mark rows read or unread from their menu
  (R), archive on hover, and cycle waiting sessions with ⌘⌥L. Unread reminders
  persist per tab and clear when opened on desktop or phone. Renaming a
  conversation also pins its active tab's title, including a previously
  untitled tab, so automatic branch/title changes keep the explicit name.
  (PRO-179, #851)

## 0.2.30

- Open local diffs and pull requests in full-width centre tabs, alongside
  files and terminals. (#826)
- Show Codex goals and token budgets in the chat while keeping chat search
  available. (#856)
- Configure repository startup behavior and files to copy into new
  workspaces from Settings. (#804)
- Wait on several agent sessions at once and read structured worker reports
  with the TerminalX CLI. (#878, #879)
- Preserve each tab's activity state across background runtime handovers.
  (#873)
- Keep private paths and configured model filenames out of recovery
  diagnostics, summaries, and exports. (#875, #884)

- Connect GitHub from the PR tab or Settings → Integrations in an embedded
  sign-in terminal. Pushing a repository without a remote now offers a URL
  field, or creation of a GitHub repository when signed in. Git failures show
  a readable explanation with command output behind **Show details**. Connection
  checks and login target the repository's host after resolving SSH aliases and
  excluding unrelated remotes. Connection failures offer retry,
  failed login output stays available, and repository creation works from linked
  worktrees. PR conversations, check logs, reruns and Fix errors remain available after
  connecting; failed reruns keep their output behind **Show details**. Remote setup
  preserves file filters and folder view in the updated Changes panel. (PRO-166)

- Keep native resend regression fixtures within their existing deadlines by
  removing shell helper launches from the simulated protocol. (PRO-166 validation)

- Keep sidebar New chat conversations in Chats with ordinary retention and
  project linking, while using the shared composer and saved agent settings.
  Branch drafts retain their requested project and advertised source branch.
  Chat Git panels follow the working folder's actual repository status;
  linked chats keep their repository account indicator and refresh control.
  (PRO-173 follow-up)
- A session started with `terminalx sessions create` from inside another
  session records it as its `parent` (`--parent`, `--no-parent`).
  `sessions list --children-of` lists the sessions a session started, and
  `sessions stop --children-of` stops their running agents. (PRO-270)
- `terminalx wait --children-of <session>` waits on every session that session
  started, with `--any` or `--all`, and returns at once when it started none.
  (PRO-328)

## 0.2.29

- Review changes from a turn checkpoint or a single commit, browse files in a
  folder tree, mark files as viewed, and choose a comparison branch. (#854)
- Read pull request conversations, manage reviewers, inspect check logs,
  rerun failed checks, and send check failures to an agent for help. (#829, #831)
- Set a manual session status and use status groups to organize local and
  cloud chats. (#811)
- Improve Native Codex follow-up delivery and recovery after a background
  runtime update. (#865, #867)
- Diagnose stalled macOS child-process startup from Settings, with recorded
  startup evidence and guided validation. (#830)
- Create GitHub and Linear issues with pipeline policy options. (#864)
- Refine chat overlays, image viewing, dialogs, sidebar styling, and the
  post-merge workspace flow. (#868, #876)
- Let explicitly authorized agents inspect and operate TerminalX's own UI
  through a session-scoped grant. Human-only confirmations remain protected.
  (#872)

## 0.2.28

- User settings reload when `settings.json` changes. General shows its location
  and offers to create it. Existing webview preferences migrate into that file;
  downgrading to a build without this support uses its preference defaults,
  because the localStorage copies are removed. The migrated choices remain in
  `settings.json`. Unknown keys and `$schema` survive saves, and an invalid
  field no longer resets valid credentials, permission choices, or other
  settings when the app starts. (Part of PRO-140)

- Keep a checkpoint for each chat turn and reset a conversation to an earlier
  turn, with an Undo option. Reset changes the conversation only; files stay
  as they are. (#843, #858)
- Find text across the chat with Command-F, including messages outside the
  visible portion of long conversations. (#857)
- Manage repository scripts from Settings, including setup and archive scripts
  and their run history. (#808)
- Native Codex can move from chat to its terminal interface while preserving
  the conversation. The transition handles process startup and readiness, and
  reports interrupted transitions without silently replaying prompts. (#819)
- Attention notices wait while the foreground conversation has an approval
  needing a response, keeping approval controls and live terminals usable.
  (#862)
- Settings and sharing get a design update, with settings search, a simpler
  account menu and a pasted sign-in-link fallback. Sharing explains permission
  choices before a link is created. (#852)

## 0.2.27

### Sessions and sidebar

- Group local sessions into your own sidebar sections, across projects, in
  both Group by project and One list of chats. A section has a name, an
  optional emoji and its place in the list. Rename it, change its emoji or
  delete it, move a chat in with the chat's menu (**Move to section**) or ⌘K,
  start a session from its header, and move sections up or down. Deleting a
  section returns its chats to the main list without deleting or archiving
  them. Sections are kept with the sessions on this Mac, and older session
  lists carry over unchanged. Dragging chats between sections comes later.
  (PRO-174, #824)
- The sidebar no longer has a standing **New section…** row above the
  projects. Make a section from a chat's menu (**Move to section → New
  section…**, which also moves that chat in) or with **New local section…** in
  ⌘K. (#840)
- The session dashboard has a **Table** view beside **Board**, remembered
  between visits. All ten columns sort either way, and the sort and the shown
  columns are remembered; both views share search, filters and keyboard
  selection. Status sorts in board order: Needs you, Working, Done, Not
  started, Archived. New filters show archived sessions, sessions started by
  an automation, and sessions by owner ("This Mac" for local ones, the creator
  for cloud ones). Archived sessions stay out of badges and notifications, and
  browsing never wakes a cloud workspace. Large tables draw only the rows in
  view. (PRO-194, #823)

### Environment variables

- Set environment variables for local agents and shells in Settings →
  Environment: your own, plus overrides for a repository that its worktrees
  share. Values are kept in the macOS Keychain and shown masked, with reveal,
  copy (the clipboard item is marked concealed and cleared again) and delete.
  Paste a block to import it, with errors by line number, or import a
  repository's `.env` file after reviewing it. Names like `HOME`, `DYLD_*`
  and `LD_PRELOAD` are refused. A running tab keeps the values it started
  with and offers **Restart to apply** after a change. When the values cannot
  be read, a new tab starts without any of them and says so, and an
  automation or issue pipeline stops with an error before sending its prompt.
  (PRO-144, #807)

### Branch, changes and pull requests

- A design pass on the side panel, sidebar, session header, composer and
  share dialog. The Branch tab now holds Changes: the panel's tabs are Branch,
  Files, Browser and Computer, and Branch has Overview and Changes, reopening
  on the one last shown; every link to Changes still lands there. Autopilot
  moves from the header into the Branch tab, under the next step. Changed
  files show their file-type icon. The sidebar has more room between rows,
  shows a row's age only for its first six days and has a redrawn branch icon.
  The header's New, Terminal, Panel and Share icons are redrawn as one family
  and fill its height; in a header narrower than 360 px they are 32 px wide,
  so the session title keeps its first characters. The line count and the
  Automation label are gone from the header. The composer
  drops the model chip's "latest" tag and offers Commit, Create PR and Run it
  only after the fifth prompt, and the mode moves from a dot on its options
  button to its tooltip and a red or blue shield on the Permissions row.
  Signed out, Share shows what sharing allows and one **Sign in to share**
  button. (#838)
- The PR panel explains a blocked or behind-base branch, failed optional
  checks and merge-queue progress; it and the Branch tab show the queue
  position, checks running in the queue and blocked or locked entries. A
  repository with a merge queue offers **Add to merge queue**. Checks share
  one summary with Required and Optional labels, and deployment statuses link
  to their pages. (PRO-207, #828)
- Read and answer GitHub review threads in the PR panel. The patch view puts
  each current thread at its line, base-side ones in the left column of a
  split view, and lists outdated threads under the diff with their original
  place. Resolve, unresolve, reply, copy a suggestion, or quote the reviewer's
  text into the chat's draft. Thread text loads no remote images and links to
  web pages only. Closed and merged pull requests are read-only. (PRO-234,
  #832)
- Diffs remember split or unified, and wrap, across the workspace, turn,
  uncommitted and history views, with a per-file wrap setting. **Hide
  whitespace changes** compares without whitespace and keeps the text shown
  and copied as it is. Images, SVGs (rendered or as text) and PDFs compare
  side by side with their own zoom and PDF pages; PDFs are drawn without
  running anything in them. Files up to 16 MiB compare locally, and up to
  512 KiB in a cloud workspace. (PRO-226, #833)

### Motion

- The sidebar and the right panel slide in and out instead of appearing at
  once, and the chat beside them follows frame by frame. Opening takes 380 ms
  and closing 320 ms; data-drawn views (Branch, Changes, the file tree) fade
  in as they arrive. A panel already open at launch does not animate, and
  Reduce motion makes it instant. Dialogs ease in and out the same way. (#847,
  #838)

### Native Codex

- Native Codex no longer asks for attention while it is working. A turn
  that ran longer than five minutes was called stalled at every look of the
  watcher, because Codex's own progress did not count as activity, and a
  message sent while Codex was still on its turn (or right after
  interrupting it) was raised as an agent error with Needs attention. That
  message is now kept in the composer with a note to send it when the turn
  ends, and the turn goes on; real silence and real failures still warn.
  Settings → Storage → **Record recovery incidents** (on by default, on this
  Mac only) notes when a warning was raised and cleared, how long it was on
  screen, what was pressed and what became of the turn, as labels, counts and
  times only; it can be exported with sessions named by codes, or cleared.
  (#815, #820)
- A Native Codex turn that keeps producing tool output is no longer called
  timed out after five minutes: the reader now counts that output as
  activity, and a stall the watcher raised is withdrawn when output arrives.
  Real silence and an explicit sign-in failure still warn. (#859)

### Development

- An app whose bundled background runtime is no newer than the older runtime
  it replaces (a development build left running while the version moved) no
  longer hands the runtime over in a loop, dropping the chat's connection
  each time. It logs one warning and keeps the runtime it has. (#841)
- The Linux CI jobs run on the `instabox-medium` runner. (#814)

## 0.2.25

### Getting started

- Install Claude Code or Codex and sign in to it without opening Terminal.
  **Install and sign in**, on the welcome screen, in Settings → Agents and in
  the new-session view, runs the provider's official native installer in an
  embedded terminal (fetched over HTTPS only; no Node or npm needed), then the
  agent's own sign-in in the same terminal, which opens the browser. One setup
  runs per agent at a time, and another window shows it. Installation and login are
  checked again after each step, so every view turns Ready by itself. A folder
  that is not writable, no connection to the provider, a failed download or a
  failed installer each get their own explanation and **Try again**; Cancel
  stops a step without leaving an error. The welcome screen also offers this
  when every installed agent is signed out. The commands to run by hand are
  still shown, now the native installers instead of `npm install`.
  (PRO-152, #799)
- Keep local agent installation and login status current when returning to the
  app, after an embedded sign-in command exits, and every two minutes while
  Settings → Agents is open. Each card's badge and setup instructions now use
  the same readiness check, so they cannot disagree about installation or
  login. The new-chat composer also picks up installation and login changes
  on return, even when its cached agent list still says not installed. (PRO-170,
  #778, #787, #802)
- Return to the welcome screen with **Home** in either sidebar layout or ⌘K,
  even after opening projects or sessions. Open local project, Open GitHub
  project and Quick start remain available there. (PRO-183, #777,
  #788)
- New chat opens the same composer from the sidebar and project menus, and
  creates nothing until the first prompt is sent. Both use the same saved
  agent, model, effort and permission mode, preferring an agent with a local
  login. When neither agent is signed in, setup keeps the draft ready.
  (PRO-173, #780)
- Show the "Enjoying TerminalX?" GitHub-star prompt only after three full
  days and finished work in three different sessions, both counted across
  restarts and updates. It used to appear after the first finished turn of a
  new install. Installs that update to this version wait the same three days.
  The prompt now sits in the sidebar's footer, so it never covers the composer
  or an approval card, and it stays out of the way while the sidebar is
  hidden. (PRO-190, #798)

### Permissions and approvals

- Start new chats in **Ask every time** until you pick another permission
  mode; after that, new chats start in the mode you last picked, as before. A
  mode you already use, Bypass included, is kept. The phone's New Session also
  opens in Ask every time. The New Session and issue start button now shows the
  mode for every mode, not only Bypass. New share links, from Share or
  `terminalx share create`, default to **Read only** with **Approve each
  person** on, so a forwarded link neither drives the session nor joins without
  you admitting them; `--can-drive` and `--no-approve` turn either back on for
  a link. Someone waiting to be admitted shows on the session's Share button
  and raises a notice that opens Share. Automations keep Bypass, as does
  `terminalx sessions create` without `--mode` in a project on this Mac; in a
  cloud project it takes your saved mode, as New Session does. (PRO-162, #791)
- Run read-only discovery commands without an approval card in **Ask every
  time**: `ls`, `cat`, `rg`, `grep`, `pwd`, and `git status`, `diff` and
  `log`, for Claude Code and Codex. Every command in a chain or pipe has to
  qualify; redirects, shell expansions, unknown options and commands that can
  run helpers still ask, and so does a Codex command that leaves its sandbox.
  **Allow read-only commands in Ask mode** in Settings → Agents turns this
  off. A command's card can also allow that exact command for the session, in
  its directory, until TerminalX restarts. (PRO-198, #796)
- Show the diff inside file-edit approvals. A Codex `apply_patch` request, and
  Claude Code's Edit, MultiEdit and Write, now list each file with its lines
  added and removed and the changed lines, marking new, deleted and renamed
  files. Long files fold behind **Show all N lines**, and the diff scrolls on
  its own so Allow and Deny stay in view. A patch that cannot be read exactly
  is quoted whole instead of by its first line. (PRO-156, #784)
- Show each permission request once, and retire it as soon as Allow or Deny
  is confirmed, including answers from the terminal or another card. Late
  duplicate requests stay retired; clicking a stale card explains that the
  request was already answered without submitting another decision.
  (PRO-160, #779)
- Stop a Codex command from showing two identical approval cards when the
  model runs it again while its first card is still waiting. Codex hands the
  turn back to the model once a script has waited for its yield time (30
  seconds by default). The repeat now files no card, whichever approval it
  or the waiting command has reached and however the model words its reason.
  Codex is told the command is already waiting, and the command runs once.
  (PRO-160, #797)
- Ask separately before a Codex command leaves its sandbox. In Ask every
  time, allowing a command no longer also allows Codex to run it outside the
  sandbox. That request gets its own card, which says so and shows Codex's
  reason. Each run of a command is asked about, instead of a repeat in the
  same turn reusing the first answer. (PRO-160, #797)
- Say when a card in Bypass comes from Claude Code's own safety check. Claude
  Code still asks about some calls in Bypass, which looked as if TerminalX
  ignored the mode. The card, the call's tool row and folded summary, the
  phone's card and the background notification now say that Claude Code's
  safety check asked, and mark the description as the agent's. Nothing is
  approved automatically. (#775, #783)

### Chat

- A design pass on the chat. The prompt map scrolls instead of squeezing its
  marks, fades at an edge with more beyond it, follows the prompt being read
  and shows each prompt's send time. The transcript scrolls behind the
  see-through composer. Each turn has one header for its work ("Worked for
  14s · 2 tool calls") and one footer row with its time, and Copy on hover;
  a time line opens a new sitting ("Yesterday, 5:21 PM"). The model chip sets
  the alias tag and the effort apart from the model name. (#790)
- Show the pictures an agent makes. A Codex image generation is a tool call
  with its saved picture, a picture a tool made is drawn in its turn even
  while tool calls are folded, and a picture, video or sound file on this Mac
  that a message names is shown under the message. The phone names these
  files instead, since they are on the computer. (#800)
- Codex file citations (`:codex-file-citation{…}`) are links to their files
  on the desktop and the phone instead of raw text: a file chip for a file
  Codex made, an inline link for a source. A citation in code, or one that
  cannot be read, is left as written. The session header's Automation button
  no longer runs under Share in narrow windows. (#776, #782)
- "Edited" rows for a Codex patch count the lines it adds and removes instead
  of showing +0 −0, so they match the file chips and the turn's totals.
  (PRO-180, #789)

### Browser

- A browser inside the app. Chromium runs headless, and its pages show in the
  app: a **Browser** tab in the side panel shows the workspace's pages beside
  the chat. It is the same browser the agent drives, scoped to the same
  worktree, and picking a page makes it the agent's current page. Clicks,
  drags, double clicks, scrolling, keys and paste reach the page, laid out at
  the panel's size. **Open in browser** hands the address to the default
  browser, and `TERMINALX_BROWSER_HEADED=1` shows the Chromium window again
  for debugging. Not yet: a page's `alert` or `confirm` stalls input until it
  times out, ⌘C and ⌘X copy inside the page only (paste works), and Tab and
  Escape go to the page while it has focus. (#790)

### Branch and changes

- The Branch tab is built around the next step. It reads top down: the
  branch, the one thing to do next in plain words (resolve, pull, commit,
  push, then open, ready or merge the pull request), its pull request, and its
  commits against the branch it came from, each with its author's picture.
  The Repo and PR tabs fold into Branch, and their shortcuts now name it.
  What others pushed is fetched when the tab opens and every five minutes, and
  a project with no remote can merge its branch locally. Uncommitted changes
  and history move to the Changes tab with the commit box; during a merge it
  leads to the merge view (Commit merge, Abort). A worktree records the ref it
  was made from, and its branch is compared with that. (#800)

### Issues

- Starting a session from the Issues page, for a GitHub or a Linear issue,
  stays on Issues instead of opening the session, so several issues can be
  started in a row. A **Session started** notice names the issue and opens
  the session when clicked, one notice per start; the issue's panel shows the
  new session with **Open session**, and the row stays in a filtered list
  until it is refreshed. Cloud projects work the same way. A failed start
  shows its error on the panel, as before. (#785, #801)

### Dashboard

- A chat that was never started is under **Not started** instead of Done.
  (PRO-180, #789)

### Settings

- Settings groups its pages under Personal, Agents & environment,
  Repositories, Admin and More. Repositories lists the open projects: a Git
  project shows its workspace-cleanup override, and a folder project says why
  Git cleanup does not apply. A link to a setting selects and reveals its row,
  organization pages and per-project settings included. (PRO-123, #805)
- Search Settings by section, in Settings (⌘F) and in ⌘K, where **Search
  settings…** narrows the palette to settings and Backspace or **Search
  everything** widens it again. Arrows and Enter open a section; Escape clears
  the search before it closes Settings. (PRO-127, #806)
- Account starts with the essentials; what this Mac shares (its host ID,
  public key and capabilities) is under **Advanced**. The Organizations page
  offers **Create organization** when there is none, with the same setup as
  Account. (PRO-193, #793)

### Menus

- The menu bar has the app's commands. The app menu: About TerminalX,
  Settings… and Check for Updates…. File: New Chat, New Window, Add Project…,
  Open Recent, Close Tab and Close Window. View: the sidebar, right panel and
  terminal, Switch Chat / Terminal, zoom and full screen. Go: Dashboard,
  Issues, Automations and the next and previous session. Help: Documentation,
  Keyboard Shortcuts and Report an Issue…. Each item runs the same action as
  its shortcut and shows your binding, and follows it when you change it.
  (PRO-177, #794)
- Right-click a project, session, tab or file-tree row for the same menu as
  its ⋯ button; Shift+F10 or the context-menu key opens it from the keyboard.
  Elsewhere in the app, right-click no longer shows the web view's Reload
  menu, and text fields keep their editing menu. (PRO-187, #792)

### Relay and terminal

- The relay status in the sidebar explains itself: clicking it says what
  Relay is for and why it is unavailable, reconnecting or not configured,
  with **Retry**. Local terminals and LAN pairing keep working without it.
  Resizing a terminal no longer repeats its prompt line. (PRO-196, #795)

### Command line

- `terminalx sessions create --issue` works with the background runtime.
  It was refused ("Sessions are started from an issue in the desktop
  app"), so sessions an agent started for an issue had no pipeline: no
  review, merge when green or conflict resolution. `--resolve-conflicts` and
  `--no-resolve-conflicts` set automatic conflict resolution apart from Merge
  when green, and `terminalx pipelines resolve-conflicts <pipeline> on|off`
  changes it later; both switches record who changed them in the pipeline's
  history. (#786, #803)

### Development

- Editors for a repository's actions and preview URLs, with a searchable icon
  picker. They are not in Settings yet: they wait for per-repository settings
  (PRO-131) and the action runner. (PRO-155, #809)

## 0.2.24

### Background sessions

- Update without stopping anything. Installing an update used to stop every
  agent and terminal the background runtime ran: a turn in progress was cut
  off, terminals and whatever they ran (dev servers, builds) were killed, and
  each agent started again only when its tab was next opened. The runtime is
  now handed over in place: the newer one takes over its process, with the
  same agents, terminals and processes, mid-turn or not. Turns finish,
  follow-ups queued during them are delivered, permission cards stay
  answerable, output written during the switch is kept, and no tab says
  "Session closed". An agent the handover cannot carry (one driven over its
  standard input and output, such as an ACP agent) is never stopped by itself:
  the app names it, and Restart now stops only it. Restart runtime, for a
  runtime that stopped answering, keeps what it runs the same way, and asks
  before stopping anything when it cannot. Takes effect from the next update
  after this one: a runtime from before this release cannot be handed over.
  (#765)
- Update and relaunch brings the background runtime along in the same step.
  The relaunched app used to keep the runtime it found, older than itself,
  and ask a second time ("TerminalX runtime is older than the app") after
  the restart. Now the update asks first, once. When moving to the new
  runtime would cut something short, the update card lists it before
  installing (agents mid-turn, open terminals, commands their tools left
  running) and offers **Update now**, which restarts them (each agent picks
  up its conversation again when its tab starts), or **Update when they're
  done**, which installs the app now and moves to the new runtime by itself
  once nothing would be cut short. With nothing under way the update just
  installs, and the relaunched app moves to its runtime as it starts. While a
  move waits, the status bar shows the runtime's version and what it waits
  for, with Restart now, even when the status bar is hidden; a floating
  notice appears only when a move failed, with the reason and Try again. An
  update from 0.2.23, which cannot ask first, waits in the status bar the
  same way. (#766)

### Chat

- Keep the chat drawn while scrolling past a long reply. Since 0.2.23 the
  chat draws only the turns near the view, and a reply taller than the 1200 px
  it draws past the view (a big table, long code) could be left out while it
  was on screen: the chat went empty but for the **Latest** button until the
  next scroll. A turn on screen is now always drawn, and the view no longer
  sits over the space that stands in for turns not drawn, scrolling either
  way. (#771)

### Stats & Usage

- Agent work and PRs count again while the app is open. The app took the
  activity-history lock at launch and held it until it quit, so the background
  runtime, which records every turn and PR, could write none of them: agents
  spawned, agent time and PRs created stopped counting, and the star reminder's
  count froze. Now only the runtime writes activity history. The app reads what
  the runtime saved, and the PRs the app finds or creates are kept aside for the
  runtime to count. Turns that went unrecorded before this release are not
  recovered. (#767)
- While another process holds activity history (an older app, another runtime,
  a command), the runtime keeps its turns and PRs aside. It takes the lock
  within a second of that process quitting, without waiting for a tab to
  change, and then counts what it kept once, with each turn's whole working
  time. Stats keeps its counters current meanwhile and shows one notice naming
  the holder: "The TerminalX app (pid …)", "Another runtime (pid …)" or "A
  TerminalX command (pid …)". It no longer offers a Retry that cannot help;
  Retry stays for a read that failed. The log gets one line for the episode
  instead of one per tab status change, and PR discovery no longer reports a
  failure on every pass. (#767)
- Usage keeps updating after the background runtime is replaced (Restart
  now, Restart runtime, a restart after a crash, an update). The window kept
  whichever snapshot had the higher revision, a counter that starts again at 1
  in each new runtime, so it threw away every snapshot from the new one and
  went on showing the old runtime's last values as current while each refresh
  succeeded. Snapshots now name the runtime that sent them, and a new
  runtime's usage shows at once. A window not updated for 30 minutes, or past
  its reset, reads as last known in the status bar and the popover, and a
  Codex window past its reset reads as expired instead of "100% used · Resets
  in now". (#772)

### Development

- Update rustls to 0.23.46 in the app and the background runtime. (#764)

## 0.2.23

### Offline dictation

- Add opt-in local transcription context, scoped dictionary spellings,
  replacements and snippets, conservative cleanup and learned corrections.
  Settings → Transcription includes import/export, sensitive-tab exclusions,
  language hints and a microphone test showing raw/final text and bias terms.
  Whisper and Apple receive vocabulary hints; other models use deterministic
  replacements. Apple refuses network fallback when on-device recognition is
  unavailable. Dictation event logs retain lengths rather than spoken text.
  Add an explicit-audio evaluation harness and recording protocol; recognition
  improvement requires real-audio evidence. Add warmed paired/matrix scoring,
  raw versus final scores, observed-correction evaluation and context timing.
  Synthetic file-recognition results are kept separate from microphone acceptance.
  Record isolated guest settings validation and public-runtime Whisper telemetry,
  including quiet-speech failures that rule out a no-speech-only filter.
  Retain a reproducible independent detector experiment and its negative controls;
  its observed speech loss prevents adopting it as an automatic filter.
  Compare strict CPU/Metal decoding with pinned fixtures; both reproduce the
  noise failures, ruling out a backend switch as a remedy for those cases.
  Add a pinned independent Whisper comparison using identical reference weights
  to distinguish app-specific behavior from upstream recognition limitations.
  Retain full-precision comparison failures and paired detector normalization
  evidence with public speech controls; no experimental runtime is shipped.
  Validate a static public-GGML detector prototype against multilingual speech
  and environmental controls, preserving runtime-upgrade incompatibilities and
  failed prototype evidence instead of changing existing recognition output.
  Add an opt-in local-model noise guard using the verified native detector,
  explicit auxiliary-model download/delete controls and detector diagnostics.
  Detection preserves original recognition audio, keeps text on model errors,
  and supports cancellation; Apple retains its platform speech detection.
  Reject symlink and nonregular detector cache entries without blocking capture.
  Learn a single word correction even when surrounding capitalization or terminal
  punctuation also changes; case/punctuation-only edits still teach nothing. (#439)
- Dictating with a downloaded model that can stream, such as the recommended
  Parakeet Unified EN 0.6B, shows the words in the composer while you speak,
  as Built in does. Before, nothing appeared until you stopped. The words come
  about a second at a time, roughly two seconds behind you. Whether a model
  streams is the model's own answer, read from its weights. Stop finishes the
  stream rather than transcribing the whole recording again, so a long
  dictation settles sooner: after 30 seconds of speech, about 70 ms after Stop
  instead of 250 ms on an Apple Silicon Mac. Under ten seconds the two are
  about the same. The final text still goes through the dictionary, learned
  corrections and the noise guard, and words streamed for noise the guard
  rejects are taken back. Words you delete while they stream stay deleted.
  Models that cannot stream (Whisper, Canary) say "Listening. Words appear
  when you stop.", and each model's card in Settings → Transcription says
  which kind it is. A stream that will not start, or breaks part way, falls
  back to transcribing the recording at Stop, and the log says why. On the
  first dictation after launch or a model change, "Opening the microphone…"
  stays up for the moment the model takes to load (under a fifth of a second
  for Parakeet here); what you say meanwhile is kept. (#754)

### Issue pipelines

- Answering the author of a pipeline at **Needs you** puts it back to
  **Working** at once, and the Issues list chip changes with the session for
  GitHub and Linear issues alike. Before, it kept saying **Needs you** until
  the author's turn ended, often for minutes. This applies to stops the author
  can act on: the work not done, failed checks, a pull request that could not
  be opened, a turn that stopped short, and conflicts with the base branch.
  Sending a message, answering a question or a permission request, or typing
  into the agent's own terminal all count, and so does a message that was
  queued behind the turn. If the turn still isn't done, the pipeline goes back
  to **Needs you**. A required review, a closed pull request and other stops
  that wait on someone else stay at **Needs you** until they are checked again.
  (#725)
- A conflict resolver that stops before committing its merge no longer leaves
  the checkout half merged. Every file the base brought in used to show as the
  branch's own uncommitted work: 23 files in Changes, and "23 uncommitted files
  would be lost" when removing the workspace, though 22 came unchanged from
  `main`. The resolver now commits the merge as soon as the conflicts are
  resolved and amends any fix its checks call for into that one commit. When
  its turn ends with nothing pushed, TerminalX aborts the unfinished merge it
  asked for, and says so in the record. A pull request merged or closed while
  the resolver works now ends the pipeline at once, and the resolver is told to
  stop. A merge is left as it is when a person interrupted the resolver or
  stopped the pipeline. (#736)
- A conflict resolver that ends its turn to wait for its own checks is no
  longer marked failed. On #733 the resolver had resolved and staged every
  file and was waiting for a 7-minute test run in the background when the
  pipeline recorded "The resolver ended without a status block." With the
  merge clean-up from #736 it would also have aborted that merge under the
  running tests. The pipeline now keeps the checkout reserved while the
  resolver's tab has work running, for up to 30 minutes, and takes the report
  from the turn that work wakes. Past that, the resolver is asked once for its
  report. A resolver that ends a turn without its report and with nothing
  running gets one reminder, as the author and reviewer do. Its merge is
  never aborted while its checks still run, and Stop hands the checkout over
  at once. Carrying a pipeline on from a failed resolution now checks the head
  against the current base first, and resolves again if it conflicts, instead
  of pushing a stale merge for review. (#753)
- Start the conflict resolver whenever GitHub says the pull request conflicts
  with its base or is behind it, even where the local merge check finds no
  conflict. With criss-crossed history (two merge bases) the local check came
  out clean while GitHub kept reporting a conflict, so the pipeline waited at
  **conflicts** for good and no resolver ever started. The resolver's merge
  leaves one merge base, so GitHub then agrees. (#748)

### Changes panel

- A merge left in progress in a local checkout is shown for what it is: what
  is being merged, and the uncommitted files split into unresolved conflicts,
  files changed here, and files exactly as Git merged them from the base.
  **Commit merge** (once nothing is conflicted) and **Abort merge** (after a
  confirmation) act on that merge only. The warning before removing a
  workspace counts only what changed while merging as lost. The Repo panel's
  **Commit** waits until conflicts are resolved, since it would otherwise
  commit the conflict markers. (#736)

### Sessions and tabs

- Open the session you click. A session with no tabs open was swapped for
  another session in the same folder that had tabs, a quick chat or another
  project's included, so it could not be opened, and neither could its history
  or its closed tabs. It now stays selected and shows its own page: its closed
  tabs, newest first, each with Reopen to resume that conversation in this
  session, plus New tab and Reopen closed tab. Opening a session no longer
  starts a shell in it by itself; opening a checkout from the command palette
  still does. (#721)
- Keep a row of tabs to real siblings: with a branch's sessions shown as tabs,
  a row holds the sessions of the same project and branch only, as the sidebar
  lists them, never a quick chat or another project's session that runs in the
  same folder. A session on that branch with no tab open has nothing in the
  row of tabs to click, so it keeps a sidebar row of its own under the
  branch's, and a browser page another session opened in the folder no longer
  hides its page until it is picked. (#721)
- Offer Undo when closing a session's last running tab. The notice says its
  agent stopped, and Undo reopens the tab on the same conversation. (#721)
- Archive conversations nobody has written in for a week (Settings → Agents:
  a day to a month, or never). Idle counts from the last message in any tab,
  not from when the session was made. A conversation stays while it is pinned
  or open, while a tab is working, waiting for you or holding a queued message,
  while its last reply is unread, while its worktree has uncommitted or
  unpushed work, and while its issue pipeline's pull request is open. A new
  message to an archived session, from the app, the CLI, a phone or an
  automation, brings it back. Archiving deletes nothing. (#718)
- Find archived conversations again. View → Show archived lists each
  project's archived conversations, and the chats', under an "Archived" fold,
  with Unarchive on each row; a project taken out of TerminalX comes back there
  with the conversations removing it archived. The command palette finds an
  archived conversation by its title and says it is archived. (#718)
- Select several conversations in the sidebar (⌘-click, Shift-click, or
  Select in a row's menu), then archive, unarchive or delete them together.
  (#718)
- Native Codex now covers a new cloud workspace's first session. With
  Settings → Experimental → Native Codex on, a workspace created with Codex
  and a first prompt opens its first tab as native Codex, and the prompt is
  sent once, as before. Before, only sessions and tabs started later in the
  workspace did; the first one opened in Codex's terminal. Ask every time,
  other agents and the switch off still start a terminal tab, and so does a
  workspace whose runtime or server predates this. (#745)
- Interrupt a Codex terminal tab right after changing its effort or permission
  mode. Codex restarts to take the change, and an Interrupt sent afterwards,
  from the desktop or a phone, let the running turn go on to its end. It now
  stops the turn, and Stop withdraws a prompt not yet entered, whether it was
  waiting for the restarted Codex to be ready, about to be typed or about to be
  submitted, so it is never typed into the new Codex. (#746)

### Chat

- Show a sent message at once. Pressing Send puts the message in the chat,
  marked as sending, and clears the composer for the next one; it is marked
  as sent once the runtime has it. A message that could not be sent goes back
  to the composer with the error, ahead of anything typed since, images and
  all. (#727)
- Keep long conversations quick. The chat is built on as events arrive instead
  of being rebuilt for each one, and only the turns in and near the view are
  drawn, so a message in a conversation of thousands of events appears as fast
  as in a short one. (#727)
- Never type a message into an agent's input box that already holds text. The
  app used to clear the box with Ctrl+U, which deletes only the row the cursor
  is on: when Claude Code had put a dropped prompt back in its box, the prompt
  lost its last wrapped row and the rest was sent with the next message glued
  to it. The app now reads the box from the agent's screen (Claude Code and
  Codex), and a message waits while the box holds something, saying so in the
  chat, until that text is sent or cleared in the terminal. (#722)
- Show a prompt Claude Code dropped before answering as not answered, with Send
  again, when it takes another prompt in its place; one sent again from its
  input box stays the one message. A message the agent received inside a longer
  prompt is shown once, as received, with what was sent behind it, and its
  queued bubble clears. (#722)
- Read the input box of an agent started by hand in a shell tab too, before
  typing into it; it had no check and no Ctrl+U, so a half-typed line or a
  prompt put back in the box went out glued to the next message. Every
  message waiting behind a full input box says so, not only the first. Stop
  withdraws a message still waiting on the box, marked as not sent with Send
  again, instead of typing it whenever the box next empties. A model or effort
  change made while the box holds text is refused with the reason rather than
  typed later. Queued messages the agent receives as one prompt all clear, and
  a message sent from the chat with a dropped prompt's words is shown as its
  own. A prompt an idle agent recorded shorter or edited is shown once, as
  changed, and a waiting note left behind when the app quit mid-wait is
  cleared on load. (#722)
- Cut more credentials from the redacted detail line that a refused sign-in or
  an agent that exits early shows in the chat: `key: value` and JSON forms,
  escaped JSON, every pair of a cookie, any `Authorization` scheme and a flag's
  secret-looking value, including one that runs on over lines. Errors such as
  `HTTP 401 Unauthorized:` and Codex's `Failed to refresh token:` stay
  readable. (#717)
- Show a native Codex reply as one message while it streams. Each piece Codex
  sent was recorded as a message of its own, so a real reply showed as dozens
  of fragments, each with its own time, and was saved that way. The reply now
  grows in place and is saved once, whole, with the time its first piece came;
  Codex's reasoning summary does the same. What streamed of a reply that never
  finished, because the turn was interrupted, failed or stopped, or the
  connection was lost, is kept as it was shown. (#644)
- Draw a streaming reply as it grows. The desktop chat showed the first piece
  of a streamed reply and then nothing new until the reply was complete, in
  local and cloud tabs alike, for every agent that streams previews (ACP
  agents, OpenCode and native Codex). Streaming thoughts, a tool call's input
  as it is written, and the end of a thought had the same problem. Each now
  redraws at the next frame. The phone shows replies once they are complete,
  as before. (#644)

### Cloud workspaces

- Show a compaction in a cloud workspace's agent tab as **Compacting
  context…** while it runs, then **Context compacted**. The tab said
  "Compaction status unknown" the whole time, even while connected. A tab
  counts as caught up once its live connection has replayed the workspace's
  saved history; while that connection is down or reconnecting, a compaction
  still shows as unknown, never as running or done. (#644)
- Say why a native Codex tab in a cloud workspace did not move to its terminal.
  The workspace's own reason (a turn still running, someone else driving the
  tab, no right to type in it) shows above the chat, with Dismiss, also when
  the composer already says why it is off. It used to say "The agent
  encountered an error", or nothing at all while someone else drove the tab.
  Local tabs are unchanged. (#644)
- A waiting native Codex tab no longer says to check the terminal, which it
  does not have until it moves there: it points to the conversation above, to
  send a message or stop the session. Its recovery banner for an expired
  permission request or an unconfirmed prompt no longer sends it there
  either. Tabs whose agent runs in a terminal are unchanged. (#644)
- Deliver a message sent from the command line, a phone or another member to a
  native Codex tab whose last turn failed, for example on a revoked sign-in.
  The workspace said it was sent, but the message sat in the queue for good:
  the tab was taken as busy while it showed the failure, and no turn was left
  to end and send it. It now goes straight in and clears the failure, as a
  message sent from the desktop does, and a message queued while that turn
  ran goes once it ends. ACP and OpenCode tabs get the same fix. A Claude Code
  or Codex terminal tab that is waiting still holds the message, since its
  CLI may be showing a prompt of its own. (#644)
- Let a native Codex tab work again once its sign-in is restored. Codex reads
  its sign-in only when it starts, so after a turn refused for a revoked login
  every later turn was refused as well, even after the login was granted
  again. Codex now stops after such a turn, and the tab keeps saying it is
  signed out. The next message starts Codex again on the same conversation
  with the sign-in in place then, and nothing is sent twice. This applies on a
  Mac too. (#644)
- Leave the workspace user's own `~/.codex` as it is. Checking the Codex version
  before a native Codex tab starts made Codex write temporary files there; the
  check now runs in the tab's own Codex home. (#644)
- Take an issue session in a cloud workspace through to its pull request,
  review and merge. The workspace never cloned its repository, because one
  folder was compared under two different paths, and an issue session in the
  repository folder got no pipeline, because that folder was never registered
  as a project. A GitHub refusal over the app installation's permissions or
  repository access now says that an organization admin must approve or review
  them on GitHub and refresh the installation in TerminalX Settings, and the
  request is not retried by itself. (#461)

### Mobile

- Show a compaction on the phone as on the desktop, in cloud workspace tabs
  and in tabs on a paired Mac: **Compacting context…** while it runs, then
  **Context compacted**, **Compaction stopped** or **Compaction status
  unknown**. Every compaction used to read "Context compacted", even while it
  ran or after the phone lost track of it. A compaction shows as running only
  once the phone has read the conversation to its end over a live connection.
  While disconnected, reconnecting or just back from the background, it shows
  as unknown. A stopped workspace's saved conversation never shows one as
  running. (#644)
- A native Codex tab's recovery card on the phone no longer says to check the
  terminal (an expired permission request, an unconfirmed prompt); it says
  what to do in the chat instead, as the desktop now does too. The Mac tells
  the phone which tabs run native Codex; an older Mac keeps the old wording.
  (#644)
- Open sessions on the phone again. The session screen crashed on load,
  because the terminal emulator it loads reads the browser's user agent and
  platform, which React Native does not have. (#726)
- Offer on the phone only what the Mac's background runtime can do. A Mac
  updated to a new app but still running an older runtime used to offer the
  Terminal view, session controls, new sessions and Mac settings, which that
  runtime then refused as "Unsupported paired-device owner operation.". The
  phone now reads what the runtime serves and shows or hides those features
  when the Mac switches runtimes, without a restart; a refusal that still
  happens says "TerminalX on your Mac needs updating or restarting to do
  this." (#730)

### Background sessions

- Never hold a send behind slow work. Merged-workspace cleanup, Settings →
  Storage (scanning, sizing and removal), workspace and session removal,
  `terminalx worktrees delete` and stopping an idle agent no longer hold the
  lock every send takes; each closes only the sessions it changes, and a send
  to any other tab goes through at once. Checking the worktree's tree before a
  prompt, which reads the whole checkout, now happens before the send waits
  for anything. A send to a session that is being removed or moved is refused
  with the reason, and one to an agent being stopped for sitting idle waits
  for that stop and starts it again. (#727)
- Time every send. Each tab's diagnostics note when Send was pressed, when the
  runtime received the send and how long it waited, when the agent took the
  prompt, and when the window showed it, so a slow send can be traced to the
  step that took the time. (#727)
- Keep the live connection up when a window falls behind. A terminal that
  cannot keep up is redrawn from its scrollback on its own, while the others
  in the window keep streaming. Events the window missed are read again,
  without reconnecting. Each window's terminal connection now carries terminal
  output only. Every lost connection is now logged: which connection, why, how
  long it was down and how many attempts it took to reconnect. The log is
  `desktop.log`, beside `runtime.log` in `~/Library/Logs`. (#716)
- Replace an older background runtime after an update. The runtime outlives the
  app, so an updated TerminalX went on using the runtime of the version before
  it. The app now replaces a runtime older than itself with its own, by itself,
  once nothing the runtime runs would be cut short: no agent mid-turn, prompt
  waiting to be delivered, agent started by hand, open terminal, command an
  agent left running or issue pipeline step, and none for 15 seconds. Until
  then every window says the runtime is older than the app, lists what it is
  waiting for, and offers **Restart now**. Agents pick up their conversation
  again when their tab next starts. A runtime of the app's version or newer is
  kept, so two builds sharing one home never replace each other's. (#730)

### Usage

- A refresh that says it succeeded now changes the usage it shows. The status
  line and the usage endpoint write a window's reset time differently (whole
  seconds against fractions that move between requests), so the endpoint's
  window was read as the previous one and dropped on every refresh, and old
  Claude (sometimes Codex) limits stayed up. Reset times within 60 seconds are
  now the same window, and a window the provider says has not started shows
  as 0% with no countdown. (#729)
- An endpoint window whose reset time is earlier than the one shown, but was
  still ahead when the request started, replaces it. It was refused as an
  earlier window until the shown reset time passed, up to a week for the 7-day
  window. A status line's earlier window is still refused. (#737)
- "Last refreshed" counts only an answer that replaced a window. When the
  provider answered and nothing changed, the card says "Checked … · no newer
  usage" and why each window was kept, including a reply that repeats a window
  that has just expired. A Codex refresh held back by its debounce says when it
  will fetch again, a tab started before an account was known says so in its
  own words, and every refresh is logged. (#729, #738)

### Command line

- `terminalx worktrees delete` no longer deletes sessions it never named. Without
  `--yes`, or with `--dry-run`, it lists every session it would delete, marking
  sessions of another project, quick chats and archived ones, with the tabs
  still running in them and the git state, and removes nothing. `--sessions
  ID,…` names the sessions you were shown: if the worktree holds any other set,
  nothing is removed and the sessions that differ are named, as in the desktop
  dialog. The result gives each deleted session's title and project, not only
  its id. `terminalx sessions list --worktree` lists what the delete would take,
  `worktrees list` gives each worktree's sessions, and `sessions list
  --project` now finds a session that names its project through a symlink.
  (#719)
- `terminalx sessions archive|unarchive SESSION...` run the app's own
  archive, so the sidebar updates at once. `sessions list` now lists what the
  sidebar does, and `sessions list --archived` the archived sessions. (#718)

### Development

- Update vite to 7.3.7, fflate to 0.8.3 and linkify-it to 5.0.2 in the app,
  the phone app and the shared portable package, and zod to 4.6.6 in the app
  and the phone app. (#762)

## 0.2.22

### Background sessions

- Reconnect to the background runtime automatically, with backoff and no attempt
  limit, instead of after three tries per window. Recovery no longer reloads
  windows: terminals re-attach in place from their retained output, and sessions,
  history and pipelines are read again without restarting agents or resending
  prompts. A hung runtime is now noticed, a restarted one is found again, and a
  window whose terminal output alone dropped recovers without affecting others.
  The notice stays quiet for short gaps and asks for action only when retrying
  cannot help or has not helped for minutes. (#643)
- Stop agents nobody is using. An agent the app started that has had nothing to
  do for an hour (Settings → Agents: 30 minutes to a day, or never) is stopped
  with its MCP servers, and its next message starts it again on the same
  conversation; a reply nobody has read stays unread. An agent keeps running
  while it is at work, waits for an answer, or waits on something it started:
  a command, monitor or agent it ran in the background and has not heard back
  from, a wakeup or cron job it scheduled, or a process one of its commands
  left running. So does one started by hand in a terminal.
  Agents in archived sessions, or whose workspace was removed, stop after 10
  idle minutes, and opening such a session, or a tab whose agent was stopped
  this way, no longer starts its agent. App resources can stop an idle agent,
  after asking. (#696)
- Set the conversations of removed workspaces apart from live work: each
  project, and the chat list, folds them under "Removed workspaces", which
  opens while it holds the open conversation. They stay readable and
  resumable. Finishing a clean-up whose worktree was already gone stops the
  agents of its sessions first. (#696)
- End the MCP servers Claude Code starts while TerminalX reads its slash
  commands and models. Each was left running under launchd; one Mac had thirty,
  about 1 GB. (#696)
- Merged workspaces of this repository are no longer kept for the CLI launcher
  the build leaves in `src-tauri/binaries`. (#696)
- A terminal that stops reading its input no longer locks up the background
  runtime, and with it TerminalX, until the Mac restarts. A write gives up after
  10 seconds, app commands that call the runtime run off the main thread with
  15-second timeouts, and a runtime that stops answering offers **Restart
  runtime**. The runtime keeps its log in
  `~/Library/Logs/com.terminalx.next/runtime.log`. (#678)

### Relay

- Poll the account service for pairing grants and revocations once every 30
  seconds while idle, over one kept-alive connection, instead of a new TLS
  connection every two seconds. Back off on failures, honour `Retry-After`, use
  a refreshed access token, and record failures in `relay-diagnostics.json`.
  Report this Mac as live only while its Relay control channel is still hearing
  from the cell, so a phone stops offering Pair for a Mac it cannot reach.
  Accept a cell's `account-pairing-changed` hint, which polls at once and then
  every two seconds for a minute. (#671)
- Notice a Relay control connection that died without a close, after a network
  change, a new address, a VPN change or sleep. Reconnect within 2 seconds of an
  address change or wake, or after 45 seconds of silence, instead of showing
  Connected until TerminalX restarts. Record each phone's Relay connection, and
  how far it got, in `relay-diagnostics.json`. Run paired-device calls to the
  local runtime off the workers Relay runs on, so a stalled runtime cannot stop
  Relay reconnecting. (#666)
- Keep Relay messages within the cell's 1 MiB limit, so long conversations load
  on mobile data. Transcript pages are sized to the connection, an oversized
  event is sent alone or shortened with a note, and larger messages, such as
  5 MB attachments, cross in fragments once both ends support it. A message that
  still cannot fit fails only its own request, and the connection stays up. (#679)

### Mobile

- Start sessions from the phone as the Mac's new-session view does: a project's
  session in a new worktree (named for the work) or on its checkout, or a quick
  chat, with the agent, model, effort, permission mode, title and first
  message. Codex sessions follow Settings → Experimental → Native Codex. A
  retry after a lost reply opens the first session instead of a second one.
  Projects reach the phone by an id, never their path. Read-only and revoked
  phones cannot start sessions.
- Settings → This Mac on the phone turns Native Codex on or off for the Mac's
  next Codex sessions; the Mac's own Settings follows it while open.
- Open a tab's terminal view on the phone, as on the desktop. The agent's own
  screen is emulated on the phone with the desktop's terminal (xterm.js) at the
  size the Mac draws it, so full-screen CLIs like Codex and Claude Code show as
  they do there. Type into it directly or send text whole, with Esc, Tab, Ctrl,
  arrow and Enter keys sent as the desktop sends them. While the phone types,
  desktop typing waits, and leaving the view gives it back. Opening the terminal
  starts the tab's agent if it is not running, and moves a native Codex tab to
  Codex's own terminal on the same conversation, as the desktop does. Shown only
  for Macs that support it.
- Switch to Sessions when tapping a connected machine on iPhone, preserving its
  active connection and session list. (#653)
- Sending a message or worktree note again after the connection dropped no
  longer gives the agent the prompt twice or adds the note twice. Each draft
  goes under one id, and a Mac that already has it answers as it did the first
  time, so the phone reports it sent and clears the box. Older Macs behave as
  before. (#675)
- Control a session from the phone as from the desktop: Stop and Interrupt a
  working agent; Retry safely, Resend last prompt, Continue here and Stop from
  the recovery banner; change the model, effort and permission mode with the
  desktop's choices, pending states and Bypass confirmation; and Continue in
  new session with a chosen agent, settings and context. A read-only phone sees
  the settings but cannot change them, and each control is checked against the
  phone's access on the Mac. Shown only for a Mac that offers them.
- Report each connection path's failure as it happens. A Relay refusal shows on
  the Sessions card while LAN addresses are still pending, and LAN addresses that
  have not answered get 3 more seconds once Relay has failed, not 15. Log
  cancelled attempts and Relay director errors, race the paths again when the
  phone changes network, and wait 1 second, rising, before reconnecting a
  connection that keeps dropping straight after connecting. (#666)
- Explain connection failures on the phone's conversation screen in plain words:
  **Reconnecting…**, which keeps the saved transcript, or **Your Mac isn't
  reachable**, with a Retry that reconnects at once. A failed send offers **Send
  again**. A transcript page that drops the connection twice over the same path
  is not requested again, and the Relay close code and reason are logged. (#674)

### Organizations

- Let organization owners delete non-personal organizations, including test
  organizations, with exact-name confirmation and guidance for remaining resources.
  Refresh membership and clear a deleted default selection without choosing a replacement.

### Terminal

- Release a tab's terminal view metadata when the tab is removed, and ignore
  late start or adoption replies from its previous lifetime. Archived tabs,
  retained conversation history and reattachment are unchanged. (#232)
- Cancel xterm's pending buffer compaction when a terminal is disposed,
  including buffers replaced by a reset, so a closed terminal's scrollback is
  not kept alive by the timer. (#232)
- Reuse one small canvas for terminal palette conversion instead of creating
  two surfaces per palette. (#232)
- Add an opt-in memory diagnostic to the terminal benchmark: weak inventories of
  xterm buffers, parsers, renderers and canvases, Tauri callback counts, and
  WebContent footprint in exact bytes. It reports typed-array spans without
  materializing their backing buffers. (#232)

### Chat

- Restart Claude Code tabs whose conversation the CLI never wrote (opened and
  never prompted, or a first prompt that never reached it) under the same id
  instead of resuming a conversation that does not exist, which exited at once.
  Send a Continue in New Session handoff again, ahead of the next prompt, when
  the CLI never took it. Offer any other prompt the agent never received with
  **Resend last prompt**, images included. Say why a CLI that exits as it
  starts went, from what it printed, with credentials and private paths cut
  out. (#663)
- Deliver Continue in New Session handoffs that the new agent left in its input.
  The Enter waits until the agent has shown the paste, and is written again up
  to twice. A handoff still in the input is offered as **Press Enter**, not
  reported as a failure. The dialog shows each delivery step, finishes about
  20 s after the last Enter instead of after 90 s, and turns a late delivery
  into success. (#662)
- Recognize completed Codex context compaction and preserve scoped compaction
  history and status across conversation changes. Add a default-off experimental
  owned-stdio connection for explicitly created new Codex sessions, with confirmed
  compaction start/completion events and retained interruption status. Existing
  PTY sessions keep their current behavior. (#644)
- Experimental Codex sessions continue after the app restarts, after Stop or
  after a lost connection: the next message resumes the same Codex thread, with
  nothing replayed, and **Retry safely** works for them. They accept Codex 0.164.0
  or newer instead of exactly 0.164.0. (#644)
- Change the model, effort or permission mode of an experimental Codex session
  instead of creating a new one. Model and effort apply from the next turn; a
  permission mode is taken between turns by resuming the thread under it. (#644)
- Opening the terminal view of an experimental Codex session moves it to Codex's
  own terminal interface on the same thread, instead of an empty terminal. The
  chat keeps its history without repeating it; the move is one-way and waits for
  a running turn to finish. (#644)
- Message an experimental Codex session from a paired phone or as a guest or host
  of a shared session, including `/compact` from the phone, instead of being
  refused as local-only. Each message is checked against its sender's access when
  it is delivered, as for other agents; one whose access ended is not sent. (#644)
- Continue in New Session can hand off to an experimental Codex session. Delivery
  is confirmed once Codex starts the handoff's turn. A handoff, or any prompt,
  that Codex never took because it failed or was stopped first is offered back
  with **Resend last prompt**, after a restart too, and is never sent again on
  its own. (#644)
- Add Settings → Experimental with a **Native Codex** switch, off by default. When
  it is on, new Codex sessions and tabs started from the app or the `terminalx`
  command line connect to Codex directly, for reliable compaction status. Sessions
  from issues, automations and Ask every time keep the terminal.
  A tab whose Codex is older than 0.164.0 when it first starts switches to the
  terminal and sends as usual, with no error. Existing sessions are unchanged. (#644)
- Native Codex in cloud workspaces: with the switch on, Codex sessions and tabs
  the app starts in an existing workspace connect to Codex directly too. Codex
  signs in with the workspace's credential and takes the creator's route and the
  workspace's variables, secrets, instructions and MCP servers, in a home of its
  own where no TerminalX hook runs; sign-in problems are reported as for other
  sessions, and the terminal view moves the tab as on a Mac. (#644)
- Add **Continue here** to the recovery banner and the Session closed bar. It
  sends "continue" in the same session, without stopping it, after a failure,
  a capacity error, a dropped connection, a sign-out or a usage limit that has
  reset. (#673)
- Recognise a revoked or expired Codex or Claude Code login. The turn ends as
  signed out with a redacted detail line, the tab offers **Sign in again**, and
  Agent logins shows Sign-in required. Cloud runtimes report the refused login
  and sync again, so Start agent works once you have signed in. (#683)
- Settings → Agents and the New Session form show whether each local agent is
  installed and signed in (Not installed, Installed · sign in required, Ready ·
  local login found, or Login not checked), with its version, path and the
  command that installs it or signs in. Create and Ask refuse to start only when
  the agent is known to be missing or signed out, and keep the draft and
  attachments; a check that cannot be read never blocks. (#715)
- A Codex tab that opens on Codex's sign-in menu is blocked with a **Sign in**
  banner that opens `codex login`, instead of having the first prompt typed into
  the menu and timing out as delivery unconfirmed; the next launch offers the
  prompt back. Claude Code's first-run screens keep their banner instead of
  setting the tab to Idle. (#715)
- Question-card options whose label contains a comma show as selected, and
  multi-select choices no longer overwrite one another. Options with the same
  label, and questions with the same text, no longer share a selection. (#708)

### Status bar

- Claude usage keeps refreshing when Claude Code's keychain login is large.
  The read no longer stalls until its deadline once the item outgrew the pipe
  buffer, as it did as MCP sign-ins accumulated, and then reported "OAuth
  credentials were not found". A failure now says whether the keychain read
  timed out, failed (with its exit code), or found no login, and Refresh
  retries a failed credential read at once instead of waiting out a backoff
  of up to four hours. A provider's Retry-After still holds it. (#664)

### Issue work status

- Refresh shared issue work when the account service changes its supported
  capabilities, and republish actual linked sessions after support returns.
  Explain when the account service has not reported support; shared activity
  still requires a supported backend. (#642)
- Name each Mac by its computer name (System Settings → General → About), so
  work on another of your Macs reads "You · on Studio" instead of
  "You · on This Mac". Macs that saved "This Mac" get their real name without
  renaming, and a name chosen earlier is kept. Settings → Account shows this
  Mac's name with a Rename button, with or without Relay. (#686)
- The work chip's hover card in the issues list holds its contents: long titles
  and branches end in … at its edge, it stays opaque in macOS glass mode, and it
  no longer dims rows for work that went quiet. (#714)

### Cloud workspaces

- Treat enabled cloud control as consent for routine cloud workspace starts,
  resumes and session launches without repeated native confirmations. Preserve
  destructive confirmations and security checks. (#658)
- Route new sessions to the selected, verified repository checkout and keep child
  checkout sessions visible. Require the runtime's `session-repository/1`
  capability; refuse unavailable or mismatched checkouts instead of using the
  blank workspace root. (#656)

### Issue pipelines

- Start a session from a GitHub or Linear issue with **Resolve conflicts
  automatically** and **Merge when green** on: from the Issues page, an issue
  picked in New Session, the command palette, and `terminalx sessions create
  --issue` without `--auto-merge` or `--no-auto-merge`. Each launch can still
  turn either off. Merge stays off where a person does the merge, where the
  pipeline is off or unavailable, and in a cloud workspace. A merge still needs
  the reviewed commit with its checks passed, and protected categories still
  hold it. Other sessions start with both off, as before. In a project's
  **Issue pipeline…** settings, each default is now **From issues**, **All
  sessions** or **Off**, and a project set to Off keeps its issue sessions off.
  A switch an older version saved as off whenever another setting was saved is
  read once as **From issues**; one an older version saves after that reads as
  Off. Continuing a session keeps its pipeline's switches as they are, and
  starting an issue again takes the switches its pipeline holds. (#700)
- When a pipeline's pull request is merged or closed, or the pipeline is
  stopped, stop the idle agents of its reviewer and conflict resolver (and,
  after a merge or close, its author), with the background commands and watches
  they left running. A reviewer or resolver still in a turn is told the pipeline
  ended and is stopped when that turn ends; an author in a turn is left alone.
  Conversations can be resumed. A reply that arrives after the end is noted on
  the issue page and ignored. (#689)
- A reviewer can answer that its own checks are still running instead of giving
  a verdict. TerminalX waits up to 20 minutes, then asks once for a verdict on
  what it has. (#689)
- Verdicts say whether the reviewer's checks passed, failed or did not run. The
  issue page and the pull request comment say so. Failed checks stop the
  pipeline for a person. A review by reading alone no longer merges a project
  without CI by itself. (#689)
- Removing a workspace stops leftover Rust builds and checks still working in
  it, such as a `cargo check` that outlived rust-analyzer, and lists any other
  process there by name. Programs detached on purpose (`screen`, `tmux`,
  `nohup`, tunnels) are never stopped. (#689)

### Issues

- Create and edit issues from a project whose `origin` still uses a renamed
  GitHub repository's old name. Writes go to the repository's current name; a
  write GitHub still redirects names the new repository and the
  `git remote set-url` command that updates the remote. (#710)

### Command line

- `terminalx wait` reports `permission` only when there is a request or question
  to answer. A failed agent is reported as `recovery` with its kind, and right
  after a send it waits for the new turn instead of returning the status from
  before it. (#677)

### Development

- Build the dev and test profiles without incremental caches and with line-table
  debug info only, so each checkout's `src-tauri/target` stays far smaller. Set
  `CARGO_PROFILE_DEV_DEBUG=2` for full debug info or `CARGO_INCREMENTAL=1` for
  incremental builds. (#697)
- Ignore the `rustc*` scratch folder a killed launcher build leaves in
  `src-tauri/binaries`, which stopped this repository's issue pipelines at
  "uncommitted changes". (#693)
- Keep three idle-agent tests and a store lock test from failing on a loaded
  machine, as they did on main's CI: they measured quiet before the pane's first
  draw or the tail's read, or retried a lock with no wait. A runtime test now
  expects App resources to stop an idle agent after asking, as #696 made it.

## 0.2.21

### Sessions and workspace

- Create sessions from a compact dialog with a combined agent menu, branch picker
  and searchable GitHub or Linear issues. Keep unsent prompts when the dialog
  closes, reuse an open branch or check out another branch in a new worktree,
  and name new worktrees from the prompt or issue. (#651)
- Add a Linux desktop in the Computer panel using Docker or Podman, with live
  viewing, manual control and agent computer tools. The container has no host
  mounts, its viewer listens on loopback, and Stop and Reset check ownership. (#651)
- Add a resizable terminal dock, per-turn changed files, branch renaming and
  clearer loading and signed-out states. Fix transcript-only task notifications
  leaving a conversation stuck on Working. (#651)

### Updates

- Check for updates shortly after launch and every four hours in release builds.
  Show an Update button and a dismissible notice with Update and relaunch. (#651)

### Permissions

- Preserve the session directory and supplied approval reason through live events
  and transcript replay. Prefer an explicit tool working directory, and explain
  when Ask every time caused the permission request. (#636)

### Terminal

- Cancel pending atlas warm-up when its final terminal owner is disposed, while
  preserving warm-up for remaining shared owners. Native memory acceptance
  remains unresolved. (#232)

### Chat

- Clarify the CLI guide to keep simple issue filing and context checks in the
  current conversation, with separate sessions reserved for authorized work. (#634)
- Show sending progress immediately and prevent repeat submissions while a message
  is pending. Preserve newer drafts and recalled text, and keep pending sends and
  errors visible across tab remounts and cloud reconnects. (#637)

- Keep issue confirmations compact and scrollable with visible decision controls
  and originating-session context. Background requests wait for explicit review
  without interrupting another conversation; human approval remains required. (#641)
- Show clear delivery progress when continuing in a new session, remove the submitted
  handoff draft, and preserve any edits made while the handoff is starting. (#635)

- Open a mobile machine’s sessions without restarting an active connection, and
  load its sessions automatically after reconnecting. (#633)

- Recover unavailable live connections automatically without restarting agents or
  resending prompts, while preserving unsent drafts and isolating unrelated window
  connection failures. (#643)

## 0.2.20

### Codex sessions and permissions

- Keep fresh and resumed Codex sessions isolated from the shared daemon so
  hooks use the current tab and runtime, fixing false tool-call refusals after
  restarting TerminalX. Accept unchanged approved tools with a supported hook
  reply, and explain when the session owner is unavailable instead of claiming
  the user declined. Explicit denials and human-only controls remain enforced. (#639)
- Check that the installed Codex supports `--no-daemon` before preparing or
  starting a session; 0.164.0 is verified. Unsupported versions receive an
  actionable upgrade message. Keep the capability check within its deadline,
  including subprocesses that retain output pipes after their parent exits. (#639)

### Documentation

- Add a fresh-VM Zeron comparison, narrated walkthrough and prioritized
  improvement backlog, with account-dependent features marked untested. (#640)

## 0.2.19

### Permissions

- Fix local sessions rejecting tool calls with “The user declined this action”
  when nobody declined them. Authenticated tool reports now leave the provider's
  own permission policy in charge; missing replies, stale launches and explicit
  denials remain blocked. (#632)
- Show the full command, working directory and approval reason in local and shared
  permission cards, including Codex commands. Preserve whitespace and long command
  suffixes, wrap long lines and keep approval buttons reachable in narrow and
  floating windows. (#632)

## 0.2.18

### Background sessions

- Keep local agents, queued follow-ups, pending permissions, terminals, pipelines
  and scheduled automations running after the desktop quits. Reopening reconnects
  to their actual state and retained history. Runtime loss, logout and reboot
  still report interrupted work honestly. (#467)
- Choose whether quitting keeps work running or stops it, with a saved preference
  and explicit Stop all and quit actions. The macOS menu-bar helper owns background
  notifications and confirms process-group exit before reporting work stopped.
  Disconnected resource views show unavailable state and discard stale actions. (#467)
- Preserve a single runtime across desktop replacement, with signed helper
  installation, authenticated attachments, bounded history replay and launch
  fencing. Sharing authorization lives with the owner; mobile connectivity,
  computer use, dictation and the built-in browser still require the desktop. (#467)
- Package the macOS CLI launcher as a native executable so its signature survives
  updater extraction while preserving arguments, streams and signal behavior. (#467)

### Agent sessions

- Keep macOS browser-use MCP helpers out of the Dock and app switcher while
  preserving screen detection and usable browser windows. (PRO-116)

### Chat

- Deliver queued messages through the provider's native interrupt without pasting
  them again. Keep repeated Send now clicks harmless, retain provider queue order,
  publish successful submission atomically with Enter, and show Codex continuations
  as working when an older interrupt hook arrives. Reconcile completion debt in
  record order and serialize managed transcript reads through application so
  concurrent readers cannot close a newer continuation or cancel its approval. (#627)

- Keep table Copy/Download menus readable and inside the window, and expand tables
  into a scrollable viewer above the conversation with keyboard focus restored on
  exit. Include Streamdown control styles and keep linked-code toolbars visible. (#624)

- Wrap long separators and unbroken plain text inside prompt, delivered and queued
  messages, including narrow chat and document layouts. Preserve original text,
  line breaks and selection while keeping code blocks horizontally scrollable. (#623)

### Session automation

- Allow continuing a merged pipeline's conversation with both automation switches
  off, including after workspace cleanup, without changing its completed history.
  Active and stopped pipelines still revoke explicitly disabled permissions.

- Carry both-off continuation choices to the backend, revoking existing merge
  and conflict-resolution permissions before handoff. Do not create a pipeline
  for an unautomated session with both switches off; refuse launch on lookup or
  handoff errors instead of retaining prior authorization silently.

- Group session automation controls accessibly and validate both launch switches,
  cleanup settings, and agent controls in WebKit without relaxing overflow,
  overlap, or narrow-pane wrapping checks. Keep tall issue launch settings and
  Start session reachable by scrolling them with the issue content.

- Preserve explicit merge and conflict-resolution launch choices when continuing
  local work or starting cloud issue sessions. Release a stopped resolver’s
  checkout reservation when its agent terminates.

- Add shared launch controls for automatic conflict resolution and merging
  after review and final-head checks, with project defaults and session controls.
  Branch sessions without an issue can now use the same pipeline without tracker
  updates. Conflict resolution waits for idle conversations, reserves the checkout,
  verifies one merge of pinned inputs, pushes without force, and requests a fresh
  independent review. Attempts are bounded and concurrent changes stop for a person.
- Allow a project check command to run under TerminalX on the final reviewed head.
  Explicit local-only policy still honors required hosted checks and repository
  rules. Cloud workspaces still require a desktop-authorized merge. Workspace
  removal continues to use the existing merged-cleanup policy and grace period.

### Workspace cleanup

- Make keeping conversations the default in workspace removal, using the existing
  settle flow and naming the project folder where agents resume. Keep original
  workspace provenance visible and separate from live checkouts in the sidebar. Require a separate
  permanent-deletion choice and explain provider resume files, recovery and recorded
  usage. Refuse unsupported cloud retention rather than silently deleting sessions;
  direct cloud users to the existing worktree cleanup flow. Document and regress
  the existing prompt-free, deduplicated historical accounting. (#464)

### Welcome

- Show a resting welcome screen when nothing is selected, with the app mark,
  build name, project/session actions and the current keyboard shortcuts.
  Share its layout with first-run open/clone/quick-start options and compact
  Issues and Skills empty detail panes. Explicit New session still opens the
  form; closing, archiving or deleting the selection returns to welcome.
  Cloud archival respects later navigation, and Reopen closed tab still works
  from welcome after closing the last tab, including Close all. Browser
  dictation checks explicitly enter New session from welcome. Narrow editor
  toolbar checks click clear of WebKit’s overlay scrollbar while retaining
  selection, keyboard and layout assertions. (#445)

### Issue pipelines

- Keep independent reviews in a named Reviewer tab in the issue session, reuse
  it for later rounds, and review changed heads again when the checkout is
  current and idle. Route author review/merge requests through the pipeline;
  `pipelines merge` preserves person-only, security and check gates. Keep shared
  cloud authors in work claims, and retain commit-specific local-check failures
  until the author reports those checks passing. (#568)

### Changes

- Retain session pull requests across follow-up branches and restarts, including
  PRs created or adopted by the issue pipeline and successful CLI creation
  recorded in session tool journals, including heredoc and Markdown PR bodies.
  Read cloud agent/pipeline associations and landed-work verification from the
  runtime, retaining each repository locator. Enforce workspace session visibility
  and retain cached history and transient branch results on older runtimes. Avoid importing another session’s checkout
  PRs and recognize squash/rebase-landed work. Refresh each saved PR by its
  repository identity, keep open PRs above history, and prevent older merged
  work from offering cleanup while follow-ups or unmerged work remain. (#463)

- Default workspace review to All changes against a displayed merge-base target,
  including committed, uncommitted and untracked files. Remember repository-specific
  scope and target choices, with Uncommitted and turn review available in the same
  panel; keep local and cloud diffs and unavailable states consistent. (#465)

### Stats & Usage

- Refresh usage for non-Git projects without blocking healthy locations, and
  show incomplete worktree discovery, saved refresh time, reporting scope, and
  omitted pricing explicitly. Read configured provider homes and Codex archives;
  reconcile whitespace, streamed copies, model switches and counter resets.
  Price individual requests, include Astra's published rates and Claude's
  one-hour cache writes, and retain recorded usage after transcript or worktree
  removal without keeping prompt contents. Zero-valued counter resets update
  the baseline; retained legacy records with unavailable pricing detail stay
  explicitly unpriced after cache migration. (#602)

### Automations

- Use the shared session launch controls for agent, model, effort and permissions,
  including refreshed model groups and notes. Automation choices stay separate
  from session preferences, retain Default effort and the unattended bypass
  warning, and flag unavailable saved models before saving. Agent discovery
  and model loading fill empty launch settings without clearing a draft. (#553)

### Chats

- Keep initiating text expandable beneath autonomous-turn status, treat unknown
  Claude prompt origins as reader messages, and separate scheduled work from
  unfinished bare slash commands without splitting running work. Preserve
  compaction summaries within their original turn. (#566)

- Order session lists by verified user and assistant message time, retaining
  pins and filters across local and cloud updates and restarts. Metadata
  edits no longer bump conversations; older logs are indexed in background
  batches without treating legacy import times as message times. Title backfill
  preserves message ordering when the app restarts. (#599)

- Keep completed Claude compaction idle instead of raising a false stall
  warning, including manual `/compact` queued behind a running turn. Record
  privacy-safe turn-opener labels in stall diagnostics while retaining warnings
  for real silent turns. (#523)

- Show compact local message times with full dates available by keyboard or
  tap, across local, cloud and mobile chats. Keep source timestamps through
  transcript imports and the first text-chunk time through streaming; omit
  missing or invalid historical times, including legacy records whose saved
  timestamp may be their import time. (#600)
- Hide Retry safely when a model or provider usage allowance is exhausted in
  session recovery, keeping reset information and alternative-model selection
  available. Transient failures still offer retry. (#601)

### Issues

- Signing out drains an active work-status publish before withdrawing this Mac’s
  claims, and prevents further publishing until a new sign-in, including one
  started while the previous logout request is still finishing. (#578)
- Count your known cloud issue authors immediately in work filters and duplicate-start
  warnings, deduplicate arriving account claims, and open an existing cloud author
  from the warning. Preserve live account evidence when deduplicating and keep
  removed authors excluded across pipeline refreshes, even before Issues opens.
  Bound pending-author grace by the actual start. Exclude reviewers and stale
  sessions. Verify signed-in claims and sign-out cleanup in the WebKit work-chip
  scenario. (#572)

- Keep cloud sessions openable when their first prompt fails, with the error
  in their transcript, and stop their issue pipeline and partial agent launch. (#577)
- Require completed workflow and check-suite evidence on the reviewed commit
  before an issue pipeline merges, including queued jobs and pending reruns.
  Missing or unreadable validation no longer passes after a fixed delay.
  Validation reads must agree on workflow attempts and child results, so a
  rerun cannot use an older optional failure to hide a new required failure.
  Repositories without CI must explicitly set `allowNoCi` in their project
  pipeline settings; reported validation and branch protection still apply. (#609)

- Pipeline rows omit only their own author from the work chip, keeping other
  sessions on this Mac and elsewhere visible for cloud and local pipelines. (#571)

- Offer a cloud repository’s Markdown issue templates in the new-issue form,
  read through your own GitHub CLI login without a local checkout. (#575)
- Pipeline reviewers no longer count as another session working on the issue,
  locally or in cloud workspaces, even after their pipeline history is trimmed.
  Existing local reviewer links are removed. New cloud connections read reviewer
  identities separately from the runtime’s limited pipeline list. (#570)
- A cloud issue that cannot start because an agent needs sign-in now offers
  **Open Agent logins** for the failed request’s organization, even if you
  switch projects while it starts. (#573)

### Computer use

- Screen Recording **Grant…** opens System Settings with the helper drag tile
  without also showing a macOS permission prompt. The permission remains
  attributed to TerminalX Computer Use Helper. (#569)

### Development

- Give the permission-probe identity regression more time to start its helper
  on loaded Macs, while keeping the app's five-second timeout and helper
  cleanup unchanged. (#579)
- Pipeline tests keep Claude trust configuration in their temporary home and
  verify the stand-in agent actually launched with the expected session ID. (#576)

### Editor

- Keep Preview / Source and neighbouring toolbar buttons readable in narrow
  editor panes, stepping down to labelled icons as space runs out. Shared
  segmented switches keep equal, content-sized options and aligned thumbs. (#482)

### Cloud runtime

- Public API follow-up messages target the existing eligible session tab instead
  of opening another tab, with unattended permission, sign-in and timeout checks.
  This ships through the separate headless runtime release and requires the
  account service's protocol-3 support. (PRO-40, #589)

### Command line

- Cloud session creation normalizes saved and explicit permission modes just
  like the session picker, so older spellings such as `default` no longer
  cause issue sessions to be refused by the workspace runtime. Unknown explicit
  modes are rejected instead of falling back to bypass permissions. (#574)

## 0.2.17

### Chats

- **Continue in New Session** is back in the title bar, to the right of
  Share, and opens the same continuation dialog as the workspace menu. It
  follows the selected chat and stays reachable in a narrow window. (#591)

### Organizations

- Organization setup now says when new machines are paused and offers
  **Allow new machines**. Allowing them moves setup on to Agent logins
  without needing **Check again**; the compute controls and setup steps
  update each other. (PRO-112)
- Owners and admins see **API keys and webhooks** on each organization's
  settings page. **Manage in the console** opens that organization's page
  in the system browser, without switching the active organization. Needs
  the account service's organization-console redirect. (PRO-40)

### Cloud workspaces

- Your own model access: in Settings → Organizations, each organization's
  page has **Your model access**, where any member can route Claude Code or
  Codex in the cloud workspaces they create through their own LLM gateway or
  model provider (with a credential they store) or through a credential
  helper they manage in the workspace, instead of the organization's login.
  Only what each CLI supports is offered, from the account service's
  versioned template catalog; the credential is entered in a native secure
  dialog, checked from this Mac against the endpoint's model list and never
  shown again. The workspace checks the route too: a helper route is labeled
  user managed until that check passes, a model the endpoint does not list
  is called out with the models it does, and the organization's login is
  never injected beside a route. A stored credential reaches only the
  member's own workspaces that nobody else drives, so those can't be shared
  with Can send until the workspace is restarted after delivery stops.
  **Switch back to the organization login** removes the route for new
  sessions; running sessions keep their launch credentials until restarted. Cursor's CLI supports neither, so it always uses
  the organization's login. Needs the account service's agent model routes
  (terminalx-saas, PRO-18). (PRO-18)
- A cloud session's agent tab shows **Needs sign-in** with a link to its
  organization's Agent logins when the launch has no login. The runtime
  checks the credentials the tab actually started with and refreshes the
  tab list when a sync changes that answer. (PRO-110)

### Command line

- `read`, `send` and `wait` can find a cloud session the CLI just created,
  before it has been opened in the app. They look up its tabs from the
  running workspace, or its saved checkpoints while stopped, without
  waking it; a launch still starting is reported as starting. (PRO-109)
- Cloud `stop` and `resume` report stopping/stopped or resuming/running
  instead of provisioning. They read the server's current state first and
  wait briefly for an opposite operation in progress, so a resume just
  after a stop can proceed. (PRO-113)

### Mobile companion

- Sharing explains when a workspace has received its creator's own model
  credential and cannot yet be shared with Can send. It offers view-only
  sharing or switching the agent's login and restarting the workspace.
  These source changes require a separately updated mobile app.

## 0.2.16

### Issues

- A session started from an issue in a cloud workspace is now carried on
  like one on this computer: a pull request that closes the issue, a review
  by a second session, the findings back to the author, more reviews up to
  the project's limit. The workspace's runtime does this itself, with no
  desktop attached, and is kept awake while it pushes or waits for checks
  (at most an hour for checks). It stops at *Ready to merge*: a cloud
  workspace never merges by itself. **Merge** on the issue page merges from
  this computer with your own `gh`, pinned to the reviewed commit, after
  reading GitHub again, and only a pull request in the project's own
  repository. The Issues view lists a cloud project's GitHub issues beside
  this computer's projects, the issue page shows the pipeline and its record,
  and shows the last one read while the workspace sleeps. A Linear issue
  works too: the workspace has no Linear key, so a desktop with one moves it
  to In Review when it sees the pull request open. The settings are under **Issue pipeline…** in the cloud
  project's menu; `terminalx sessions create --project cloud:… --issue`
  starts one from the command line. A runtime that predates this starts a
  plain session, and the page says so. (#433, #461)
- The Issues list says who already works on an issue, and where: "You · this
  Mac", "You · on *Studio*" for another of your machines, "You · in the
  cloud", and a teammate's name for someone in an organization that
  connected the repository. Hovering shows the session, branch, state and
  when it was last active; work fades after half an hour idle and is gone
  after a day. A filter hides issues someone works on, or shows only yours,
  and starting a session on a taken issue asks first (Start anyway, Open
  the existing session, Cancel). Sessions are linked to their issue from
  their branch name, the pull request they opened or their first prompt,
  and by hand with **Link to issue…**; **Unlink** and **Don't share this
  session** are in the session's menu. Only the issue, the session's title
  and branch, a coarse state and times are shared; Settings → Account turns
  sharing with the team off, and an organization's admins can turn it off
  for everyone on its page in Settings → Organizations, where they also name
  its Linear workspaces. Needs the account service's work-claims routes
  (terminalx-saas `raccoon/441-work-claims`); without them, or signed out,
  the list shows this Mac only. (#441)

### Chats and composer

- A new chat keeps its conversation title, taken from Claude Code's own
  title for it, until the agent creates a real branch; placeholder worktree
  names are no longer shown as the title. The header shows the whole
  branch's added and removed line counts and follows a branch switch. Tool
  groups show an error only when their last call failed. **Continue in New
  Session** moved into the workspace menu, and copy actions in menus use the
  native clipboard, which WebKit refused before. (#584)
- The row of tabs is its own row under the title bar, ended by its **+**,
  with the window's whole width; the title bar names the project and the
  branch, or the chat's title, with the branch's line counts, and keeps
  Share and the other actions at its right edge. Its pipeline and automation
  chips give way to their icons when it is tight, and under 360 px the title
  bar leaves its issue, work, pipeline and automation chips out, as the cloud
  header's chips are. (#584)
- The composer puts the permission mode in its options menu, the mic and
  options on the right, and one button that is **Send** or **Stop**, with
  concentric corner radii. **Latest** sits above the composer and is opaque.
  The usage popover is redesigned. (#584)

### Projects

- A project overview page: stats, contributors with their activity, pull
  requests, branches with ahead/behind counts, the latest commits, and
  actions to start a new chat or a new branch. Projects without chats are
  listed in the sidebar, and only the chevron folds a project, so clicking
  its name opens the overview. (#584)

### Cloud

- The compute provider key dialog names the organization by its name, with
  the id only as a fallback, and the provider by the name Settings shows,
  for example "Local Docker (development)". (PRO-111)

### Command line

- `terminalx` output goes through a writer that reports errors instead of
  panicking, so a reader that closes the pipe early (`| head`) ends the
  output, the command keeps its own exit status, and a release build no
  longer aborts or leaves a macOS crash report. (PRO-108)

## 0.2.15

### Issues

- Post a comment from an issue's detail pane. A comment box sits under the
  thread, with Write/Preview, dictation and `@` mentions of the people the
  assignee picker offers (GitHub inserts `@login`, Linear a profile link it
  turns into a real mention). **Comment** or ⌘/Ctrl+Enter posts; the comment
  shows in the thread as *Sending…* and becomes a normal comment when the
  provider answers. A failed post keeps the text in the thread with the
  reason, **Retry** and **Discard**, and a comment that did land is
  recognised on the re-read so it is never posted twice. Drafts and failed
  posts are kept per issue across switching issues and restarting the app.
  On an open GitHub issue, **Close with comment** posts and then closes; if
  the close fails after the comment went in, **Try closing again** only
  closes. (PRO-94, #542)
- The Issues list has filters and sorting: State, Assignee (anyone, me,
  unassigned or a person), Labels, the Linear team, and Sort, remembered per
  project and provider. They replace the "Assigned to me" toggle. GitHub
  reads the repository's own list with the website's filters, pull requests
  left out; Linear filters, sorts and searches on its side, so closed issues
  past the first page can be found. An edit made in the detail pane updates
  its row at once, and a row that no longer matches the filter stays, dimmed
  with the reason ("Now Closed", "No longer assigned to you"…), until a
  refresh that has the change; a list read older than an edit can't undo it.
  Keyboard, while the Issues view has the focus: Up/Down move through the
  list, `s` opens the status picker, `a` assignees, `l` labels, `c` the
  comment box, all listed in Settings → Shortcuts. (PRO-98, #544)
- **New issue** in the Issues toolbar, or **New issue…** in the command
  palette, creates a GitHub or Linear issue from the detail column: provider
  and target (the project's repository or a Linear team), title and
  description in the Markdown editor, assignees with **Assign to me**,
  labels, and status and priority on Linear. GitHub repositories' issue
  templates fill the description, and the title prefix and labels when
  those are still empty; an edited description is not replaced without
  asking. The new issue is selected and pinned at the top of the list until
  a read includes it, and its detail pane opens with **Start session**. The
  draft is kept per project and provider across Escape, opening another
  issue and restarting, with **Discard draft** to drop it; a failed create
  keeps everything and says why, and a create that timed out after
  succeeding finds the issue it made. ⌘/Ctrl+Enter creates; Enter and IME
  composition never do. The identifier in an issue's header is now a copy
  button. (PRO-99, #543)

### Organizations

- Agent logins are a setting of each organization. Settings → Organizations
  gives every organization you belong to its own page, opened with
  **Settings** on its row; the page names the organization it changes and
  holds its agent logins with its members, compute and other settings. An
  owner or admin sets or replaces another organization's agent logins there
  without switching the active one, and members see each organization's
  status read-only. Settings → Account links to the active organization's
  page instead of holding the section. (PRO-107)
- Organization setup has an **Agent logins** step right after the compute
  connection: Log in with Claude or an API key for Claude Code, Log in with
  ChatGPT or an API key for Codex, an API key for Cursor, or this Mac's
  sign-in lent. **Set up later** skips it, and setup completion then says
  which agents have no login, with the way to the organization's page.
- Every "sign in required" message opens the Agent logins of the
  workspace's own organization, not the active one's.

### Chat

- A turn Claude Code starts by itself — a `/loop` check or scheduled task, a
  background task reporting in, a message from another agent — is a turn in
  the chat: the tab shows the agent working, the turn opens with a line
  saying what started it ("Scheduled check", or the background task's own
  summary) and ends with its own "Worked for …". A message sent while it runs
  is queued behind it and lands after its output, where the terminal shows
  it; it used to be drawn above the output, as though that were its answer. A
  background task's `<task-notification>` is no longer taken for something
  you said. (#540)
- A message sent while the agent is working stays in the chat once the agent
  has taken it. Taken mid-turn, it is drawn as your message at the point the
  agent read it, in the app and on the phone, and a finished turn no longer
  folds it away with the tool calls; it used to vanish when the turn ended.
  **Send now** shows only on a message still waiting behind the running
  turn: the message it sends opens the turn it starts, the rest stay queued
  behind it, and one the agent has already taken is not sent again. (#551)

- A compaction's summary is folded, collapsed, under the **Context
  compacted** line instead of appearing as a huge message you sent. It
  opens no turn and stays out of the composer's history and the last-prompt
  text, including summaries older tab logs stored as prompts. (#524)
- Settings → General has an **Autocorrect** switch, off by default. Off
  leaves what you type exactly as typed in prompts, answers to an agent's
  questions and notes; on, your keyboard's spelling correction, smart quotes
  and dashes, and text replacements apply there as before. The setting
  applies live to every agent-facing field, the typed answer on a question
  card included. (#525)

### Sessions

- **Link to a project** in a chat's menu now opens a dialog before anything
  moves. It shows the project, lets you switch between a new worktree and the
  main checkout, and offers the same agent, model, effort and permission
  pickers as New Session, plus Focused or Full context. They start from the
  chat's own settings, effort included, and any provider can be picked. The
  chat is archived only once the new session has started. If it can't start,
  the chat stays put, the dialog says so, and **Retry Start** reuses the
  session already created. (#555)
- **Continue in New Session** gets the same pickers, starting from the source
  conversation's model, effort and permission mode instead of the last ones
  picked anywhere. Each starting value counts only while it is valid for the
  provider chosen; switching provider falls back to that provider's saved
  choices. (#552)
- New Session and issue starts share one permission picker with each mode's
  hint. Bypass permissions asks first, the same everywhere.

### Cloud workspaces

- Creating a cloud workspace and starting another agent inside one use the
  same launch-settings component as New Session: the cloud agent list,
  model, effort and permission mode, with bypass confirmed once. Effort
  stays valid when the model changes, which fixes the stale effort that
  could be sent before. (#554)

### Mobile companion

- A message sent to the agent from the phone shows once, as the prompt of
  the turn it starts, rather than also as a worktree note. **Send to agent**
  sends the text and its attachments in one request, so a send that fails
  leaves no note behind and a retry sends the message once. **Add worktree
  note** still adds a note and sends nothing to the agent. A note promoted
  to an agent is marked with the tab and message it became, and the phone
  leaves it out of that tab's conversation; the note-plus-prompt pairs saved
  by earlier phones are hidden too (#541).

These source changes require a separately updated mobile app.

## 0.2.14

Issues worked from inside the app: a comment thread, status, assignees,
labels, priority, title and description all editable from the issue detail
pane, and a `terminalx issues` command for agents whose every write is
confirmed first; the cloud sidebar's sections, filter and workspace menus
back in the chat-first sidebar; **Log in with ChatGPT** for Codex in Agent
logins; a tab bar without the session name, its actions pinned right; cloud
sessions that say what happened when a machine never checked in, a provider
is hidden, a workspace is deleted or access is removed; an agent CLI
installed after the fact that is found without a restart; and a phone that
notices a workspace someone else started or stopped.

### Issues

- An issue's comments are a thread in the detail pane, under the
  description: avatar, name, relative time with the exact time on hover,
  "· edited", and the body as Markdown. The most recent 30 are shown and
  **Show earlier comments (N)** uncovers older ones 30 at a time; past 2,000
  comments the oldest are counted and left on the website. **Refresh**
  re-reads the issue and the thread and keeps what is on screen until the
  answer arrives. Your own comments have a **…** menu: edit in place in a
  Write/Preview editor (⌘/Ctrl+Enter saves, Esc cancels, a refused edit
  keeps the draft) or delete after an inline confirmation. The comments
  reach the agent too: the issue prompt gains a **## Comments** section for
  both providers, newest first kept, capped at 12,000 characters with each
  comment clipped at 3,000. On Linear the pane shows the description alone,
  so the pasted comments no longer duplicate the thread. (#529, #534)
- Change an issue's status from the detail header. Linear offers the team's
  workflow states grouped by type in Linear's order, each with its colour
  dot and the current one checked; GitHub offers **Close as completed** and
  **Close as not planned** on an open issue and **Reopen** on a closed one,
  and the trigger reads "Closed as not planned" when the reason is known.
  The header and the list row change at once and the provider's answer
  replaces them; a refusal shows the provider's message and re-reads the
  issue. **Mod+Shift+S**, in a new Issues group in Settings → Shortcuts,
  opens the picker while the pane has focus. While a pipeline on a Linear
  issue has yet to move it to review the picker still works and says the
  pipeline may move the issue when its pull request opens; the pipeline now
  leaves alone an issue someone moved by hand past the review state. (#535)
- "Assigned to …" in the detail header is an assignee picker. On Linear it
  lists the team's members with avatars, **Assign to me** and **Unassign**,
  and a pick replaces the assignee. On GitHub it lists the repository's
  assignable users as checkboxes with **Assign to me** and **Clear**; each
  tick is one write, and past 10 the rest are greyed out with "An issue can
  have up to 10 assignees." Search matches names and logins, current
  assignees are listed first, and only people the provider offers can be
  picked, so **Assign to me** appears only when the provider would accept
  you. A refused write shows its message in the picker and re-reads the
  issue. The header shows every assignee as an avatar stack with all names
  on hover, list rows show the assignee avatars, and a row in **Assigned to
  me** that is assigned away stays until the next read, marked "No longer
  assigned to you". (#532)
- Edit an issue's labels, priority, title and description from the detail
  pane. Labels have a searchable picker with colour dots and multi-select
  that lists the repository's labels on GitHub and the team's on Linear in
  their groups, and sends the whole set once the picker closes. Priority
  (Linear only) offers No priority, Urgent, High, Medium and Low with
  Linear's icons. Click the title to edit it in place: Enter saves, Escape
  cancels. **Edit** on the description opens a Write/Preview Markdown editor
  with **Save** and **Cancel**; when the issue changed meanwhile and only a
  comment or label moved it, the save is retried once, and when the
  description itself changed nothing is written and the pane offers **Show
  their text**, **Copy theirs**, **Start again from theirs** and **Replace
  theirs with mine**. Labels, priority and title update on screen at once
  and roll back with the provider's message if the write fails. Linear rows
  show at once and read the whole issue in the background. (#531)
- GitHub and Linear issues are read and written through one contract.
  GitHub goes through `gh api` with your own login: every assignee is kept,
  a pull request's number is refused, assignees are changed so an issue
  never passes 10, and a label the repository does not have is refused
  instead of quietly created. Linear reads comments oldest first, offers
  labels from the team, its parent teams and the workspace with their
  groups, reads a stale picker id as invalid instead of "couldn't find that
  issue", checks a description for conflicts just before the write, and no
  longer pastes comments into the description; the agent's prompt for a
  Linear issue carries the newest 50 comments under the description, capped
  at about 12,000 characters with a link to the rest. Failures carry a fixed
  message per kind, so no token or provider reply can reach the screen.
  (#526, #533, #534)
- Agents running inside TerminalX read and update the issue they work on
  with the app's own credentials: `terminalx issues view` (with
  `--comments`), `comment`, `status`, `assign`, `label` and `create`, each
  with `--json`. `#123`, `PRO-42` and GitHub or Linear URLs all name an
  issue, and `--project` defaults to the calling session's project or the
  working directory. `--to STATE` must match exactly one state ignoring
  case, else the error lists the valid states; people and labels follow the
  same rule, never a guess. Every write is asked for in the same native
  question the cloud CLI uses, whoever runs the command: **Refuse** is the
  default, the question expires after 40 seconds, and it backs off after a
  refusal. (#528)

### Cloud sidebar

- Everything the cloud tree had is back in the chat-first sidebar, in its
  look. The organization header has **⋯** (refresh, **New section**, **New
  cloud workspace…**, **Hide organization**; also on right-click), **+**
  for **From repository…** and **New project…**, a running-slots chip, and
  Loading, failed and **Offline · last known HH:MM** lines each with
  **Retry**, plus **Switch** for an organization that is not live. Personal
  sections are folding rows inside the organization: create, rename (menu,
  F2 or double-click), move up and down, delete, and **Move to section** ▸
  on a project. A project's **⋯** has new session, pin, refresh, diagnostics
  and the workspace lifecycle (stop, resume, archive, unarchive, delete),
  one submenu per workspace when there are several; a project with several
  workspaces names each on its own row with its state ("Stopped",
  "Resuming", …) and its own **⋯**, and a lone workspace's state shows on
  the project row. Archived workspaces, the Unread / Needs you filter, the
  notice for a workspace deleted elsewhere, the "N organizations hidden"
  line and the session menu are back too. (#491)
- A running cloud session shows its Working mark in the sidebar, taken from
  the same reading the Dashboard and the filter use, and a stopped
  workspace's sessions are never marked Working. A workspace nobody has
  opened offers **Open to load sessions** to admins as it did to members,
  and once connected its sessions reach the sidebar, the Dashboard and
  Search. **+** on a cloud project no longer offers to create another
  workspace when one is Ready but its first prompt once failed, as long as
  an agent has run there since. After a relaunch the selected cloud session
  and its unsent draft come back. (#508)
- A workspace whose first prompt failed on a broken agent login no longer
  reads "Needs attention" for good: once a session with a tab exists there,
  or its runtime reports a turn or approval, the failure is history in the
  sidebar rows, the Dashboard, the workspace header and a project's
  only-workspace row. A workspace the server flags as needing attention
  still says so. (#505, #521)

### Cloud workspaces

- A create whose machine never checks in now says so: "The workspace's
  machine did not finish setting up in time, so it was deleted at the
  provider. Create the workspace again.", with **Create another** instead of
  Retry. Needs the matching terminalx-saas release, which gives up on the
  create and deletes the machine. (#489)
- Machine0 is hidden unless the server offers it: the new-workspace pickers
  never list it, provider and environment settings list it only while the
  organization is still connected to it so an admin can disconnect, and
  Compute settings show its row only while a policy already limits it.
  Existing Machine0 workspaces still list, open and delete. A provider the
  server hides reads "This provider isn't offered right now. Choose another
  provider." on a create, and settings say a saved connection can still be
  disconnected, instead of an unavailable error or a retry for a create the
  server refused. The server half is in terminalx-saas. (#490, #494)
- A cloud workspace that refuses a new session shows the runtime's own
  reason, such as "Claude Code is not installed in this workspace", instead
  of "The workspace could not be created (unavailable)"; a refusal whose
  message is not text reads as its code. The missing agent CLI on Hetzner
  is fixed in terminalx-saas. (#492, #495)
- A workspace whose access was removed no longer reconnects forever from
  the workspace view: it shows "Your access to this workspace was removed."
  with **Back** and **Check again**, closes the connection and updates the
  sidebar row, and reopens only when the list grants a role again. (#504)
- A session open on a workspace that was deleted, here or elsewhere, shows
  "This cloud workspace was deleted" with **Back**, instead of "Loading the
  session…" under a "Development runtime" chip. The side panel says open
  previews ended with it and nothing reconnects. (#511)
- A local mirror cut off by a quit resumes after a relaunch: the app follows
  cloud connections from launch, with the sidebar hidden or Settings open
  too, instead of staying at "Mirror paused: the workspace is not
  connected" until the mirror is turned off and on. (#503)
- The Share dialog reads the organization's members again every time it
  opens, so someone removed from the organization is no longer offered. A
  share refused because the person left re-reads the shares and members,
  drops their stale row and clears the **Add person** picker. (#506)
- The organization list is read again about every minute while the window
  is visible and someone is signed in, and when a hidden window is shown
  again, so being added back to an organization shows within a minute
  instead of on the next focus or token rotation. (#518)

### Agent logins and CLIs

- Settings → Account → Agent logins offers Codex the same ways to connect
  as Claude Code. **Log in with ChatGPT** runs Codex's own device-code login
  in a private throwaway home, so neither `~/.codex` nor an `OPENAI_API_KEY`
  reaches it. The dialog shows the one-time code large and copyable, with
  **Open the ChatGPT page and copy the code**, **Copy code**, a link to the
  page the CLI printed, a live status line, **Cancel** and **Get a new
  code** after an expiry. Once signed in, the credentials are uploaded to
  the account service, which alone holds and renews the refresh token, and
  the row shows the ChatGPT account. The code is never logged or sent to
  the account service, and the CLI is stopped on cancel or quit. (#483)
- **Lend this Mac's Codex sign-in** lends the access token, ID token and
  account id from `$CODEX_HOME/auth.json`, never the refresh token, with
  the same confirmation as the Claude Code lend. An API key kept there is
  refused (connect it as an API key), and a login Codex keeps in the
  Keychain shows as not found. A departed admin's Codex login says "log in
  with ChatGPT again". (#483)
- Quitting during a Codex login waits until the login CLI is gone before
  wiping its throwaway home, so the refresh token never survives a quit.
  (#509)
- A Claude Code or Codex installed while the app or a cloud runtime is
  running is found within seconds, without Settings' Re-check or a resume:
  a missing CLI is looked for again after two seconds instead of being
  believed missing for the life of the process. The runtime part needs a
  runtime release. (#496, #520)

### Tab bar and menus

- The session's name and branch are gone from the tab bar; both stay in the
  sidebar, and a tab's hover names its session when the workspace has
  several. **Share**, new chat, the chat/terminal switch and the side panel
  button sit at the right edge at every width, with the empty room between
  the **+** and the actions still dragging the window. (#477, #487)
- A menu or submenu that has to shift to fit stays 8 px inside the window's
  edges, so a tall workspace submenu no longer ends half a pixel past the
  bottom. (#522)

### Workspaces

- Deleting a workspace once its pull request merges now works for a workspace
  that has been built. SwiftPM's `.build` is known build output, and a
  repository can list its own regenerable ignored paths (generated code, a
  downloaded sidecar) in `.terminalx/cleanup` on its default branch; this
  repository lists `src-tauri/gen/schemas/` and its agent-browser sidecar. An ignored
  file nobody listed, such as `.env`, still keeps the workspace. A newly
  merged workspace that is kept says so in a notice with the full reason, and
  its row's **Why** shows that reason in full. (#476)

### Reliability

- An agent-browser call that passes input while a terminal or CLI is being
  started no longer hangs: the input goes through a file instead of a pipe
  whose write end a child spawned at the same moment could inherit. (#510)
- Debug builds no longer contact the production pairing relay; release
  builds are unchanged. (#493, #519)

### Mobile companion

- The phone notices a workspace someone else started or stopped: the
  workspace list is read every 15 seconds while a workspace screen or the
  Cloud list is open, so an open workspace goes Live within one read instead
  of staying on "Stopped. Showing the saved conversation; nothing is
  running." Nothing is read in the background. (#500, #507)
- The Sharing screen reads the organization's members afresh every time it
  opens, so someone removed from the organization is no longer offered, and
  a refused change for someone who left re-reads both lists and drops their
  row. (#501, #506)
- "No conversation yet" and "Not readable on this phone yet" are drawn
  upright instead of upside down. (#512, #515)

These source changes require a separately updated mobile app.

## 0.2.13

A chat-first sidebar with a flat chat list, folding projects and one title
bar; TerminalX's own icon set; prompt delivery that is confirmed instead of
doubted; the GitHub account a project pushes as; Screen Recording granted to
the computer-use helper itself; the Ports panel reachable from a cloud
session; the price before a workspace is created; sharing refusals that say
why; and a runtime that gives a participant nothing before its role is known.
The sidebar's cloud organizations are back as sections after Local, each
listing its cloud projects and their sessions.

### Sidebar and chats

- Start a chat without a project. **New chat** runs the agent in a Chats
  folder the app owns, in place, and never registers it as a project. Chats
  lead the sidebar as one row that folds to the latest chat. (#484)
- A second sidebar layout lists every chat flat, as a messenger does, with
  the project and branch as the subtitle and a drawn bot face per chat that
  moves while the chat is working. The project view stays the default. Both
  layouts share one title bar: hide, group by project, search and new chat.
  The workspace tree layout is gone, the sidebar can be dragged wider, and
  Skills and Usage moved from the sidebar into Settings. (#484)
- In the project view a project folds its branches away from its row, and
  a branch row offers a new session where the branch is checked out, or a
  new workspace branched from it when it is checked out nowhere. A chat's
  state sits at the end of its row, where a working chat shows three bars
  rising and falling in turn. (#484)
- A chat links itself to the folder its agent works in, read off each tool
  call, and registers the repository as a project when needed. A repository
  with no project files at its root that tracks nothing under the folder
  does not own the work, so a stray `git init` in a parent folder no longer
  files a chat under that folder. **Move to a project** starts the same
  agent in the project, in place or on a new worktree branch, hands it the
  chat, and archives the chat. (#484)
- The header leads with the GitHub mark, which names on hover the account
  the project pushes as, asked from inside the folder over SSH with the gh
  CLI's active account as the fallback, and reads project / branch. Project
  rows wear the picture of the repository's owner until a logo is chosen.
  (#484)
- A request Claude Code refuses on the plan's usage limit says which window
  ran out and when it resets, with a countdown, and offers another model,
  instead of a generic error with a retry that could only fail again.
  Attachments show when `TERMINALX_HOME` points at another data folder.
  (#484)

- The cloud organizations follow the local projects in both layouts, each
  a section named after it: a row per cloud project that folds to its
  sessions, a repository with several workspaces naming each workspace over
  its sessions, **+** on a project starting a session there, and the local
  projects labelled **Local** once an organization is listed. A cloud
  session is also started from the new chat screen's project picker or the
  command palette, which offers **New cloud workspace…** and **Go to cloud
  session…** too. (#486)
- Gone with the tree: the sidebar's unread and needs-you filter, archived
  cloud workspaces, personal sections and the in-sidebar tab rows. A cloud
  session's tabs are switched with the tab shortcuts. (#484)
- Beside the tabs, the branch crumb keeps its icon and about its first ten
  characters when the tabs press on it, instead of folding to nothing.
  (#485)

### Icons

- TerminalX has an icon set of its own: 747 glyphs on a 16-unit grid with
  one 1.25 stroke, covering every icon the app uses and every name in
  Cursor's icon picker, so a project can wear any of them. Brand marks come
  from Simple Icons; the few no open library carries get neutral stand-ins.
  (#484)

### Prompt delivery

- "Prompt delivery could not be confirmed" no longer appears for prompts
  that were taken. A prompt ending in an `@path` mention or a backslash is
  padded so the Enter sends it instead of picking a file or adding a line
  break, an Enter left unacknowledged for four seconds is written once more
  while the CLI is asking nothing, and image labels are matched the way
  Claude Code numbers them across the session. (#484)
- **Send now** on a message queued behind a running turn interrupts the turn
  and types the held text once the CLI reports the turn over. (#484)
- A prompt typed in the terminal after a slash command that never ended
  (`/help`, `/model`) counts its own "Worked for" time instead of the time
  since the command, and a composer prompt is no longer shown as queued
  behind a bare command. (#474)

### Cloud workspaces

- **Ports** is a tab in a cloud session's side panel, next to Changes, Repo,
  PR and Files, and **Ports and previews** in the New tab menu and the
  workspace menu opens it. The panel says "Looking for ports…" until the
  runtime first answers and reads the list every two seconds; connecting,
  reconnecting, restarting and update-needed each have their own text; a
  preview that closed with its connection is marked expired, struck through,
  with **Start again**. **Start preview** only forwards the port and shows
  its address: the browser opens only from **Open in browser**, and there is
  a **Copy** button. (#470)
- Search lists local and cloud project rows, each labelled with where it
  is. Personal sections for an organization's projects were also written,
  but the sidebar does not draw them in this release. (#469)
- Settings → Account opens on the provider the organization connected, and
  **New cloud workspace** shows the machine and its price first; only
  **Create workspace** under the price creates. (#473)
- A second person opening a cloud session sees "Loading the conversation…"
  instead of "Nothing here yet", the New tab hint for a driver reads as a
  sentence, and refused commands stay in a bar of their own instead of
  overlapping the transcript. (#471)
- A refused share change says why: can send is not available while the
  organization has an agent login that only owners and admins may use.
  People who always have access are not offered, and the desktop passes the
  server's reason through instead of reading it as unavailable. (#472, #479)
- A scheduled task paused for an approval nobody could give no longer offers
  **Resume**, and says why; it can still be deleted. (#468)
- The runtime refuses a participant everything until it knows the member
  list, instead of serving files, Git and terminal output in the window
  after a restart. The runtime part needs a runtime release. (#475, #478)

### Computer use

- The computer-use helper runs from a copy outside TerminalX.app, under
  Application Support, so macOS charges Screen Recording to the helper
  itself and not to TerminalX: the prompt names the helper, its row is the
  one consulted, and TerminalX needs no Screen Recording of its own. Only
  the helper the app shipped with may run: before every start, and again on
  its socket, the running code's signature is checked against the bundled
  helper's exact build, and a copy that differs is stopped before its first
  instruction. Reset re-registers the bundled helper, and the Grant window
  offers only the bundled helper to drag into System Settings. (#481)

### Mobile companion

These source changes require a separately updated mobile app.

- A conversation opens at its newest message, and the back button reads
  "Cloud". (#472)
- **Add someone** leaves out owners, admins, the workspace's creator and
  yourself, and a refused share says why. (#472)
- The connection banner follows your role: "No access" when the workspace
  is not shared with you, "Checking your access…" until the runtime knows,
  and Live only with a role. Nothing is asked of a runtime before the role
  is known. (#475, #478)

## 0.2.12

A browser-style tab strip in the title bar, workspaces that remove themselves
once their pull request is merged, issue pages that stay reachable after the
merge, Stop from a guest or the phone that interrupts instead of ending the
agent, and cloud mirror and agent login fixes.

### Tabs

- A session's tabs are a row in the title bar, as in a browser: one tab per
  agent, terminal and browser page, each with its icon, a shortened title
  and its state (working, waiting, an unread reply, exited). Click to
  switch, middle-click or the close button to close, and the "+" at the end
  of the row opens a new tab. Hover a tab, or move the keyboard focus to it,
  for its full title, its agent and its state. Settings → General has "Tabs
  in the title bar" to turn the row off and keep tabs in the sidebar only.
  (#438)
- The row is the workspace's: when several sessions share a worktree, all
  their tabs are in it, in one flat row, and opening a tab opens its session
  too. A tab of another workspace is never in it. (#438)
- A tab in the row is what runs in its terminal, as its sidebar row is: an
  agent's mark, name and state while one runs there, a terminal when none
  does, with the menu items that apply to what it is now. A terminal an
  agent is started in stays where you put it, with its pin, its mute and the
  name you gave it, and a name you give a tab is kept whatever comes to run
  in it. (#438)
- Tabs share the width and shrink evenly; when they no longer fit, the row
  scrolls and a menu at its end lists every tab by its full title. The
  session's name and its chips give way to the tabs in a narrow window, and
  the header's own buttons are never covered. Empty title bar still drags
  the window; a tab does not. (#438)
- Drag a tab to move it. The order is one order for the workspace, saved
  with the sessions: the sidebar, next and previous tab and the numbered
  shortcuts follow it, it survives a restart, and the CLI and a paired
  phone list a session's tabs in it. "Move tab left" and "Move tab right"
  do the same from the keyboard. (#438)
- New shortcuts, all remappable in Settings → Shortcuts: the main modifier
  and 1 to 8 switch to that tab, 9 to the last one, from the composer and
  from a terminal as well; move tab left and right; and reopen closed tab.
  (#438)
- Right-click a tab, in the row or in the sidebar, for everything that can
  be done to it: rename it, switch it between chat and terminal view,
  duplicate it, fork its conversation, open it in the floating window,
  reload or restart it, copy its title, folder, conversation id or address,
  pin it (pinned tabs stay at the left as an icon), mute its notifications,
  move it, act on its session, and open a new tab right after it. (#438)
- Close other tabs, tabs to the right, tabs to the left, idle tabs or all
  tabs from the same menu. Each says how many tabs it will close first, and
  names any with an agent working or waiting, a terminal in the middle of a
  command or a draft not sent, with the choice to close only the idle ones.
  Pinned tabs are left open unless you include them. (#438)
- A closed agent tab keeps its conversation, and "Reopen closed tab" brings
  the last closed tab back where it was: an agent with its conversation, a
  browser page at its address. (#438)
- Closing the last agent tab of a session no longer takes you off the
  terminal or page you were on, or opens a shell you did not ask for.
  (#438)

### Workspaces that go once their pull request is merged

- A new setting, off unless you turn it on: **Delete the workspace when its
  pull request is merged** (Settings → Storage). It has a default for every
  project, and each Git project and cloud workspace can answer for itself.
  When it is on and a workspace's pull request shows as merged, the worktree
  is removed with its local branch, and with its branch on the remote while
  that still points at the commit that was merged. Its conversations are
  kept, filed under the project as from a removed workspace; deleting them
  too is a separate switch, also off. (#432)
- Nothing is forced, and no work is lost. The workspace goes through the same
  checks and the same removal as the Delete workspace dialog and the worktree
  clean-up: one with uncommitted work, commits that are not merged, ignored
  local files other than build output, a Git operation in progress, a turn
  running or a terminal open stays, and its row in the sidebar says why
  ("kept: 2 uncommitted files"). Squash and rebase merges are recognised. A
  remote branch that has moved since the merge is kept, and that is said; a
  remote that cannot be reached leaves its branch and does not hold up the
  rest. An agent that sits idle at its prompt does not keep a workspace: it
  is stopped, as the dialog stops it. One you started by hand in a terminal
  does keep it, and so does a tab that is a terminal now. (#432)
- It waits first: 10 minutes by default (5 minutes to 1 hour), counted from
  when the merge is first seen and from the last thing done in the
  workspace's sessions. A notice says the workspace will go and offers
  **Keep workspace**; the row offers Keep too. After a removal a notice
  offers **Undo**, which puts back the worktree, its branch, the branch on
  the remote and the sessions that have not been used since. The grace
  period runs only while the app is running, so nothing goes the moment the
  app is opened again. A pull request merged in TerminalX, from the pull
  request panel or by an issue's pipeline, is seen at once. (#432)
- Every removal is recorded with its workspace, branch, commit and pull
  request, and listed in Settings → Storage with **Restore** for as long as
  its commit is still in the repository. (#432)
- It never applies to a project's main directory, a worktree TerminalX did
  not create, or a pull request that was closed without merging. For a cloud
  workspace it runs on the workspace's own runtime, only for a manager and
  only while the workspace is connected; a runtime from before this needs a
  restart to offer it (`workspace/2`). (#432)
- For a project the setting is on for, Settings also offers to turn on
  GitHub's own "Automatically delete head branches" when you administer the
  repository, which covers pull requests merged while TerminalX is closed.
  (#432)

### Issues

- An issue stays in the Issues view after its pull request is merged. The
  merge closes the issue and the list holds open ones only, so its page, with
  the record of every stage, verdict and merge, could no longer be reached in
  the app. Issues with a pipeline that the list does not hold are now shown
  below it, under **Pipelines on issues not listed above**, and the open
  issue's page says *Closed* once the merge has closed it. (#433)
- **Refresh** in the Issues view reads the open issue again too, and keeps
  its page as it is until the answer comes. (#433)

### Stop from a guest or the phone interrupts too

- A guest's Stop in a shared session no longer ends the host's agent and puts
  "Session closed" over the host's tab. It interrupts the running turn, as the
  host's own Stop does; if the agent does not answer, the same button becomes
  "Stop session" and ends the process. What guests queued behind the turn is
  kept and goes out when the interrupted turn has ended. (#427)
- A guest's Steer no longer stops the host's agent and starts it again. The
  turn is interrupted and the steering prompt is the next message, to the
  same process, ahead of anything already waiting.
- A guest's queued follow-up is no longer dropped when its turn ends within a
  quarter of a second of that guest's last action.
- On the phone, Stop in a cloud workspace interrupts the running turn instead
  of ending the agent's process; pressed again while that turn is still
  running, it stops the session. A workspace on a runtime from before the
  interrupt keeps the old Stop.

### Cloud

- Local mirror: "Discard my changes" (and "Keep a copy, then discard") now
  puts the workspace's files back right away, and reads "Files synced" only
  once they are back. With an unchanged workspace it used to say "Files
  synced" at once and leave the discarded edits on disk until the workspace
  next changed. (#451)
- Settings → Account → Agent logins now flags a login whose configurer is no
  longer an owner or admin of the organization, and says that logging in
  again takes it over. A member sees, per agent, whether a login their
  workspaces can use is connected. The text about Disconnect matches what
  the service does: it reaches running workspaces too. A first prompt
  refused for lack of a login says which cases it can be and opens the
  desktop's Agent logins instead of pointing at the web console. (#450)

### Mobile companion

These source changes require a separately updated mobile app.

- The phone's Stop in a cloud workspace interrupts the running turn instead
  of ending the agent's process; pressed again on the same turn, it stops the
  session. (#427, #456)

## 0.2.11

Issue sessions that carry through a pull request, review and optional merge;
tabs that follow what runs in their terminal; Escape that interrupts instead
of killing the agent; dictation that respects edits; live clean-up progress;
scheduled tasks and an environment section for cloud workspaces; and cloud
terminal, login and mobile fixes.

### Issues

- A session started from a GitHub or Linear issue no longer stops at the
  code. When the agent reports the work done and its checks passing,
  TerminalX opens a pull request that closes the issue, has a second session
  that did not write the code review it, takes the findings back to the first
  session, and has the new commit reviewed again, up to three times. The
  issue's page shows the stage it is at, the open findings, and a record of
  every stage, verdict and merge with links to the sessions and the pull
  request. A Linear issue is moved to In Review when its pull request opens.
  (#433)
- It ends at *Ready to merge* unless **Merge automatically when the review is
  addressed** is on for the issue. With it on, TerminalX merges only at the
  exact commit the reviewer approved, with no finding of medium severity or
  higher open, its checks passed, no conflicts, and nothing in a category the
  project keeps for a person (database migrations, deploy configuration,
  anything the security pass flagged). Otherwise the page says *Ready to
  merge* or *Needs you*, and why. The merge uses your own `gh` credentials
  and never bypasses branch protection. (#433)
- Each project has its own settings under **Issue pipeline…** in its menu:
  whether the pipeline runs at all, what the switch starts at, whether a
  person always does the merge, the number of review rounds, the merge
  method, and what is always left for a person. (#433)
- `terminalx sessions create --issue <issue>` starts a session from an issue,
  and `terminalx pipelines` lists and steers the pipelines. (#433)
- With a session already on an issue, **Open session** and **Start session**
  no longer cover the worktree choice in a narrow window. (#433)

This covers workspaces on this computer. See
[docs/ISSUE-PIPELINE.md](docs/ISSUE-PIPELINE.md).

### Tabs follow their terminal

- A tab is now what runs in its terminal. Type `claude` or `codex` into a
  plain terminal and its sidebar row becomes that agent's tab, with its
  status and a chat that shows the conversation from its first turn. Exit
  the agent and the row is a terminal again. Start another agent there and
  the same tab is that agent's. The tab keeps its place, its selection and
  any name you gave it throughout. (#437)
- The same goes for a tab created as an agent tab: exiting its CLI from the
  terminal view leaves a shell in the same terminal, and the tab is a
  terminal until an agent is started in it. (#437)
- Exiting an agent is not an error. There is no "needs attention", no
  recovery banner and no "Resume safely"; a turn that was cut short is
  marked as interrupted, with one line saying so. (#437)
- A tab keeps every conversation it has held. The chat shows the current
  one; earlier ones are under **Conversations**, and a terminal's last
  conversation can be resumed in place with **Resume here**. Starting an
  agent by hand on a conversation the tab already holds (`claude --resume`,
  `claude -c`, `codex resume`) picks it up instead of opening a second copy.
  (#437)
- Sending from the chat types into an agent you started by hand, as it does
  for one the app started. What would need that agent restarted (its
  permission mode, and for Codex its model and effort) is disabled there and
  says why. (#437)
- Cursor and OpenCode started in a terminal are shown on the terminal's row
  by their mark; they have no chat. Cloud workspaces do not follow their
  terminals yet. See [docs/TABS-FOLLOW-TERMINAL.md](docs/TABS-FOLLOW-TERMINAL.md).
  (#437)

### Escape interrupts the agent instead of ending it

- Pressing Escape while an agent works no longer kills the agent and puts
  "Session closed … Resume safely" over the tab. Escape is the agent's own
  key. In the terminal view (local and cloud) it is typed into the agent's
  screen like every other key, so it also closes the agent's menus and leaves
  its modes; an Escape typed in any terminal is never taken by a shortcut. In
  the chat it interrupts the running turn: the turn shows as "Stopped", the
  agent's process stays, and the next message goes to it without a restart.
  With nothing running, Escape does nothing. Dialogs, menus, pickers and the
  editor still get the key first. (#427)
- Queued follow-ups survive Escape. Claude Code and Codex keep their own
  queue and, interrupted with a message queued, send it at once as the next
  turn; the chat now shows that as the queued message becoming the next
  prompt rather than drawing it twice. For agents with no queue of their own
  the app's is kept, and the next message starts when the interrupted turn
  has ended. A request the turn was waiting on (a permission or a question)
  is withdrawn with it, so nothing you were still deciding about runs.
- Stopping the session is now a separate, explicit action: "Stop session" in
  the terminal view and on the recovery banner, and "Stop the session" in
  Settings → Shortcuts, which has no keys until you give it some (never a bare
  Escape). The composer's Stop interrupts first; if the agent does not answer,
  the same button becomes "Stop session" and ends the process. Only that
  shows the "Session closed" banner.
- If you had moved "Stop the running turn" to other keys, they now interrupt
  (that is what stopping a turn does now), and Escape stays free if you had
  taken the action off it.
- Cloud tabs: Escape in the chat is sent to the runtime as a live interrupt
  (`session/3`), for whoever may stop the tab. A workspace whose runtime is
  older than this leaves the key alone until it is updated; its Stop works as
  before.
- The same holds for the agents that are driven without a terminal, checked
  against the real ones. On an OpenCode tab the first message no longer fails
  with "The connection was lost" (it was sent before OpenCode had started),
  the reply no longer begins with your own prompt, and a message queued
  behind a turn is no longer cut short the moment it starts.

### Dictation

- Text deleted from the composer while dictating stays deleted. Selecting
  dictated words and pressing Backspace or Delete, or cutting them, used to
  look as if nothing had happened: dictation wrote the words straight back,
  and went on doing so after the mic had closed. Whatever is typed, deleted,
  cut, pasted or undone in the composer now wins, with the mic toggled on or
  a key held to talk; dictation carries on from the caret with what is said
  next. (#428)
- A dictated message no longer comes back into the composer after it is
  sent. (#428)
- An edit made before the first words arrive is kept. With a local model,
  whose words all arrive when the mic closes, it used to be overwritten.
  (#428)
- When an utterance settles after an edit (a comma added, a word corrected),
  words already in the draft or already deleted are not added again, and no
  stray piece of a word is left behind. (#428)
- A composer stops following the recogniser once its own dictation has
  ended, so a later dictation in the other window (main or floating) cannot
  add its words to it as well. (#428)

### Cleaning up worktrees and leftovers

- Removing worktrees ("Clean up worktrees…") now shows how far it is. After
  the removal is confirmed the dialog has a progress bar and "N of M
  worktrees done", the space freed so far against what the review measured
  ("3.2 GB of about 11 GB", or "at least" when some sizes were never
  measured), the worktree being handled with its host and the step it is on
  (measuring, checking it again, removing, updating sessions), and each
  worktree's outcome as soon as it is known. On this computer the counter
  used to stay at "0 of N" until every worktree was done. When it finishes,
  the same view is the result. (#426)
- The dialog can be hidden while it runs, with Hide, Escape or the close
  button. The clean-up carries on and the app stays usable. A small indicator
  in the bottom-right corner then shows "Cleaning up 4 of 12" and the space
  freed, sits below any notices and above the composer so a message can still
  be written and sent, and opens the dialog again when it is clicked or
  reached with the keyboard. If the run finishes while hidden the indicator
  becomes its summary: one where everything was removed goes away by itself;
  one with anything skipped, failed or not known stays until it is dismissed
  or read. (#426)
- Only one clean-up runs at a time: "Clean up worktrees…" during a run opens
  that run instead of starting a new scan. Stop lets the worktree being
  removed finish and leaves the rest, reported as "Not attempted"; it never
  interrupts a removal half way. Hiding and stopping change nothing about
  what is removed: each worktree is still checked again on its own machine
  first, and git is never forced. (#426)
- A worktree whose size the review already measured is no longer measured a
  second time before it is removed. Its figure is then shown as "about";
  one that was never measured is still measured, and shown exactly. (#426)
- Deleting leftovers in Settings → Storage has the same treatment. It used
  to show only a spinner on "Scan again" for the whole deletion; it now says
  that everything is being checked again, then which leftover is being
  deleted, how many are done and what was freed. It carries on when Settings
  is left, with the same corner indicator leading back to Storage. (#426)
- Quitting while a clean-up or a deletion of leftovers is running now asks
  first: from the Quit menu item and ⌘Q, the tray's Quit and the main
  window's close button. Quitting from the Dock, logging out and shutting
  down cannot be asked about and end the app as before. (#426)

### Cloud workspaces

- Scheduled tasks. On a server that has them turned on, an organization's
  owners and admins find "Scheduled tasks…" in a cloud workspace's menu: a
  task wakes the workspace at set times and sends one prompt to an agent.
  The dialog shows what a task costs before it is saved (each run, a month,
  and the limit of 24 runs in 24 hours), how its last run went, and lets
  them pause, resume or delete it, or pause every task of the organization.
  A scheduled agent never starts in bypass permissions. (PRO-37)
- Settings → Account gains a **Cloud environment** section for the
  organization's provider template: the machine install script and each
  repository's setup, with revisions, a confirmed Build, the versions with
  their state, log, cancel, retry and roll back, and recipe results labelled
  as observed by TerminalX or reported by the agent. Members see the active
  version only. A save names the revision it started from, so a draft cannot
  overwrite someone else's save. (PRO-20, #442)
- **Configure with an agent…** in that section, for owners and admins on a
  server that offers recipes, asks first with the price and limits, starts a
  private preparation workspace with a fixed first prompt, verifies the
  agent's recipe itself in fresh clones (machine script, setup, lint, test,
  build and start), stops the machine, and shows the proposal to save as a
  recipe. It needs a server with preparation workspaces; without one the
  create is refused and nothing starts. (PRO-20, #446)
- A line typed into a cloud tab's terminal view just after a wake is no longer
  lost without a word. The runtime answers a tab's slash-command list from its
  own task so it no longer holds up the terminal, a cloud tab that is not on
  screen does not ask for the list, the view says "Connecting to the agent's
  terminal" while the attach is unanswered and tells you when a key was
  dropped, and a replaced attach no longer prints the history again. The
  runtime part needs a runtime release. (#449, #455)
- The provider connection in Settings loads once when it opens, not twice,
  so the controls no longer flash and a click in the gap is not lost. (#444)
- Agent logins: every native dialog says when it replaces the login stored
  for the agent, an open sign-in can choose Replace if someone else stores a
  login meanwhile, and logging in again no longer widens a login an admin had
  narrowed to managers; the dialogs say who the stored login reaches. (PRO-79,
  #429, #435)
- A command refused because the workspace is stopped is resent under the same
  command id once you agree to wake it, from the CLI and the phone. (PRO-89,
  #430)

### Mobile companion

These source changes require a separately updated mobile app.

- A cloud session comes back to Live after the app was in the background or
  the workspace was stopped and started, instead of staying on "waiting for
  the runtime". (#448, #454)
- The phone asks before waking a workspace for a command the server already
  holds, and resends a refused command under its original id. (PRO-89, #430)

## 0.2.10

Dialogs that keep their buttons in reach, and cloud workspaces that stay awake
through a silent turn and follow role changes.

### Dialogs with long lists

- A dialog can no longer grow past the window and take its buttons out of
  reach. Deleting many leftovers in Settings → Storage now asks in the app
  instead of in a system alert that listed every item and ran off the screen:
  the list scrolls on its own, each item shows its project and size, and
  Cancel and Delete stay in view. Cancel holds the focus, so Enter does not
  delete. What can be deleted, and the check made before each deletion, are
  unchanged. (#424)
- The worktree clean-up keeps its buttons in view the same way in short
  windows, in its list, its review and its results, and every other dialog
  now ends at the window's edge and scrolls if it is taller. (#424)

### Cloud workspaces

- A cloud turn that has been silent for five minutes is still shown as "Needs
  attention", but it no longer lets the workspace suspend underneath it. The
  turn keeps the workspace awake for up to an hour without agent events or
  terminal output; new output renews that hour. After an hour of silence the
  runtime reports the turn as inactive and the workspace may suspend under its
  idle policy; the agent is not killed and the turn is not marked complete.
  (#422)
- A connected user who changes role is counted correctly for idle suspension:
  a driver demoted to viewer stops holding the workspace awake, and a viewer
  promoted to driver starts holding it without reconnecting. Phones are still
  not counted, and revoking access or the first member list revalidates the
  connections already open. (#423)
- A line typed into a cloud agent tab's terminal view in the first seconds
  after a wake is no longer lost without a word. With another tab of the
  session left in chat, that tab asked the runtime for its slash commands on
  every connect; the runtime answered nothing else until the tab's CLI had
  answered (15 seconds when it never did), so the terminal was not attached
  yet while the view already read "Idle", and keys typed then were dropped.
  The runtime now answers the command list apart from everything else, a
  tab that is not on screen no longer asks for it, and while the terminal is
  still connecting the view says so, and says when something typed was not
  sent. Needs the next runtime release for the first part; the rest is in
  the desktop. (#449)
- Opening a cloud agent tab's terminal view no longer prints its history
  more than once when the view was left and shown again before the runtime
  had answered. (#449)

## 0.2.9

A start screen and floating quick chats, chat settings that follow the agent
CLI, link sharing for local sessions, bulk worktree clean-up, a renamed
computer-use helper, and mobile pairing and transcript fixes.

### Start and chat

- A first-run start screen offers Open local project, Open GitHub project and
  Quick start. Its dialogs fit a short window, and a failed clone leaves a
  tidy folder. (#405, #410)
- A floating chat window and quick chats that need no project. (#408)
- Chat prompts are submitted only after the CLI has read them, and
  unacknowledged prompts are flagged. The chat's model, reasoning effort and
  permission mode stay in step with the agent CLI. (#416, #418, #421)
- A failed tool in a running turn no longer raises "Needs attention", and
  Delete workspace appears in the chat once the session's pull request is
  merged. (#413, #414)
- The status bar's usage stays fresh, and the App resources popover is no
  longer transparent. (#380, #415)

### Sharing and organizations

- Share a local session with signed-in guests by link. (#402)
- Choose which organizations the sidebar shows. (#399)
- A local mirror belongs to the account that made it, an unreadable session
  removes nothing, and nothing syncs until the owner is confirmed. (#375)
- The phone and the CLI ask before waking a workspace, and a viewer or a
  phone no longer counts as attached. (#383)

### Worktrees

- Clean up safe worktrees in bulk across open local and cloud projects, and
  remove what earlier deletes left on disk, with sizes shown. (#322, #406)

### Computer use

- The computer-use helper has a new identity and name, "TerminalX Computer
  Use Helper". It serves only the app, never operates TerminalX's own
  windows, and the old helper's grant is removed at every launch. macOS asks
  for Accessibility and Screen Recording again for the new helper. (#382,
  #409, #412)

### Mobile companion

These source changes require a separately updated mobile app.

- A paired phone reconnects after the app restarts, and pairing works when
  the direct port is busy. (#381, #390)
- Transcripts load correctly, keep earlier history during catch-up, order
  unfinished turns, and scroll long histories smoothly. Markdown renders and
  chat links can be opened. (#389, #391, #392, #393, #394)

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

### Model and effort

- The chat's model and effort pickers now always show what the agent is
  really running. A change made in the terminal — Claude Code's `/model`
  (with a name or through its picker) and `/effort`, or Codex's `/model`
  picker — shows in the chat straight away, and in the session header,
  sidebar and dashboard with it. (#404)
- A change made in the chat is shown as "Switching to …" until the agent
  confirms it. For Codex mid-turn that is when the turn ends; the chat no
  longer shows the new model while the old one is still answering. A change
  the agent refuses goes back to what is running, with the reason. (#404)
- A model or effort level TerminalX does not know is shown as the agent
  reported it instead of as the default, and a tab on the agent's own default
  shows which model that is. (#404)

### Permission mode

- The chat's permission picker now shows the mode the agent is really in. A
  mode cycled with Shift+Tab in Claude Code's terminal shows in the chat with
  the next prompt or tool call, and a preset chosen in Codex's `/permissions`
  shows straight away. (#417)
- A mode chosen in the chat while a turn is running is shown as "Switching to
  … after this turn" until the restart that applies it; the picker keeps
  showing the mode the running turn is under. (#417)
- A mode TerminalX has no entry for (Claude Code's `dontAsk`, an unusual
  Codex approval policy and sandbox) is shown as the agent reported it
  instead of as Bypass. (#417)
- A shared session still cannot be in Bypass: if the agent is switched to it
  in the terminal, the agent is restarted in the mode it was in and the chat
  says why. A session with a tab waiting to switch to Bypass cannot be
  shared. (#417)

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
