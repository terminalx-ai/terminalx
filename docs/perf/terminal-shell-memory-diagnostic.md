# Shell allocation inventory (UNEXECUTED diagnostic draft)

Base: c205fbe4e55b8efde5e74e90b36e9e79517985ed, including PR652. This is not a
post-652 memory result or an acceptance workload. The earlier native pair still
fails. No GC, scrollback reduction, private allocator setting or renderer fallback.

## Source binding

The existing terminalMemory inventory from exploratory691a95e2 is copied narrowly,
with missing required shapes reported as `unavailable`. No other exploratory
lifecycle, palette, native or framework changes are adopted. Creation records every
terminal, including all four baseline terminals. Pre-disposal records internal
buffers/parser/write queues before teardown; WebGL acquisition/release records
renderer/atlas/canvas identities. These hooks return immediately unless explicitly
enabled by the benchmark. Objects are held only through WeakMap keys/WeakRef targets;
returned samples contain scalar counts/spans only. Enumeration necessarily keeps
dereferenced objects alive for that JavaScript job; samples must not be interpreted
as unperturbed acceptance. Typed-array `.buffer`, terminal text and callback contents
are never read. View spans deduplicate identical views, not overlapping backing
stores. Canvas pixels are not native bytes. Shared atlases are never marked retired
merely because one renderer closes.

The existing bench driver accepts this explicit mode only with exact PID/output,
`--scenarios soak` and4 sessions/50 shells. It creates no 50MB log/TUI workload files,
opens no agent and performs no200-switch phase. Default benchmark selection is
unchanged. The app refuses diagnostic start with nonempty existing inventory and
rejects agent/switch requests during the mode. The full raw JSON is marked
`diagnostic-not-acceptance`; completion means execution completed, not attribution.

Three steps: open4, tabs50, cleanup. Original fill `seq 1 20000; exec cat`, two-frame
+150ms per-tab settle,6s churn settle,1s other-step wait remain. After each result,
a separate `memoryInventory` request returns scalars (including all baseline roots),
then the driver waits the fixed5s before existing process-memory sampling. This
adds inventory request/poll time relative to acceptance and is explicitly diagnostic.
Snapshot has UTC/performance timestamps; external aggregate sample has start/end
UTC/performance timestamps. Clock domains are separate. Tracked terminal counts
must be4/54/54; unknown shapes/mismatch yield `inconclusive-inventory`, otherwise
`pending-native-region-evidence`, NEVER a memory pass. Collection is not asserted.
Cleanup's snapshot clears probe state after building its scalar result.

Reporting repair R1/R2/R3 (source only): live glyph/rectangle children, glyph-only
attribute buffers, renderer/layer/atlas page canvases and numeric pending counters
are required shapes. Missing data is sticky `unavailable`, not an empty payload.
Actual renderer `_store.isDisposed === true` allows released child geometry;
pre-disposal `retired` alone does not. Atlas acquisition may be deferred only when
both device character dimensions are nonpositive, matching the installed source.
`disposedRenderers`/`lazyAtlasRenderers` expose these states explicitly. Rectangle
geometry does not require the glyph double-buffer field.

`pendingWriteUnits` is xterm's mixed raw counter (string UTF-16 code units plus
Uint8Array bytes), with null for incompatible counters. It is NOT pending bytes.
`queuedStringCodeUnits` covers all stored string entries, including processed but
untrimmed entries; typed view spans likewise describe stored payload, not exact
pending offsets. No text/backing-buffer reads are added to separate these units.

Cleanup retains original pre-fallback observations and separately samples owned
sessions/panes/global instances after fallback and the existing1s settle. It also
retains scalar delete/close failure counts (no exception messages/content).
Any failure or nonzero/invalid owned count makes cleanup incomplete; the driver
prioritizes `inconclusive-owned-cleanup` over native-region readiness. Disposal
collection is not required. Failed-run external teardown remains separately bound.

## Exact proposed commands — NOT executed

Only after source review, dependency closure, separately authorized checks/build,
assigned disposable app/PID/home and native capability verification:

```sh
node scripts/perf/terminal-bench.mjs --home "$TX232_PRIVATE_HOME" \
  --pid "$TX232_VERIFIED_APP_PID" --work "$TX232_PRIVATE_WORK" \
  --scenarios soak --shell-memory-diagnostic \
  --out "$TX232_EVIDENCE/shell-inventory.json" --label shell-allocation-diagnostic
```

Do not use a live app/user home or old staged binaries. Exact source diff/lock/patch,
bundle/executable signatures/hashes and runtime engine OS/shared-cache provenance
must be pinned before execution. Runtime engine identity is not SDK identity.
Future focused source checks (not executed):

```sh
pnpm exec tsc --noEmit
pnpm vitest run src/lib/terminalMemory.test.ts --maxWorkers=1 --no-file-parallelism
```

The original six test drafts include real installed xterm view spans, same-object dedup,
no `.buffer` access,4 baseline owners and missing-shape rejection. They are NOT
passes. Driver branch/endpoint integration has not been executed or type-checked.
Additional unexecuted repair controls cover matched valid/missing live shapes,
disposed/lazy states, mixed-unit/non-numeric counters and post-fallback cleanup
policy. Synthetic shape controls do not claim native renderer coverage.

## Native capture plan and actual missing binding

This change implements inventory and workload selection, NOT automatic vmmap/footprint
capture. Current aggregate `memory()` still lacks retained raw responsibility and
region data. No native adapter is silently assumed ready. Before scheduling, bind
ONE reviewed read-only capture at each existing endpoint between the fixed5s wait
and the next workload step. Native capture adds tool time; record it as a perturbation,
not the original acceptance cadence. Do not run the command above and claim the
missing region evidence exists. The per-endpoint capture integration is a remaining
explicit prerequisite after target capability is established, not a new supervisor.

For each baseline/shell/cleanup endpoint, resolve only WebContent processes responsible
for the verified private app; retain PID/start/executable/responsibility before and
after capture. Never infer ownership from process name or parent PID alone. For each
verified child, planned known-tool commands are:

```sh
/usr/bin/footprint -p "$TX232_WEB_PID" -f bytes -j "$TX232_PHASE_DIR/footprint.json"
/usr/bin/vmmap -summary "$TX232_WEB_PID"
```

Preserve stdout/stderr/actual exits, command start/end UTC+monotonic times, raw zone
and region outputs; no parsing-only substitute. Tool paths/options, installed version,
permissions and bounded per-child completion remain UNVERIFIED on the eventual guest.
Use the already reviewed responsibility mechanism only if its ABI/permission is verified
for that target; do not add a private-kernel fallback. Engine binary/shared-cache
identity availability, pressure/swap counters' supported paths/units and PID stability
also remain unverified. No pressure-inducing command is proposed. If any capability
is unavailable, stop the attribution run as incomplete; no privilege/consent bypass.

Budget proposal: one private app, three endpoint captures,90s cooperative per workload
step, maximum300s whole diagnostic including exact-owned cleanup, at most12s per native
tool and32MiB per raw tool output. The existing driver alone does not enforce that
whole-run/native-tool bound; reuse a reviewed owner runner only after command binding,
no new generic framework. No retry, extra variant or adaptive wait. On failure preserve
partial files, stop further workload, and terminate/reap only freshly identified owned
app/driver/fixtures/tools under that runner's bounded cleanup; preserve unrelated state.
No present resource reservation or run authorization follows from this plan.

## Interpretation

Live internal payload requires a retaining-path investigation, not an immediate patch.
Allocated zone bytes near baseline plus persistent dirty WebKit/JS reservation bytes
would support capacity retention in THIS app/engine; it would not prove permanent
leakage or provide a safe decommit hook. Dominant canvas/IOSurface regions would redirect
ownership work. Missing identity/fields/raw accounting, overlapping category sums,
unbounded tool time or incomplete cleanup is inconclusive. Zone totals and their
component regions must not be added together. No attribution category may be subtracted
from the unchanged<=10% acceptance endpoint. A later uninstrumented faithful4/50/20/200
run remains a separate acceptance gate after any demonstrated repair.
