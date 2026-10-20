# TerminalX changelog

## Unreleased

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

### Mobile companion

- A message sent to the agent from the phone shows once, as the prompt of
  the turn it starts, rather than also as a worktree note. **Send to agent**
  sends the text and its attachments in one request, so a send that fails
  leaves no note behind and a retry sends the message once. **Add worktree
  note** still adds a note and sends nothing to the agent. A note promoted
  to an agent is marked with the tab and message it became, and the phone
  leaves it out of that tab's conversation; the note-plus-prompt pairs saved
  by earlier phones are hidden too (#541).

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
