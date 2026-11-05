# Paired ownership and capacity diagnostic — prepared, not measured

The unresolved production result remains **+68.4607671%**. This is a new scoped
standalone-engine diagnostic, not another logging attempt, browser acceptance
run, buffer-size reduction or replacement renderer. Its explicit collection
must never be used to pass an acceptance endpoint.

## Evidence supporting the next question

The existing parser-only JSC snapshots were re-read offline: both baseline and
endpoint had zero Uint32Array instances, as did the library-only control. Those
snapshots collected the heap but did not capture matched native residency.
Conversely, the unforced WKWebView control captured native growth but still had
21/24 tracked objects alive. Neither observation separates collected terminal
storage from process capacity at the same endpoint.

A tiny capability-only command on assigned `local:terminalx-cua-macos` exited 0
and verified `gc`, `memoryUsageStatistics`, `MemoryFootprint` and `readline` as
functions, plus the statistics field names. It created no terminals, invoked no
collection, and recorded no performance counters. Raw output is
`counter-capability.txt`. Same installed JSC hash as the previous scoped graph
experiment; this does not make the 4-CPU/8-GiB guest equivalent to the original
2-CPU/6-GiB guest or physical macOS 27 host. #466's guest was not accessed.

Upstream source provides a more direct mechanism than inferred GC log events:

- [jsc.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/jsc.cpp)
  exposes the functions. `gc()` requests synchronous full collection; statistics
  and footprint are separately obtained. No DollarVM flag is required here.
- [JSBase.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/API/JSBase.cpp)
  exposes heap size/capacity, extra memory, counts and object-type census.
- [Heap.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/Heap.cpp)
  defines heap size and capacity as object-space size/capacity plus extra memory.
  Extra memory includes array-buffer accounting. Thus capacity minus size is an
  object-space accounting difference, not a count of physically resident wasted
  bytes or unused Gigacage pages. Before collection, “live-cell” enumeration
  does not establish root reachability.

Saved source hashes are in `source-manifest.json`. Upstream main is not the
installed binary's source revision; record raw fields and reject unsupported
schema rather than treating these descriptions as byte-exact native attribution.

## Exact bounded experiment

Request **one three-minute coordinated resource window**, no build, no host GUI.
Three fresh standalone JSC processes run **serially** in the assigned alternate
guest: `control`, `disposed`, `retained`. Each gets an empty private HOME/TMPDIR
and minimal environment. Core bundle SHA remains
`01a701e40cc0fc68796b19f6987ce1f0bc25b6fe6124de298787ebc5366d679c`.
No production source or installed engine changes are involved.

1. Load the actual installed-xterm common bundle and the same diagnostic code in
   every process. Collect once, report baseline counters, then sample that PID
   with `footprint -f bytes` while blocked on stdin acknowledgement.
2. Control constructs no terminals. The other arms each construct eight
   80×24/10,000-scrollback terminals, parse 5,000 ANSI lines apiece, check output,
   and dispose. Only `retained` keeps all eight disposed terminals in an explicit
   array. No `.buffer` materialization or weak-reference dereferencing occurs.
3. After workload stack frames return, report unforced counters; do not substitute
   them for a collected endpoint. Invoke the shell's explicit synchronous GC,
   report counters, and capture native footprint from the same still-live PID.
4. Clear the intentional root array in all arms, collect again, report counters
   and capture native footprint once more. Acknowledge and verify actual exit.

This is **16 terminal constructions total**, three processes, four counter
checkpoints each and **nine** native footprint samples. No full heap snapshots
are emitted, avoiding their large graph/JSON allocations in measured processes.
The workload itself creates approximately 42.6 MB of logical typed-array spans
per parser arm cumulatively; that is not a promised resident-memory maximum.
Processes run one at a time on the 8-GiB guest. The driver has a 170-second shared
work deadline plus bounded owned-child cleanup inside the proposed three-minute
cap. It stops on the first error, never retries or extends the reservation.

Stage `core.js`, `workload.js`, `probe.js` and `run.py` in a new private directory
only after the resource window is coordinated. Use the verified guest hostname
`Apple-Virtual-Machine-1.local`, `--scheduled-diagnostic`, `--fixture` and a new
`--output` path. The driver verifies core/JSC hashes and records script hashes.
Capture host/guest load before and after without examining command arguments or
other agents' data. Announce actual start/end and release promptly.

## Falsifiable controls and interpretation

- **Positive control required:** after collection, `retained` must still own eight
  disposed terminals and show the corresponding Uint32Array census above its
  baseline. If the counter cannot detect known retained buffers, reject its use
  for ownership attribution; do not relabel a zero count as collection proof.
- If `disposed` retains comparable Uint32Array counts after explicit collection,
  investigate actual remaining JS roots or conservative stack retention. Capacity
  alone is not a sufficient explanation. This would justify a targeted graph
  capture in a later diagnostic, not an automatic additional run.
- If `disposed` and the released positive control return their typed-array census
  and extra-memory accounting near their own baselines while native categories
  stay elevated, the residual cannot be explained by those live terminal arrays.
  Compare heap capacity/size and the library-only observer control. This supports
  retained engine/allocator residency in this process, **not** a numerical proof
  of fragmentation, a cache bound, or the production residual's owner.
- If counters and native footprint both decline on collection/release, the scoped
  allocation is reclaimable. That does not show when an unforced WKWebView would
  collect or satisfy the original fixed-endpoint criterion.
- If the positive control's arrays remain after clearing its root, do not infer
  allocator retention. Retain the failed control and investigate rooting/engine
  semantics first. No repeated GC or longer wait is allowed to obtain a desired
  result.

Record numerical deltas, not a new pass threshold. Shell `MemoryFootprint`
current/peak and external `footprint` fields are separate accounting observations,
not interchangeable. Do not subtract heap-reported bytes from physical footprint
and label the difference allocator waste. The small stats/report objects and JIT
warm-up are observer effects; the library control records them but cannot exactly
subtract nonlinear effects from parser arms.

## Preparation validation

`check-workload.cjs` runs the hash-verified actual common bundle under Node. All
three modes passed: checked terminal output, explicit roots 0/0/8, preserved
5,001 normal lines and 524,288-byte parser views in retained disposed terminals,
release of the root array, and rejection of repeat workload invocation. This is
source/control validation, not native GC or memory evidence. `probe.js` syntax
check and driver `--help` passed. Existing captured graph schema and zero-array
endpoints were checked again. No comparative native measurement ran.

No production repair is supported yet by this new preparation. Full project
checks were not rerun; final-head checks/review and original native acceptance
remain outstanding. The prior fourteen logging/analyzer tests remain unchanged.

## First coordinated attempt: not measured

The coordinator authorized one three-minute run subject to #467's explicit
combined-check completion and an independent contention check, with latest start
16:27 UTC and hard expiry 16:30 UTC. #467 reported at 16:23:40 that Cargo PID 2951
and rustc PIDs 2952/2953 were still active; existing work remained untouched.

The isolated fixture was staged at
`/tmp/tx232-ownership-capacity-20261024` on `local:terminalx-cua-macos`.
All four transferred artifact hashes match source `80ca3545`, and guest driver
`--help` exited 0. The driver/probe itself was **not launched**.

At 16:25 UTC the host no longer showed Cargo/rustc. Sampled CPU idle was
78.33–88.36%; host load was 2.92/3.82/3.62, with 340 swap-ins and no swap-outs in
the sampled interval. Guest load was 0.66/0.82/1.31, with no process over 10%
sampled CPU or identified build/model/probe workload. These were preparation
checks, not a claim of a completed quiet measurement.

The required owner completion confirmation did not arrive by the cutoff.
Process disappearance was not substituted for that confirmation. At
**16:27:05 UTC**, the pending hold was explicitly released to #467. No extension,
job interruption, new diagnostic process or memory sample occurred. Coordinator
was notified in the owning session. Raw staging, process inventory and supported
CLI coordination responses remain in host
`/tmp/tx232-ownership-capacity-20261024`.

No reservation is held. A later coordinated three-minute window with actual
owner exit confirmation is still required; no new user/product decision is
needed. Production acceptance remains failed and unchanged.

## Completed adaptive run

[The collected ownership/capacity result](result.md) completed all three processes
and nine samples. The positive control went from 40,024 live Uint32Array objects
to zero while substantial native residency remained. This is diagnostic evidence,
not production acceptance. The resource hold has been released.
