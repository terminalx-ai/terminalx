# Native WKWebView parser control, 24 October 2026

**Diagnostic completed; production acceptance remains failed.** The existing
230657024 → 388566592 byte result (+68.4607671%) is unchanged. This is a small
common-parser experiment, not the faithful 4-session/50-terminal/200-switch/
20-agent acceptance workload, and not physical macOS 27 validation.

## Scheduling, provenance and actual exits

The conditional 14:12 and 14:16 UTC starts were deferred while #439's real Cargo
work continued. No job was killed. #467 confirmed its earlier actual exit; #439
reported its suite's exit by 14:18:47. The coordinator aligned the final
14:20–14:25 hold with the other owners/reviewer. Own host checks found no
Cargo/rustc jobs, 82.78–89.46% CPU idle and zero swap activity during the sampled
second. Guest process observations showed no process above 15% CPU before the
run or at its sampled endpoints. Host background UI activity and recent-load
history remain in the logs; these are not physical-host latency measurements.

The assigned guest was `local:tx-queue-232`, macOS 26.5.2 (25F84), arm64,
2 vCPU / 6 GiB. No TerminalX GUI, real sessions, credentials, other guest or host
GUI was operated. Each probe used a fresh nonpersistent offscreen WKWebView.
Both native phase delays were fixed at five seconds; no collection was forced.

- Source checkpoint: `d1d1ffcc`; runtime repair remains `a0880b80`.
- Probe SHA256: `955054db9c03609060e936b9efd9cf30f203af018cb526a8a93eee3c1ba96ca5`.
- Common xterm bundle SHA256: `01a701e40cc0fc68796b19f6987ce1f0bc25b6fe6124de298787ebc5366d679c`.
- Workload SHA256: `9723102d470368ddc8280cc264cf5bb1b9ea1f6fd6ace7928bd5eef8607476ba`.
- Driver SHA256: `f0b4ffbaa8bb5df921322982ae491d25b9c9bcf9a8b16dad69604262b3e07efa`.

| Mode | Probe / WebContent PID | Start UTC | Baseline UTC | Endpoint UTC | Probe exit UTC |
| --- | --- | --- | --- | --- | --- |
| Control | 85514 / 85516 | 14:20:45.479236 | 14:20:51.829 | 14:20:57.007 | 14:20:57.114306 |
| Parser | 85525 / 85527 | 14:20:57.132520 | 14:21:03.414 | 14:21:08.813 | 14:21:08.920369 |

Both modes completed their assertions and samples; the driver then terminated
only its own completed probe (child status -15). The driver exited **0**. The
post-run process check found no probe remaining. The reservation was released
early, both owners notified at 14:21:29.578/586 UTC, and the guest explicitly offered for the
coordinator's #466 handoff. Only evidence retrieval and host analysis followed;
no new guest workload was started.

The first failed reservation and the unsupported-return functional failure are
preserved in the previous startup evidence. They are not discarded or counted as
successful measurements.

## Raw-byte result

These are each process's `footprint` field from byte-unit JSON, with unchanged
PID across baseline/endpoint. Auxiliary `phys_footprint` values are also preserved
rather than mixed into these differences.

| Mode | Baseline bytes | Endpoint bytes | Difference |
| --- | ---: | ---: | ---: |
| Empty control | 13142144 | 13158528 | +16384 |
| Eight-terminal parser | 13076672 | 84248896 | +71172224 |

Parser change minus control change is **71155840 bytes**, a descriptive contrast
between two fresh processes, not an exact causal accounting or acceptance result.
The parser's peak auxiliary physical footprint was 105138496 bytes.

| Parser category | Dirty-byte difference |
| --- | ---: |
| JS VM Gigacage | +48037888 |
| WebKit malloc | +21495808 |
| JS JIT generated code | +1441792 |
| Stack | +163840 |
| Page table | +32896 |

These category differences sum to the parser footprint difference; swapped-byte
differences were zero. The empty control had WebKit malloc +32768 and stack
-16384. Full clean/reclaimable/region fields and warnings remain in the raw JSON.

## What this discriminates

The parser mode executed the same eight-terminal, 5,000-ANSI-line-per-terminal
workload used for the earlier scoped JSC snapshot comparison, verifying output
before disposal. It has no TerminalX session state, renderer, WebGL, PTY transport
or application UI. Substantial unforced growth therefore does not require those
layers in this minimal case.

**21 of 24 terminal/buffer weak references remained alive at the endpoint**, as
in the functional check. Disposal does not imply immediate collection. This
count does not identify strong roots, individual surviving types or whether a
future collection would reclaim them. Consequently the growth cannot be called
solely native caches, fragmentation, or a persistent xterm leak. It also cannot
explain the production endpoint where all tracked buffers had already collected.

This materially limits the previous standalone JSC result: its forced-GC
snapshots found mostly CodeBlock/Unicode growth, while this unforced WKWebView
run has a much larger Gigacage contribution. Neither result replaces the other;
the endpoints and accounting methods differ.

## Continued bounded source analysis

An offline V8 execution of the exact common bundle checked its logical storage
without reading typed-array `.buffer`: each terminal had 5,001 normal lines with
4800960 bytes of line-array views, an empty alternate buffer, and a 524288-byte
parser array. Across all eight creations those spans total **42601984 bytes**.
Installed `BufferLine.ts` uses three Uint32 elements per column;
`InputHandler.ts` caps its parse buffer at 131072 elements. These are bounded,
required terminal data structures. The arithmetic is not a native allocation
measurement or an exact surviving-byte total; do not subtract it from footprint
to label the remainder overhead. No buffer reduction or speculative repair is
supported by this evidence.

Upstream [MarkedBlock.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/MarkedBlock.h)
defines allocator blocks at least 16 KiB, but size alone cannot identify the
owners of the production profile's 16 KiB allocations. Upstream
[Heap.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/Heap.cpp)
contains natural-collection logging and separate heap-capacity/sweep reporting.
[OptionsList.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/OptionsList.h)
marks `logGC`, `dumpOptions` and `useOSLog` as normal diagnostic options, unlike
the restricted `useDollarVM` hook. These are upstream references with saved hashes,
**not a source match or proof of support in the installed guest binary**.

The next bounded capability check, once the #466 guest handoff is resolved, is to
verify process-private `JSC_logGC=2` and `JSC_dumpOptions=1` in a disposable probe,
including the actual WebContent PID's effective settings/logs. If needed, inspect
that guest's supported logging tools before selecting an output route. Do not
mistake UI-process logs for WebContent logs. Refuse unsupported/restricted options;
no system settings, entitlements, engine replacement, forced collection, longer
acceptance waits or new permissions are part of this proposal. If natural GC
logging is available, correlate actual collection events with the same weak
liveness reports before interpreting another allocation delta. This capability
check has **not** run; no guest work is authorized by this document itself.

## Validation and evidence

Both native modes completed and retained the same WebContent PID per pair. The
offline analyzer verifies integer byte units, one matching PID and complete mode
records. Its identical-real-capture control produced zero deltas and its wrong-PID
control was rejected. The logical-span check passed eight actual common-core
instances. No production sources changed; the four required runtime checks remain
those passed for `a0880b80`, and were not rerun for this evidence-only checkpoint.
Independent final review and full native acceptance remain outstanding.

`wk-parser-control-result-evidence.tar.gz` contains raw guest results, both
phase/resource/footprint records, reservation and release messages, analyzer,
logical-span probe and results, and source references. Its manifest records sizes
and SHA256 hashes. The original failed production/physical measurements and all
prior evidence remain unchanged. No desktop or native-measurement reservation is
held, and the guest is handed off pending the coordinator's assignment.
