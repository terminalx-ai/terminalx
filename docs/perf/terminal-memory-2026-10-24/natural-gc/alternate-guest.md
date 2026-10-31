# Alternate guest capability preflight

Coordinator assigned `local:terminalx-cua-macos` for **read-only preflight and
preparation**, preserving #439 artifacts. `local:tx-queue-232` remains with #466
and was not accessed. No quiet reservation or diagnostic execution is granted.

The named `cua sandbox info local:terminalx-cua-macos --json` returned
`state: stopped`, `status: stopped`, backend `lume`, kind `vm`. No resume, guest
exec, file transfer, GUI action or guest filesystem modification followed.
Its current OS/architecture/hostname and resumable user workloads are therefore
**not verified**. A stopped VM's lack of host execution does not establish that
it will resume without active jobs. Historical guest identity is insufficient.

## Prepared artifacts

A local-only minimal bundle is ready at
`/tmp/tx232-natural-gc-alternate-prep-20261024.tar.gz` (86,303 bytes). It contains
only the existing `probe`, `core.js`, `workload.js`, the observation/analyzer
Python scripts and a byte/hash manifest. It contains no credentials, accounts,
history, acceptance data or #439 artifacts. The probe's saved SHA256 matches the
previously verified `955054db9c03609060e936b9efd9cf30f203af018cb526a8a93eee3c1ba96ca5`.
Host-side Mach-O inspection shows **arm64, minimum macOS 26.0, SDK 26.5**.
Compatibility is conditional on checking the actual resumed guest; the binary
was not executed on the host. The eleven offline analyzer/guard tests pass again.

## Remaining preflight after coordinator permits resume

Use only the explicitly named sandbox route. First verify named guest state,
then run read-only commands with a short timeout:

```sh
cua sandbox exec --timeout 15 local:terminalx-cua-macos 'sw_vers; uname -m; hostname; sysctl hw.ncpu hw.memsize; uptime; ps -axo pid,ppid,%cpu,etime,comm; command -v python3'
cua sandbox exec --timeout 15 local:terminalx-cua-macos '/usr/bin/log help show'
```

Save outputs. Inspect process names/CPU without command arguments or environment
values that could expose credentials. If a user/agent/model/build job or sustained
WindowServer load is present, report the exact process and do not kill it or
start the probe. Verify macOS >=26, arm64, Python availability and supported log
query syntax. Capture the installed JSC helper's version/hash when available;
never copy host credentials or configure guest authentication.

When preparation writes are permitted, use a new private directory such as
`/tmp/tx232-natural-gc-capability-alt-20261024`; refuse an existing path. Transfer
only the bundle, verify all manifest hashes, and preserve every existing #439
path. Record the actual `hostname` from this guest and supply it literally to
`observe.py --guest-hostname`. Do not reuse the original guest's hostname or
substitute the host's name. Named targeting plus verified identity remains
mandatory; the guard does not authorize a different target.

## Proposed bounded run

After preflight passes, request **one two-minute quiet reservation** for one
parser capability process, with the normal five-second baseline/endpoint delays.
The invocation is the existing `observe.py`, with the verified hostname,
`--scheduled-disposable-guest`, the new fixture directory and a new results
subdirectory. No footprint comparison, full soak, compilation, forced GC or
additional pressure is involved. Preserve actual process exit, raw child logs,
option candidates and liveness; release immediately after completion or failure.
Do not automatically retry or start a second run.

This guest can answer whether **its installed WebKit** exposes natural-GC logging
through the supported process-private path. Successful child-specific logging
would establish that capability here, not prove it on the original guest or
physical host. Missing logs remain inconclusive. Even matching OS versions do
not make this a reused memory baseline. The production **+68.4607671% failure**
and all original physical failures remain unresolved and unchanged.

No production sources changed. Full project checks were not rerun for this
preflight document; the eleven offline diagnostic tests passed. No resource
reservation is held. The next dependency is coordinator lifecycle permission for
this stopped guest, followed by read-only verification and the separate bounded
run reservation—not a product decision or a need for user credentials.

## Authorized resume and completed staging

The coordinator subsequently authorized resuming this existing guest and preparing
isolated state. Supported `cua sandbox resume local:terminalx-cua-macos` succeeded.
The first exec during startup failed with `rpc failed: transport error (Aborted)`;
a subsequent bounded read-only exec succeeded. No guest was recreated or deleted.

Actual identity: **macOS 26.5.2 (25F84), arm64, 4 CPUs, 8589934592 bytes RAM**;
hostname **Apple-Virtual-Machine-1.local**, Python 3.9.6. Installed JSC helper SHA256
is `ac4ab8952b32a3d2110cde476f096e7884d0ad4c879b0e7bd0b9919be8c8728e`.
This matches the earlier helper hash, but the guests have different resources and
this is not a performance-baseline equivalence claim.

The initial process inventory showed startup system activity, not an existing
agent/build workload. At **15:51:54 UTC**, no process exceeded 10% sampled CPU,
WindowServer PID 194 reported 0%, and no TerminalX/agent/build/model/probe workload
was found. Load averages were still 20.99/11.82/4.92 from startup. These snapshots
do not establish quiet comparative-measurement conditions.

Preflight caught an actual driver issue: `log help show` emits the expected syntax
but exits **64 (EX_USAGE)**. The driver now accepts 0 or 64 only when all required
syntax tokens are present. The captured help regression rejects other exit codes,
permission-error text and missing process filtering. All **12** offline tests
pass, including the original wrong-host guard.

Created only the new private directory
`/tmp/tx232-natural-gc-capability-alt-20261024` (umask 077) and transferred the
minimal corrected bundle. All five artifact hashes were compared successfully
with the local manifest. Guest `python3 observe.py --help` exited 0. No #439
artifact was read, overwritten or removed; #466's guest was not accessed.
Local corrected bundle: `/tmp/tx232-natural-gc-alternate-stage-20261024.tar.gz`
(86,375 bytes). Raw preflight/staging outputs are retained alongside the local
preparation/staging directories and in `alternate-preflight-evidence.tar.gz`.

The exact proposed command, **not executed**, is:

```sh
cua sandbox exec --timeout 120 local:terminalx-cua-macos 'cd /tmp/tx232-natural-gc-capability-alt-20261024 && python3 observe.py --guest-hostname Apple-Virtual-Machine-1.local --scheduled-disposable-guest --fixture /tmp/tx232-natural-gc-capability-alt-20261024 --output /tmp/tx232-natural-gc-capability-alt-20261024/results-01'
```

For this capability-only question, no pause of #439's serial host matrix is
necessary: preserve contention observations and make no timing, memory, GC-rate
or absence-of-GC inference. A positive child log can establish logging capability
under these conditions; empty output remains inconclusive. Any later comparative
measurement still requires separate scheduling. Execution remains proposed rather
than started; no reservation is held and no host matrix was paused. The guest is
left running for the proposed bounded probe.
