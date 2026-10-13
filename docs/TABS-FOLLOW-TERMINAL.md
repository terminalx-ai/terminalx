# Tabs follow their terminal

A tab is what runs in its terminal now (#437). It used to be what it was
created as: an agent tab stayed that agent's for life, and a shell stayed a
shell whatever was typed into it.

1. Open a plain terminal in a session. The sidebar lists a terminal.
2. Type `claude`. The row becomes a Claude Code tab, with its mark, its name
   and its live status, and the tab has a chat.
3. Exit it. The row is a terminal again. Nothing is raised: no "needs
   attention", no recovery banner, no "Resume safely".
4. Type `codex` in the same terminal. The row is a Codex tab, with a chat of
   its own. The Claude Code conversation is still the tab's, under
   **Conversations**.

The same holds for a tab that was created as an agent tab. When its CLI is
exited from the terminal view, a shell takes its place in the same pane and
the tab is a terminal, and whatever agent is started there next is the tab's.

Through every change the tab keeps its id, its place among the session's
tabs, its selection and its log. A name the reader gave it is never replaced.

This is for local sessions. A cloud workspace's runtime does not follow its
terminals yet; see [Limits](#limits).

## What a tab can hold

`Front`, in the session index (`store/index.rs`), names the three things that
can be in front of a tab's terminal:

| `front` | What it is | Who runs it |
| --- | --- | --- |
| `agent` (the default, not written) | the tab's agent | the app, with its hooks and settings ([PTY-FIRST.md](PTY-FIRST.md)) |
| `by_hand` | the tab's agent, typed into the tab's terminal | the reader. The app follows it and never restarts it |
| `terminal` | no agent: a shell | the reader |

The fields that go with it are flattened into the tab's entry (`Follow`), and
none of them is written for a tab that only ever ran the agent it was created
for, so such an entry is stored exactly as before and an older build reads a
newer index as it always did.

A shell tab has no entry in the index until an agent is first started in it.
It is then given one that takes over the shell's pane (`pane`, instead of the
tab's own `tab:<id>`) and the time the shell was opened (`created`), which is
what keeps it in the shell's place. From then on it is a tab like any other.
A window that had the shell selected has that tab selected.

Where the reader arranged the workspace's row of tabs themselves (#438), the
shell's place is in the workspace's saved layout, under `terminal:<pane id>`.
What the layout says of the shell (its place, a pin, a mute, a title the
reader gave it) it says of the tab from then on, under `agent:<tab id>`
(`index::shell_became_tab`). A window is told of the tab before it is told
of the layout, and reads a layout that still names the shell as naming the
tab (`followedLayout`), so the tab is never drawn out of its place.

No pane survives the app, so at the next launch a tab is in a pane of its own
again, and an agent that was started by hand is the tab's agent for the app
to resume when the tab is opened. A tab that was a terminal is still one.

## Noticing what runs

Nothing tells the app that a program was started by hand, so it asks the
terminal (`foreground.rs`). A PTY knows two things, each one call:

- which process group it gives its input to (`tcgetpgrp`): the pane's own
  process, or a job started from it;
- whether it is being read a key at a time with nothing echoed (`tcgetattr`):
  what a full-screen program does.

Both are asked of every pane four times a second. The processes themselves
are only listed when the answer can matter: a job that is not the pane's own
process has the terminal raw. Then `ps -t <tty>` lists the terminal's
processes once, and the job is read against the harness registry.

Probed on Claude Code 2.1.296 and codex-cli 0.153.4 (2026-10-12), each typed
into an interactive zsh in a PTY:

- both TUIs have the terminal raw for as long as they are up, from 0.02 to
  0.43 s after they start;
- `claude --version`, `claude -p`, `claude doctor`, `codex --version` and
  `codex exec` leave it as the shell had it for their whole run. They are
  the same binaries, and typed at a prompt they are never looked at;
- Claude Code is one process and the leader of the job. The npm `codex` is a
  node launcher and the native program it starts, in one job;
- the shells an agent runs for its tools are in a session of their own with
  no terminal, so the job in front stays the agent.

### Which programs count

One rule, for every row of the registry (`harness::recognise`): the program
is an agent's binary by name, wherever it is (a version manager's shim, an
alias the shell expanded, an absolute path), or it is an interpreter running
that binary or a file inside the agent's package (`npx`, a global install).
Which agent it is comes from the program and its script alone, never from
the other arguments, so `vim claude.md` is not an agent.

The rest of the command line is read for one thing: whether the run was
asked to have no screen of its own. Each row of the registry lists how that
is asked of its CLI (`headless`): a subcommand as the first word
(`codex exec`, `claude mcp`, `opencode run`) or a flag anywhere after it
(`claude -p`, `cursor-agent --print`). Such a run is a script's or another
program's and nobody's session, and it is often started by a program that
does hold the terminal the way a session does: an editor's plugin, `watch`,
a spinner. Without this, `claude -p` under `nvim` made the shell's tab a
Claude Code tab. A command line is only known as words, so a prompt passed
as an argument with a bare `-p` in it reads as such a run too; the tab then
stays a terminal, which is the lesser mistake. Claude Code's own file is a
second check: one whose `kind` is not `interactive` is not followed.

The registry is one table (`REGISTRY` in `harness/mod.rs`) that also lists
what the app offers and drives. An agent added there is recognised in a
terminal by the same row.

When a job holds several agents (an agent that starts another as a tool), the
outermost is the one in front.

A job that is suspended (Ctrl+Z) gives the terminal back to the shell, and
the tab is a terminal until it is brought back (`fg`); it then picks its
conversation up where the tab had read to.

## Following a CLI the app did not launch

A CLI the app launches is told which conversation to open, and reports
through the app's hooks. One that was typed into a shell was given neither:
the shell has no hook socket and no token, on purpose. So everything is read
from what the CLI leaves behind (`harness/by_hand.rs`), and nothing is
written, signalled or restarted.

| | Which conversation | What it is doing |
| --- | --- | --- |
| Claude Code | `<config>/sessions/<pid>.json`, which every running CLI keeps: `sessionId` and the `cwd` its transcript folder is derived from | `status` in the same file: `idle`, `busy`, `waiting` |
| Codex | the process's open files: its newest `thread-writer-locks/<id>.lock`, and that conversation's rollout once the first prompt has made one | the rollout itself: `task_started`, `task_complete` |

Details that matter, all from the same probe:

- Claude Code's file appears 0.2 to 0.7 s after the CLI starts and before any
  prompt. `--resume <id>` has that id from the first write. `-c` is first
  written with a fresh id and rewritten about 0.1 s later. `/clear` changes
  it on the spot.
- Codex takes the lock about 0.3 s after it starts. A new conversation has no
  rollout until its first prompt. `codex resume <id>` has the existing
  rollout open from the start. `/new` takes a second lock and keeps the
  first conversation's files open, so the newest lock is the conversation it
  is in.
- Both write to the reader's own home (`~/.claude`, `~/.codex`), not to the
  Codex home the app manages for the tabs it launches.

A CLI is looked at five times a second for as long as it runs, so a look is
kept cheap (`Locator`). Claude Code's file is read once a look, for the
conversation's id and what the CLI is doing. Where a conversation is written
is only worked out again when that id changes, or now and again. Codex has
nothing as cheap, and listing a process's open files means starting `lsof`.
So once its conversation and rollout are known, the files are listed again
only when the folder its locks are taken in has changed (a conversation
started or switched to takes a lock), or after thirty seconds.

The transcript is then tailed with the same decoders an app-launched tab
uses. Where it is read from depends on what it is:

- a file that does not exist yet, or was made since the CLI was first seen,
  is the one it is writing now: read from its start, as it is written. A
  fork (`claude --resume <id> --fork-session`) is such a file, and arrives
  holding a copy of its parent's turns: everything before the prompt it is
  on is brought in as history;
- an older file the tab already holds is read on from where the tab had got
  to, or from its end;
- an older file the tab has never seen (`claude --resume` on a conversation
  from elsewhere) is brought in whole, as turns that are over, so the chat
  shows the conversation from its first turn. Nothing in it is work
  happening now: no status moves and nobody is notified.

A CLI may name its conversation before it says where that is written
(`codex resume <id>` takes the lock before it opens the rollout). The tab is
then on the conversation by name, and it still counts as never seen until
its transcript has been read.

History is read by the thread that follows the tab's transcript, a couple of
hundred records at a time, so a long conversation holds up neither the
watcher that looks at every pane nor the tab itself.

A turn is opened by its prompt in the transcript, or by Claude Code saying it
is busy. With no `Stop` hook to close it, it is closed by the transcript's
own record that it ended, or by Claude Code saying it is idle. Each record is
acted on where it stands, so a turn that ended and a queued prompt after it
are two turns even when they are read together, and a turn the reader
interrupted in the CLI's own screen (Codex's `turn_aborted`) ends as
interrupted, not as done. The silence
watcher does not call a stall on such a tab: the CLI may be waiting on a
question in its own screen, and only Claude Code says so. Its `waiting` is
shown as "Needs attention", with the notice that says to look at the
terminal; nothing is raised to recover from.

### What the chat can and cannot do

- **Sending works.** A prompt from the chat is typed into the CLI as it is
  for any tab, and the CLI's own record of it is matched so it is drawn once.
  Interrupt is Escape.
- **Nothing is typed once the CLI has left.** It shares its pane with the
  shell it was started from, and the watcher is up to a quarter of a second
  behind an exit. So the terminal is asked which job has it when a prompt is
  sent and again before each write, the Enter above all; if it is no longer
  the CLI's, the prompt is refused with the reason and nothing is raised.
- **Stop ends the CLI's own job** and leaves the shell it was started from.
- **Claude Code's model and effort work**: they are its own `/model` and
  `/effort`, typed.
- **What needs the CLI restarted is refused, and says so**: the permission
  mode for either CLI, and the model and effort for Codex. The pickers are
  disabled with the reason, which is also written under them. The app only
  restarts an agent it launched.
- **Permission cards are not drawn.** The CLI asks in its own screen.
- **A guest of a shared session cannot send to it.** It runs with whatever
  permissions the host gave it by hand.
- The permission mode is shown as "Set in the terminal" until the CLI says
  what it is in (Codex does, in its rollout). When the app later launches
  that conversation itself (**Resume here**, or the tab opened after a
  restart) and the mode is still not known, it runs in "Ask every time", and
  that is then the tab's mode, shown in the picker and changed from it.

## Several conversations, one tab

Each agent run in a tab is its own conversation. They share the tab's log,
which stays one append-only file: a `conversation` event marks where the tab
moved on, and the events after it belong to that conversation
(`conversationEvents` in `packages/portable`). The chat draws the one the
tab holds now. The ones before are listed in the tab (`history`) and read
from **Conversations**, as they were.

An agent started on a conversation the tab already holds, the current one or
an earlier one, picks that one up: `claude --resume`, `claude -c`,
`codex resume`. No second copy is made, and the tab's entry for it is
restored with its name and settings.

A conversation in which nothing was ever said leaves nothing behind.

A tab is named for the conversation it holds now, unless the reader named
it.

When a session is deleted, the conversations the app started in its tabs are
deleted with it, the earlier ones included. One the reader started by hand
(`adopted`) is theirs, as one made in any other terminal is, and stays.

## Exits

An agent leaving the front of its terminal is not an error.

- The tab becomes a terminal. For an app-launched CLI, which was the pane's
  own process, a shell is opened in the same pane; what the CLI printed stays
  above its prompt.
- A turn it was in the middle of is closed as interrupted, and the log says
  what happened in one line ("Claude Code exited before the turn finished.").
- A permission request it left unanswered is cancelled with it.
- No recovery is raised and none is restored when the log is opened again.
- An automation waiting on the turn is told it failed.

A pane the app closed itself (Stop, a restart for a setting, the tab or the
app going) changes nothing here.

A tab that is a terminal shows its terminal. Its chat is the conversation it
last held, to read, with **Resume here**: the app starts the agent again on
it, in the place of the shell. A prompt sent to such a tab from elsewhere (a
paired phone, `terminalx tabs send`) does the same. Neither is done while the
shell is running something of the reader's.

## Limits

- **Cloud workspaces** do not follow their terminals. `follow_terminals` is
  only called by the desktop app; `terminalx-serve` behaves as before, and a
  test holds it to that. Doing it there needs the same watcher on the VM and
  the conversation's hand-over in the runtime's tab list.
- **Cursor and OpenCode** are recognised and drawn as what they are (mark and
  name on the terminal's row), and have no chat: the app drives them
  headless and has nothing that projects their own TUI's conversation.
- **`tmux` and `ssh`**: the job in front is `tmux` or `ssh`, and the agent
  has another terminal. The tab stays a terminal.
- **`exec claude`** replaces the shell itself, which is still the pane's own
  process, and is not noticed.
- **A path with a space in it** is not recognised: the command line is read
  as `ps` prints it.
- **A subcommand after an option's value** (`codex -m gpt-5 exec …`) is not
  read as a headless run: only the first word is taken for a subcommand.
- **A hand-started Claude Code's permission mode** is not known; nothing it
  writes says it before a hook would.
- **Windows** has no foreground process group to ask. Tabs become terminals
  on exit there, and nothing started by hand is noticed.
- **A paired phone** lists the tab under its current agent and draws the
  tab's whole log, one conversation after another.
- A conversation resumed by hand that another tab also holds is brought into
  the tab it was resumed in; the other tab keeps its own record of it.
