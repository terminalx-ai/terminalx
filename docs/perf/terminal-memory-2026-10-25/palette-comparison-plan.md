# Faithful palette-repair comparison — preparation only

No build, guest access or measurement has been performed for this plan. Neither
CUA guest is assigned to this worker. The proposed target is the previously
working default-WebGL `local:terminalx-cua-macos`, subject to coordinator assignment
and fresh identity/readiness checks. Earlier +68.46% guest and +22.29% physical
cleanup failures remain unchanged. A different guest/OS baseline cannot overwrite
them or establish physical-host acceptance.

## Exact comparison and artifact reuse

Parent: `e3f898e8673bf158689cfd8a09c917ca3bd1c434`.
Candidate: independently reviewed `c378ada9dd75cd28f5e28cdf2ebed9374e16cd3f`.
Both include the earlier metadata/disposal repairs; their runtime difference is
only palette surface reuse. Do not compare candidate to 550d4522 and attribute
all changes to the palette fix. The companion manifest pins common workload,
fixture, lockfile and configuration hashes. Binary hashes are explicitly pending.

Existing `/tmp/tx232-repair-550d4522/app.tar.gz` is 26 MiB and its source.txt pins
550d4522: reusable as preserved failed evidence, NOT a matched parent. The original
42a1ef4b physical bundle is also too old. The current target/debug bundle exists
(~75 MiB) but has no verified manifest matching either requested head: do not
relabel it. The c378ada9 functional check results are reusable; no unchanged test
suite/count-only diagnostic is requested. Existing dependency/toolchain caches
may be reused after build provenance verification, not as proof of binary identity.

## Build phase — separately scheduled, no GUI

Allow a separate 30-minute jobs2 build budget for two sequential debug bundles;
this is a reservation request/abort budget, not a promised compile duration.
Audit disk first: preparation observed only ~11 GiB host availability. Require a
coordinator-approved cache/output budget and at least 20 GiB available before
starting; do not delete another worker's artifacts or assume a warm incremental
build fits. Reserve at most 2 GiB for copied bundles, archives and run artifacts;
Cargo output can exceed that and must use the agreed build cache budget.

Export each exact commit with `git archive` to a new disposable source directory,
without switching this branch or editing another worktree. Use the installed
matching node_modules read-only through a symlink, verify the pinned lockfile,
and use this worktree's existing Cargo target only after exclusive build-cache
access is confirmed. Do not run concurrent parent/candidate builds. Commands per
arm (paths assigned once the build window is granted):

```sh
# source_sha is exactly one of the two full hashes above; source_dir must be new.
git archive "$source_sha" | tar -x -C "$source_dir"
ln -s "$issue_tree/node_modules" "$source_dir/node_modules"
# From source_dir; private stores must be fresh per arm.
env SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" CARGO_BUILD_JOBS=2 \
  CARGO_TARGET_DIR="$issue_tree/src-tauri/target" \
  TERMINALX_HOME="$build_state/store" CLAUDE_CONFIG_DIR="$build_state/claude" \
  pnpm tauri build --debug --bundles app --no-sign \
  --config src-tauri/tauri.dev.conf.json
```

Record actual toolchain, SDK, source hashes, build start/end/exit and logs. Copy
each completed bundle out before the next build. In that copy only, assign the
private Perf bundle identity, remove URL schemes and ad-hoc sign, following
bench-app.sh's packaging steps WITHOUT its launch step. Use identical identities
and names for sequential arms, with distinct private paths. Record executable,
frontend assets, full bundle file manifest and archive hashes; verify deep/strict
signature. Check min OS/arm64 compatibility against the assigned guest before
transfer. Stop on build/signature mismatch; no fallback to an old bundle.

## Measurement reservation and private state

Request **15 minutes exclusive guest/quiet host time**, after both artifacts are
ready: up to 2 minutes common readiness, 5 minutes per arm, and 3 minutes total
termination/transfer margin. Parent then candidate, sequential fresh processes;
no retries or extra diagnostic variants. Each five-minute watchdog starts at
launch and bounds startup, workload and termination. A timeout is INCOMPLETE,
not a shorter successful soak. No start unless the full reservation is available.

The earlier unprofiled control's app step durations were 2.7 + 18.4 + 20.8 + 18.2
+ 2.2 = **62.3 seconds**, plus **25 seconds** of fixed driver waits, five polling
rounds and native process-memory sampling overhead. Startup/visibility/identity
checks are additional. Thus two minutes might fit a fast run but is not a sound
cap for the complete workload. This five-minute cap adds deadline headroom only:
it DOES NOT move the sample endpoints or add a post-cleanup wait. If a slow guest
cannot finish, retain incomplete evidence and do not extend automatically.

Guest private roots: `/tmp/tx232-palette-parent` and
`/tmp/tx232-palette-candidate`, both required absent before preparation. Each gets
its own app copy, home/.claude, bin, scripts, work and results directory. Copy the
pinned fake-claude script as bin/claude (not a host symlink); verify python3 and
node paths in the assigned guest. No credentials/account data are transferred.
Create files only beneath these new roots. Preserve prior workers' artifacts.

After assignment, launch each app once through the supported guest route with:

```sh
# arm_root is one of the two private roots, never a real store.
open -g -n -a "$arm_root/app/TerminalX Perf.app" \
  --env "HOME=$arm_root/home" \
  --env "CLAUDE_CONFIG_DIR=$arm_root/home/.claude" \
  --env "PATH=$arm_root/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  --env "TERMINALX_HOME=$arm_root" \
  --env "RACCOON_DEV_KEYCHAIN_SERVICE=dev.terminalx.perf232.palette" \
  --env "TERMINALX_TERMINAL_BENCH=1" \
  --stdout "$arm_root/results/app.log" --stderr "$arm_root/results/app.log"
```

Use a nonblocking orchestration process with private PID/start/completion files,
not streaming CUA stdout as readiness. Verify one exact executable path/PID,
private socket status PID/home and binary hash before driving. Record OS/build,
WebKit/UA, CPU/RAM, guest identity, host/guest load/process snapshots, swap and
actual viewport/scale. Keep a normal foreground visible app window with identical
geometry/mode in both arms; no Inspector, renderer override, Redraw, memory probe,
heap tools, forced GC or private GPU preferences. Supported named guest UI only;
no global target switches. If visibility or default WebGL cannot be established,
stop as invalid instead of substituting another renderer. Record pre-run readiness
elapsed time and start immediately after identical readiness checks in each arm;
no extra warmup workload.

Run the pinned common driver once per verified PID:

```sh
node "$arm_root/scripts/terminal-bench.mjs" \
  --home "$arm_root" --pid "$verified_pid" \
  --scenarios soak --soak 4,50,200,20 \
  --work "$arm_root/work" \
  --label "$source_sha fresh faithful palette comparison; guest-only" \
  --out "$arm_root/results/soak.json" \
  > "$arm_root/results/driver.log" 2>&1
```

Do not pass `--memory-diagnostics`. Confirm fake agent availability before starting:
the driver otherwise skips the agent step! Reject missing/short agent workload.
No real providers, cloud calls or authentication. This measures synthetic native
memory, not real authenticated agent/cloud correctness or latency acceptance.

## Original fixed timing and result requirements

Preserve the common source exactly:

- Open four sessions, each `seq 1 20000; exec cat`, 100×24 requested terminal size;
  each settle is two animation frames +150 ms, followed by 1 s step wait.
- Fifty shell terminals opened/closed; settle each, followed by 6 s step wait.
- Twenty fake-Claude agent tabs; wait up to 15 s for each instance, then 500 ms,
  close through production tab removal, two frames +150 ms settle; 6 s step wait.
- Two hundred switches: two animation frames +20 ms each, then 1 s step wait.
- Delete all four sessions, wait 1 s, record deletion leftovers, close any leftovers,
  clear selection, then 1 s step wait. Leftovers are still a failure even if repaired
  by this final cleanup path.
- Driver polls every 500 ms and waits exactly 5 s after each completed step before
  reading its endpoint. Preserve this for baseline and cleanup; no later sample
  replaces either. Tool/poll overhead and actual timestamps must be retained.

Require complete=true, all five step results, 50 shell +20 agent closures tracked,
all 70 collected at the endpoint, no deletion leftovers and zero final terminal
resource counters. Missing process samples, failed WebGL, lost process identity,
truncation, crash or skipped step cannot pass. Use raw summed responsible
WebContent bytes, not rounded MB: `100*(endpoint/baseline - 1)` must be <=10% at
both switches and cleanup. Report each arm independently, along with main/GPU,
raw counts and load. Do not subtract the retained 1×1 context or allocator capacity.
A candidate pass on this guest is scoped new evidence, not erasure of earlier
physical/guest failures or satisfaction of all other issue criteria. A candidate
failure leaves the threshold failed even if lower than parent.

## Incomplete-run cleanup and release

The existing driver checkpoints completed steps with complete=false; retain that
JSON, stdout/stderr and timeout/exit timestamps. If failure precedes the first
checkpoint, preserve logs plus a separate incomplete manifest, never fabricate a
step/result. The outer watchdog must not change the driver's per-step waits.
On timeout, stop only the recorded driver child; mark the arm incomplete. Verify
exact app PID, executable/start identity and private root again before sending
TERM to that owned app. Bound exit observation to 10 s; if necessary KILL only
the same verified owned PID. Capture leftover private child identities/commands
before cleanup, and terminate only positively identified fixture descendants;
never name-kill WebContent, TerminalX, Python or other system services. Record
whether termination was natural/TERM/KILL and confirm no owned fixture is left.
Do not delete run roots or raw evidence. If safe ownership cannot be established,
stop and report exact remaining PID instead of touching another process.

Normal completion likewise terminates only this arm's app after its final sample
and status capture, then verifies its children gone before starting the next arm.
After both exits (or first invalid/incomplete arm), release coordinator and other
owners immediately. No automatic retry, guest reassignment, longer waits, extra
measurement or extension. No native allocation-count diagnostic is requested.
