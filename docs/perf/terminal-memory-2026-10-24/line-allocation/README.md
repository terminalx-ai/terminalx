# Line allocation-shape discriminant — source preparation only

**No guest measurement has run.** `local:terminalx-cua-macos` was released to
#467 for packaged lifecycle acceptance. #232 has no guest process or queued
workload; all prior `/tmp/tx232-*` artifacts remain preserved. Only host source
and offline checks followed the handoff. A new guest assignment and resource
window are required before executing this preparation.

Production acceptance remains **failed at +68.4607671%**, with the physical-host
failures also unchanged. The preceding [collected ownership result](../ownership-capacity/result.md)
established native residency after terminal Uint32Array collection in a scoped
JSC process, not the cause of the whole application failure.

## Question and controls

Can the line-array allocation shape produce post-collection native residency
without xterm parsing/JIT activity? Is the residual different when payload bytes
are held in many small GC auxiliary allocations versus a few large allocations?

All four fresh processes load the same unchanged xterm bundle and this workload.
Each performs one identical warm-up CoreTerminal construction, obtains its actual
BufferLine constructor through a blank line, reads the three initial cell words,
and disposes the terminal before baseline collection. The diagnostic never reads
a typed array's `.buffer`. No export, parser implementation or dependency is
patched. This warm-up is intentionally common, so these new baselines must not
be equated with the previous experiment's baselines.

| Arm | Payload representation | Deliberately retained arrays | Payload bytes |
| --- | --- | ---: | ---: |
| `control` | No payload after shared warm-up | 0 | 0 |
| `raw-lines` | Eight groups of 5001 Uint32Arrays, 240 elements each | 40008 | 38407680 |
| `buffer-lines` | Eight groups of 5001 actual xterm BufferLine(80) objects | 40008 | 38407680 |
| `packed-lines` | Eight Uint32Arrays, 1200240 elements each | 8 | 38407680 |

Raw and packed arrays contain the same repeated three-word cell data as an
actual newly constructed BufferLine. Every element is written, so the large
array arm is not merely uncommitted virtual zero-fill. The offline audit checks
every element and total view span. The native path does not traverse the arrays
again for that audit; it records predetermined shape metadata and real engine
census. No 131072-element parser buffers are allocated by these payloads, because
the question concerns the line-storage path specifically.

The packed arm changes allocation granularity, not total payload. It deliberately
has fewer array wrappers and index slots; it is not a byte-perfect native
allocation match. The BufferLine arm adds actual per-line objects and metadata.
This is a diagnostic contrast, **not a terminal implementation, proposed pooling
patch, or justification to shrink buffers**. Reflow, resize, queue-drain and
restoration behavior are not exercised and cannot be claimed preserved by a
hypothetical packed implementation.

## Prepared execution and resource request

A future run would need **one four-minute coordinated window**, four sequential
JSC processes and twelve native footprint samples. It performs four common
warm-up terminal constructions, 40008 raw small arrays, 40008 BufferLine payload
arrays and eight large payload arrays. Only one arm/process is active at a time;
the logical payload per nonempty arm is 38.4 MB, not a guaranteed resident peak.
No build, model inference, host GUI or real app/session operation is required.

`run_shapes.py` invokes the existing ownership-capacity driver with explicit
mode/root configuration and a 230-second work deadline, leaving bounded cleanup
inside four minutes. Default behavior of the original three-arm driver is
unchanged; the immutable executed-input archive preserves the original run source.
The shared driver now records its own hash and selected configuration and rejects
boolean root counts. The wrapper does not execute on import. Preserve the sibling
`ownership-capacity` directory when staging, and supply the correct verified
hostname, `--scheduled-diagnostic`, new fixture directory and new output directory.
No artifact has been transferred since the guest handoff.

Each arm uses the same sequence:

1. Shared warm-up returns; explicit collection; engine census and matched native
   byte footprint from that same PID.
2. Construct payload and return; record unforced counters without a native sample.
3. Explicit collection with roots still held; record counters and native footprint.
4. Clear roots, explicitly collect; record counters and native footprint; exit.

No forced collection is an acceptance operation. No extra cycles, arbitrary waits,
full heap snapshots, logging-option changes or automatic retries are included.
The existing core/JSC hashes are required; an engine change stops the driver.
Capture host/guest resource observations and actual exits when newly scheduled.

## Interpretation gates

`analyze_shapes.py` refuses missing arms, failed processes, unexpected phases,
invalid counters, wrong PIDs and non-byte native records. Each nonempty arm must
show exactly its expected *additional* Uint32Array count at the held checkpoint,
and return to its own baseline after release. The empty arm must stay at its
baseline census. An invisible positive control or residual rooted arrays makes
allocation-path interpretation invalid; raw output remains retained as a failure
of the control, not discarded or retried until it looks right.

Provided every gate passes:

- If raw small arrays show a substantial native residual similar in category to
  actual BufferLine, parser execution is not required for that scoped effect.
  This supports an engine allocation-shape reproducer without attributing the
  entire production footprint.
- If the actual BufferLine arm has additional WebKit-malloc residency that the
  raw arm lacks, line objects/metadata or their construction code remain relevant.
  The difference is not an exact additive accounting of those objects.
- If small arrays retain Gigacage residency that the equal-payload packed arm
  does not, allocation granularity/path is implicated. This is evidence for an
  upstream allocator investigation; it is not sufficient to ship buffer pooling
  or predict a WASM engine's memory behavior.
- If none of the three allocation arms reproduces the residual, line storage
  alone is insufficient under this workload. Parser/terminal churn or a different
  allocation/lifetime pattern remains a candidate; do not call the previous
  measurement invalid or repeat a full soak to compensate.
- If all layouts retain similar residency, the count/size split alone does not
  discriminate the cause. Investigate reclamation semantics with explicit scope,
  rather than declaring a persistent leak or changing the acceptance wait.

Report own-baseline native/category deltas alongside complete engine counters.
Do not subtract JS heap bytes from physical footprint as “allocator overhead,”
introduce a new pass threshold, or compare this guest to the physical baseline.

## Offline validation completed

`check-workload.cjs` ran the hash-verified actual common xterm bundle for all four
arms. It checked actual blank-cell values for every element, equal payload spans,
expected roots/array counts, release and repeat-invocation rejection. This is
Node source validation, not JSC collection or native residency evidence.

Five new Python tests use the previous real captured control: ownership/release
gating, mismatched shape and unreleased controls, refusal to reinterpret the
old three-arm result as this experiment, strict root count types, and the real
CLI wrong-host guard. Six existing captured-result analyzer tests also pass.
Probe syntax and wrapper CLI help pass. The full new native analyzer has no
positive four-arm capture yet; that remains an explicit validation gap.

Run offline checks from repository root (the existing core bundle path is an
explicit local prerequisite, not a new dependency download):

```sh
node docs/perf/terminal-memory-2026-10-24/line-allocation/check-workload.cjs /tmp/tx232-wk-parser-control-v2/core.js
python3 -m unittest discover -s docs/perf/terminal-memory-2026-10-24/line-allocation -p 'test_*.py' -v
python3 -m unittest discover -s docs/perf/terminal-memory-2026-10-24/ownership-capacity -p 'test_*.py' -v
```

No production sources changed, and full project checks were not rerun for this
preparation. Final-head review/checks and the original acceptance criteria remain
required. No reservation or guest ownership is held by #232.

## Completed run and next source-only reduction

[The four-arm result](result.md) completed under the explicit #467 handoff at
18:00:32–18:00:33 UTC. All ownership gates passed; raw line arrays alone retained
54821056 native bytes above baseline after collection. This does not meet or
replace production acceptance. All workers and guest holds were released.

`minimal-jsc-repro.cjs` removes the remaining xterm warm-up for a possible upstream
engine reproducer. It is **not native-validated** and is not scheduled. Its
source/control check is:

```sh
node docs/perf/terminal-memory-2026-10-24/line-allocation/check-minimal.cjs /tmp/tx232-wk-parser-control-v2/core.js
```

No new guest measurement is authorized by this document.
