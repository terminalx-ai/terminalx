# Raccoon

Raccoon is a desktop workbench for the coding agents already installed on your
machine. Every session is its own git worktree, and a session holds tabs — each
tab an agent conversation against that same tree. A Claude Code or Codex tab
*is* the real interactive CLI, running in a PTY: the chat you read is a
projection of that one process, built from the transcript the CLI writes and
the hooks it runs, and ⌘⇧T flips between the chat and the terminal without
stopping anything or waiting for a turn to end. One process, two views. See
[docs/PTY-FIRST.md](docs/PTY-FIRST.md) for how that works and why.

Raccoon is macOS-only today, and it brings no compute of its own: it drives the
`claude` and `codex` CLIs you are already logged into.

## What it does

- **Sessions are worktrees.** Creating a session creates a branch and a
  checkout under `.raccoon/worktrees/`; settling one offers to remove it, and
  deleting is guarded by unpushed commits and open pull requests.
- **Chat and terminal are the same process.** Switch views mid-turn; nothing is
  resumed or reconciled.
- **Permission cards and status from the CLI's own hooks** — approvals asked in
  the chat, including an "ask every time" mode for Codex that covers every
  tool, with Codex's hooks installed in a home Raccoon manages so your
  `~/.codex` is never edited.
- **A composer that never hides**: `@` file mentions, `/` slash commands,
  images by drop or paste, and follow-ups queued while a turn runs.
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
- **A terminal dock** (⌘J) whose shells live in the session's checkout and
  survive switching sessions.
- **Agent dashboard** (⌘⇧A): every session across every project in three
  columns — needs you, working, done — with search, filters and keyboard
  navigation.
- **Projects and workspaces**: a projects rail with colours and logos, and
  every checkout — including worktrees made outside the app — listed with its
  sessions.
- **Notifications graded by attention** (banner, in-app notice, or just a
  tone), a Dock badge, four themes in light and dark, and a pixel raccoon that
  potters about while you wait.

## Install

Download the `.dmg` from this repository's Releases page and drag Raccoon to
Applications. You will also need `claude` and/or `codex` installed and logged
in — Raccoon runs them, it does not replace them.

The build is ad-hoc signed rather than notarized, so on first launch macOS will
warn that it cannot verify the developer. Open it once from the right-click
menu (Control-click → Open → Open), or allow it under System Settings →
Privacy & Security, and Gatekeeper will not ask again.

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
- [CHANGELOG.md](CHANGELOG.md) — what has shipped. The app renders it in the
  About tab.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

Raccoon exists because other people built this category first and built it
well. Each of these shaped how it thinks, and any of them may suit you better:

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
