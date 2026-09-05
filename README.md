# TerminalX

TerminalX is a desktop workbench for the coding agents already installed
on your machine. Every session is its own git worktree, and a session holds tabs — each
tab an agent conversation against that same tree. A Claude Code or Codex tab
*is* the real interactive CLI, running in a PTY: the chat you read is a
projection of that one process, built from the transcript the CLI writes and
the hooks it runs, and ⌘⇧T flips between the chat and the terminal without
stopping anything or waiting for a turn to end. One process, two views. See
[docs/PTY-FIRST.md](docs/PTY-FIRST.md) for how that works and why.

TerminalX brings no compute of its own: it drives the `claude` and `codex` CLIs you are already logged into.

## What it does

- **Sessions are worktrees.** Creating a session creates a branch and a
  checkout under `.raccoon/worktrees/`; settling one offers to remove it, and
  deleting is guarded by unpushed commits and open pull requests.
- **Chat and terminal are the same process.** Switch views mid-turn; nothing is
  resumed or reconciled.
- **Permission cards and status from the CLI's own hooks** — approvals asked in
  the chat, including an "ask every time" mode for Codex that covers every
  tool, with Codex's hooks installed in an app-managed home so your
  `~/.codex` is never edited.
- **A composer that never hides**: `@` file mentions, `/` slash commands,
  images by drop or paste, and follow-ups queued while a turn runs.
- **Computer use for agents**: `terminalx computer …` gives agents
  accessibility snapshots, window screenshots, clicks, typing, scrolling and
  drags through a signed helper on macOS 14+, AT-SPI on Linux, or UI Automation
  on Windows. Linux screenshots and hotkeys require X11; Windows cannot reach
  elevated windows from a non-elevated app.
  See [docs/COMPUTER-USE.md](docs/COMPUTER-USE.md).
- **Dictation** (⌘⇧D) using the Mac's own on-device speech recognition, with
  optional local models (Parakeet, Nemotron, Canary, Whisper) downloaded on
  demand. Audio never leaves the machine.
- **Issues from GitHub and Linear** (⌘I): browse them, read them, and start a
  session on one — the worktree is named after the issue and the header links
  back.
- **File explorer** (⌘⇧E) with git status badges and Material icons, **editor
  tabs** with a gutter against HEAD and markdown preview, ⌘P quick open and
  ⌘⇧F project search.
- **Changes, git and pull requests** in the right panel: the last turn's diff
  or the whole session's, repository status and history, and PRs through the
  GitHub CLI.
- **Full-height shell tabs** (⌘J) beside agent conversations, whose processes,
  scrollback and working directories survive tab and session switches.
- **Agent dashboard** (⌘⇧A): every session across every project in three
  columns — needs you, working, done — with search, filters and keyboard
  navigation.
- **Projects and workspaces**: a projects rail with colours and logos, and
  every checkout — including worktrees made outside the app — listed with its
  sessions.
- **A first-party command line interface**: `terminalx` (or `tnx`) drives
  projects, sessions, tabs, transcripts, permission cards, worktrees and
  issues through the running app's authenticated control socket.
- **Notifications graded by attention** (banner, in-app notice, or just a
  tone), a Dock badge, four themes in light and dark, and a pixel raccoon that
  potters about while you wait.

## What leaves your machine

TerminalX has **no telemetry, no analytics and no crash reporting**. An account
is optional: signed out, TerminalX makes no account, directory or relay request
and everything that worked locally before accounts still works. Once you choose
Sign in, the app keeps this Mac discoverable to your own devices with a metadata
heartbeat and a persistent relay connection. It never uploads how you use the
app. The outbound connections are these eight:

| To | When | Carrying |
| --- | --- | --- |
| TerminalX account | You press Sign in, a session is refreshed, or you sign out | PKCE authorization values and the account session credentials issued by `login.terminalx.ai`; no prompts, transcripts, files or workspace metadata |
| TerminalX machine directory | While you remain signed in: once when binding this Mac, then a liveness heartbeat every 30 seconds | Host id, public key, binding generation, the editable machine name, platform, environment kind and pairing capability — no workspace, session, path, transcript, scrollback or device credential |
| TerminalX relay | While you remain signed in, and whenever a paired device connects | Account and host identifiers, public keys, routing ids, connection metadata and plaintext handshake keys; device credentials, RPC and terminal traffic are end-to-end encrypted |
| GitHub | You open the Issues view or a PR panel, or become eligible for the local star reminder | Uses your existing `gh` credentials; the reminder checks only whether you starred `terminalx-ai/raccoon`. It stars only when you press **Star on GitHub**; **Open GitHub** opens that repository in your system browser |
| Linear | You open the Issues view with a Linear key configured | A GraphQL query to `api.linear.app`, authorized with the key you pasted |
| Anthropic usage | The focused status bar lacks a Claude model limit, no more than once every 15 minutes | A GET to `api.anthropic.com/api/oauth/usage`, authorized with the OAuth token Claude Code already stores; no prompts, transcripts or files |
| Hugging Face | You press Download on a transcription model | A plain GET for the weights, at a pinned revision |
| The update endpoint | You press "Check for updates" | The current version and your channel |

Some detail on each:

- **TerminalX account.** Sign-in opens the deployed TerminalX console in your
  default browser, returns through `terminalx://auth/callback`, and exchanges the
  one-time code with `login.terminalx.ai`. Access and refresh tokens stay in the
  native process and are stored in macOS Keychain under the app's own
  `com.terminalx.next.account` service (or the corresponding development app
  service); they are never written to TerminalX's files. The session refreshes near
  expiry, and sign-out clears the Keychain item before its best-effort logout call.
  Signing in also enables the directory and relay calls listed above. This uses
  services TerminalX must operate and pay for; an outage makes remote discovery
  or relay reachability unavailable, never local work.
- **Pairing and relay.** This Mac has a stable Curve25519 identity only after
  sign-in or after you explicitly create a pairing code. Its private key and
  raw per-device credentials stay in macOS Keychain. Account binding synchronizes
  machine authority, not terminal contents. Pairing codes are made locally.
  **TerminalX Relay** codes carry both a direct endpoint and a short-lived,
  single-use relay invite, so a nearby phone tries LAN/Tailscale first and can
  fall back to `relay.terminalx.ai`; **LAN** codes contain no relay invite and
  require no account. Traffic after the pinned-key handshake uses end-to-end
  authenticated encryption on either path. Revoking a device removes its local
  authority and drops its live socket immediately.
- **The agents themselves.** `claude` and `codex` talk to Anthropic and OpenAI
  the same way they do in your terminal, under your own login. TerminalX
  does not proxy, inspect or re-send any of it; it reads the transcript files
  the CLIs write on disk.
- **Claude usage.** Claude's status line is the live usage feed. When it omits
  a model-scoped limit, TerminalX reads the existing OAuth credential from
  the macOS Keychain item `Claude Code-credentials`, falling back to
  `~/.claude/.credentials.json`, and makes the usage GET above. It never writes
  or refreshes credentials, never stores the token, and keeps usage results in
  memory only. Failures back off without clearing the last result.
- **Linear.** The API key is yours, entered in Settings → Integrations. It is
  stored in `$RACCOON_HOME/settings.json` (default `~/.raccoon/settings.json`),
  which is written `0600` inside a `0700` directory. It is never sent anywhere
  but `https://api.linear.app/graphql`.
- **Model downloads.** Every transcription model in the catalogue is pinned to
  a Hugging Face commit revision, so a URL always names the same bytes, and the
  download is verified against a compiled-in SHA-256 before it is moved into
  place. A failed checksum leaves nothing behind. Nothing is downloaded until
  you ask for it.
- **The updater is manual only.** Nothing checks on launch, on a timer, or in
  the background. The one call happens when you press "Check for updates" in
  Settings → About, and it goes to the endpoint in
  `src-tauri/tauri.conf.json`. Updates are signed and verified against a public
  key compiled into the app; nothing installs without you pressing Install.
- **Dictation stays local.** Apple's recogniser runs on-device where your
  language supports it, and the optional local models run entirely in-process.
  Audio never leaves the machine.

## What TerminalX touches outside your repo

Driving somebody else's CLI means writing a few things outside your checkout.
All of them, in full:

- **`~/.claude.json`** — Claude Code asks "do you trust this folder?" the first
  time it runs anywhere new, and every session worktree is somewhere new. That
  dialog would swallow your first prompt where you could not see it, so
  TerminalX sets `projects["<worktree>"].hasTrustDialogAccepted` for each worktree it
  creates, and changes nothing else in the file. It does nothing at all if the
  file does not exist yet — a first-ever run's dialog is yours to answer.
- **`$RACCOON_HOME/codex`** — Codex reads hooks from `$CODEX_HOME/hooks.json`
  and only runs one whose hash is recorded in `$CODEX_HOME/config.toml`, so
  TerminalX needs a Codex home it owns. It builds one here and points
  `CODEX_HOME` at it for the tabs it launches. **Your `~/.codex` is never edited.** Instead
  the managed home *symlinks* to it: `auth.json`, `AGENTS.md`, `skills`,
  `prompts` and `plugins` are links, so you stay on the same account and a
  refreshed token lands in your own file.
- **`$RACCOON_HOME/run/hooks.sock`** — the unix control socket used by the
  CLIs' hooks and by `terminalx`. Created `0600`, inside the `0700`
  `$RACCOON_HOME` directory, and removed when the app exits.
- **`$RACCOON_HOME/run/control.token`** — a per-launch control credential,
  written `0600`. App-launched tabs receive the same value and socket path in
  `TERMINALX_NEXT_TOKEN` and `TERMINALX_NEXT_SOCKET`; normal shells read the
  file without printing it.
- **`~/.local/bin/terminalx` and `~/.local/bin/tnx`** — symlinks to the
  app executable, only when you press Install under Settings → General.
- **`~/.claude/skills/terminalx-cli` and
  `~/.agents/skills/terminalx-cli`** — the first-party discovery stub,
  only when you install it under Settings → Agents. Its full version-matched
  guide stays embedded in the binary.
- **`$RACCOON_HOME`** itself (default `~/.raccoon`) — projects, the session
  index, transcripts, settings, downloaded models, the non-secret account mirror,
  and paired-device records containing credential hashes rather than credentials.
  Created `0700`; the account session, host private key and device credentials
  remain in macOS Keychain.
- **`<repo>/.raccoon/worktrees/`** — inside your repository, but outside your
  working tree: the checkouts sessions run in.

## Permission modes

TerminalX's five modes are its own vocabulary; each maps onto flags the
two CLIs already have. This is the whole mapping:

| Mode | Claude Code | Codex |
| --- | --- | --- |
| **Plan** — read and plan only | `--permission-mode plan` | `-a on-request -s read-only` |
| **Ask every time** — every edit and command waits for you | `--permission-mode manual` | `-a on-request -s workspace-write`, plus a `PreToolUse` hook gate on *every* tool |
| **Auto** — routine actions approved, risky ones ask | `--permission-mode auto` | `-a on-request -s workspace-write` |
| **Accept edits** — edits go through, commands still ask | `--permission-mode acceptEdits` | `-a on-request -s workspace-write` |
| **Bypass** — nothing asks | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

Two things are worth knowing:

- **Codex has fewer knobs than Claude.** codex-cli 0.152 accepts only
  `on-request` or `never` for `-a`, so Auto and Accept edits land on the same
  pair as Ask every time. What separates Ask every time is not a flag:
  TerminalX gates every tool through the `PreToolUse` hook, which is the
  only way to be asked about a tool Codex would otherwise have run without asking.
- **Bypass means what it says** on both. No sandbox, no approvals, nothing
  asked. Use it only in a tree you would be happy to throw away.

The source of truth is `normalize_mode` in
`src-tauri/src/harness/claude/mod.rs` and `stance` / `asks_every_tool` in
`src-tauri/src/harness/codex/mod.rs`; both are covered by tests that assert
every mode names something the CLI will accept.

## Install

Download the `.dmg` from this repository's Releases page and drag TerminalX to
Applications. You will also need `claude` and/or `codex` installed and
logged in — TerminalX runs them, it does not replace them.

The macOS release is signed with a Developer ID certificate but is not notarized.
If macOS blocks the first launch, allow TerminalX under System Settings →
Privacy & Security → Open Anyway.

## Development

```sh
pnpm install
pnpm tauri:dev
```

The full setup, the four checks a change must pass, and the commit conventions
are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

- [docs/PTY-FIRST.md](docs/PTY-FIRST.md) — one process per tab: the CLI, its
  transcript, its hooks, and the two views onto it.
- [docs/PLAN.md](docs/PLAN.md) — the build plan and the principles the code is
  held to.
- [docs/RELEASING.md](docs/RELEASING.md) — dev and release builds, signing, and
  the update feed.
- [docs/ACCOUNTS.md](docs/ACCOUNTS.md) — the Phase 1 decision on optional
  accounts, device pairing and the cost of operating a service.
- [CHANGELOG.md](CHANGELOG.md) — what has shipped. The app renders it in the
  About tab.

## Security

Found something? See [SECURITY.md](SECURITY.md). Please do not open a public
issue for a vulnerability.

## License

MIT. See [LICENSE](LICENSE), and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
for the licences of everything TerminalX bundles or links against.

## Acknowledgements

TerminalX is the native successor to TerminalX Legacy. It carries forward the
app, its workflow, and its community while the new implementation grows toward
feature parity.

TerminalX also exists because other people built this category first and
built it well. Each of these shaped how it thinks, and any of them may suit you
better:

- [Conductor](https://conductor.build) — the idea that a workspace is a git
  worktree and that parallel agents each deserve their own.
- [MonoCode](https://www.usemono.dev) — a desktop UI over the agent CLIs you
  already have, rather than a service that resells them.
- [Cursor](https://cursor.com) — the shape of an agent conversation sitting
  next to an editor and a diff, and the polish that made it feel ordinary.
- [Orca](https://www.onorca.dev) — an agent development environment: terminals,
  editor, git and review gathered around the agents instead of beside them.
- [Superset](https://superset.sh) — running many agents at once without
  ceremony, and treating the terminal as a first-class surface rather than an
  escape hatch.
- [Dray](https://www.drayhq.com) — one app for Claude Code and Codex together,
  with issues and pull requests where the work already is.

Built on [Tauri](https://tauri.app), [React](https://react.dev) and
[xterm.js](https://xtermjs.org), and it drives
[Claude Code](https://claude.com/claude-code) and
[Codex](https://github.com/openai/codex).
