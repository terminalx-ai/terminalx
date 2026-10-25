# Headless runtime (`terminalx-serve`)

Cloud workspaces used to run the legacy Electron AppImage under Xvfb. `terminalx-serve`
replaces it with the current Rust backend, built without Tauri. It runs the same
harnesses (Claude/Codex PTY-first), hooks socket, control socket, transcript store and
git/worktree code as the desktop app, with no WebView, GTK or audio libraries (PRO-42).

## How it is built

- `src-tauri` has a default `desktop` feature. It enables Tauri, its plugins,
  `tauri-build` and `cpal`, plus the modules that only serve a window: commands, account,
  pairing, browser, computer use, dictation, media and the star reminder.
- `src-tauri/serve` is a workspace member that depends on the library with
  `default-features = false`. Its binary is a thin call into `raccoon_lib::serve::main`,
  and the desktop build compiles that module too, so clippy and the tests cover it.
- Sessions, terminals, the control service and pairing publish through
  `sink::EventSink` instead of an `AppHandle`:
  - On the desktop, the sink is the `AppHandle` itself, so every emit and listener
    behaves as before.
  - Headless, `BroadcastSink` runs Rust listeners inline and fans every event out on a
    broadcast channel. That channel is what the relay host will serve (PRO-13).
  - Session reactions (the star reminder and automation runs) go through
    `sink::SessionObserver`. The local runtime observer handles automation and
    pipeline turns; the star reminder remains in the window.

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
| `--idle-grace-seconds <1–3600>` | Local runtime's unattached idle grace; defaults to 60 seconds |

- **Stdout:** one JSON line when the runtime is ready (version, runtime kind, project root,
  data dir, socket path) and one when it stops. Logs go to stderr.
- **Shutdown:** `SIGTERM` or `SIGINT` stops it cleanly, killing agent children and PTYs
  and flushing activity.
- **Hooks:** the agent CLIs' hooks call back into the same binary as
  `terminalx-serve hook <Event>` and `terminalx-serve statusline`.
- **Control socket:** the runtime listens on `run/hooks-<pid>.sock` in the data dir, which is
  the socket path in its ready line and what its agent tabs are given. It also answers on the
  published `run/hooks.sock`, authenticated by `run/control.token`. Local mode now refuses
  another local owner or an existing desktop on the same data directory before opening
  session stores. Cloud publication retains its existing takeover behavior.
  `status` reports ownership of the published endpoint as `publishesHome`.
  Both sockets speak the desktop's JSON-lines protocol:
  - `status`, `projects`, `sessions`, `tabs`, `send`, `read`, `wait`, `permissions`,
    `worktrees` and `issues` work as on the desktop.
  - `browser.*` and `computer.*` return `unsupported`.
- **Socket path length:** keep `--data-dir` short. A Unix socket path must fit in about
  104 bytes.

### Local ownership and attachment API (#467, desktop wiring in progress)

Local mode holds `run/local-runtime.lock` for its lifetime. `status.localRuntime`
reports `protocol: 1`, an `epoch` unique to the process, attached-client count,
idle grace and the authenticated `eventSocket`. The existing control request
envelope and token protect these additional methods:

- `runtime.attach` takes `{protocol: 1}` and returns an epoch and lease.
- `runtime.heartbeat` and `runtime.detach` take that epoch and lease. Renew every
  five seconds; a lease expires after twenty seconds without renewal.
- `runtime.stopAll` takes the observed epoch and stops work in this runtime.
  An epoch from a previous runtime is refused. Stop rejects new work, fences
  queued follow-ups, terminates children and flushes activity before exit.
- `runtime.session.*` forwards typed session operations to the same manager;
  `runtime.pty.*` forwards shell creation, input, resize and retained-output reads.

The Unix event socket expects `{protocol: 1, token}` as its first JSON line and
responds with `{type: "ready", attachment}`. It publishes backend `event` frames
and PTY frames only for explicitly attached panes. Send `attach` with `id` and
view `token`, `ack` with the cumulative `drawn` byte count, or `detach` with the
same id/token. `ping` answers `pong`. Each connection has its own window identity,
so one disconnected window cannot detach another window's tap. Connections own
a lease automatically; EOF, lag or a failed writer removes all their taps.
Frames are bounded to 1 MiB, with a 2 MiB output budget per connection. A client
that lags must reconnect and reload durable chat history and bounded PTY replay.
The native bridge must decode PTY base64 back to the existing raw frontend channel.

Idle grace runs only with no attachments, accepted requests or live work.
Currently any live PTY conservatively keeps the runtime alive; proving idle
shells/agent processes and desktop connection/quit integration remain in progress.
Local mode without a relay link starts the existing automation scheduler and
pipeline observer. Enabled schedules keep the owner available between runs;
disabled schedules do not. Open automation runs from a previous owner are
recovered before client admission. Reattachment never repeats that recovery.
Cloud workspaces continue using their cloud schedule mailbox separately.
These APIs do not yet change how quitting the desktop behaves.

## Cloud idle activity

The activity reporter sends `activeTurns` and `pendingApprovals` at least every
45 seconds while either is nonzero, including when no client is attached or only
a viewer is watching. A turn's five-minute silence warning changes its displayed
status to "Needs attention", but does not end the turn or remove its cloud activity
protection (#419).

A live turn keeps counting through that warning for up to **one hour without
agent events or terminal output** (`cloud_activity::MAX_TURN_SILENCE`). This is a
separate budget from the UI warning and the workspace's configured idle timeout.
New events or terminal output renew the budget. Completion, process exit, an
actual provider error, or unconfirmed prompt delivery do not get this extension.
Permission requests remain in `pendingApprovals` under the existing policy.

At the one-hour limit the runtime reports the silent turn as inactive; it does
not kill the agent or claim the turn completed. The server may then suspend the
workspace under its idle policy, potentially immediately if its idle timeout has
already elapsed. A legitimate command silent for an hour has the same limit.
Process liveness is required, but neither a live agent nor a live child is proof
of progress: both can hang, so neither grants an unlimited exemption.

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
- `runtime.json`: workspace, organization, relay host id, runtime credential and the
  SHA-256 of the token it was bought with. Rotating credentials deletes it before
  writing a new token.
- `lock`: held with `flock` while the runtime runs; a second runtime on the same data dir
  refuses to start.

Every step survives `kill -9`:

1. Generate and durably write the host key (temp file, fsync, rename, fsync dir).
2. If `runtime.json` exists, refresh with it. On success, delete the token only if it is
   the one already spent; a newly provisioned token stays. If the credential is rejected
   and a new token is present, redeem the new token.
3. Otherwise redeem the token. The token stays on disk until the credential is durably
   in `runtime.json`; only then is it deleted.
4. If the process dies after the server committed the redeem but before the credential
   reached the disk, the retry redeems the same token with the same host key. The server
   replays the redeem for that key and rotates the credential (terminalx-saas, PRO-42).
   An older server rejects the replay: the token is still kept and the runtime exits 3.

Failures are retried in the process with backoff (1s doubling to 30s), not by systemd
restarts, which would hit the unit's start limit during a short outage:

- An unreachable API or a 5xx is retried until it answers.
- A 401 is retried too, because the server also answers 401 while a workspace is briefly
  in another state. Only when the token or credential has been rejected for 10 minutes
  straight (the token's lifetime) does the runtime exit `3`. The unit sets
  `RestartPreventExitStatus=3`, and the next credential rotation restarts it.
- A missing or malformed token with no stored identity exits `3` at once. Local faults
  (unreadable state, a host key that does not match the stored identity) exit `1`.

The token is kept in every failure case.

Requests carry `x-terminalx-cloud-workspace-runtime-version` and, on refresh,
`x-terminalx-cloud-workspace-runtime-capabilities` (`organization-access-v1`,
`agent-grants-v1`, `github-broker-v1`, `quiesce-v1`, `environment-template-v1`,
`collaboration-v1`, `attachment-installation-v1`; see `CAPABILITIES` in `src/cloud_bootstrap.rs`). With `quiesce-v1` the
refresh answer carries an archive's final-checkpoint request, which `src/cloud_quiesce.rs`
answers (see [CLOUD-LIFECYCLE.md](CLOUD-LIFECYCLE.md)). With `collaboration-v1` it carries
who the workspace is shared with ([CLOUD-SHARING.md](CLOUD-SHARING.md)). With `attachment-installation-v1` each attachment carries
an `installationKey`, by which a person's terminal comes back to them after a wake (same document). The `ready` line reports `cloudWorkspace`
(`workspaceId`, `relayHostId`, `capabilities`), or `null` without a bootstrap. The session
is refreshed every 5 seconds in the background, as the legacy runtime did: a new
attachment waits for the next refresh before the relay host can answer it, and a revoked
share stops access that promptly.

## Environment templates (PRO-15)

A workspace pinned to an Environment version boots from an image that already holds every
repository at `/home/repos/<owner>/<name>`. `environment-template-v1` makes the refresh
carry `setup.environment`, and `cloud_environment.rs` applies it after the GitHub
credential helper is installed and before any agent starts (a plan that only arrives on a
later refresh is applied then):

- An entry with a `ref` switches that checkout to the branch. The single ref is fetched
  first only when the image lacks it. Launch never clones.
- An entry without a `ref` stays on the built default branch.
- The whole checkout is bounded (120 s); a timed-out git call has its process group killed.
- The outcome goes to `/v1/cloud-workspace-bootstrap/progress` (`repository-ready` or
  `repository-clone-failed`), then to `environment-checkout.json` next to the bootstrap
  token, where the worker and the local e2e read it. The record is written whether or not
  the API takes the report (it answers 401 once the operation has settled), so a
  successful checkout of a version is final and a restart never switches a person's
  branch back. A failed checkout or a new version is applied again on the next boot.
- A checkout this process cannot see (`unreachable`: the directory cannot be opened, as
  under the systemd unit's `ProtectHome=true`, which hides `/home/repos`) is not a failed
  clone: git never ran. Nothing is reported, the record says `unreachable`, and it is
  tried again on the next boot. A directory that is there but is not a checkout is still
  `missing`, and reported as `repository-clone-failed`.

Debug builds honour `TERMINALX_SERVE_TEST_CRASH_AT=<step>`, which SIGKILLs the process at
that step. `serve/tests/bootstrap_crash.rs` uses it against a fake server to check each
step. Release builds compile it out.

## Relay host and workspace RPC (PRO-13)

A bootstrapped runtime with `--project-root` registers with the relay as a Host, outbound
only, using the bootstrap's Relay Token and host key (`src/remote/host.rs`):

- Director `/v1/assign`, then the Cell's `/v1/host/control` with the host proof bound to
  the token's identity. The token's `runtimeGeneration` is the generation it serves; a
  `4101` from the relay means a newer runtime replaced it, and it stays down (`fenced`).
- Each pending attachment from `/refresh` gets a single-use relay invite and a pairing
  code (offer v2), published with `/attachments/:id/complete`. Attached devices (token
  hashes only) are kept in `run/remote-devices.json`.
- Each revocation from `/refresh` drops the device and closes its connections, then, once
  the device list is saved, is confirmed with `/revocations/:id/complete`. The API lists a revocation until it is
  confirmed, and a refresh that lists more than 256 is refused, so an unconfirmed backlog
  would eventually stop the relay token from renewing.
- A client connection runs the E2EE v2 handshake, proves the attachment's device token,
  may install a resume credential (`pairing.provisionRelay`) and then speaks
  `terminalx-workspace-rpc/1` (`src/remote/server.rs`): `rpc.hello` capability
  negotiation and the versioned `pty.*`, `fs.*`, `git.*`, `session.*`, `keys.*`,
  `lifecycle.*` and `runtime.agents` methods, plus sharing (`collab/1`,
  [CLOUD-SHARING.md](CLOUD-SHARING.md)); see `CAPABILITIES` and `METHODS` in
  `src/remote/protocol.rs`. Each is authorized against the attachment's authority, with
  idempotent mutations. `session/2`, `pty/2`, `agents/1` and `collab/1` are additive: a
  client that asks only for `session/1` and `pty/1` is served as before.
- A rejected runtime credential disconnects every client and stops serving until the
  API accepts one again.

Registration states are printed as `{"type":"relay","status":{...}}` lines.
`--relay-link <file>` reads the relay session from a JSON file instead of the bootstrap;
`scripts/remote-runtime/e2e.sh` uses it to run `serve/tests/relay_e2e.rs` against the
terminalx-saas relay code.

## Testing on Linux

`scripts/remote-runtime/e2e-linux.sh` builds `terminalx-serve` in a `rust:1-bookworm`
container (`scripts/remote-runtime/linux.Dockerfile`, with bun, Redis and python3) and runs
the relay e2e there, so a Mac checks the Linux runtime the cloud boots:

```sh
TERMINALX_SAAS_DIR=~/code/ai/terminalx/terminalx-saas scripts/remote-runtime/e2e-linux.sh
UNIT=1 ...        # also the library unit tests, serve's clippy and its own tests
BUILD_ONLY=1 ...  # only the binary, at target-linux/terminalx-serve
```

`two_agent_tabs_and_a_shell_survive_a_reattach_and_a_fenced_restart` is the PRO-12 check:
two fake-Claude agent tabs and a shell run at once, a new connection finds the same tabs,
transcripts, shell process and output, and after a reboot on a newer generation the old
generation is refused, transcripts survive and the old shell is gone. It then exercises
the additive namespaces on that runtime: `runtime.agents`, `session.addTab` (and its
resend), `session.update`, a session's terminal (`pty.create` with `sessionId`) and
`session.delete`, which closes that terminal and leaves the others. terminalx-saas
`bun run cloud:e2e:local` builds its local-docker image from `target-linux/terminalx-serve`
(or `TERMINALX_SERVE_BIN`) and runs the full workspace lifecycle against it.

## Not yet

- **Repository clone** for a workspace without an Environment template. The runtime does
  not advertise `organization-setup-v*`, so the server sends no clone list and such a
  workspace starts with an empty project; a launch into it makes the folder a Git
  repository on its work branch. Organization credentials need no setup: agent
  logins arrive as sealed grants (`cloud_grants`) and GitHub access through the broker
  (`cloud_github`).
- **The `terminalx` agent CLI inside the runtime.** The CLI module links the desktop's
  computer-use and browser parsers, so it is still desktop-only.
- **A signed artifact, and arm64 in the cloud.** `release-serve.yml` publishes
  `terminalx-serve-linux-x64` and `-arm64` as a runtime prerelease after CI passes on
  `main` ([RELEASING.md](RELEASING.md)). terminalx-saas installs the newest compatible x64
  one by default (versioned directory, atomic `current` swap, health check, rollback). It
  is verified by SHA-256, not signed, and the server does not provision the arm64 build.
