# Private #643 fixture continuity overlay — source checkpoint, UNEXECUTED

Base439 source3d73b0a40d29d5c55f22fdf89bd3de775d4bdc53; previous deliberately
partial overlay49ec49fd. This child implements a fixed local fixture boundary
and discriminator. No compiler, tests, app or guest were run. Baseline439
checks are not overlay credit. Independent review and a separately bound
runtime-bearing build/deployment remain mandatory.

## Selection and normal-build absence

Only `terminalx_recovery_acceptance && debug_assertions && desktop && macOS`
compiles the module, fault/PTY observer and native reconnect counter. The owner
is built separately without desktop and has none of these. No production
RPC/invoke handler, feature, dependency or arbitrary script endpoint added.

F1 child additionally requires the private frontend compile input
`VITE_TERMINALX_RECOVERY_ACCEPTANCE=fixed-local-v1`. Only that frontend emits
the fixed call-site observation event; ordinary builds with this input absent
emit nothing. The native listener remains under the original Rust guard and
private identity checks. Both frontend and native source/pins must be rebuilt
and reviewed together; no existing artifact supplies this evidence. The small
frontend origin-metadata plumbing does not decide retries, delays or budgets.

Fixed bundle `com.terminalx.next.dev.recovery643.private3d73b0a4`, root
`/Users/Shared/tx643-private-recovery-3d73b0a4`, private home/state/bin/fixture,
scenario `TERMINALX_RECOVERY_ACCEPTANCE=fixed-local-v1`. Root/home/state/bin/
fixture must be canonical, same effective UID and mode0700; source files and
journals must be private regular single-link files, never symlinks. No old
root is reused. Interpreter requires TWO compile-time pins:
`TERMINALX_RECOVERY_PYTHON_PATH` (canonical guest executable path) and
`TERMINALX_RECOVERY_PYTHON_SHA256`. They are intentionally not fabricated from
host Python. Missing pins prevent permission construction; runtime environment
or receipt cannot replace them. Build-script rerun bindings track these inputs.

## Trusted disposable boundary and explicit ready handoff

Later provisioning, NOT executed/released here:

- Use the separately reviewed runtime-bearing build recipe, with this derived
  source+overlay identity and new private bundle/root. Include signed matching
  local-ui owner; normal app startup installs it in state/runtime. Require a
  fresh owner parented by this desktop; no borrowed existing runtime.
- Stage exact scripts/remote-runtime/fake-claude as `<root>/fake-claude` and
  scripts/local-runtime/recovery-fixture.py as executable `<root>/bin/claude`.
  These are embedded using include_bytes in the verifier; compare their
  SHA256/modes before any later launch. Provide only the reviewed pinned
  interpreter as python3 on the private PATH; keep real providers/account CLIs
  rejected. No original Claude/config/account is read or resumed.
- Driver creates a fresh challenge (create_new0600/fsync), logs waiting state,
  and waits up to180s for `<root>/fixture-ready` containing EXACT challenge
  bytes, no newline. It neither starts agents nor creates sessions. Future
  coordinator-owned setup uses supported `terminalx sessions create --project
  <root>/fixture --agent claude --prompt slow:600:1000 --on-main --json` twice
  in the private app environment. Project registration and directory setup
  are future explicit operations, not invented code in this driver. Both
  source-pinned no-account fixture turns must still be live.
- Put the two DIFFERENT fixture panes in main/floating chat windows, with
  respective drafts tx643-main-unsent and tx643-floating-unsent. PTY-first
  TabView keeps its TerminalView mounted under chat; accepted tap bytes can
  be observed without changing view mode. Only after actual setup writes the
  ready file does the worker validate the full boundary. Ready is a trigger,
  not authority. Existing/stale challenge/output files stop a new run.

Boundary checks kernel Darwin proc_pidinfo/PROC_PIDTBSDINFO PID,start seconds/
microseconds, UID,parent and proc_pidpath/executable hash. KERN_PROCARGS2 binds
actual interpreter argv to fixed adapter and exact fresh provider session id
(no --resume). Bounded ancestry must reach the SAME source-matching owner.
Owner executable must be in private state/runtime and match the packaged
resource hash; its parent is this desktop. Process identity is read again
after hashing/binding to reject PID reuse. No process is signalled/spawned by
these helpers. Interpreter pin absent/mismatch, wrong process shape or unsafe
path stops before fault; no inferred shell/interpreter fallback.

Adapter uses the existing fake via fixed-path runpy, never a model. Version
queries are not launches. Each live launch creates one new private journal;
threads serialize/flock/fsync complete start, accepted-submit and output rows.
Marker `TX643:<challenge>:<pid>:<cursor>` is written through the actual PTY.
Native binder verifies sequence/challenge/PID, one start and one exact
slow:600:1000 submit, live process and canonical user_message count1. Extra
launch journals, submits, exit rows, missing/partial/busy persistence all fail.
Counters refer to fixture starts and meaningful non-command submit calls,
not every byte written by a harness. Source-pinned adapter/interpreter plus
kernel lineage and existing session/tab/pane APIs bind that distinction;
a `verified=true` or PID-only receipt cannot arm it.

## Fixed scenario and observation semantics

One worker, main-thread eval dispatch only, no GUI-thread waiting. Existing
pending-id waiter/drop retirement is preserved. Snapshots are fixed read-only
DOM/sessionStorage reads. Window tap observer stores at most16KiB/window and
only records bytes accepted by the original tap. Before/after comparison
requires fresh markers beyond captured cursors in BOTH owner output and
accepted window taps, same process starts/PIDs/owner epoch/session/tab/pane
and unchanged start/submit/canonical counts. This is actual reader delivery,
not a pixel/render-latency measurement.

Read-only pagehide listeners witness the REAL localDrafts checkpoint before
reload; installation is acknowledged before a fault using two bounded ids.
Post-reload requires changed timeOrigin, exact draft and consumed checkpoint;
pre-reload checkpoint must map the visible fixture pane's tab to the exact
sentinel, include only the two bound local tab IDs and have no duplicate keys.
Shared recovery observes both windows. No storage write, mock reload or
manufactured event occurs. WebKit may drop IPC on unload: missing witness is
INCOMPLETE, never inferred successful. Late listeners/replies address retired
ids only. Current Desktop is resolved anew for every EOF, not retained across
replacement; shutdown leaves normal real-reader EOF/error/event handling intact.

Phases: main-reader EOF; shared-event EOF; enough further main-reader EOFs to
reach three TOTAL main native reconnect calls across actual documents; a new
main-reader EOF with12s/two poll periods of no additional automatic call;
then wait for a REAL candidate Reconnect action (driver never clicks); finally
wait for explicit clear-ready challenge handoff plus actually empty main
composer and repeat manual recovery to require no resurrection. Native entry
counters are per window; storage must equal min(actual calls,3), including
manual calls after saturation. Missing action/clear handoff times out. Floating
is unchanged for view-only faults and reloads only for shared repair.

Manual acceptance now requires a bounded read-only witness, installed after
the quiet interval, for the original trusted click on the visible enabled
Reconnect button in main. A WeakSet binds that exact DOM Event object to the
event carried through the real handler's async/pending check and observed at
the actual reconnect call site. A click near an unrelated automatic invocation
does not suffice. Coalesced distinct/mixed actions conservatively fail this
single-action oracle without changing retry behavior. Synthetic clicks are
rejected; the driver never creates an action. The witness binds pending-request
phase ID, window, timeOrigin, location.origin, action/install/invocation times
and exactly one action. A delayed automatic call after12s has no bound manual
origin and is rejected even if its reload succeeds. The phase still requires
exact native counts, no active/late extra call, checkpoint and fresh output.
Both manual phases use this predicate and persist the witness in their evidence.
The180s manual deadline now includes silence and observation; it is not reset
after a click. Listeners remove themselves on first call-site observation,
pagehide or180s timeout; native pending IDs retire on every return. Missing
frontend flag, missing/lost witness or incompatible event timestamp semantics
is INCOMPLETE, not permission to infer a manual action.

The two Rust F1 predicate drafts cover delayed-auto/nearby-click rejection and
manual-positive plus stale phase/document/window/origin/time rejection. Two
frontend drafts bind a delayed auto call to null action and a manual handler
to the exact original event. JSDOM input remains untrusted and cannot prove
live positive acceptance. All four additions are unexecuted source drafts.

Each completed phase is fsynced before progressing. Missing output, truncated
JSONL, failed fsync, no final record, startup/worker error or absent ready state
is incomplete. Consumers must parse the ENTIRE retained log and require final
LOCAL_SCENARIO_COMPLETE with no errors plus successful invoker completion;
absence/partial evidence is not a pass. Existing native RPCs still have120s
read timeouts:45s phase/180s handoff/manual deadlines are cooperative, not a
hard total bound during native calls. A future bounded invoker is still needed.

## Residual gates and limits

No guest interpreter inventory/hash, signed overlay/owner or runtime lane is
supplied here. All source controls are UNRUN; compilation is unproven. Source
fixtures may encounter a different actual PTY launch shape or unload IPC
behavior; mismatches fail, not weaken the pins. This scenario exercises closed
readers and successive recoveries, not hung-reader heartbeats, arbitrary fault
timing, malicious same-UID processes, cloud isolation or rendered latency.
It does not kill/restart an owner, imitate real-provider access, grant consent
or load microphones/models. Local/native counters do not claim remote receipt.

Private file ownership/hashes protect this isolated trusted fixture boundary;
they are not attestation against a malicious same-UID actor replacing files or
forging IPC. Original failures/seals, host UI lock, original Claude read-only,
#439 source/apps, watcher/queue and merge/cleanup holds remain unchanged.
