# PTY-first agent tabs

## The decision

An agent tab used to be two processes wearing one face. The chat was driven by
a headless child (`claude -p --output-format stream-json`), and the "terminal
view" was a *second* process (`claude --resume`) that could only be started by
stopping the first one and could only be left by reading the CLI's transcript
back to catch up. Two processes, one conversation, a hand-off in the middle,
and a button that had to be refused mid-turn.

A tab is now **one process: the real interactive CLI, running in a PTY**. The
chat is a projection of that process, and the terminal view is the same process
seen directly. Switching between them is a view flag — nothing is stopped,
resumed, or reconciled.

Phase 1 does this for Claude Code. Codex, ACP and OpenCode still run headless
and keep the old hand-off.

## The architecture

```
                    ┌──────────── the tab ────────────┐
  composer ──keys──▶│  claude (interactive, in a PTY) │──bytes──▶ xterm
                    └───┬────────────────────────┬────┘
                        │ appends                │ runs
                        ▼                        ▼
        ~/.claude/projects/<cwd>/<id>.jsonl   raccoon hook <Event>
                        │ tailed                 │ unix socket
                        ▼                        ▼
                    tab event log ◀────── status, permission cards
                        │
                        ▼
                  Chat, summaries, dashboard
```

### One process per tab

`session.rs` spawns the CLI through the existing `pty.rs` terminals, in a pane
named `tab:<tab-id>`. A new tab gets `--session-id <uuid>` with a uuid minted by
the app, so the transcript's path is known before the CLI has written a byte; an
existing tab gets `--resume <provider session id>`, which appends to that same
file. A forked tab gets `--resume <parent> --fork-session --session-id <new>`.
The rest of the command line is `--model`, `--effort`, `--permission-mode`,
`--name` (so the tab is recognisable in the CLI's own picker) and `--settings`.

The pane's environment carries `RACCOON_TAB_ID`, `RACCOON_SESSION_ID` and
`RACCOON_HOOK_SOCKET`, all of which the CLI passes on to every hook it runs.

Opening a Claude tab starts its CLI (`ensure_tab_started`); it does not wait for
a first prompt, because in this model the tab *is* the CLI.

### The transcript is the conversation

The CLI writes one JSON record per message to
`~/.claude/projects/<encoded cwd>/<session id>.jsonl` whether it is interactive
or headless. `claude/transcript.rs` follows that file from wherever it stood
when the CLI was spawned and decodes new records into the app's existing
payloads — user messages, assistant prose, thinking, tool calls with their
input, tool results, file edits, context occupancy, compaction boundaries.
They are published through the same `publish` path the headless engines use, so
Chat, the transcript builder, session summaries, the dashboard and the handoff
chips needed no changes.

Two details that matter:

- **Polling, not watching.** A 200 ms stat is the authority. The file does not
  exist when the CLI starts, appears about half a second after the first prompt,
  and there is no signal to subscribe to. `Tail` also holds the cursor, which
  serialises the poll loop against a `Stop` hook flushing before it closes the
  turn.
- **Bytes, not text.** A read can land inside a record and therefore inside a
  multi-byte character, so nothing is decoded until its newline has arrived.

The path derived from the session id is a guess made before the CLI ran; the
first hook to arrive carries `transcript_path`, which is authoritative, and the
tail is re-pointed at it.

### Hooks carry what the file cannot

The transcript says what was said; it does not say *when a turn began or ended*,
and it cannot ask a question. The CLI's hooks do both. `--settings` is passed a
JSON object (the CLI accepts a raw JSON string, not only a path) registering
`SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PreToolUse`,
`PostToolUse`, `Notification`, `Stop`, `SubagentStop` and `SessionEnd`. Each
hook command is **the Raccoon binary itself**, found with `std::env::current_exe`
so it works for `cargo run` and for the bundle alike:

```json
{"type": "command", "command": "'/path/to/raccoon' hook Stop", "timeout": 10}
```

`main.rs` answers `argv[1] == "hook"` before Tauri starts: it reads all of
stdin, connects to `$RACCOON_HOOK_SOCKET`, sends one framed
`{tab, session, event, payload}` line, waits for a reply, prints it, and exits
0. If anything at all goes wrong — no socket, no app, a bad frame — it prints
`{}` and exits 0, so the CLI is never blocked and never sees an error. It
prints `{}` rather than nothing on purpose: an empty stdout from a permission
hook is read as a refusal.

On the app side, `hooks.rs` listens on one unix socket per instance at
`$RACCOON_HOME/run/hooks.sock` (stale file removed at start, mode 0600), one
thread per frame so a parked permission cannot queue the next hook behind it.
`SessionManager::on_hook` routes by event:

| Event | What it does |
|---|---|
| `SessionStart` | re-point the tail at the real `transcript_path` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | flush the tail, open the turn, status Working |
| `PermissionRequest` | flush, publish the permission card, **park** until it is answered |
| `Notification` (`permission_prompt`) | status Waiting — the CLI is asking in its own TUI, which means our hook did not answer in time |
| `Stop` | flush, close the turn with the CLI's `last_assistant_message`, status Done |
| `SessionEnd` | close any open turn, status Idle |

### Permissions are decided by the app

`PermissionRequest` is a real hook event in Claude Code 2.1.258, and it can
return a decision. The hook thread publishes the app's existing
`PermissionRequested` payload — so the chat draws the card it always drew,
including the "Allow and switch to…" options built from the event's own
`permission_suggestions` — and then blocks on a channel. `respond_permission`
(the same command the Allow/Deny buttons already called) sends the answer, and
the hook prints:

```json
{"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow"}}}
```

or `{"behavior": "deny", "message": "…"}`. Note the shape is *not* `PreToolUse`'s
`permissionDecision`, and this event ignores exit code 2, so a denial has to be
said in JSON. `AskUserQuestion` comes through the same event and becomes the
chat's question form; the answers ride back inside `decision.updatedInput`.

The hook and the app agree on a 600 s wait — the CLI's own default for a
command hook. If it lapses, the card is retired as "Lapsed" and the CLI falls
back to asking in its own TUI, which the `Notification` hook turns into a
Waiting status so the reader knows to look at the terminal view.

### The composer writes keystrokes

`send_message` on a Claude tab writes into the pane, on its own thread under a
per-pane lock:

1. `Ctrl+U`, so a half-typed line in the terminal view is not glued to the front.
2. Any image attachments, each as its own bracketed paste of its path — a typed
   path is read as prose, only a paste becomes an attachment.
3. The body, as a bracketed paste (`\x1b[200~` … `\x1b[201~`), with newlines
   normalised to carriage returns and any embedded escape replaced by `␛` so it
   cannot close the frame early.
4. **After a pause**, `\r`.

The pause is the whole trick: a carriage return inside the same write is read as
part of the paste, so the text lands in the composer and never sends. It is
250 ms plus a byte-rate term, so a long prompt still gets its Enter after the
last character has arrived.

The first prompt after a spawn waits for the TUI to finish drawing first, since
a TUI mid-paint drops what is typed at it and has no way to say when it is
ready. The sign is that the pane has drawn something and then been quiet for a
second — measured, not guessed: the CLI paints at 0.3 s, pauses 0.7 s, paints
again at 1.0 s and settles at 2.0 s, and a prompt typed into that gap vanishes
without a trace.

A single-line prompt starting with `/` is written as plain keystrokes instead,
because a pasted slash command is classified as prose and never opens the
command palette. `/model` and `/effort` reach the running CLI the same way.

Interrupt writes a bare Escape. Stop kills the pane.

### Workspace trust

The interactive CLI asks "is this a folder you trust?" the first time it runs
anywhere new, and a session's worktree is always somewhere new. That dialog
would take the first prompt instead of the composer, and a reader watching the
chat would never see it. The CLI names the alternative itself, so
`claude/trust.rs` sets `projects[<cwd>].hasTrustDialogAccepted` in the CLI's own
config for a checkout the reader already adopted by making the session, and
leaves every other key alone. It only writes when the flag is missing or false,
which is once per checkout, before that checkout's CLI has started.

### Nested-session stamps are stripped

If Raccoon itself was started from inside an agent's session — a `tauri dev` an
agent ran — then `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_CODE_BRIDGE_SESSION_ID` are in its
environment. A CLI that inherits them believes it is a nested child and **stops
writing its transcript**, which would leave the chat permanently empty. `pty.rs`
removes them from every pane it opens. This was reproduced and then fixed
against the installed CLI, not taken on trust.

### Chat and terminal are one pane

`tabViews.ts` keeps a `chat | terminal` flag per tab. For a PTY-first tab the
terminal pane stays mounted underneath and the chat is drawn over it, so
toggling never unmounts xterm, never loses scrollback and never resizes the
agent's window. (`invisible`, not `hidden`: xterm needs a laid-out box to fit
itself to.) The backend names the pane it spawned in a `tab_pty` event and the
frontend adopts it, which is what routes the CLI's output into this window's
xterm instance.

`tab_handoff` still exists for the harnesses that still need it. `tab_reconcile`
is gone: nothing used it once Claude stopped handing off.

## Limitations

- **Message-granularity streaming.** The transcript is written per message, not
  per token, so assistant prose appears a message at a time. There are no
  deltas and no streaming preview for a Claude tab.
- **Keystroke input.** Everything the composer sends is typed into a TUI. It is
  robust for prose and for slash commands, but it is not a protocol: there is no
  acknowledgement, and a prompt sent while the CLI is starting up can be lost.
- **Images by path.** An attachment is archived as today and its *path* is
  pasted for the CLI to pick up, rather than base64 bytes on a wire.
- **Queueing.** A prompt sent mid-turn is written immediately — the CLI queues
  typed input itself. The chat shows it as queued until the CLI takes it and the
  transcript says so; the app keeps no queue of its own for these tabs.
- **Permission mode changes** restart the CLI on the same conversation, because
  the TUI has no command for it. Model and effort change in place.
- **One permission surface.** While the hook answers, the CLI never shows its
  own prompt. If the hook lapses it does, and the answer has to be given there.
- **Codex, ACP and OpenCode are unchanged** in this phase: still headless, still
  handing off to a terminal.

## Phases

1. **Claude Code** (this change) — PTY-first tabs, transcript projection, hook
   bridge, permissions by hook decision, terminal view as a view flag.
2. **Codex** — the same shape for `codex`: interactive CLI in the PTY, its
   rollout file tailed, its own hook/notify mechanism for status and approvals.
3. **Cleanup** — remove the headless Codex engine and the `tab_handoff` path
   with it; decide whether ACP and OpenCode follow (they are protocols, not
   TUIs, so headless may stay the right answer for them) and, if they do not,
   say so in the plan rather than leaving the question open.
