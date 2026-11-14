# Offline native owner tracing, 2026-10-24

Issue #232 remains unresolved. Runtime source is still `550d4522`; this extends
clean evidence checkpoint `102983e9`. The unprofiled guest control remains
**230657024 → 388566592 bytes (+68.4607671%, FAIL)**. The original physical
failure and all prior artifacts are unchanged. No application was launched,
collection forced, workload repeated, or GUI operated in this investigation.

## Read-only allocation census

The repaired application's existing **pre-snapshot** heap reports (PID 68761)
contain 169050748 baseline and 384412292 cleanup bytes of enumerated WebKit
malloc allocations. Of the 215361544-byte increase, **213244664 bytes (99.0%)**
are labelled `non-object`. This label includes JSC allocator blocks; it does
not mean unreachable memory or free capacity. The 16 KiB non-object size class
alone grows from 5284 / 86573056 bytes to 11998 / 196575232 bytes, a
**110002176-byte** increase. These are allocation sizes, not resident bytes.
They must not be substituted for the paired post-collection footprint samples.

The largest named type increase is `WebCore::CSSFontAccessor` (+872784 bytes),
followed by `JSC::StringSourceProvider` (+351360). Baseline, DFG and FTL JITCode
objects increase by 161440, 154336 and 125632 bytes respectively. These are the
objects' own allocation sizes, not their generated executable code or retained
subgraphs. The complete type census and parser are archived; there is no
quantitative basis here to attribute the large residual to those named objects.

## One bounded discriminating experiment

The already captured PID 34011 baseline/cleanup memgraphs contain native
references, unlike the repaired run's text census. In the assigned guest
`local:tx-queue-232`, `heap --addresses` enumerated DFG JITCode objects in those
**older** graphs: 405 baseline, 980 cleanup, with 791 cleanup addresses absent
from baseline. Address reuse prevents treating this as an object identity test.
The first, middle and last addresses in numerical order were selected before
tracing; each `leaks --noContent --traceTree` invocation exited 0:

- `0x10a541ee0`: first predecessor is an unnamed 16384-byte block, offset 11912.
- `0x1624fb8e0`: first predecessor is an unnamed 16384-byte block, offset 2312.
- `0x166e2d1e0`: first predecessor is an unnamed 16384-byte block, offset 1416.

All three conservative traces report 49 roots and traverse allocator-sized
blocks, VM/global structures and other native references. They do not decode
JSC cells or distinguish strong, weak and incidental pointer matches. An
NSCache or WebProcess appearing along such a path does **not** establish that
it owns a JavaScript function. `heap --layouts=JSC::DFG::JITCode` returns an empty
layout (instance size 0, allocation size 16), despite the enumerated allocations
being 416 bytes. Thus type recognition is available but member layout is not.
The initial wildcard query matched nothing; the corrected regex and exact-type
queries, including that unsuccessful attempt, are preserved.

This experiment identifies the missing bridge precisely: an owning JSC
CodeBlock/cell and its source/function, plus live-cell occupancy inside the
unnamed blocks. The older memgraphs cannot establish the repaired build's
post-collection ownership, even if their conservative traces look similar.
No sampled path justifies a terminal source change.

## Available capability and next option

The guest is macOS 26.5.2 arm64 with Command Line Tools selected. `heap`,
`leaks`, `malloc_history`, `vmmap` and `sample` are installed. `/usr/bin/xctrace`
is present, but `xcrun --find xctrace` fails: Instruments is not installed.
Guest load was 1.22/1.70/2.35 during the first tooling audit; no timing or
footprint measurement was made, so no quiet measurement reservation was needed.

Installing Instruments alone should not be promised to supply JSC cell
ownership: existing malloc-stack logging already changed the allocator path,
and allocation origins did not reveal current cell occupancy. The concrete
next option is a **symbolized, instrumentable WebKit/JSC build compatible with
the assigned guest**, exposing MarkedBlock live-cell occupancy and owning
CodeBlock/function metadata at matched checkpoints. First verify that it can
resolve a known synthetic function and its code allocation; only then run a
small terminal parse/dispose workload alongside a page without TerminalX.
This is diagnostic engine work, not a proposed production engine replacement.
It requires a suitable WebKit build/toolchain and engine instrumentation;
those capabilities are not supplied by the currently installed graph tools.
Reserve a quiet coordinator window before collecting any new comparative
native measurements. Do not repeat the full soak to compensate for missing
ownership information, or use this diagnostic build for acceptance.

No source repair emerged from this bounded probe. The four code checks recorded
for runtime `550d4522` remain the latest code validation; they were not rerun for
this evidence-only addition. The archive's per-file sizes and SHA-256 hashes
were verified. All three native trace commands succeeded. Native acceptance
remains failed, and independent review remains outstanding. No desktop/native
reservation is held and no disposable app was started or left running.

`owner-trace-evidence.tar.gz` contains raw address queries, empty layout,
three complete traces, deterministic selection script, native tool capability
output, and the repaired-run type delta with its parser.
`owner-trace-manifest.json` records file hashes and the additional heap inputs;
the trace result records hashes of both original memgraphs. These synthetic
memgraphs remain in the previously documented external evidence location.
