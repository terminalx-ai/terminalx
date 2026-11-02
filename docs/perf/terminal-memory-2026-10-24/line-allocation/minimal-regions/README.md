# Native allocator ownership of the standalone array reproducer

One authorized headless host diagnostic from source **87de835300b18dc647accf6151418c5ace5f366c**,
2026-10-24 18:55:01–18:55:05 UTC. Both children exited 0 and were reaped normally:
control PID 21418 at 18:55:03.867321, raw arrays PID 21428 at 18:55:05.546525.
No GUI, guest, store, host-global setting, engine option or product code was touched.
No repeat/extra variant is queued. This is an upstream-report evidence packet,
not a submitted report or production acceptance result.

## What changed in the experiment

Existing guest region evidence included xterm warm-up and another engine version;
the prior pure host run had no region breakdown. The same verified host shell and
standalone source were used, adding only `readline()` after each phase report so
the driver can inspect the live owned PID. Two sequential processes, three phases
each: baseline/held/released, with the existing explicit diagnostic GC unchanged.
The driver adapts the previous verified phase-barrier harness; it validates roots,
array census and process identity, uses private HOME/TMPDIR with a minimal environment,
bounds the whole run to 100 seconds and each tool to 12 seconds, and reaps only its
own child in finally. Actual total duration was under four seconds. Each barrier
runs `footprint -p PID -f bytes -j FILE`, then `vmmap -summary PID` before acknowledgement.
All twelve tool invocations exited 0; footprint warnings/errors are empty.
Instrumentation and barriers perturb allocation/reclamation timing: these are not
comparable timings or a rerun of production acceptance.

Engine: arm64 macOS 27.0 build 26A428; JavaScriptCore framework 22625.1.29.11.27.
Shell `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`:
`1b4278b8b579ecdbfcd3c4fe3e297c7c4b28709e691387b5b0bdb6b813f192e6`.
Original input: `8bc9f9bf812e47d0239e243cf67c7451cb4be02e6aff7685fafe91b0f1bd0d05`.
Barrier input: `0f8174b0457043d841ef316cb499773276c03ab8a26dbe9f0ae3e6aa5494fc3a`.
Helper hash is not an engine shared-cache hash; OS/framework identify the installed
engine build. Exact driver, probe, raw observations and hashes are in capture.tar.gz
and manifest.json. Host originals: `/tmp/tx232-minimal-regions-20261024/`.
No quiet reservation; load averages 8.07/11.98/9.88. No latency claim.

## Exact external footprint bytes

| Arm | Baseline | Held | Released | Released minus baseline |
| --- | ---: | ---: | ---: | ---: |
| Empty control | 7,471,632 | 7,553,552 | 7,569,936 | 98,304 |
| 40,008 raw arrays | 7,291,432 | 67,011,208 | 66,749,064 | 59,457,632 |

Array census is 0 → 40,008 → 0; roots 0 → 8 → 0. Control is zero throughout.
Values above are external footprint samples, not the preceding shell self-samples.
Neither sample replaces the prior uninstrumented +58,081,400-byte standalone result.

Released-minus-baseline dirty region bytes, using footprint's exact labels:

| Category | Delta |
| --- | ---: |
| WebAssembly Memory | 50,429,952 |
| WebKit Malloc | 8,470,528 |
| JS JIT Generated Code | 196,608 |
| Stack | 147,456 |
| Untagged | 147,456 |
| page table | 65,632 |

These sum to the observed 59,457,632-byte footprint delta. The control's only dirty
category delta is WebKit Malloc +98,304. **The label “WebAssembly Memory” is not
proof that WebAssembly executed**: this script contains no WASM import or workload.
vmmap instead labels the large released mapping `JS VM Reservations (empty)`,
256 MiB virtual / 48.1 MiB resident and dirty. These are two tools' region naming
schemes, not interchangeable exact semantic ownership or proof of an allocator bin.

## Allocator-level evidence

vmmap's WebKit Malloc zone table (rounded tool units preserved):

| Raw phase | Dirty | Allocations | Allocated bytes | Reported fragmentation |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 3696K | 3900 | 1186K | 2510K (68%) |
| Held | 59.9M | 10781 | 51.9M | 8181K (14%) |
| Released | 60.0M | 4391 | 1323K | 58.7M (98%) |

This is **native-tool allocator accounting**, not physical footprint minus JS
heapSize. The zone spans multiple region categories; do not add its totals to the
category table. The allocation count is allocator bookkeeping, not one allocation
per typed-array wrapper. The control zone ends at 3984K dirty, 1188K allocated,
2796K reported fragmentation (71%).

This identifies WebKit Malloc allocator capacity, predominantly the dirty JS VM
reservation region, as the owner of most retained physical bytes in this isolated
case. Allocated bytes return near baseline while dirty zone pages remain, agreeing
with the independently verified disappearance of typed-array cells. JIT contributes
only 196,608 delta bytes here; it cannot account for most of this scoped residual.

The evidence does not identify which libpas size class/scavenger policy holds the
pages, whether fragmentation is internal/external or deferred decommit, how long
retention lasts, whether another allocation reuses it, or whether pressure reclaims
it. “98% fragmentation” is the tool's accounting label, not proof of a permanent
leak. No stacks/symbol-resolved allocator ownership were collected. Upstream source
allocation routes are explanatory context, not a matched source build for Apple's
installed binary. These limits do not erase the narrower native zone attribution.

## Product conclusion / next use

No safe TerminalX-only remedy follows. Forcing GC/decommit, shrinking scrollback,
changing engines, materializing .buffer, or speculative array pooling is not
justified by this one-case allocator result. Preserve the demonstrated lifecycle
repairs separately. This packet is now sufficient for local review of an upstream
allocator-reclamation report, with the minimal reproducer and exact tool accounting.
A further engine-internal investigation would need symbols or allocator diagnostics
mapping those retained pages to size classes/decommit policy; no further run is
necessary simply to establish native zone ownership.

The original physical +22.29% cleanup and faithful guest +68.46% production failures
remain unresolved. No forced-GC diagnostic is production acceptance, and this does
not quantify the engine's share of those production measurements.

## Validation

Four offline tests pass: actual six-sample capture, PID mismatch rejection,
retained-array rejection, failed-tool rejection. The analyzer verifies phases,
root/census controls, raw-byte units, warnings/errors and successful process/tool
exits. Full app checks were not rerun for this evidence-only checkpoint; final-head
checks and independent review remain required before an eventual completed issue.
