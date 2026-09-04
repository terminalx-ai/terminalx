# TerminalX CLI

`terminalx` is the authenticated command-line surface of a running TerminalX app. The alias
`tnx` is equivalent. It drives the app's real projects, sessions, PTY-first agent tabs,
transcripts, permission cards, worktrees, and issue integrations; it does not maintain a second
copy of that state.

The guide is embedded at build time. If this text came from
`terminalx skills get terminalx-cli`, it matches the command parser and protocol in
that binary.

## Start here

Choose the executable once:

1. Use `terminalx` when it is on `PATH`.
2. Otherwise use `tnx` when it is on `PATH`.
3. Otherwise use `/Applications/TerminalX.app/Contents/MacOS/terminalx` when
   TerminalX is installed there.

If none exists, install it from TerminalX → Settings → General. Do not guess command names or
flags. Agents should pass `--json`; human-readable output is intended for interactive use.

Confirm the connection first:

```text
terminalx status --json
```

The app listens at `$RACCOON_HOME/run/hooks.sock` and writes its per-launch credential to
`$RACCOON_HOME/run/control.token`, both owner-only. Tabs launched by the app receive
`TERMINALX_NEXT_SOCKET` and `TERMINALX_NEXT_TOKEN`; a normal shell reads the token file
automatically. Never print, copy, or persist that token.

## Selectors

Commands that accept a session or tab use an exact id or an unambiguous id prefix. A session
selector addresses its active tab. A tab selector may address any tab directly. Project
selectors accept an attached project's exact path, exact name, or an unambiguous name match.

When automation passes ids between commands, copy the full ids from JSON output.

## Commands

### App and discovery

```text
terminalx status --json
terminalx projects list --json
terminalx sessions list [--project <project>] --json
terminalx sessions show <session> --json
terminalx tabs list <session> --json
```

`status` reports the app version, process id, socket path, attached projects, and tabs whose
agent process is running.

### Start a session

```text
terminalx sessions create \
  --project <project> \
  --agent <claude|codex> \
  --prompt <text> \
  [--worktree | --on-main] \
  [--model <id>] [--effort <level>] [--mode <mode>] \
  --json
```

A new session uses a worktree by default. `--on-main` deliberately runs in the attached
project's own checkout; `--worktree` makes the default explicit. The command creates the real
session, starts its PTY-first tab, types the prompt through the same path as the composer, and
returns both ids. Valid modes are `plan`, `manual`, `auto`, `acceptEdits`, and
`bypassPermissions`.

### Send, read, and wait

```text
terminalx send <session-or-tab> <text> --json
terminalx read <session-or-tab> [--since <seq>] [--tail <count>] --json
terminalx wait <session-or-tab> [--timeout <seconds>] --json
```

`send` types into the live agent TUI through the composer path. `read` returns normalized,
persisted transcript events; `--since` is exclusive and `--tail` is applied after it. `wait`
returns when the turn completes, the agent asks for permission, the tab stops, or the timeout
expires. Its result names the reason and includes the current tab status.

The safe polling loop is: capture the largest `seq` from `read`, `wait`, then `read --since`
that sequence. Do not scrape terminal escape sequences.

### Permissions

```text
terminalx permissions list --json
terminalx permissions allow <request-id> [--option <option-id>] --json
terminalx permissions deny <request-id> --json
```

Use the request ids and option ids returned by `permissions list`. `allow` defaults to the
one-time `allow` option. A decision fails if the card has lapsed or was already answered. The
CLI cannot grant itself broader permissions; it can only answer a card the running agent
already raised.

### Worktrees

```text
terminalx worktrees list [--project <project>] --json
terminalx worktrees delete <path-or-name> [--project <project>] --yes --json
```

Deletion always requires `--yes` and refuses a project's main checkout. It stops every tab
running in the worktree and removes the sessions that ran there, transcripts included; the
response lists their ids under `removedSessions`. The branch is retained. Inspect the
worktree's uncommitted and unpushed counts from `worktrees list` before deleting it.

### Issues

```text
terminalx issues list --project <project> [--provider github|linear] \
  [--assigned-to-me] [--team <id>] [--search <text>] --json
```

GitHub uses the reader's authenticated `gh` CLI. Linear uses the key configured in TerminalX →
Settings → Integrations. The default provider is GitHub.

### This guide

```text
terminalx skills get terminalx-cli [--full]
terminalx skills get terminalx-cli [--full] --json
```

The non-JSON form prints this Markdown directly. `--full` is accepted for callers that always
request an explicit complete guide; the embedded guide is complete either way.

## Typed errors and recovery

JSON failures have this shape:

```json
{"ok":false,"error":{"code":"app_unavailable","message":"…","recovery":"…"}}
```

- `app_unavailable`: open TerminalX with the same `RACCOON_HOME`, then retry `status` once.
- `unauthorized`: do not retry with the same credential. A human shell should remove stale
  `TERMINALX_NEXT_TOKEN` and let the CLI read `control.token`; an app tab should be restarted so
  it receives the new launch environment.
- `not_found`: refresh the relevant list and use an id from the result.
- `ambiguous_selector`: use the full id or exact project path.
- `invalid_arguments`: correct the named flag or missing value; do not invent a substitute.
- `confirmation_required`: inspect the target, then repeat the destructive command with
  `--yes` only when deletion is intended.
- `request_lapsed`: refresh `permissions list`; never reuse the old request id.
- `timeout`: the socket did not answer in time. Check `status` before retrying a mutating
  command, because it may already have completed.
- `internal`: report the message and stop rather than guessing at app state.

All mutating commands act only through the running app. Version 1 exposes no arbitrary
filesystem or git-write command, and worktree deletion is the only destructive operation.
