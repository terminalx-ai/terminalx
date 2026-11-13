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
Explicit session deletion also runs there: the session stays fenced from new
turns through process confirmation and history removal, failed confirmations
retain history, and other sessions sharing the same checkout remain running.

Checkout admission is one app-wide lock, so it is held only for short decisions:
whether a prompt may start a turn, and whether a checkout may be reserved for
local checks or conflict resolution (#727). Work that stops sessions and then
changes what they run in takes a fence (`issue_pipeline::admission::fence`)
over just those sessions, one tab, or a checkout path, and runs its slow part
behind it: workspace and session removal, quick-chat moves and retention, merged
cleanup's removals and restores, Settings → Storage removal, CLI worktree
deletion, tab closing, the idle-agent stop, a guest's forced stop and an
experimental Codex tab's move to its terminal. Taking a fence takes admission
for a moment only, so a prompt admitted before it has finished (and its turn is
visible to the work's last look) and one admitted after it meets the fence. A
prompt for a fenced session is refused with the fence's reason; one for a tab
whose agent is only being stopped (or moved) waits for that and is then
admitted as usual, the host's and a guest's alike, and a guest's queued input
for it stays queued until then. Merged cleanup weighs a workspace's grace period
again behind its fence, so a turn that ended while the sweep asked GitHub or
fetched keeps the workspace. Scans, sizing, merged-cleanup's GitHub calls and
fetches, and the ledger take no fence at all. A prompt's baseline tree
(`git add -A` into a scratch index) is read before it is admitted.

Every composer send is timed in the tab's diagnostics as `send_timing` lines
sharing its `seq`: `received` (the window's `pressed_at`, the runtime's
`received_at`, `waited_ms`, `admitted_ms` and `answered_ms`), `delivered` (the
agent took it) and `shown` (the window's `drawn_at`, `answered_at` and
`shown_at`).

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
owner exits.

An update brings the runtime with it (#730). The runtime says its `version`
in `runtime.liveness` (0.2.22 only in `status`, as `appVersion`), and a desktop
that attaches to one older than itself replaces it with its bundled runtime
(`local_runtime/replace.rs`). It does so by itself only once nothing the
runtime runs would be cut short, by the runtime's own idle rule but for an
agent's own helpers: only managed agents that have settled, running nothing
their tools started, may be stopped without asking. An agent's MCP and
language servers start again with it; a shell it started (how its tools run a
command), and anything left in its process group outside it, is work
(`idle::working`). A runtime of this build or later names everything else
(`runtime.work`: agents mid-turn, prompts not yet delivered or held, agents
started by hand, running terminals, commands agents left running, processes
that outlived what started them, issue pipeline steps) and stops only when
there is none,
deciding under the admission lock (`runtime.stopAllIfIdle`, refused as
`runtime_busy`). An older one is judged by what it shows (agents mid-turn in
`runningTabs`, open terminals in `runtime.pty.shells`, what its agents' tools
left running by the process table), read again just before it is stopped; a
group whose leader has gone is invisible there. It cannot show the prompts
it holds, nor can any runtime see a follow-up a CLI holds until its turn ends,
so nothing may be found under way for 15 s first. Until then every window says
the runtime is older than the app, lists what it waits for, and offers
**Restart now**; after a switch that failed it says it will not try again by
itself. Replacing stops the runtime as Stop All does (`launch::retire`, pinned
to its epoch). Restart now stops one that will not stop as Restart runtime
does; replacing it by itself does so only once it agreed to stop, and anything
that goes wrong before then leaves it running and is waited out. The
supervisor attaches the bundled runtime in its place; each
agent picks up its conversation again when its tab next starts. A runtime of
the app's version or newer is attached as before, so two builds sharing one
home never take turns replacing each other's runtime. What a phone is offered
follows the attached runtime, not the app ([MOBILE.md](./MOBILE.md), "What the
phone is offered"). Validate keychain access under the helper signing identity and
notification authorization on macOS; these are not established by a shell test.

### Handing the runtime over (#765)

From 0.2.24 a runtime is replaced in place and stops nothing. Every agent and
terminal belongs to the runtime process (it holds each PTY master, each agent
is its child, each agent's hooks dial `hooks-<pid>.sock` with a per-launch
token), so the runtime is not stopped and restarted: asked to hand over
(`runtime.handover`, pinned to its epoch), it holds everything still and execs
the newer runtime's binary in its own process (`local_runtime/handover.rs`).
The pid does not change: the agents stay its children, their hooks reach the
same socket with the same tokens, and every terminal stays open. The status
says which handover record a runtime writes (`localRuntime.handover`, a format
number; absent before 0.2.24).

- **What is held still, in order.** The hook and control sockets stop
  answering once the frames under way are answered (`hooks::Bridge::freeze`).
  A frame that waits on a person (a permission card) or only waits and reads
  (`terminalx wait`) does not hold this up: it goes over with its connection.
  New connections wait in the listening socket's queue, which goes over too,
  so a hook that fires mid-swap is answered by the new runtime, never refused.
  Then no issue pipeline step starts and none runs, nothing is admitted, each
  PTY's reader stops with all it read in the scrollback (`pty::handover`:
  output written meanwhile stays in the terminal for the next reader, and an
  exit meanwhile stays unreaped for it), and every agent tab is held with no
  prompt being typed into it and no transcript being read
  (`session::handover`). What is about to settle (a CLI starting or stopping,
  a prompt on its way, a phone's prompt) refuses the handover as
  `handover_busy`, with nothing stopped, to be tried again.
- **The record** (`run/handover-<pid>.json`, owner-only, removed once read)
  names each descriptor kept open across the exec (the ownership lock, the
  sockets and their lock, each PTY master, each connection still waiting) and
  carries each terminal's scrollback, screen and process group, each agent
  tab's transcript position, open turn, queued prompts, cards and hook token,
  and the log's `seq`. The new runtime (`--adopt <record>`) takes all of it
  over before it answers anything, makes every descriptor close-on-exec again,
  serves its sockets frozen until it is ready, then answers what queued up.
  An agent's background-command ledger is read again from where its CLI
  began. A CLI started by hand is found in front of its terminal again and
  followed on from where it was read to. Startup recovery leaves alone what
  was handed over: its turns, panes, automation runs and pipelines go on.
- **Versioned.** A runtime reads every format its `handover-formats`
  subcommand names. Before holding anything, the runtime being replaced asks
  the binary taking over which it reads, and refuses (`handover_unsupported`)
  one that reads none of its own, or that is not a runtime installed in this
  home as `launch::install` installs one (in this home's private runtime
  directory, under the digest of its contents, private to this user), signed
  by the same team on macOS, at this version or newer. It checks the binary
  again just before the exec, after everything was held still: the same file,
  with the same contents. On Linux it execs the very descriptor it checked;
  on macOS, which cannot exec one, it execs the path a moment after the check.
  On macOS, whoever holds the control token therefore cannot put a program of
  their own in the runtime's place. Linux has no code signature to require:
  there a program of this user's own, installed in this home's runtime
  directory under its digest and claiming a newer version, would pass, which
  gains nothing over what the control token already allows (every terminal
  and session).
- **Waiting hooks.** The hook bridge stops answering before anything else
  comes to rest, and is taken (its sockets, and the frames not yet answered)
  only once every tab is held, when no waiting hook can be answered any more,
  since an answer is given under its tab's lock. A permission answered in
  between is answered here, and the handover is tried again
  (`handover_busy`). That includes one whose hook has yet to wake when the
  bridge is taken: it is still waiting, on a card no held tab waits on any
  more, and the runtime taking over would find no card for it.
- **Stats.** Activity history (#767) is written by the runtime, which holds
  its lease on a descriptor that closes with the exec; the runtime taking
  over claims it again before it adopts anything. What the exec would lose
  is each tab's last counted state, which the record carries: a turn under
  way is not counted as a new agent start when it is seen again, and when it
  ends it counts the time it ran before the handover too. The record also
  carries the machine's monotonic capture time, so work during serialization,
  exec and replacement startup counts without depending on the wall clock.
  Older records without this timestamp retain the elapsed work they supplied.
- **What it cannot carry** in format 1 is an agent driven over its standard
  input and output (experimental Codex stdio, ACP agents, OpenCode) while its
  process runs. `runtime.handover.plan` names it; the handover refuses
  (`handover_unadoptable`) unless the request names it in `stop`, and then
  stops only that, as Stop does, and hands the rest over. Every window sends
  back exactly what it showed (Restart now, Try again, Restart runtime, and
  Update now through the update plan): an agent started since is refused
  (`handover_unadoptable`), with nothing stopped, and shown in turn.

A desktop newer than a runtime that can be handed over replaces it at once,
mid-turn or not (`replace.rs`): windows say the runtime is being updated and
that its agents and terminals keep running. What the handover cannot carry is
never stopped by itself: every window names it, and **Restart now** hands
everything else over, stopping only that. A bundled runtime that cannot take
the runtime over falls back to replacing it as above, once nothing would be cut
short. **Restart runtime**, for one that stopped answering, hands it over first
too; when that cannot be done, nothing is stopped, and the window says why and
offers to stop only what cannot be kept, or everything. A runtime from before
0.2.24 cannot hand over, so the first update to 0.2.24 still replaces it as
above.

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
and rechecks current window health on disconnect events. It attempts reader
recovery after 1, 2 and 4 seconds, then leaves manual reconnect available while
checking for independent recovery every 5 seconds. A terminal-view failure is
scoped to its window's shared PTY connection; healthy windows and cloud session
connections are not declared unavailable by that event. Only a failed shared
event connection needs desktop-wide reattachment. A reconnect closes old view leases
before opening a replacement event attachment to the same owner generation; it
never replays input or silently follows a replacement runtime. Successful
reattachment rechecks current health before reloading the view to rebuild snapshots
and PTY taps. Only unsent drafts positively identified by the loaded local session
index are checkpointed to window-scoped session storage before that reload and
consumed by the next document, without sending them. Cloud and issue drafts keep
their existing scoped persistence; unclassified draft IDs and the legacy all-draft
checkpoint are never restored through the local handoff. Recovery waits for the
local index to load before checkpointing. Recovery also waits until each cloud
draft matches text acknowledged by its account-scoped cache, with no queued or
in-flight write for that tab. Pending, failed or unsavable drafts keep the
document open; a health poll can finish recovery after a later successful save.
Cache mutations, including deletion, are serialized by account, organization,
workspace and tab beyond individual store lifetimes. Returning A -> B -> A
cannot let an old issued mutation overtake the replacement store's save. Recovery
also waits for detached stores' outstanding mutations before destroying the
document that owns this ordering. Deletion and uncertain results invalidate
matching saved-draft evidence. This barrier is synchronous with checkpoint/reload and does not rely on
the best-effort unmount flush. If
checkpointing fails, the page stays open with its drafts. The attempt budget is
also window-scoped session storage, recorded before native recovery and retained
across reloads/remounts. Neither reader release nor a connected control read
replenishes it: automatic attempts are conservatively limited to three per window
browsing lifetime, with manual recovery still available. This avoids assuming an
absent replacement reader has recovered. Manual clicks during a pending health
read are coalesced and honored after it completes. Pairing must
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
lease subprocess regression exercises these four interleavings. Desktop input
and a mobile driver claim serialize on that pane's own gate, never the registry:
no terminal write happens under the registry lock (#661).

The macOS CLI sidecar is a generated native launcher. Its signature stays in
the executable across updater extraction, while it `exec`s the sibling desktop
binary's `terminalx` command with unchanged arguments, environment, working
directory and streams. It does not own sessions or add another runtime process.
See `docs/RELEASING.md` for archive signature validation.

## A terminal that stops reading input (#661)

On 2026-10-29 one Claude Code pane stopped reading its input after a 6.3 KB
handoff paste. A PTY master accepts about 1 KB of unread input (1022 bytes on
macOS) and a blocking write past that waits for good. The desktop's write to
that pane held the mobile registry lock while it waited, so 58 hook, control,
retention and worker threads queued behind it. The app's synchronous commands
then waited up to 120 seconds each on the main thread, and every relaunch
attached to the same wedged runtime. Its log went to `/dev/null`. The guarantees
below keep one such pane from taking anything else down.

- **Every write is bounded.** Each PTY master is non-blocking. A write waits
  for room with `poll`. It fails with `InputStalled` after `pty::INPUT_STALL`
  (10 s) without progress, or after `pty::INPUT_DEADLINE` (30 s) in all,
  however slowly the program reads. `InputStalled` says how many bytes got
  through. Bytes are never written after the call returns. While a pane stays
  stalled, its next writes fail at once rather than each waiting out the limit.
  The reader waits on `poll` instead of a blocking `read`. Prompt delivery,
  nudge and interrupt keys, mobile input and the remote server's input threads
  all use this one write.
- **Desktop typing is queued, not dropped.** `runtime.pty.write` hands its
  bytes to the pane's queue (`local_runtime::typing`) and returns. One thread
  per pane delivers them in order, in pieces of up to 64 KB. While the program
  is not reading, it tries again every 250 ms, taking the pane's gate for one
  attempt at a time. A paste into a shell busy with a command therefore arrives
  whole once the command ends, as in any terminal. Queued typing goes only to
  the process it was typed at. Past 1 MB of unread typing, more is refused
  whole. A mobile driver claiming the pane discards what is still waiting.
- **No terminal write under the mobile registry.** Desktop input and mobile
  driver claims serialize on the pane's own gate. Some writes still happen
  under narrower locks, now bounded by the limits above:
  - the Enter and Escape that must stay atomic with a tab's state, under that
    tab's lock;
  - a shared or mobile prompt's writes and its two paste waits of up to 10 s
    each, under the sharing lock;
  - mobile input, under its device grant.
- **Bounded socket threads.** One launch handles at most 256 hook and control
  frames at once, across its own and the published socket. Past that, a frame
  is answered by a single refusal thread. A control request gets `busy`. A hook
  gets nothing to act on, so a deciding hook fails closed, plus the reason for
  its CLI's hook log.
- **The window never waits on the runtime.** Every Tauri command that calls the
  runtime runs in `spawn_blocking`. That includes the share dialog's status and
  changes and the mobile-driver list each window loads. Reads the window shows,
  and quick controls, give up after `client::QUICK_TIMEOUT` (15 s) with
  `Unresponsive`. The quick calls are status, pane, queue, read marks,
  permissions, interrupt, terminal input, resize, lists, share status and the
  quit-time fences. Long operations keep 120 s. Quitting lets go of a runtime
  the watchdog found not responding before fencing sharing, so it does not
  wait on one either.
- **Watchdog and restart.** The owner's loop records each completed pass.
  `runtime.liveness` reports the age of the last pass as
  `localRuntime.loopAgeMs`. It reads nothing but the owner's lifetime state,
  so it answers while sessions, tabs and shares are held up, and a probe never
  takes a request place that stays taken. Owners too old for it are asked for
  `status`. Every 5 seconds the desktop probes. A runtime is flagged
  unresponsive after two failed probes in a row. A probe fails when the owner
  does not answer in time, refuses as `busy`, or its loop has not finished a
  pass for 120 seconds. The loop shares the sharing and tab locks with prompt
  delivery, which can hold them for about a minute at most, so 120 seconds is
  never reached by delivery that is still working. Only an open attachment is
  probed. Once it closes, the supervisor's attempts to attach again (#643) say
  instead: one that times out or meets `busy` counts as not responding, so a
  window opened onto a wedged runtime offers the restart without having
  attached. A successful attach clears the finding. The status the window reads
  shows `unresponsive` in place of connected or reconnecting, because
  reconnecting reaches the same wedged process. A change is announced with
  `local_runtime_state`, like the supervisor's own changes.
- **Restart.** The notice reads "TerminalX runtime is not responding" and
  offers **Restart runtime**, never Reconnect. `local_runtime_restart` takes the
  launch lock and finds the process listening on `run/hooks.sock`. It continues
  only if that process runs `runtime/<hash>/terminalx-serve` from this home. It
  sends SIGTERM to the runtime's process group, then SIGKILL after 3 seconds,
  and then ends the sessions of the terminals the runtime started. Then it
  drops the old attachment and asks the supervisor to attach now. Discovery
  starts a fresh runtime, and windows re-attach their terminals in place, as
  after any reconnect, without reloading. Agents resume their conversations
  from the provider transcripts. The restart names the epoch the window saw,
  and it acts only while the runtime is still found not responding. A second
  window's late click therefore stops nothing: not the replacement, and not
  the old runtime while the replacement is still being attached.
- **Runtime log.** A desktop-launched runtime gets `--log-file
  ~/Library/Logs/<identifier>/runtime.log`. Its stdout and stderr point there
  too, so panics are kept. At 8 MB the log moves to `runtime.log.1` and a new
  file starts.

## A connection that falls behind (#716)

On 0.2.21 a window showed "Live connection unavailable" while every agent ran
normally. A window's connections to the event socket could close for being
read too slowly, and nothing recorded which one closed or why. Each limit was
the whole connection's: 64 frames or 2 MiB queued, one frame over 1 MiB, a
subscriber falling 1024 events behind (every pane's output was an event too),
or one write taking 10 s. Attaching four terminals with full scrollback was
enough to pass 2 MiB. The guarantees below replace that.

- **One stream per connection.** The runtime advertises `streamVersion: 2` in
  its status. A desktop that sees it names the stream in its hello:
  `"stream": "events"`, or `"stream": "terminals"` with the `window` label.
  An event connection takes no terminal views; a terminal-output connection
  takes no events. Events are followed on `BroadcastSink::subscribe_app`,
  which carries no `pty_data`, so busy terminals cannot put it behind. A hello
  without `stream` is a desktop from before #716: it gets both on one
  connection, and the old behaviour of losing the connection when anything
  falls behind. A new desktop sends the old hello to a runtime that does not
  advertise version 2, which refuses unknown hello fields.
- **A view that falls behind is let go alone.** Each view has its own 2 MiB
  queue, inside the connection's 8 MiB. A view that acknowledges what it draws
  never has more than about 1.4 MiB outstanding (`pty::FLOW_HIGH` and a chunk
  as base64, a full replay included), so only a view whose window stopped
  reading fills it. Its pane then stops sending to it, and the runtime queues
  `{"type":"lagged","id","token"}`. Greetings, pongs and notices use a separate
  256 KiB budget, so the notice can always be queued. The bridge drops the
  view and emits `pty_view_lagged`. The window's terminal with that attachment
  token attaches again: on screen it is reset and redrawn from the pane's
  scrollback, off screen it is let go. Other views on the connection go on.
- **No frame is refused for its size.** A full scrollback replay (512 KiB,
  683 KiB as base64) is one frame, as before. Longer output would be split, so
  no view is handed a frame over the 1 MiB limit, which would make it fall
  behind on every attach.
- **Missed events are counted, not fatal.** An event connection that falls
  behind the app's events, finds its queue full, or meets an event over 1 MiB
  counts the event missed. 250 ms after the first, it sends
  `{"type":"missed","events":n}`. The bridge emits `local_runtime_reattached`
  with `missedEvents`, and every window re-reads what it shows, as after a
  reconnect.
- **What still closes a connection.** The client sends something malformed,
  stops reading altogether (one frame not read within 10 s), or reads
  none of 256 KiB of pongs and notices. The desktop gives up on silence after
  15 s. Each of these means one side has stopped working, not that it is slow.
- **Every end is logged.** The runtime logs each connection's end, at info when
  the desktop closed it and warn otherwise. The line names the connection, how
  long it was up, the reason, and how many views fell behind or events were
  missed. Views falling behind and missed events are logged as they happen.
  The desktop keeps its own log, `~/Library/Logs/<identifier>/desktop.log`,
  beside `runtime.log`, rotated the same way. It records each lost connection
  with its reason. It records failed attempts sparsely: the first, each with a
  new reason, and the 2nd, 4th, 8th and so on. Each recovery is recorded with
  how long the connection was down and how many attempts it took.

## Workspace ports and local URLs (PRO-243)

Before a local shell or agent starts, its checkout receives a block of ten
ports. `TERMINALX_PORT` is the first port; `TERMINALX_PORTS` is the ten ports
as a comma-separated list. For example, a shell can run
`pnpm dev --port "$TERMINALX_PORT"`. Commands must use these variables to
benefit from the allocation; existing running processes retain their old
environment. The assignments do not reserve sockets against other applications.

The first ports range from 20000 through 49000 in steps of ten. Assignments
are shared by sessions in the same canonical checkout, distinct across
checkouts, and persisted in `sessions/index.json` under `workspacePorts`.
The index transaction lock protects simultaneous launches. Renaming a
workspace retains its block; archived sessions retain theirs too. After the
last session of a workspace is removed, a later allocation may reuse its
block. No repository file supplies commands or port assignments.

A visible local terminal offers **Open** for up to eight localhost URLs
with explicit ports found in its bounded output tail. Opening one creates
and selects a TerminalX browser tab for that pane's session. Discovery is
read-only, ignores terminal control strings, and never opens a URL without
a click. It polls only while the pane and window are visible. Older runtimes
without `runtime.pty.localLinks` simply offer no links.

This is the independent portion of PRO-243. Named actions, the header Run
menu, Cmd+R and non-concurrent replacement must use PRO-131's
`repositorySettings` (#804) and PRO-149's script runner (#808) when those
land. Setup port injection and “run after setup” await PRO-240 (#836).
The action editors from PRO-155 (#809) are already on main; this change
does not introduce a competing action schema or script runner.

## Stop confirmation and destructive callers

A PTY pane name can be reused after its view/process handle is detached. Stop
confirmation therefore retains the exact launch ownership handles, and the
terminal registry associates every retained launch with its pane ID. A failed
agent Stop keeps those handles for retry; it does not resolve the reused name
and stop a replacement. Session deletion also discovers unresolved shell launches
whose Pane objects have already been removed. Confirmation errors keep the
session indexed and its workspace/history intact; unrelated sessions are not a
reason to veto or broaden a scoped stop.

| Caller | Required result before mutation |
| --- | --- |
| Agent Stop and retry | Exact captured PTY launches must confirm exit; failure keeps stopping/recovery and launch admission closed. |
| Agent relocation | Every affected agent Stop must succeed; failure preserves original workspace metadata. Reader-opened shells are not stopped. |
| Session deletion and tab removal | Scoped agents and shells must confirm exit before history/index removal. |
| Remote session/workspace removal and merged cleanup | Fallible stop reaches the existing retention/refusal APIs; waiting cleanup retains terminal metadata and subscriptions on failure. |
| Resource kill | Sampling, kill rules and confirmation still apply; an unconfirmed wait cannot return `killed: true`. |
| Explicit Stop all | Per-tab failures and retained owned groups prevent acknowledgement; this remains broader than a session-scoped operation. |
| Nonwaiting terminal teardown | Requests termination without promising confirmed exit; retained launch ownership remains available to later confirmation. |

These results are bounded OS observations of owned work, not a universal
process-containment certificate. On macOS they still come from the session
census, whose reviewed internal-truncation omission remains open under its
separate mechanism hold: propagating a failed wait repairs known-live and
indeterminate caller handling, but does not detect an unobserved false-empty
census. On Linux the census is no longer the authority; see
[Linux PTY ownership](#linux-pty-ownership-467).

The compatibility `kill_and_wait`/`kill_all_and_wait` wrappers log failure for
non-confirming teardown callers. Destructive session/workspace/resource callers
use the fallible variants. Final headless process teardown still uses the unit
wrapper; it is not a successful removal acknowledgement. Restart reservations
publish their exact detached handles before releasing runtime, and completion
retires only those handles under the still-current claim. No runtime lock is
held across a process-exit wait; startup refuses unresolved prior ownership and
leaves its handles for explicit Stop instead.

## Linux PTY ownership (#467)

On Linux every terminal pane, an agent's included, runs under a supervisor
process of its own, one per launch. The supervisor, not a process census,
decides when a launch is over. macOS is unchanged: its panes are still
portable-pty children, owned through the session census described above.

### The supervisor

`Terminals` starts each pane by executing `/proc/self/exe` with a private
argument and the launch's id: the exact image the runtime is running, even
when an update has since replaced or removed its file. The helper runs from
the executable's pre-initialisation array, before any shared library's
constructor (the desktop links GTK and WebKit) and before `main`; `main.rs`
and `serve.rs` also dispatch first, should that not have run. Two
descriptors are inherited at fixed slots: a `SOCK_SEQPACKET` socket pair for
a bounded, versioned protocol, and the PTY's peer, opened from the master
with `TIOCGPTPEER`, never by path. There is no listener, path or RPC through
which anything else can reach a supervisor.

Before doing anything, the helper checks:

- that the channel's peer is its parent, with its uid;
- that the PTY slot is a terminal;
- that its parent is this same program image: the same device and inode
  behind `/proc/self/exe` and `/proc/<parent>/exe`;
- that it runs with unchanged privileges.

It then closes every other descriptor and runs preflight. Preflight requires
a single thread, `pidfd_open` and `pidfd_send_signal`, `close_range`,
`PR_SET_CHILD_SUBREAPER`, an all-child `waitid`, and a `/proc` of its own PID
namespace. That means Linux 5.9 or later, with no seccomp filter denying
these calls. A failure is reported to the runtime by stage, and the message
says what is missing. There is no fallback to the census.

The supervisor becomes the subreaper of everything the launch starts. It
forks the shell in a new session with the PTY as its controlling terminal,
the signal mask and dispositions reset, and the control socket not
inherited. Arguments and environment are carried as bytes. `Started` means
an exec was observed (a close-on-exec handshake, then the child's proc flags
under its still-unreaped identity). It does not mean the program got far,
or will keep running.

The supervisor's main loop is the only caller of `waitpid(-1, __WALL)` in
that process. The shell's exit status is reported, but a shell exiting does
not end the launch: jobs it left, including ones that called `setsid` and
left its session, stay owned. Stop moves a launch through these steps:

1. The runtime sends a numbered Stop claim.
2. The supervisor signals each direct child it still holds, through a pidfd
   taken and checked against its unreaped identity: TERM first, then KILL
   after the 400 ms grace.
3. After two seconds it reports "unconfirmed". A new Stop restarts the
   escalation.
4. Only `ECHILD` from the all-child wait, for the current claim, makes it
   report "extinct". The runtime accepts that only while its pidfd witness
   of the supervisor is still live.
5. The runtime then lets the supervisor exit, and reaps it.

Some things never count as success: a timeout, a lost or out-of-order
channel, a supervisor that died after a launch was sent, or an uncertain
send. These keep the launch owned (`OwnedGroup::pid` stays `Some`), so Stop,
destructive cleanup and idle exit go on treating it as live work.

A lost channel usually settles by itself. The supervisor sees its end
close, stops everything as for a Stop, and exits with status 124 only once
its all-child wait finds nothing left (`linux::EMPTY_AFTER_LOSS`). The
runtime reaps that exact helper, and that status is the proof. A
supervisor that is killed or crashes ends with anything else, and leaves
the launch lost for good: nothing it started can be observed any more, but
it may still run. Only the reader releases such a launch, explicitly (see
below). It is never forgotten silently.

### Integration with the runtime

Only the process creation in `Terminals::spawn_after` changes on Linux:

- portable-pty's spawn is replaced by the supervisor bootstrap;
- `Waiter::Supervised` waits on the shell status the supervisor reports;
- `OwnedGroup` defers `pid` and `signal` to the launch's supervisor.

Every caller (Stop, Stop All, tab and session removal, merged cleanup,
resource kills, the stop confirmation above) is main's code unchanged. The
bootstrap runs under whatever guards the caller already holds, as
portable-pty's spawn did. It normally completes in milliseconds and is
bounded at 12 seconds. A bootstrap that fails with ownership unsettled
stays listed under its pane id, for Stop to end.

This is deliberately narrower than the 2026-11-12 draft, which moved
discovery and bootstrap outside the runtime, admission and authority
guards. That needed a Linux-only launch, send and admission path (pending
launch records, cold-send tickets, discovery fencing) beside main's, and it
is not carried. The cost is that a pathological bootstrap can hold the
caller's guards for up to the 12-second bound. Main's spawn under those
guards was never unbounded-safe either: a hung `fork` or `exec` held them
indefinitely.

### Through a runtime update (#765)

The in-place handover carries supervised launches:

- `freeze` holds each launch's observer still, between whole exchanges.
  What it has sent and received is all in its state, and anything newer
  waits in the channel.
- The record gets that state, plus a duplicate of the control socket that
  the exec keeps open.
- The supervisor stays this process's unreaped child across the exec, so
  its pid still names it. The runtime that takes over reaps around it,
  re-opens its pidfd, checks that the channel is a SEQPACKET pair this same
  process made, and resumes the observer.

Shells, agents and their jobs keep running in the same terminals, as on
macOS. A handover that is called off lets every observer go on.

A launch that cannot be carried as it stands is listed in
`runtime.handover.plan` by its terminal's title, as a `Terminal` item with
its pane id. That covers one still starting, one between proof and release,
and one lost. The handover then refuses as `handover_unadoptable`, never as
`handover_busy`. The desktop reads the plan again every five seconds with
no attempt cap (`replace.rs`, `check`), shows what it is waiting for, and
finishes the update once nothing is listed. A starting launch clears within
the bootstrap bound, and a lost channel settles as above. The items carry
no session or tab, so Update now and Restart now never stop them.

What clears a launch lost for good is the reader. When Update now or
Restart now passes back a shown item's pane, `runtime.handover` releases
exactly that launch, if it is lost for good, before deciding what still
blocks. The log records that what it started may still be running,
unowned. A launch still starting or cleaning up is not released and goes on
holding. So the update can wait on a lost launch only while the window
names it, and the reader can always get through by choosing to update
anyway.

There is one remaining way for the update to give up. A refusal that comes
as `handover_busy` (a terminal opening just as the freeze began, a hook or
pipeline step not settling) counts toward `BUSY_ATTEMPTS` (six) in
`replace.rs`'s `handover_busy`. After that the window shows the blocker and
advises Stop all and quit, as it does on macOS. A supervised terminal
reaches that path only through the transient "A terminal was opening."

### Evidence and its limits

Tests:

- **`src-tauri/serve/tests/local_supervisor.rs`** drives the shipped module
  from a dispatcher with no libtest harness. It covers live exec and stop,
  injected bootstrap faults, lost and uncertain launches, clone, nested and
  orphan adoption, multithreaded leader exit, and a helper refusing a parent
  that is another program.
- **The lib's Linux tests** (`pty::supervised_tests`) start real supervised
  panes. They cover:
  - an escaped `setsid` job stopped with its launch;
  - ownership outliving its shell;
  - a lost channel settled by the supervisor's own exit-124 proof;
  - a launch whose supervisor was killed holding the freeze, named by pane,
    never released by itself, and released only explicitly (a running
    launch never is).
- **The #765 tests** (`pty::handover::tests`) carry real supervised panes
  between two `Terminals` in one process.
- **`serve/tests/local_handover.rs`** execs the real runtime with a terminal
  and agents running.

These ran in a Linux container: aarch64, kernel 6.8, uid 501, all
capabilities dropped, no-new-privileges, no network.

What this does not show:

- other kernels, seccomp profiles, proc mounts or user namespaces;
- a packaged Linux desktop being updated;
- the unchanged-privileges check against a real setuid launch, which no test
  can run unprivileged.

Darwin's census omission stays on its separate hold.
