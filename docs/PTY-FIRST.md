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

Phase 1 did this for Claude Code and phase 2 for Codex. Phase 3 drew the line:
Claude Code and Codex are the only agents the UI offers, and ACP (Cursor) and
OpenCode — the two that are still headless and still hand off — are hidden.

Every shape described here — the transcript and rollout formats, the hook
payloads, the keystroke and readiness behaviour of the two TUIs — was
verified against Claude Code 2.1.258 / codex-cli 0.152.0 on 2026-09-02.
Both CLIs move quickly and none of this is a stable public interface; when a
newer CLI stops matching, the fixtures under `harness/*/fixtures/` are what
to re-record first.

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

The pane's environment carries `RACCOON_TAB_ID`, `RACCOON_SESSION_ID`,
`RACCOON_HOOK_SOCKET` and `RACCOON_HOOK_TOKEN`, all of which the CLI passes on
to every hook it runs. It also carries `TERMINALX_NEXT_SOCKET` and
`TERMINALX_NEXT_TOKEN`, the app-launch credential that lets an agent call the
authenticated control API. The hook token is minted per launch of the tab's
CLI; the server drops any frame whose token does not match the live tab, and
only accepts a `transcript_path` under that tab's own transcript directory.

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
`{tab, session, event, token, payload}` line, waits for a reply, prints it, and exits
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
a TUI mid-paint drops what is typed at it. Claude Code says when it is up: the
`SessionStart` hook runs once its session exists, for a fresh start and a
`--resume` alike, and a 300 ms settle after it covers the last of the paint.

Reading the screen instead does not work for it. A fresh start paints at 0.3 s,
pauses 0.7 s and settles at 2.0 s, so a short quiet threshold fires into the
gap; a `--resume` replays the conversation and then keeps redrawing, so a long
one never fires at all. Quiet output survives there only as the fallback for a
CLI whose hooks never reach us.

Codex has no such moment, and this is the one place the two harnesses part.
Probed fresh and resumed with no prompt sent, Codex runs *no* hook until a
prompt creates its session — which is the very thing being waited for — so its
tab reads the screen, and that is the rule rather than a fallback. It can:
Codex paints in a burst and settles between 1.9 s (a resume) and 3.5 s (a cold
start, while its model and directory lines resolve), so three seconds of quiet
is reached without ever having to be waited out.

If no signal comes at all, the prompt is typed anyway behind a status line —
losing it to a TUI that was not listening is bad, but discarding it in silence,
which is what used to happen, is worse.

A single-line prompt starting with `/` is written as plain keystrokes instead,
because a pasted slash command is classified as prose and never opens the
command palette. `/model` and `/effort` reach the running CLI the same way.

Interrupt writes a bare Escape. Stop kills the pane.

### Replacing the process in a pane

A restart keeps the pane and swaps what runs inside it, so the reader sees the
CLI redraw rather than a new tab. Two things make that harder than it sounds:

- an agent CLI **holds its conversation** while it runs, and refuses to open one
  another process still has (`--session-id` on a live session is refused
  outright), so the replacement has to start after the old process is gone, not
  after it has been signalled; and
- **Claude Code ignores SIGTERM.** It was still running six seconds after one in
  a probe here. So `Terminals::kill_and_wait` asks politely, gives it a short
  grace, then kills it outright, and waits for the pid to actually disappear.

The same wait guards Stop, so a prompt sent straight after it does not find the
session still taken.

A restart resumes; it does not fork. `--permission-mode` *is* honoured on
`--resume` — verified against the installed CLI by reading the mode back out of
a `Stop` hook payload after a completed turn.

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

A window claims a tab's pane by asking for it (`tab_pane`) when the tab view
mounts, not only by hearing it announced: an app that restarts into a session
whose CLI is already running was not listening when the pane opened. Starting a
tab is shared per tab on both sides — one runtime per tab in Rust, one in-flight
promise per tab in the frontend — because two starts racing is how a tab ended
up with two CLIs fighting over one conversation.

`tabViews.ts` keeps a `chat | terminal` flag per tab. For a PTY-first tab the
terminal pane stays mounted underneath and the chat is drawn over it, so
toggling never unmounts xterm, never loses scrollback and never resizes the
agent's window. (`invisible`, not `hidden`: xterm needs a laid-out box to fit
itself to.) The backend names the pane it spawned in a `tab_pty` event and the
frontend adopts it, which is what routes the CLI's output into this window's
xterm instance.

`tab_handoff` still exists for ACP and OpenCode, which are the only tabs that
can reach it — the backend refuses it for a PTY-first tab, and no button asks
for it. `tab_reconcile` is gone: nothing used it once Claude stopped handing
off.

## Codex

Codex is the same architecture with the same three channels — the CLI in the
pane, its own transcript projected into the chat, its hooks carrying status and
decisions — and the parts that are identical live in `harness/tui.rs`: the
bracketed paste, the delayed Enter, the quiet-for readiness rule, the
byte-level tail, and the `TurnTail` that keeps a reply from being drawn twice.
What differs is not the shape but four facts about the CLI, each read out of
codex-cli 0.152.0 rather than assumed.

### A home Raccoon owns

There is no `--settings`. Codex reads hooks from `$CODEX_HOME/hooks.json`, and
it runs a hook only if `$CODEX_HOME/config.toml` holds a `trusted_hash` for it:

```toml
[hooks.state."/…/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:764f7e14…"
```

Installing that in the reader's `~/.codex` would edit two files Raccoon does
not own and would fire our hooks at every `codex` they run in their own
terminal. So `home.rs` keeps a home at `$RACCOON_HOME/codex` and points
`CODEX_HOME` at it. A separate home must not become a separate Codex, so it
gets the reader's account (`auth.json` **symlinked**, never copied, so a
refreshed token is shared), their `skills`, `prompts`, `plugins` and
`AGENTS.md` (symlinked too — Raccoon writes nothing into their home, but Codex
goes on keeping its own house there through the links, exactly as it would if
they had run `codex` themselves), and an explicit list of their `config.toml`
keys —
model, effort, `[features]`, `[mcp_servers]`, `[plugins]`, `[marketplaces]` and
a few more. Two keys are deliberately *not* mirrored: `notify`, which runs the
reader's own desktop helper and has nothing to do with a tab, and `projects`,
because Raccoon trusts only the checkouts it opened (`trust_level = "trusted"`
for the session's worktree, which is what stops the TUI asking).

The hash is **asked of Codex, not computed**. `codex app-server` answers
`hooks/list` with a `key` and a `currentHash` per hook, which is the same pair
the TUI's own "Trust all" writes; reimplementing the digest would be one more
thing to get wrong on every upgrade. The answer is cached against a digest of
`hooks.json`, so the short-lived child runs when Raccoon moves or is upgraded,
not on every tab.

Two startup dialogs would otherwise eat the first prompt, and both are handled
before the CLI starts:

- **"Hooks need review"** — an *untrusted* hook is worse than no hook: the TUI
  opens a modal whose default choice is "Review hooks". If trust cannot be
  established, `hooks.json` is emptied for that launch, so the tab runs without
  status or cards rather than behind a dialog.
- **"Update available"** — once Codex has seen a newer version, it opens a
  modal whose default is "Update now", and the Enter meant for the prompt runs
  `npm install -g @openai/codex` instead. (Observed here, the hard way.)
  Recording the version it found as `dismissed_version` in the managed home's
  `version.json` — the same thing its own "Skip until next version" does —
  leaves a passive banner and no modal. A `codex` the reader runs themselves is
  untouched and still offered the update.

### The conversation names itself

Claude is told `--session-id`; Codex is not, and mints its own. A new tab
therefore has *nothing* to follow until its first `SessionStart` hook arrives
carrying `session_id` and `transcript_path` — which is when the tail is pointed
at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` and the id is
recorded so the tab can resume. Launch is `codex resume <id>` for a tab that
has one, plain `codex` for one that does not, plus `-m <model>`,
`-c model_reasoning_effort=<effort>` and the approval/sandbox flags.

Tabs made by the old headless engine hold an id whose rollout is in the
reader's own home, where a `codex resume` against ours will not look. That file
is **copied** into the managed home on first use, keeping its relative path;
the reader's copy is left exactly as it was. Resuming a copied rollout was
verified against the installed CLI — the conversation replays in full, so the
sqlite thread history is not needed. If the id cannot be found in either home
the tab says so in the chat and starts a new conversation, because
`codex resume <unknown>` fails the launch outright.

### The rollout is the conversation

Codex appends `{"timestamp", "ordinal", "type", "payload"}` per event, and two
record types matter:

- **`event_msg`** is the stream the TUI itself draws from — typed items
  (`UserMessage`, `AgentMessage`, `CommandExecution`, `FileChange`,
  `Reasoning`, `McpToolCall`, `WebSearch`) plus `task_started`,
  `task_complete`, `token_count`. This is the conversation.
- **`response_item`** is the model's *input tape*: the same messages again, but
  also the developer prompts, the environment preamble, the encrypted reasoning
  blobs, and the JavaScript `exec` wrapper Codex builds around every shell
  command. Drawing it would show the reader the harness instead of the
  conversation, so `rollout.rs` skips it whole — and a test asserts that
  nothing decoded ever contains `tools.exec_command`.

`task_complete` and `turn_aborted` are the exception among the `event_msg`
records: they say the turn ended, and they draw nothing. The `Stop` and
`Interrupt` hooks say the same thing with the same reply, moments apart, and
two closers for one turn is one too many — the second lands as a turn with no
prompt in front of it and draws the reply again as its final text, which read
in the app as "delta / Worked for 10s / delta / Worked for 2s". The hooks are
the authority, as they are for Claude; these records only carry the tail
forward to them. `TurnTail` latches it: a turn is opened by the prompt that
starts it and closed by whichever closer arrives first, and a second close is
dropped until a new prompt is published. That guard is not Codex-specific —
Claude's transcript records an interruption as a boundary too, and it can race
the same way.

The cost is that a tab whose hooks could not be trusted has nothing to close a
turn with, so it says so in the chat when it starts rather than leaving a turn
spinning.

`session_meta`, `turn_context`, `world_state` and `thread_settings_applied` are
configuration snapshots and draw nothing. Occupancy is
`token_count.info.last_token_usage.total_tokens`; the sibling `total` is
cumulative over the turn and would over-report it several times.

### Two gates, one card

`PermissionRequest` is a decision-returning hook for Codex as it is for Claude,
but its shape and its reach both differ:

```json
{"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow"}}}
```

`updatedInput` and `updatedPermissions` exist in the schema but Codex **fails
closed** if either is present, so an allow says nothing but allow — there are
no "allow always" suggestions and no `AskUserQuestion` for a Codex tab.

More importantly, `PermissionRequest` only fires when Codex *itself* wants
approval — a command escalating out of the sandbox. Under `-a on-request` a
plain `date` never reaches it. "Ask every time" therefore cannot be a flag:
`-a` takes only `on-request` or `never` in 0.152 (the old `untrusted` and
`on-failure` policies are gone, and naming one makes the CLI refuse to start).
It is built on **`PreToolUse`**, which fires for every tool and can answer:

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "…"}}
```

A denial blocks the call and the model is told `Command blocked by PreToolUse
hook: <reason>`; the reason is required, and `permissionDecision: "ask"` was
probed and does nothing useful (the tool simply runs). An allow at `PreToolUse`
does *not* satisfy the sandbox, so an escalating command reaches
`PermissionRequest` a moment later with the same `tool_input.command`. One tool
must not cost two cards, so the answer is remembered for the turn under the
tool and its target and reused for the request that follows.

Permission modes map as `plan → -a on-request -s read-only`, everything else
`→ -a on-request -s workspace-write` (with the `PreToolUse` gate for "Ask every
time"), and `bypassPermissions → --dangerously-bypass-approvals-and-sandbox`.

One thing `SessionStart` is *not* good for here: readiness. Codex fires it
when the session is created, which is at the first prompt — 20 ms before
`UserPromptSubmit` in every probe, fresh or resumed — so a composer waiting on
it would be waiting on the prompt it is holding. That is why a Codex tab's
readiness is the quiet-output rule and a Claude tab's is the hook.

The events registered are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `Stop`, `Interrupt` and `SessionEnd`. None
of them carries a matcher: a Codex tool hook without one runs for every tool,
where Claude's has to say `*` or it is never called. Codex clamps hook timeouts
per event — the two that park on a person get 600 s, `SessionEnd` and
`Interrupt` are clamped to 3 s, which is why neither ever waits on anything.

## Status bar feeds

Usage belongs to the window, not to the active transcript. Claude Code
2.1.258 was probed again on 2026-09-03: after an API response its configured
`statusLine` command received top-level `rate_limits` with `five_hour` and
`seven_day` windows, `used_percentage`, and epoch-second `resets_at` values.
Raccoon's launch settings point that command at `raccoon statusline`; the
short-lived command forwards the block through the tab's existing authenticated
hook socket and prints nothing. There is no usage request, hidden PTY, durable
cache, or second transport. A pane may contribute at most one non-empty update
per 15 seconds. Both the documented percentage and the fractional
`utilization` form are accepted because installed CLI builds have emitted both.

Codex 0.152.0 answers `account/rateLimits/read` on the same one-shot app-server
client already used for model discovery. A 300-minute primary window is `5h`,
a 10,080-minute secondary window is `weekly`, and `resetsAt` seconds become
milliseconds at the boundary. The client only runs while the macOS window is
visible, focused, and not minimized: once on focus, then no more than every 15
minutes, with provider-local failure backoff. The status bar keeps the
composer's per-tab context ring; only app-wide account limits moved.

Resources start from the PTY registry rather than inferring ownership from
process names. The sampler runs `LC_ALL=C ps -eo pid=,ppid=,pcpu=,rss=`, builds
the parent tree once, and claims descendants once across panes. Twenty local
samples took 1.21 seconds in the 2026-09-03 probe (about 60 ms each), so a
subprocess every two seconds is acceptable only while the popover is open.
With it closed there is no interval: spawn/exit events maintain the agent count
and window focus takes one memory snapshot. The App and host rows use native
host queries so the total includes Raccoon's main and webview processes.

A tab-bound agent pane is never killable here; closing its tab owns the ordered
shutdown. Only a childless terminal-dock shell can be stopped immediately.
An orphan or any shell whose idleness cannot be proved requires confirmation
naming the process and the work that will be lost. The backend recomputes that
rule at click time rather than trusting the rendered row.

## Limitations

- **Message-granularity streaming.** The transcript is written per message, not
  per token, so assistant prose appears a message at a time. There are no
  deltas and no streaming preview for a Claude tab.
- **Keystroke input.** Everything the composer sends is typed into a TUI. It is
  robust for prose and for slash commands, but it is not a protocol: nothing
  acknowledges a prompt, so the app can say it typed one and not that the CLI
  took it. The `UserPromptSubmit` hook arriving is the nearest thing to a
  receipt.
- **Images by path.** An attachment is archived as today and its *path* is
  pasted for the CLI to pick up, rather than base64 bytes on a wire.
- **Queueing.** A prompt sent mid-turn is written immediately — the CLI queues
  typed input itself. The chat shows it as queued until the CLI takes it and the
  transcript says so; the app keeps no queue of its own for these tabs.
- **Permission mode changes** restart the CLI on the same conversation, because
  the TUI only cycles modes on a key with no way to read the result back and
  the CLI reads `--permission-mode` at startup alone. A change made mid-turn
  waits for the turn to end. Model and effort change in place through the CLI's
  own `/model` and `/effort`.
- **One permission surface.** While the hook answers, the CLI never shows its
  own prompt. If the hook lapses it does, and the answer has to be given there.
- **One CLI per visited tab.** Opening a PTY-first tab starts a real `claude`
  or `codex` process, and it stays up until the tab, the session or the app is
  closed —
  that is the point of the model, but it does mean a long afternoon of clicking
  through sessions leaves several running. The status bar names and measures
  them; they are killed together when the window closes, and individually when
  a tab or session is removed.
- **The hook socket is a unix socket**, so the Raccoon home has to sit inside
  the platform's path limit (about 104 bytes on macOS). A path too long to bind
  is logged and the tab runs without status or permission cards.
- **No streaming preview for Codex either.** The rollout is written per item,
  and only `item_completed` is persisted, so there are no deltas.
- **No "allow always" for Codex**, and no question card: the decision it
  accepts is a bare allow or deny, and anything richer fails the hook closed.
- **A Codex model or effort change restarts the tab**, because the TUI's
  `/model` opens a picker rather than taking an argument and there is no
  `/effort` at all. Mid-turn, the restart waits for the turn to end.
- **A Codex tab has no fork.** `codex fork` exists but nothing is wired to it.
- **The managed Codex home mirrors an allowlist**, so a `config.toml` key the
  reader adds that is not on that list does not reach a Raccoon tab.
- **ACP and OpenCode are unchanged, and hidden**: still headless, still handing
  off to a terminal, but no longer offered for a new session or a new tab. A
  tab already on one opens and runs exactly as before; its model picker is
  empty, because the hidden harnesses' models are filtered out of the list too.

## Phases

All three have landed. Each was its own change; none of them is "this
change", and the shape they arrived at is what the repository holds now.

1. **Claude Code** ✅ landed — PTY-first tabs, transcript projection, hook
   bridge, permissions by hook decision, terminal view as a view flag.
2. **Codex** ✅ landed — the same shape for `codex`: the interactive CLI
   in the PTY, its rollout tailed, its hooks carrying status and approvals, a
   managed `CODEX_HOME` to put them in. The headless Codex engine and its
   hand-off are gone with it, and the shared half of phase 1 moved into
   `harness/tui.rs`.
3. **ACP and OpenCode** ✅ landed — they are protocols, not TUIs:
   `cursor-agent acp` and `opencode serve` have no interactive surface to
   project, so headless stays the right answer for them and `tab_handoff`
   stays for their terminal view. Rather than build a second shape out to
   match, they are **hidden**: the code, the engines and the model entries all
   stay, and every tab already on one keeps working, but neither is offered
   for new work. Claude Code and Codex are the two agents the UI lists, and
   ⌘⇧T is a view flag for both of them and nothing else.

   The switch is one list, `HIDDEN_HARNESSES` in `harness/mod.rs`. `catalog`
   still returns all four and `models::catalog` still carries their models;
   `harness::offered` and `models::offered` are what the `list_harnesses` and
   `list_models` commands answer with, so taking an id out of that list puts
   the agent back in the new-session picker, the new-tab menu, Settings →
   Agents and the model picker at once.

   The open question is unchanged — whether either grows a hook mechanism
   worth reading — and if one does, phase 4 is to make it PTY-first and
   unhide it.
