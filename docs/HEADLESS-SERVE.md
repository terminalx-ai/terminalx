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
| `--data-dir <dir>` | State directory (sets `TERMINALX_HOME`). Required unless `TERMINALX_HOME` is set: the runtime never falls back to the desktop app's `~/.raccoon` |
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

## Cloud workspace bootstrap

With `--runtime-kind cloud-workspace`, the runtime establishes its identity before it
serves anything, using the same contract as the legacy runtime
(`POST /v1/cloud-workspace-bootstrap/redeem` and `/refresh` on terminalx-saas `apps/api`).

| Variable | Meaning |
| --- | --- |
| `TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_ORIGIN` | API origin: https, or http on loopback |
| `TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_TOKEN_PATH` | File holding the one-time bootstrap token |

Set both or neither; with neither the runtime serves without a cloud identity. State lives
in `<data-dir>/cloud-workspace/` (mode 0700):

- `host-key.json`: the X25519 relay host key. The relay host id is derived from it the
  same way the server does. It is written before the token is ever sent and is never
  regenerated, so every attempt names the same host. Rotating credentials must keep it.
- `runtime.json`: workspace, organization, relay host id and runtime credential.
  Rotating credentials deletes it before writing a new token.

Every step survives `kill -9`:

1. Generate and durably write the host key (temp file, fsync, rename, fsync dir).
2. If `runtime.json` exists, refresh with it. On success, delete a token a previous run
   left behind. If the credential is rejected and a token is present, redeem the token.
3. Otherwise redeem the token. The token stays on disk until the credential is durably
   in `runtime.json`; only then is it deleted.
4. If the process dies after the server committed the redeem but before the credential
   reached the disk, the retry redeems the same token with the same host key. The server
   replays the redeem for that key and rotates the credential (terminalx-saas, PRO-42).
   An older server rejects the replay: the token is still kept and the runtime exits 3.

Exit codes: `3` means the server rejected the token or credential and a restart cannot
help (the systemd unit sets `RestartPreventExitStatus=3`). `1` is transient, such as the
API being unreachable. Both keep the token.

Requests carry `x-terminalx-cloud-workspace-runtime-version` and, on refresh,
`x-terminalx-cloud-workspace-runtime-capabilities: organization-access-v1`. The `ready`
line reports `capabilities` and `cloudWorkspace` (`workspaceId`, `relayHostId`). The
session is refreshed every 30 seconds in the background.

Debug builds honour `TERMINALX_SERVE_TEST_CRASH_AT=<step>`, which SIGKILLs the process at
that step. `serve/tests/bootstrap_crash.rs` uses it against a fake server to check each
step. Release builds compile it out.

## Not yet

- **Relay host registration and the portable RPC surface (PRO-13).** `BroadcastSink::subscribe`
  is the event feed that will serve it.
- **First-run setup** (organization credentials, repository clone). The runtime does not
  advertise `organization-setup-v*`, so the server does not send it.
- **The `terminalx` agent CLI inside the runtime.** The CLI module links the desktop's
  computer-use and browser parsers, so it is still desktop-only.
- **Cloud installation.** The saas bootstrap script still installs the AppImage. Switching
  it to this binary behind a flag, and the signed, pinned linux-x64/arm64 artifact with an
  atomic `current` symlink swap, are separate steps.
