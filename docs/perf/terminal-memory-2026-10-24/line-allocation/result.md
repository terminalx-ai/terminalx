# Line allocation-shape result — 24 October 2026

**All four ownership controls passed; line-sized arrays alone reproduce a large
immediate post-collection native residual.** This does not pass the production
memory target, establish a persistent leak, or identify every allocation in the
original +68.4607671% failure. Original failed acceptance evidence is unchanged.

## Source, environment and actual handoff

Executed source: **94d11de8**. The staged scripts and shared driver are archived
with their hashes; the runtime JSC/core hashes were verified by the driver.
Only assigned `local:terminalx-cua-macos` was used: macOS 26.5.2 (25F84), arm64,
4 CPUs/8 GiB. No host GUI, real session or #466/#627 guest was accessed.

#467's actual handoff was 17:59:45 UTC, after its build exited at 17:59:33 with
no queued heavy work or guest workload. Latest permitted start was 18:00:45,
hard release 18:04:45. Fresh checks showed no Cargo/rustc/build/model job or busy
guest process. Host CPU was 82.76–85.10% idle; the sampled interval had **372
swap-ins and zero swap-outs**, which is preserved rather than reported as zero
swap activity. Guest load was 0.86/1.05/1.00. This is not a latency benchmark.

| Arm | PID | Start UTC | Actual exit UTC | Exit |
| --- | ---: | --- | --- | ---: |
| Control | 2502 | 18:00:32.806355 | 18:00:32.899934 | 0 |
| Raw line arrays | 2506 | 18:00:32.900129 | 18:00:33.013140 | 0 |
| Actual BufferLine objects | 2510 | 18:00:33.013343 | 18:00:33.136186 | 0 |
| Packed arrays | 2514 | 18:00:33.136465 | 18:00:33.244611 | 0 |

The driver exited 0; all twelve native samples completed with matching PIDs,
byte units and no warnings/errors. Completion audit found no JSC probe remaining.
#467, #466 and #627 received direct release notifications, all successful, by
**18:00:50.930685 UTC**. No workload or reservation remains. The first attempt to
copy the result directory was refused by CUA (`is a directory`); only the owned
results were then archived and copied successfully. That retrieval failure did
not repeat or change the measurement. Guest ownership returned to #467; #627
owns the other guest. No further guest access is planned.

## Observed controls and raw-byte results

All nonempty arms contain **38407680 payload bytes** at the held checkpoint.
They differ in allocation granularity and wrapper objects, not payload amount.
The control and all allocation arms share the same pre-baseline xterm warm-up.
Both held and released checkpoints below are explicitly collected diagnostics.

| Arm | Held Uint32Arrays above baseline | Released Uint32Arrays above baseline | Baseline native bytes | Released native bytes | Released native delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 0 | 0 | 12011136 | 12109440 | +98304 |
| Raw line arrays | 40008 | 0 | 11994752 | 66815808 | +54821056 |
| BufferLine objects | 40008 | 0 | 11978368 | 87099200 | +75120832 |
| Packed arrays | 8 | 0 | 11978368 | 53069504 | +41091136 |

All expected counts match exactly, and every arm returns to its own baseline
array census. The raw-line arm's engine heap size falls **51535249 bytes** on
release/collection and capacity falls **52721361**, yet its external footprint
increases by 81920 bytes between these immediate checkpoints. That is not a
claim that GC itself leaks 81920 bytes; sampling/reporting and allocator activity
occur between observations. The important distinction is disappearance of the
known array ownership without a corresponding immediate residency decline.

| Arm | Released engine heap size | Released engine heap capacity | Released extra-memory accounting |
| --- | ---: | ---: | ---: |
| Control | 1107250 | 1919490 | 494082 |
| Raw line arrays | 1125739 | 1953435 | 511643 |
| BufferLine objects | 1157644 | 1983484 | 541692 |
| Packed arrays | 1113328 | 1941344 | 499552 |

Dirty-category deltas from each arm's own baseline:

| Category | Raw lines | BufferLine | Packed |
| --- | ---: | ---: | ---: |
| JS VM Gigacage | +50380800 | +50380800 | +38436864 |
| WebKit malloc | +4227072 | +24018944 | +2375680 |
| JS JIT generated code | +65536 | +360448 | +98304 |
| Stack | +98304 | +311296 | +163840 |
| Page table | +49344 | +49344 | +16448 |

The actual BufferLine arm has 20299776 more residual native bytes than raw arrays,
including 19791872 more WebKit-malloc bytes. The packed arm has less residual than
raw small arrays but still retains 41091136 bytes above baseline. These are
single-run descriptive contrasts, not exact additive causal accounts or a new
threshold. Full counters, peaks, categories and process timestamps are retained.

## Supported and rejected hypotheses

**Supported within this diagnostic:**

- Many small, fully touched Uint32Arrays can produce a large immediate native
  residual after their known JS roots are released and their census returns to
  baseline. Additional terminal/parser execution is not required after the
  common warm-up.
- Allocation shape affects the observed residual. Raw small arrays and actual
  BufferLine objects share the same Gigacage delta; BufferLine adds substantial
  WebKit-malloc residency. That is consistent with its additional JS objects
  and metadata, without assigning every byte to a specific object.
- Few large equal-payload arrays also show residual residency. Packing changes
  magnitude; it does not demonstrate elimination of the problem.

**Rejected as necessary causes for this scoped effect:**

- React/application session stores, PTY IPC, DOM, WebGL and renderer disposal.
  None participates in these allocations.
- Still-live terminal Uint32Array instances at the measured released endpoint.
  The deliberate positive controls verify that the census sees ownership and
  release. This does not exclude other live engine objects or native retention.
- Full parser/JIT warm-up as a prerequisite for the raw-line arm's large residual.
  The common baseline does contain xterm class initialization, so this is not yet
  a standalone no-library reproduction.

**Not resolved:** the original full-app failure's byte attribution; whether
native pages are already free inside allocator pools versus another native
retainer; automatic reclaim timing; long-session boundedness; and behavior on
physical macOS 27. A subsecond standalone experiment with forced collection is
not equivalent to the original unforced application endpoint. No full soak was
repeated, no endpoint was moved, and no acceptance threshold changed.

## Source diagnosis and smallest justified next implementation

The previously captured upstream
[JSArrayBufferView allocation path](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/JSArrayBufferView.cpp)
routes these small arrays through primitive Gigacage auxiliary space, while
large arrays follow a separate path. The shared source snapshot of
[Heap.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/Heap.cpp)
shows synchronous `collectNow` completing sweeping and shrinking object space.
The shell's `gc()` invokes that path. Allocator page decommit remains separate
from the absence of JS cells; upstream allocator documentation also distinguishes
free memory from scavenger-driven decommit. These are primary-source explanations,
**not a source-version match or proof of installed allocator timing**.

No further production lifetime fix follows from this result. Adding forced GC,
reloading the webview, materializing `.buffer`, shrinking history, speculative
pooling or switching engines would exceed the demonstrated remedy. The existing
metadata/resize-disposal repairs remain scoped repairs, not full acceptance.

The smallest justified implementation step is an upstream-ready engine regression
reproducer that removes the remaining shared xterm warm-up. That source-only step
is now prepared as `minimal-jsc-repro.cjs`: it creates the same 40008 raw arrays,
writes the exact blank-cell words, and supports control/held/released snapshots
using existing shell counters. It imports no xterm code, requests no special
engine options, and never reads `.buffer`. **It has not run in JSC or produced
native measurements.** Node verification confirms only its array shape, exact
cell values against actual xterm, root release and repeat guard. The initial Node
check encountered the repository's `.js` ESM semantics; the standalone source uses
`.cjs` for explicit CommonJS test loading. That preparation failure is unrelated
to the successful native run.

This is suitable for an engine report draft with the captured raw-array evidence
and the explicit remaining validation gap. No upstream report has been sent. A
future native execution of that smaller reproducer would need fresh coordination;
there is no queued run or current reservation request. In parallel, no safe
frontend-only change has been demonstrated that would force WebKit allocator
pages back to the OS while preserving app behavior. A WASM/native alternative
would require its own measured release policy; these results do not justify
migration on allocation count alone.

## Validation and artifacts

- Four real native processes exited 0; twelve PID-matched byte captures verified.
- Six allocation-shape analyzer tests pass, now including the real four-arm
  result, a retained-array negative control and malformed shape metadata.
- Six previous ownership/capacity analyzer tests still pass.
- The source-only minimal reproducer's exact cell/shape/release check passes.
- Full project checks were not rerun for diagnostic-only changes; independent
  final-head review and unchanged production acceptance remain outstanding.

`captured-results.tar.gz` contains the raw four-arm record, phase streams, stderr,
and twelve native JSON/log pairs. `run-evidence.tar.gz` and its manifest preserve
executed inputs, analysis, resource observations, start/release notifications and
actual completion. The standalone no-library reproducer is **prepared source**,
not part of that executed-input archive. Source head and runtime hashes must stay
attached when sharing these numbers.

Follow-up: the unchanged standalone reproducer was subsequently executed once in
headless host JSC with no xterm import. See [native host result](minimal-host/README.md)
for the two-process ownership controls, exact engine/input provenance and causal
limits. This does not replace the failed production acceptance.
