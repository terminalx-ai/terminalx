# Local background runtime (#467)

The desktop now attaches to a separately launched local `terminalx-serve` owner.
Session processes, transcript readers, permission waits, queue delivery, activity,
local pipelines and scheduled automations belong to that owner. Closing or quitting
the desktop detaches views; it does not stop accepted work. Final packaged
acceptance and independent review remain in progress; this document does not
claim production signing, updater or credentialed-provider acceptance.

The helper is copied into a verified, immutable private location before launch,
with a lifetime lock and authenticated per-launch sockets. Desktop callbacks use
a private endpoint and a fixed service allowlist bound to the live attachment.
The owner never forwards generic control authority to paired devices or guests.
Store read-modify-write transactions use a stable cross-process lock, preserving
unknown fields and closed-tab history across atomic file replacement.

PTY readers retain bounded output and atomically replay it when a view attaches.
View acknowledgements remain independent, so a detached or stalled view cannot
block its process forever. Pending permissions remain at the owner; expired,
cancelled or stale answers fail closed. Only a new owner performs interruption
recovery. Transport loss is reported as unavailable rather than false idle state.

Normal quit defaults to keeping work, with a first-choice dialog and saved policy.
Explicit stop-all confirms process termination and retains recoverable state on
failure. A single accessory tray remains with the owner, shows live counts and
routes Open, Quick Chat and quit actions through the registered window. Local
notifications and automations continue there; dictation, computer use, the browser
and mobile connection transport remain window-owned. An unattached owner exits
after its idle grace only when no live shell, active turn, permission, queued work,
cleanup or enabled schedule remains. AppKit receives a private wake event when
backend shutdown completes, so idle exit does not require a user's mouse event.

See [the isolated acceptance procedure](LOCAL-RUNTIME-ACCEPTANCE.md) for measured
artifact requirements and the distinction between fixture/development evidence
and real accounts, production updates and notarization.

## Original proposal and checkpoint record

The following investigation and checkpoint notes are historical; statements that
integration remains unfinished describe their checkpoint, not current source.

Original status: implementation in progress, **not complete**. The original investigation
used `958d1c77` (includes #464 / #621); main through #567 / #622 (`22429b99`)
was merged as `9c6e7830`. The coordinator released session/pipeline/control
integration and confirmed ownership of native `pty.rs`, `sink.rs` and PTY
command handlers. #232 retains its frontend terminal and performance files.
Local owner locking, lifecycle control and bounded event/PTY streams now run in
`terminalx-serve`; desktop ownership and quit integration remain unfinished.

## Current ownership and reusable paths

| Concern | Current owner and path | Required background owner |
| --- | --- | --- |
| Agent processes | Desktop `AppState` constructs `Host`, `Terminals`, `SessionManager`; `lib.rs` destroys them with the main window | The same objects in `serve.rs`, one per data directory |
| PTY output/input | `pty.rs` reader, bounded 512 KiB byte tail, atomic `attach` replay/live handoff, tap acknowledgements; desktop channels in `sink.rs` | Runtime owns reader, history and flow control; window is a detachable tap |
| Chat/status | `session.rs` projects provider transcripts into stored events, index and activity | Runtime tails and publishes while no window exists |
| Permissions/questions | Authenticated `hooks.rs` frames enter `SessionManager::on_hook`; in-memory pending asks and decision senders; control decisions return to the blocked hook | Runtime retains the actual decision receiver; reconnect snapshots must distinguish pending from expired asks |
| Queue | PTY CLI owns typed pending prompts; session tracks echoes; headless `TabRuntime.queued` drains on turn completion | Runtime keeps both paths and #567 continuation authorization intact |
| Terminal-launched agents | `session_follow.rs` foreground monitoring currently starts only on desktop | Enable for local background runtime, not implicitly for cloud |
| Recovery | `serve::start` calls `idle_orphaned_tabs`; desktop also initializes local stores | Only a new runtime generation recovers old records; UI attachment must never initialize or reset runtime stores |
| Control | Per-launch authenticated socket plus `hooks.sock` publication guarded by `hooks.lock` | Keep per-launch hook identity; a separate lifetime lock must prevent multiple local owners before any store mutation |
| Cloud RPC | `remote/{host,server,protocol}` exposes versioned workspace methods with authority checks and idempotency | Reuse handlers over authenticated local transport, preserving cloud capabilities and authorization |

The original `terminalx-serve --runtime-kind local` had no UI lease or idle
shutdown. The current implementation adds those and an authenticated event/PTY
socket alongside its existing request/response control socket; desktop
notification hosting and complete desktop RPC integration remain unfinished.
`BroadcastSink` is bounded and can lag: subscribing alone is not a durable replay
mechanism. Local mode now starts its own pipeline observer without a synthetic cloud
identity or cloud agent mailbox. The local owner now also uses the existing
scheduler and automation store through a portable host; cloud scheduling stays
on its existing path. Recovery of open local automation runs completes before
external requests are admitted. Enabled schedules count as standing work even
between runs; disabled schedules do not prevent idle exit. Desktop scheduler
ownership still needs to move when desktop attachment is wired.

## Proposed ownership and attachment

Launch a signed, versioned local `terminalx-serve` helper independently of the
desktop process, with standard streams redirected to bounded private logs and
no inherited window pipes. Use the same login environment resolution and provider
homes as current desktop launches. Do not move, migrate or refresh provider
credentials. Child processes receive the runtime's hook/control endpoint, never
the window's PID or bundle-relative hook executable.

Before initializing any store, acquire an OS lifetime lock under the canonical
data directory. A losing launcher connects to the authenticated owner or reports
an incompatible live owner; it must not reset tabs or replace the owner's token.
The existing publication lock only elects a socket publisher and permits several
live runtimes, so it is insufficient for store ownership. Never unlink a held
lock file. Refuse symlinked/insecure endpoint artifacts and keep directory and
socket permissions owner-only. Boot/runtime generation, protocol capabilities
and process identity belong in the authenticated handshake; a PID file alone is
not proof of ownership. Retain per-tab hook authentication and remote authority
checks. A paired viewer must never acquire local-owner powers through this path.

The desktop becomes a client before loading sessions. Sequence:

1. Discover or start the owner, authenticate and negotiate supported namespaces.
2. Establish event subscription before taking the session/status/pending-ask
   snapshot at a revision watermark. Replay stored events beyond each chat
   cursor, deduplicate by event identity, then follow live events.
3. Attach each visible PTY with the existing atomic history/live boundary;
   forward input, resize and acknowledgements. A disconnected window releases
   its taps so stale flow-control credits cannot block a background command.
4. On lag or reconnect, repeat snapshot/replay; never call `ensure_started` just
   because transport disconnected. Failed transport is not a finished turn.

Use an additive local lifecycle namespace for attach/lease/detach and stop-all;
the current protocol is described in HEADLESS-SERVE.md. Do not proxy arbitrary Tauri
command names. Inventory `commands.rs`, `src/lib/api.ts` and portable workspace
methods before wiring: local mode must support multiple projects, unlike the
existing one-root cloud connection. Destructive worktree operations stay at the
runtime owner and preserve #464 history retention and removal dispositions.

## Lifetime and honest recovery

Proposed unattached idle grace: 60 seconds, reset whenever real work or a client
returns. Pending approvals/questions, queued delivery, pipelines, cleanup and
in-flight mutations count as work. Do not reuse `turn_counts()` as the shutdown
predicate: its cloud silence budget eventually excludes a still-live turn.
Unknown terminal activity is busy; silence is never evidence that a command
finished. An open plain shell preserves its environment and remains live, even
at its prompt. Managed, settled agent CLIs qualify only when a final process
table inspection proves they have no descendants; unknown activity stays live.
Idle agent CLIs may close only after their turns, pending asks and queues drain.
Idle shutdown and new attach/start must serialize under the lifecycle state
machine so work cannot be accepted after shutdown commits.

Stop-all first rejects new work and cancels queues/automations, then records
intentional stop, terminates process groups using existing teardown, flushes
activity and releases sockets/lock last. It is distinct from client detach.
SIGTERM/logout ends work and persists interruption honestly. A crash or reboot
creates a new generation; retained transcripts survive but pending decisions
and PTY process identities must not be reported live. No automatic restart of
an interrupted turn. Do not configure a helper to restart after logout or boot.

## Permission and output constraints requiring implementation

Local owner permission hooks now share one policy: provider timeout 2,147,483
seconds, owner decision deadline 30 seconds earlier, bridge deadline 15 seconds
earlier. This is finite (about 24.8 days), not an unlimited hook. Inspection of
installed Claude Code 2.1.309 found a positive seconds schema and command runner
`Math.min(timeout * 1000, 2147483647)`. Codex 0.153.4 normalizes deciding timeouts
with a 600-second default and no 600-second ceiling; an isolated real
`app-server hooks/list` accepted 2,147,483 seconds for both PermissionRequest and
PreToolUse without warnings. Only SessionEnd/Interrupt are capped at 3 seconds
in that Codex version. The repeatable evidence script is
`scripts/local-runtime/provider-hook-probe.py`; Claude evidence is static binary
inspection, not a real permission round-trip. Sources:
[Codex 0.153.4 normalization](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/hooks/src/engine/discovery.rs)
and [Claude hook timeout behavior](https://code.claude.com/docs/en/hooks#timeouts).

The policy is enabled only after the local runtime acquires its ownership lock.
Cloud/default command and reporting waits remain unchanged. Deciding bridge
commands carry an explicit failure-policy argument, which grants no authority:
origin tokens/session/tab checks still happen in the owner. Missing/refused/lost
owner transports return denial JSON for both gates, never an empty allow-through
reply. Pending cards hold owner lifetime, independently of view leases. Sender
removal cancels immediately; a disconnected hook is detected within 100 ms,
without a watcher thread or a runtime lock held while waiting. Answers also
check the live hook connection at admission. At most 256 deciding waits are
retained per owner; excess requests are denied. Reaching the finite ceiling
withdraws the card and denies, rather than presenting an answerable stale card.
Real Claude/Codex interactive permission behavior and packaged quit/reopen still
need guest acceptance; elapsed provider timers cannot be renewed by a UI attach.

Each live PTY retains a bounded 512 KiB tail. At orderly idle shutdown the
owner atomically saves at most 32 MiB of terminal tails in its private runtime
directory. Reopening consumes that snapshot as output history, with no live PID;
only still-present sessions and open agent tabs are restored. A new CLI can append
to its retained tail. Snapshots reject symlinks, public files, oversized data and
duplicate IDs. A crash can lose memory-only output and remains an interruption;
this is not an unlimited scrollback promise. The frontend transport stays unchanged.

Stop-all acknowledges only after managed agents and all terminal process groups
have actually exited. A failed stop leaves the owner available solely for an
explicit authenticated stop retry; it never reports success or accepts new work.
Resource sampling and termination rules are evaluated by the actual owner.
Explicit session deletion also runs there: checkout admission remains held through
process confirmation and history removal, failed confirmations retain history,
and other sessions sharing the same checkout remain running.

## Window features, updates and macOS

Background duties include the automation scheduler, pipeline runtime observer,
paired-device admission and writes, notification decisions and tray count/actions.
The paired-device network endpoint remains window-owned: phones cannot connect
while the desktop is closed, but pending provider questions remain in the owner.
Closing the window revokes its mobile attachment and undelivered mobile permits.

The optional macOS `local-ui` feature hosts an AppKit accessory menu-bar item and
notifications inside the owner. The packaged helper enables it; ordinary/cloud
serve builds remain headless. Only the desktop launcher opts into AppKit, and
hook, credential, help and self-test modes return without opening it. The desktop
requires the helper's native-tray capability and creates no second tray. Tray
actions include Quick Chat, Open TerminalX, normal Quit while a window is attached,
and explicit Stop all (Stop all and quit while attached). Attached quit actions
return through the window's existing quit guard; detached Stop all confirms owned
process exit and retains a retryable failure. Provider-lock sampling stays off
the AppKit thread; stale counts show unavailable. Native package behavior and
notification authorization still require guest acceptance; compilation is not
that evidence.

Dictation, computer use, built-in browser and star-reminder presentation remain
window-owned. While detached, browser/computer calls report unavailable rather
than spawning another window or pretending success. Dictation changes stay with
#439. Settings and all normal quit routes share a persisted first-choice policy:
keep running by default, or stop all; cancellation changes nothing. Explicit
stop-all always overrides that preference. Preserve the worktree-cleanup guard
for work that would actually be interrupted. Update restart always detaches.

Copy the bundled signed helper and its required resources into a private,
versioned runtime location before launch; atomically install and verify its code
signature, preserving required entitlements. Later hooks must resolve that
retained executable even after app bundle replacement. Never overwrite/delete a
running version. New desktop versions negotiate compatibility with the running
owner; incompatible upgrades must preserve work and explain incompatibility,
not silently kill/restart it. Versioned helper retention ends only after its
owner exits. Validate keychain access under the helper signing identity and
notification authorization on macOS; these are not established by a shell test.

## Integration release request and reviewable stages

The coordinator released `session.rs`, `session_follow.rs`,
`issue_pipeline/*`, `remote/{host,server,protocol}.rs`, `control.rs`,
`session_ops.rs`, hooks/launch registration and CLI integration. Additional
production wiring will need `serve.rs`, `lib.rs`, `commands.rs`, `sink.rs`,
`quit.rs`, settings/tray/automations/pairing, `src/lib/api.ts`, portable workspace
client, helper packaging/signing and tests. Native PTY transport integration was subsequently released; #232 retains the
frontend renderer and performance files. No reserved frontend files are changed.

Accepted stages as incremental commits in **one complete issue PR**:

1. Runtime ownership, authentication and local transport, with process tests;
   cloud and existing desktop behavior remain runnable.
2. Desktop attachment, replay and provider prompts, plus quit policy, helper
   tray/notifications/automations and update-safe packaging; enable only with
   complete behavior. Preserve #567 and #464 contracts.
3. Native acceptance and repair across all providers, real process exit and
   signed bundle replacement; run all four CONTRIBUTING checks at final head.

Prefer incremental commits in one complete PR. If stages require separate PRs,
none may auto-close #467 until the final stage meets every acceptance criterion.

## Disposable validation

`scripts/local-runtime/probe.py` takes an explicitly supplied built serve binary.
It uses a short private temporary directory, an allowlisted child environment,
no provider credentials or installed app, and real authenticated control calls.
It verifies launcher exit, reconnect to the same runtime PID, wrong-token
rejection, explicit SIGTERM and fresh endpoint credentials after restart. The
built-in PTY self-test separately exercises a real shell. These are baseline
prerequisites, **not** desktop acceptance or stop-all/idle protocol coverage.

Extend after release of integration using existing fake-Claude/mailbox fixtures
and `serve/tests/relay_e2e.rs` reattachment coverage: keep a delayed fake turn and
numbered terminal writer running after the UI client process exits; compare
complete event/byte sequences and PIDs after reconnect; hold a question and
permission across detach and answer once; verify stale decisions are refused;
exercise queues and all four harnesses. Test stop-all descendants, idle grace
reset/races, singleton concurrent launch, SIGKILL/restart recovery, bounded spool
overflow and auth/version mismatch without touching real data.

Native acceptance must use a disposable signed test bundle and private homes,
inside the coordinator-assigned guest: start work, truly exit the desktop process, verify
helper/tray/notifications and same child PIDs, reopen and answer prompts, then
replace the test bundle while work continues and launch the new client. Record
versions, runtime/child PIDs, before/after output cursors and visible results.
Window hide/close and a raw executable rename are insufficient evidence for
signed updater survival. The installed live app is never a test target.

### Baseline results (2026-10-24, macOS)

- `CARGO_BUILD_JOBS=2 SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" cargo build
  --manifest-path src-tauri/serve/Cargo.toml --bin terminalx-serve`: passed.
- `python3 scripts/local-runtime/probe.py src-tauri/target/debug/terminalx-serve`:
  passed launcher exit, authenticated reconnect, wrong-token rejection, SIGTERM,
  fresh restart credentials and real PTY output/exit assertions.
- `cargo test --manifest-path src-tauri/serve/Cargo.toml --test fake_agent`, with
  jobs=2, SDKROOT and disposable `TERMINALX_HOME` / `CLAUDE_CONFIG_DIR`: one test
  passed. Existing fake CLI covered transcript projection, permission allow/deny
  and mid-turn steering through the real harness. This test does not detach a
  desktop or hold permissions past provider deadlines.
- Python syntax and `git diff --check`: passed.

The four final CONTRIBUTING checks and native acceptance have not been run for
this preparation. Desktop quit behavior is unchanged. The ownership dependency
was subsequently released; implementation is proceeding, not ready for a
completion PR.

## Current implementation evidence

On 2026-10-24 the eight disposable `serve/tests/local_lifetime.rs` tests passed:
exclusive ownership, attached idle grace, detached fake-provider completion and
approval, unacknowledged output release and bounded replay, rejected event
authentication, pinned-client refusal after owner replacement, stop-all
cancellation of an admitted long poll, and independent native bridge views.
Headless all-target Clippy passed. The desktop ownership unit filter passed five
tests before the latest installer and bridge tests were added.

TypeScript checking passed. The full Vitest run had 3,351 passing tests and one
GuestSession Stop-button failure; its isolated four-test rerun passed. This is
not a full-suite pass. A subsequent full rerun passed all 285 files and 3,352
tests. Checkpoint `d6d31f62` passed desktop Clippy and full native tests
(2,230 unit tests, six CLI tests and two serialization-contract tests; 14 ignored).
After the scheduler/module-gating changes, desktop and headless all-target
Clippy passed and the 14-test local process suite passed, including installed
helper survival after launcher exit and replacement of its bundle source.
This is executable replacement evidence, not signed desktop updater acceptance.
The recovery-before-ready and reattachment-history regression passed. Desktop
automation unit tests (15) and lifetime unit tests (six) also passed after the
scheduler changes. The full headless package suite passed 36 tests; eight
existing relay tests remain ignored because they require the separate SaaS/Redis
harness. TypeScript and all 3,352 frontend tests passed again after these changes.
Checkpoint `462c7502` then passed the full desktop suite (2,231 unit tests,
six CLI tests and two serialization checks; 14 existing tests ignored). All four
CONTRIBUTING checks passed for that checkpoint. Subsequent sharing-owner edits
need their own validation and do not inherit this result.
No actual desktop quit, signed app replacement, tray, notification, keychain,
ACP, or OpenCode acceptance is established by these checks.

## Index transaction audit

`store/index.rs` is the only production writer of `sessions/index.json`.
`message_activity` reads it; test fixtures and remote-mirror tests also write
private copies. Every `save_file` call now sits inside the stable `index.lock`
transaction, including shell cleanup/conversion and the test-only `save`.
The lock covers the read, callback and atomic write; it is not the JSON inode
that gets replaced. The existing atomic write and unknown-field serialization
remain intact. No-op shell conversions still avoid a write.

Lock ordering is caller/runtime lock, index transaction, then the existing
process-wide atomic-write mutex. `write_atomic` never calls back into index
mutations. Index callbacks mutate their provided records; event publication,
process stops and provider-history copying happen after/outside the transaction.
Reads stay lock-free and see a complete committed JSON file. Nested mutation
callbacks fail immediately instead of deadlocking. Acquisition times out after
30 seconds without calling the mutation. A file descriptor owns the OS lease,
so callback errors, panics and process death release it; its sidecar path is
never unlinked. Older builds that do not use this lock must not concurrently
write the home: owner compatibility checks are still necessary.

## Sharing-owner integration in progress

The coordinator released `pairing/{mod,sharing,mobile}.rs` and `local_sharing.rs`
for narrow owner/admission integration. The session-scoped router now lives in
`local_sharing/runtime.rs`; the desktop adapter calls that same implementation.
The new internal `runtime.sharing.*` namespace binds registration to an owner
epoch, attachment lease, account generation and account/profile/organization
scope. It is not a guest or mobile RPC namespace. Guest roles and approval rights
are derived from the owner's link settings, never a forwarded admission boolean.
Account clear retains a revoked generation until the attachment ends, so a late
register cannot restore its grants. Attachment expiry/disconnect invalidates the
same grant checked at delivery. A write guard serializes actual input with detach
and stop-all; share recreation also changes the delivery-permit generation.

Checkout admission is acquired before sharing, attachment, device-grant and tab
revision guards. Already-admitted send bodies receive that guard rather than
locking it recursively; asynchronous PTY writers retain their final authority
checks. Deletion and stop-all can therefore revoke queued senders without waiting
for a permit held by a thread that is itself waiting for checkout admission.

The window revalidates the exact sharing connection after an owner RPC succeeds
and before forwarding its reply. A removed, expired or disconnected guest loses
buffered data as well as future requests. Pending authentication is distinct from
a data-bearing reply, and status replies use the fresh owner projection. This is
a delivery-boundary check, not atomic revocation of bytes already handed to the
network; no failed check replays the original operation.

This is still backend integration, not complete desktop pairing migration.
The desktop pairing adapter must register/revoke its context on the live owner,
route link authentication and identity refresh there, and preserve cancellation
of subscriptions. Mobile device/account scope and observation-only subscriptions
still require their own owner-side integration. Do not route mobile requests
through the internal owner namespace or cache an authorization boolean in the
window. Real desktop attachment and final independent security review remain
required before shipping.

Sharing checkpoint validation: desktop and headless all-target Clippy passed;
14 local lifetime process tests and five owner-sharing process tests passed.
The latter use actual event-socket disconnects, private homes and a fake provider
whose readiness is gated, proving revoked input never reaches the PTY before a
subsequent host turn succeeds. Desktop filters passed 12 sharing tests, three
sharing-router tests, eight lifetime tests, 24 terminal-follow tests and 54
prompt/interrupt tests (two existing ignored). These are focused checkpoint
results; full issue validation, mobile observation and actual desktop acceptance
remain outstanding.

## Native session adapter checkpoint

The typed `local_runtime::sessions::Sessions` adapter reads events, running tabs,
permission requests, pane identities, queues and status from its pinned owner.
It also forwards tab mutations, including explicit delivery confirmation and
continuation preparation, so the window need not inspect or reconcile another
process's live transcript. All reads return errors on disconnection; no empty
queue or idle state is synthesized. The event connection exposes its validated
owner epoch and attachment lease for scoped sharing registration.

A real disposable runtime test detaches before a permission request, reconnects,
answers the retained request and sends another turn through this adapter without
recovery. Replacement-owner tests require live-state reads to fail on the old
client. This does not yet switch desktop command routing or satisfy packaged
quit/reopen acceptance. A separate account test covers sign-out overtaking
registration: a revoked generation cannot register late, and its stale sign-out
cannot revoke a newer account.

## Helper build checkpoint

`pnpm build:local-runtime` builds `terminalx-serve` independently of the desktop
Cargo feature graph and packages its executable under `target/local-runtime`
in the Tauri resource directory. The script honors Tauri's target architecture
and debug flag; explicit standalone target/profile arguments are supported,
including two-slice universal macOS builds. It selects the actual executable
from Cargo's artifact report, so a custom Cargo target directory cannot cause
an old binary from a guessed path to be bundled. Existing sidecars and the
computer-use helper remain separate.

The helper receives the app entitlements and a verified code signature. A
production invocation (`TERMINALX_MAC_RELEASE=1`) requires an explicit
`APPLE_SIGNING_IDENTITY` and timestamp; development may use an ad-hoc signature.
The Tauri hooks propagate failures before bundling. Direct `cargo test`/clippy
only prepare the missing resource directory and never fabricate an executable.
This packages the real headless helper but does not yet implement its tray or
switch desktop session ownership. A development signature and disposable PTY
self-test are not evidence of notarized release or packaged update acceptance.

Checkpoint validation (before merging #623/#624): TypeScript passed; Vitest
passed 286 files / 3,357 tests; desktop and headless all-target Clippy passed;
desktop tests passed 2,234 units (14 existing ignored), six CLI tests and two
serde tests. The full headless suite passed 43 tests, including 15 lifecycle and
six sharing-owner process tests; eight relay tests require the external harness
and remained ignored. The real arm64 development helper passed code-signature
verification, its isolated PTY self-test, and the disposable launcher/reconnect/
wrong-token/SIGTERM/fresh-credential probe. No installed app or host GUI was
operated, and no production-signed or notarized artifact was validated.

## Desktop adapter checkpoint

`local_runtime::desktop::Desktop` holds one app-wide event attachment and one
independent PTY bridge per window. Window destruction releases only its view
connection; it does not stop processes or drop the control attachment. View
connections consume but do not republish app-wide events, avoiding duplicate
chat/status updates when the floating window is open. Tokens and cumulative
acknowledgements remain scoped to their window connection. The existing stream
protocol remains unchanged.

Usage refresh and Codex reset now use SessionManager's owner store and sink,
including the existing provider account generations, backoff and early Claude
publication. Typed usage and activity reads fail on owner disconnect instead of
opening a second activity collector or synthesizing an empty account. Session commands now use this typed boundary through a transitional in-process
backend. Startup still requires the production owner cutover; this checkpoint does
not establish desktop quit/reopen acceptance.

The desktop session and PTY commands now have owner-compatible paths. AppState
still starts with its in-process backend until pairing, cleanup and lifetime
integration are complete; it never falls back to that backend after an installed
owner connection fails. Closing a window deliberately silences its connection's
disconnect event, while unexpected view failure and owner failure remain distinct.
Directly launched commands in shell tabs count as busy even when their process
group equals the original PTY process; a bare interactive shell still uses its
foreground job to classify close confirmation. This is not yet proof that every
idle interactive shell can safely be reaped by the detached-owner policy.

Seventeen disposable lifecycle tests pass at this checkpoint, including typed
terminal input/resize/stop and per-window acknowledgement isolation. Saved quit
policy data defaults to keeping work, with an unset value reserved for the first
quit choice. The next checkpoint adds the quit dialog and settings presentation,
with production startup still using the in-process backend.


## Reconnect and quit presentation checkpoint

The connection notice separates unavailable live state from session history. It
subscribes before reading status, ignores older status results after a disconnect,
and reconnects only when explicitly requested. A reconnect closes old view leases
before opening a replacement event attachment to the same owner generation; it
never replays input or silently follows a replacement runtime. Successful
reattachment reloads the view once to rebuild snapshots and PTY taps. Pairing must
bind its new account-scoped owner adapter before production reconnect is enabled.

The first intercepted quit offers keep-running, stop-all, and cancellation. Only
an explicit choice is saved. The existing cleanup warning precedes the choice or
stop request. App and tray explicit stop-all use the same guard without changing
the saved normal-quit policy. Failure to save the preference or obtain the pinned
owner's authenticated stop acknowledgement keeps the app open and shows the
error. Update restarts continue to bypass interactive quit choices. The actual
startup/teardown ownership cutover and background tray handoff are still pending;
this checkpoint must not be treated as completed desktop quit/update acceptance.

Settings hide the background policy for the transitional in-process backend.
Disconnected owner state keeps the preference visible and never substitutes an
empty session list. Focused UI tests exercise status/disconnect races, explicit
retry, failed preference writes, cancellation-safe defaults and single reload.


Session-link adapters now forward invitation lookup/rate limiting, host changes,
guest join/refresh, queue draining and scoped guest calls to the owner when
attached. No desktop sharing mutex is held across RPC. Every call carries the
current verified account generation and event attachment, and the owner applies
its existing role, approval, mode and final-writer checks. Sign-out clears the
owner generation before changing the account; a failed clear disconnects the
lease. Queued outbound guest events recheck owner access before forwarding.
Reconnect binds pairing to the new lease without recreating old guest grants.
Paired-device/mobile host RPC and startup attachment remain to be integrated.

This checkpoint passed TypeScript, all 288 Vitest files / 3,366 tests, desktop
and headless all-target Clippy, three focused native quit tests, and the full
headless suite (including 18 lifecycle and eight sharing process regressions).
Eight external-relay tests remain ignored. A test request that incorrectly added
a tab id to session.status was corrected to the real scoped contract; assertions
remain strict. These results do not establish packaged desktop acceptance.

Owner command checkpoint: tab closure now serializes with admission, confirms
process exit, and retains the conversation in the existing closed-tab store.
Late view/composer requests cannot recreate the closed tab. Automation reads,
definition changes and manual dispatch use the owner scheduler/store, including
the existing pipeline consent flags. Twenty disposable lifecycle process tests
and desktop/headless Clippy passed for this checkpoint; startup cutover and
packaged desktop acceptance are still pending.

Workspace cleanup checkpoint: desktop workspace operations now use the owner’s
admission gate and live process state. Fallible stop variants preserve the
existing infallible caller APIs, but removal and quick-chat relocation abort
before moving history or deleting a worktree if any required process stop fails.
A partially stopped multi-session workspace remains indexed and retryable;
merged cleanup records the refusal rather than recording successful removal.
CLI worktree deletion uses the same confirmed-stop requirement.

Desktop/headless Clippy and 29 disposable lifecycle tests passed on this
checkpoint, alongside 47 session-operation and 19 merged-cleanup tests. The full
native suite last passed on the preceding checkpoint (2,248 unit, six CLI and
two serde tests); it has not yet been rerun for these cleanup changes. Production
startup, paired-device adapters and packaged desktop acceptance remain pending.


Desktop attachment checkpoint: production startup now connects to the local
owner instead of creating a window-owned SessionManager. Closing the window
detaches its views and private service endpoint without stopping processes.
Computer/browser/cloud UI services are a fixed allowlist behind authenticated
private IPC, fenced at both ends to the current attachment. This endpoint never
publishes home discovery credentials, even after owner loss; it cannot replace
the owner. Local pipeline recovery and automation scheduling run only in the
owner. An explicit stop request with no owner reports failure.

Desktop/headless all-target Clippy and 30 lifecycle process tests passed on this
checkpoint. Focused native checks passed 33 window, 153 pipeline and four quit
tests. These are checkpoint results, not the final full-suite or packaged
acceptance: paired-device adapters, background tray/notifications and genuine
packaged quit/reopen/update validation remain outstanding.


Paired-device ownership checkpoint: the window authenticates encrypted mobile
connections, but the owner reads the device/account records and admits each
connection against its attachment and account generation. Session writes retain
a permit that is checked again at the provider writer. Revocation, mode changes,
tab stop and owner loss invalidate queued writes; only a pre-effect busy refusal
is queued. Permission answers and terminal driver leases now target the owner.
Viewer observations use ordered retained/live PTY taps with an 8 MiB aggregate
buffer budget, a 1 MiB per-view bound and 64 KiB live packets. A slow connection
closes explicitly rather than silently dropping output. Pairing transport still
requires the desktop window; this checkpoint does not claim phone access while
the window is closed.

The initial adapter checkpoint passed both all-target Clippy checks, seven
process regressions and 27 native mobile tests. Subsequent packet-size and
post-response authorization hardening is being validated separately. Native
tray/notifications, packaged lifecycle acceptance and current-head full suites
remain outstanding; this is not issue completion.


Native-tray source checkpoint: desktop, headless and `local-ui` all-target Clippy
passed. TypeScript and all 288 Vitest files / 3,366 tests passed. The helper-feature
process regressions passed (30 lifecycle, eight mobile, eight sharing, two startup
isolation cases and one hook activation case). The full desktop suite passed
2,261 unit tests, six CLI tests and two serde tests, with 14 existing ignores.
The full headless suite passed 68 tests, with eight external relay tests ignored.
A subsequent desktop startup-order fix installs window services before publishing
the attachment; desktop all-target Clippy passed after that change. The full
desktop suite has not yet been repeated for that final ordering change.
The preceding committed mobile checkpoint `e058fa0e` passed seven process tests
and two output-buffer tests after the packet and response-fencing hardening.
Current edits additionally cover mode ABA, owner replacement, in-flight queue
budgets and stale PTY process identities. Packaged guest checks are specified in
[LOCAL-RUNTIME-ACCEPTANCE.md](LOCAL-RUNTIME-ACCEPTANCE.md); no installed application
or host GUI has been exercised.


Window-publication checkpoint: the desktop publishes its attachment identity to
its private request validator before registering window services with the owner.
Reconnect explicitly revokes the previous lease before creating the replacement;
a failed publication or registration disconnects only that view. The regression
checks actual owner dispatch before/after publication, first delivery after
reattachment, immediate old-lease rejection and failed registration.

The final production-code revision passed desktop and headless all-target Clippy,
50 local-ui process tests (32 lifecycle, eight mobile, two startup-isolation and
eight sharing), and the full desktop suite (2,261 unit, six CLI and two serde;
14 existing ignores). TypeScript and 3,366 Vitest tests passed before these
Rust-only changes. An additional headless process regression passed for both
legacy ACP and OpenCode fixture peers: queued turns complete while detached,
pending permissions survive attachment, duplicate answers fail, and the owner
identity remains unchanged. Those fixtures do not establish real-provider
compatibility or credentials. Packaged guest acceptance is still pending.

Packaged guest acceptance exposed an AppKit-specific idle-exit failure: backend
shutdown finished, but `NSApplication.stop` called from the timer did not wake
`nextEvent`. The helper now posts a private application-defined event after
stopping. Apple's documented `stop:` contract requires event dispatch; no user
input should be necessary. The opt-in native guest regression reproduced the
failure on helper `db2ef716d28e1b68997b1b5b381338458120e7e81d16bba362a02ed35574c1e5`.
The repaired development helper
`5e3fc5c26ae657266a6cdbc571fd3306a251d2d09a3a1635d4951fd00b02b151`
passed actual idle exit (2.21 seconds with a two-second grace) and authenticated
stop-all exit (0.27 seconds), without any external UI event. Local-UI all-target
Clippy passed. A rebuilt desktop bundle and the remaining guest acceptance cases
still need validation; these results are not a completed issue claim.

### Mobile authority lock order

Mobile registry metadata never waits on an attachment, grant, driver or tab
revision lock. Readers snapshot identity under the registry, acquire attachment
authority, then revalidate the current generation and connection pointer.
Same-lease mutations serialize through that attachment; revocation still fences
in-flight writes before acknowledging. Pruning checks snapshots outside the
registry and removes only matching objects. Shared force-stop can therefore
invalidate a mobile tab while holding its sharing attachment without cycling
against a mobile check, close, device revoke or account clear. The bounded mixed
lease subprocess regression exercises these four interleavings.

The macOS CLI sidecar is a generated native launcher. Its signature stays in
the executable across updater extraction, while it `exec`s the sibling desktop
binary's `terminalx` command with unchanged arguments, environment, working
directory and streams. It does not own sessions or add another runtime process.
See `docs/RELEASING.md` for archive signature validation.
