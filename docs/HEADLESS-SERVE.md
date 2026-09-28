# Headless runtime (`terminalx-serve`)

Cloud workspaces used to run the legacy Electron AppImage under Xvfb. `terminalx-serve`
replaces it with the current Rust backend, built without Tauri. It runs the same
harnesses (Claude/Codex PTY-first), hooks socket, control socket, transcript store and
git/worktree code as the desktop app, with no WebView, GTK or audio libraries (PRO-42).

## How it is built

- `src-tauri` has a default `desktop` feature. It enables Tauri, its plugins,
  `tauri-build` and `cpal`, plus the modules that only serve a window: commands, account,
  pairing, automations, browser, computer use, dictation, media and the star reminder.
- `src-tauri/serve` is a workspace member that depends on the library with
  `default-features = false`. Its binary is a thin call into `raccoon_lib::serve::main`,
  and the desktop build compiles that module too, so clippy and the tests cover it.
- Sessions, terminals, the control service and pairing publish through
  `sink::EventSink` instead of an `AppHandle`:
  - On the desktop, the sink is the `AppHandle` itself, so every emit and listener
    behaves as before.
  - Headless, `BroadcastSink` runs Rust listeners inline and fans every event out on a
    broadcast channel. That channel is what the relay host will serve (PRO-13).
  - Desktop-only reactions (the star reminder and automation runs) go through
    `sink::SessionObserver`, which is a no-op headless.

```sh
cd src-tauri/serve && cargo build --bin terminalx-serve   # or: cargo build -p terminalx-serve
```

Building from `src-tauri` with `--bin` alone searches only the desktop package, so select
the serve package (its directory or `-p`). Otherwise the desktop features are unified in.

## Running

```sh
terminalx-serve --project-root /workspace --data-dir /var/lib/terminalx --runtime-kind cloud-workspace
```

| Flag | Meaning |
| --- | --- |
| `--project-root <dir>` | Registers the directory as a project; agents run in it |
| `--data-dir <dir>` | State directory (sets `TERMINALX_HOME`); defaults to `$TERMINALX_HOME`, then `~/.raccoon` |
| `--runtime-kind <kind>` | `local` (default) or `cloud-workspace`, which requires `--project-root`. Reported as `runtimeKind` by the control `status` command |
| `--self-test` | Start, run the login shell in a PTY, type a command, wait for its answer and exit, then stop |

- **Stdout:** one JSON line when the runtime is ready (version, runtime kind, project root,
  data dir, socket path) and one when it stops. Logs go to stderr.
- **Shutdown:** `SIGTERM` or `SIGINT` stops it cleanly, killing agent children and PTYs
  and flushing activity.
- **Hooks:** the agent CLIs' hooks call back into the same binary as
  `terminalx-serve hook <Event>` and `terminalx-serve statusline`.
- **Control socket:** `run/hooks.sock` in the data dir, authenticated by `run/control.token`.
  It speaks the desktop's JSON-lines protocol:
  - `status`, `projects`, `sessions`, `tabs`, `send`, `read`, `wait`, `permissions`,
    `worktrees` and `issues` work as on the desktop.
  - `browser.*` and `computer.*` return `unsupported`.
- **Socket path length:** keep `--data-dir` short. A Unix socket path must fit in about
  104 bytes.

## Not yet

- **Relay host registration and the portable RPC surface (PRO-13).** `BroadcastSink::subscribe`
  is the event feed that will serve it.
- **Bootstrap redeem/refresh with a replay-safe identity (PRO-12).**
- **The `terminalx` agent CLI inside the runtime.** The CLI module links the desktop's
  computer-use and browser parsers, so it is still desktop-only.
- **Cloud installation.** The saas bootstrap script still installs the AppImage. Switching
  it to this binary behind a flag, and the signed, pinned linux-x64/arm64 artifact with an
  atomic `current` symlink swap, are separate steps.
