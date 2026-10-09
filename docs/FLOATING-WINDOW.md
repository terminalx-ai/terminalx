# Floating chat window and quick chats

The floating window is a second, compact TerminalX window for talking to an
agent, or opening a terminal, without attaching or choosing a project first.
What it shows is a **quick chat**: a full session that has no project.

This page says how both are built and what was decided. Issue #395 has the
user stories.

## Two things, kept apart

- A **quick chat** is a kind of session. It lives in the session index, is
  listed in the main window, and works from the CLI and a paired phone with no
  floating window involved.
- The **floating window** is a view. It can show any local session, and owns
  no state: hiding it stops nothing, and closing it hides it.

## Quick chats

### The session model

`SessionEntry` has a `kind`: `project` (the default) or `quick`. It is an
explicit field, in Rust (`store/index.rs`) and in TypeScript
(`types/session.ts`); nothing infers a quick chat from an empty or odd path.

A quick chat's `project_path` is its **scratch directory**, not an empty
string. That is a deliberate choice for compatibility:

- An ordinary session is written exactly as before (`kind` is left out when
  it is `project`), so the index of someone who never uses quick chats does
  not change.
- A build from before quick chats requires `projectPath` and would fail to
  read the whole index without it. It reads a quick chat as a session in a
  plain folder it has no project for, and its unknown-field passthrough keeps
  `kind` when it rewrites the index. `store::index` has a test that parses the
  index with the old shape and round-trips it.
- A `kind` this build does not know is read as `project` rather than failing
  the index.

Code that means "the reader's project" asks `SessionEntry::project()`, which
is `None` for a quick chat. What each consumer does with one:

| Consumer | A quick chat |
| --- | --- |
| Sidebar | Its own "Quick chats" section; never under a project |
| Agent Dashboard, command palette | Listed; named "Quick chat", filterable as one group |
| Worktrees, branches, base ref | None. Not offered at creation, never cut |
| Changes / Repo / PR | Hidden in a scratch folder, with a "no repository" note above Files. Shown when the chat is pointed at a real repository |
| `terminalx sessions list` | Listed, with `"kind": "quick"`; never matched by `--project` |
| Automations | Not a target (they are per project) |
| Leftover clean-up (Settings → Storage) | Not scanned: it walks projects. Orphaned scratch folders are swept separately (below) |
| Resource panel | Grouped under "Quick chats" |
| Paired phone | Listed under a "Quick chats" group (below) |
| Headless runtime (`terminalx-serve`) | Never listed: it serves one project root |

### Scratch directories

`~/.raccoon/quick/<session id>` (`store/quick.rs`), one per quick chat: not
the home directory, where an agent would see everything, and not a
repository.

- **Made** before the index entry, and removed again if creating the session
  fails.
- **Found by session id**, so it is cleaned up for a chat that was pointed at
  another folder or moved into a project.
- **Removed** when the session is deleted, by any route (the UI, the CLI, a
  workspace removal, retention). The delete confirmation counts the files in
  it first and names them; an empty one needs no mention. A symlink inside it
  is removed, never followed.
- **Made again** at launch if it was removed by hand.
- **Orphans** (a directory with no session, from a crash between the two
  writes) are removed by the retention sweep once they are an hour old.

The scratch directory is on no branch, even when the TerminalX home sits
inside a repository (dotfiles kept in git).

### Another working directory

"Set working directory…" points a quick chat at any folder. The folder is
used as it is and is **not** registered as a project. The chat's agents are
stopped and start again there; "Use scratch folder" goes back.

### Move to project

Turns the quick chat into an ordinary session of an existing or newly added
project: same session id, same tabs, same saved transcript. Its agents are
stopped and resume in the project.

Whether the *provider's* conversation resumes depends on the provider:

- **Claude Code** files a transcript under the directory it was started in,
  and `--resume` looks under the directory it is run in. The transcript is
  moved to the new directory's folder (`claude::transcript::rehome_in`) so the
  same conversation resumes.
- **Codex** keeps its rollouts by id in TerminalX's managed home, not under
  the directory, so there is nothing to move.
- If a provider still cannot resume, the tab keeps its history (TerminalX's
  own log does not depend on the directory) and **Continue in New Session…**
  carries the conversation on. The dialog says so before moving.

Files in the scratch folder are not copied into the project. They stay where
they are until the session is deleted, and the dialog says how many there are.

### Retention

Settings → General → "Keep idle quick chats for": 7, 30 (default) or 90 days,
or for ever. A quick chat nobody has touched for that long is deleted with its
scratch directory, at launch and every six hours. Kept regardless: pinned and
archived chats, a chat with a turn running or waiting, and a chat with a
shell still running in it. Manual delete is always available.

### Provider trust

A new scratch directory is trusted the same way a new project is: Claude
Code's `~/.claude.json` and TerminalX's managed Codex `config.toml` are
prepared for the session's working directory before the CLI starts, so
neither shows a first-run trust prompt.

## The window

`src-tauri/src/floating.rs`. Label `floating`, made on first use and reused.

- 460×640 by default, resizable, 360×420 minimum. Size and position are
  remembered by the window-state plugin, saved each time the window hides.
- Always on top by default; the pin in the window (and Settings → General)
  turns that off.
- Same theme, mode, font scale and translucency as the main window: both read
  the same preferences and follow each other's changes.
- Closing it (the window's close button) hides it. ⌘W closes the tab on
  screen, as it does in the main window.
- If the main window closes, the floating window goes with it, so the app
  quits as it always has.

### Opening it

| From | How |
| --- | --- |
| Any app | The system-wide shortcut, ⌥⇧Space by default |
| The tray icon | Quick Chat |
| The main window | "Quick Chat" in the sidebar, "Open the floating chat window" in the command palette, "Open in floating window" in a session's menu, "+" on the Quick chats section |
| The command line | `terminalx floating show\|hide\|toggle [--session ID]` |

The shortcut toggles: a window that is up and focused is hidden; otherwise it
is shown and focused, with the caret in the composer. **Escape** hides the
window when nothing else wanted the key. A menu or dialog closes first, a
running turn is stopped first, and a terminal keeps its Escape.

### The system-wide shortcut

Settings → Shortcuts → System-wide. It can be changed or turned off.

Unlike the app's other shortcuts it is registered with the system, so:

- it needs Command, Control or Option (a bare key or Shift+key would be taken
  from every other app); such a binding is refused before it is saved;
- registration can fail, typically because another app has the keys. The
  failure is kept and shown in Settings with what to do, and never stops the
  app. The other ways of opening the window still work.

It is stored in `settings.json` (`floating.shortcut`), not with the other
shortcuts in local storage, because the Rust side registers it before any
window exists. `null` is "turned off", which is not the same as "unset".

### Platforms

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Always on top | Yes | Yes | A request to the window manager; honoured on X11, often ignored on Wayland |
| Every Space / desktop | Yes, including over another app's full-screen Space | No: Windows has no public switch for it; the window stays on the desktop it was shown on | A request; honoured by most X11 window managers |
| System-wide shortcut | Yes | Yes | X11 only. Under Wayland registration fails and Settings says so; bind `terminalx floating toggle` in the desktop's own keyboard settings |
| Tray icon | Menu bar | Notification area | Needs an app-indicator host |

Only macOS on Apple silicon is built and tested today (see CONTRIBUTING.md).
The Windows and Linux columns are what the code asks for and what those
platforms document, not something that has been run.

## One session, two windows

Both windows load the same page and the same stores. A session open in both
must not diverge, and nothing may happen twice.

**The backend is the source of truth and tells every window.** What changed
to make that hold:

- **Session changes.** Rename, pin, archive, adding or closing a tab and the
  active tab used to update only the window that made them. Each now emits
  `session_updated`. Project changes emit `projects_changed`.
- **Terminal output.** A pane had one view; a second attach replaced the
  first. It now has one view **per window** (`pty.rs`), each sent, counted and
  flow-controlled on its own, so a hidden window that stops drawing cannot
  stall the other. A reloading window drops only its own views.
- **Shell tabs.** The list of a session's shells lived in one window's
  memory. The backend now lists them (`pty_shells`) and announces
  `pty_opened`, `pty_renamed` and `pty_closed`, so both windows show the same
  tabs under the same names. Pane ids carry a per-window mark so two windows
  cannot mint the same one.
- **Transcript, permissions, questions.** Already events (`agent_event`,
  `tab_status`), delivered to every window and de-duplicated by id. A
  permission answered in one window is a `permission_decided` event, so its
  card goes from the other.
- **Preferences and theme.** Local storage, shared by both pages; each
  follows the other's `storage` events.

**What stays per window**, on purpose: which session is on screen, which tab
of it is selected, chat versus terminal view for a tab, and unsent composer
text.

**What there is one of**, owned by the main window: the dock badge, and
desktop banners. Each window writes whether it has the focus and which
session it shows; the rule is:

- the window with the focus plays the tone and shows the in-app notice;
- when neither has it, the main window alone sends the banner;
- a banner about the session the floating window shows brings the floating
  window back, on that session and tab, when the reader returns to the app.
  A banner about one of the main window's sessions does not move the main
  window, which is how it behaved before.

A **hidden** floating window draws no session at all. Its page keeps running,
and a session view left mounted there would mark a finished tab as read with
nobody looking.

### Capabilities

`capabilities/floating.json` grants the floating window what a session view
needs and no more. It cannot update or restart the app, sends no desktop
notifications and does not set the dock badge.

## Paired phones

Quick chats **are** visible to paired mobile devices. They are sessions like
any other, and leaving them out would make the phone's list disagree with the
desktop's. In the summaries a phone receives, a quick chat has
`"kind": "quick"`, its project is `"Quick chats"` (one group, not one per
scratch directory) and its place is `"scratch"` or the folder it runs in.
Sessions of a project are sent as before, with `"kind": "project"` added.

## Out of scope

Cloud workspaces in the floating window, a lightweight chat that bypasses the
provider CLIs, and more than one floating window.

## Tests

- `store/index.rs`: storage of `kind`, an older build reading and rewriting
  the index, an unknown kind.
- `store/quick.rs`, `session_ops.rs`: scratch directory lifecycle; creation
  with no project; a chosen folder; pointing elsewhere and back; move to
  project; deletion; retention; orphans.
- `pty.rs`: two windows on one pane; shell tabs listed for any window.
- `floating.rs`, `control.rs`, `cli.rs`: shortcut bindings; the CLI verbs.
- `src/lib/twoWindows.test.ts`: two copies of the stores over one fake
  backend stay the same through rename, create, delete, shells and events.
- `src/lib/notify.windows.test.ts`: who speaks, and bringing the reader back.
- `src/components/floating/FloatingShell.test.tsx`,
  `SessionView.terminalView.test.tsx`: the compact shell around the same
  session view.
