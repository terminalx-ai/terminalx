# Contributing to Raccoon

Thanks for wanting to help. Raccoon is a Tauri 2 (Rust) app with a React 19
front end, and it drives the agent CLIs you already have installed. That means
the interesting bugs usually live where the app meets a real process, so please
run what you change.

## Prerequisites

- **Rust**, stable toolchain, with `clippy` and `rustfmt`. `rust-toolchain.toml`
  asks for all of it, so `rustup` installs it on the first build.
- **Node** 20 or newer (`.nvmrc`) and **pnpm** (`corepack enable`, which reads
  the `packageManager` field and gets the right version).
- **Xcode command line tools** for a dev build. A *full* Xcode install is
  needed for `pnpm tauri build`: the build script links clang's builtins
  archive (`libclang_rt.osx.a`) for the local transcription engine's Metal
  code, and the command line tools alone may not ship it. See
  [docs/RELEASING.md](docs/RELEASING.md).
- The **`claude`** and **`codex`** CLIs, logged in, if you want to run agents.
  Raccoon spawns them; it does not bundle or proxy them.
- macOS on Apple silicon is the only platform currently built and tested.

## Setup

```sh
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` runs the badged dev build (`Raccoon Dev`, its own bundle
identifier and Dock icon), so it can sit beside an installed release without
either one clobbering the other's macOS permission grants.

Both builds read the same store at `~/.raccoon`. To keep your development
sessions, projects and settings away from your real ones, point `RACCOON_HOME`
somewhere else:

```sh
RACCOON_HOME=~/.raccoon-dev pnpm tauri:dev
```

## The four checks

All four must pass before you open a pull request:

```sh
pnpm exec tsc --noEmit
pnpm vitest run
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test
```

`pnpm check` runs the first two together and `pnpm test` runs vitest alone.
The same four run on every pull request in `.github/workflows/ci.yml`, on
macOS, because the Rust side links AppKit, AVFoundation and Speech and will
not build anywhere else.

Clippy is run with `-D warnings`, so a warning is a failure.

If you have `pnpm tauri:dev` running while you do this, give the cargo commands
their own target directory so the two do not fight over the same lock and
rebuild each other's artifacts:

```sh
CARGO_TARGET_DIR=$PWD/target/check cargo clippy --all-targets -- -D warnings
```

The same advice applies to release builds, and the reasoning is in
[docs/RELEASING.md](docs/RELEASING.md): the Tauri build script re-runs whenever
`TAURI_CONFIG` changes, and `pnpm tauri:dev` sets it.

## Branches and worktrees

Work on a branch off `main`. Raccoon is built with worktrees and it is a
pleasant way to develop it too:

```sh
git worktree add ../raccoon-wt/my-change -b feat/my-change main
```

Keep a change to one topic. If a change is large, land it as a sequence of
commits that each leave the app runnable.

## Commits and pull requests

- Imperative summary line, no type prefix, no scope, no trailing period —
  "Close a turn once, not once per closer".
- A short body saying *why*, in prose. What changed is in the diff; the body is
  for the reason, the constraint, or the thing that surprised you.
- **No trailers.** No `Co-Authored-By`, no generated-with lines, nothing after
  the body.
- One commit per runnable change. `pnpm tauri:dev` should start on every commit
  in the branch.
- The pull request description is the same shape: what problem, what approach,
  how you verified it. Say which of the four checks you ran and on what.

## No mock data, no simplified stand-ins

A pull request must not add placeholder data, fake fixtures standing in for a
real code path, or a "simplified version" of a feature meant to be filled in
later. Test fixtures captured from a real CLI are fine and are how the harness
tests work. Something that merely looks like it works is not.

## Adding a harness

A harness is one agent CLI. They live in `src-tauri/src/harness/`:

- `claude/` and `codex/` are **PTY-first**: the tab *is* the interactive CLI
  running in a PTY, the chat is a projection of the transcript it writes, and
  status and permission cards come from its hooks. `tui.rs` holds what the two
  have in common. Read [docs/PTY-FIRST.md](docs/PTY-FIRST.md) before touching
  either.
- `acp/` and `opencode/` are **headless**: a peer driven over a pipe, where
  each inbound line becomes a list of `Action`s the session manager applies.
  That shape is testable on fixtures but hands a tab off when you switch to
  the terminal view, which is why it is no longer what Raccoon offers.

Which harnesses the UI offers is decided in exactly one place —
`HIDDEN_HARNESSES` in `src-tauri/src/harness/mod.rs`. A hidden harness is not
deleted: its adapter, its models, and any tab already running on it keep
working. Adding a harness means a parser and a mapper onto the normalized
`AgentEvent` stream in `src-tauri/src/events.rs` (with its TypeScript twin in
`src/types/events.ts`) — the UI and the on-disk log never see a raw protocol.

## Design docs

`docs/` is the place to look before a large change, and the place to write when
you make one:

- [docs/PLAN.md](docs/PLAN.md) — the build plan, its principles, and what each
  checkpoint delivered.
- [docs/PTY-FIRST.md](docs/PTY-FIRST.md) — why a tab is one process, and how
  the chat, the terminal view, the transcript and the hooks fit together.
- [docs/RELEASING.md](docs/RELEASING.md) — dev vs release builds, signing, the
  updater feed, and the macOS entitlement traps.

## Reporting bugs and security issues

Open a GitHub issue for a bug. Include your macOS version, which agent CLI and
version, and what the tab was doing — attach the relevant part of
`~/.raccoon/sessions/<id>.jsonl` if you can share it.

For anything with a security impact, do **not** open a public issue. Email
dudhatparesh@gmail.com — the full policy, including scope and the disclosure
window, is in [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Contributions are licensed under the [MIT License](LICENSE).
