# Resize compaction outlives terminal disposal

This is a demonstrated xterm 6.0.0 lifetime defect, not an explanation of the
unresolved +68.46% native acceptance failure. That soak collected all tracked
buffers at its endpoint. A pending callback retaining those same buffers cannot
explain memory remaining after their collection.

## Falsifiable reproduction

`pnpm vitest run src/lib/terminalDisposal.real.test.ts` executes the installed
xterm distribution with 100 lines written through its public asynchronous write
API. At 240 columns, shrinking to 80 columns schedules buffer compaction:

| Control | Pending callbacks after dispose | Disposed line compacted when scheduler runs |
| --- | ---: | --- |
| No resize, unmodified xterm | 0 | No |
| Shrink, unmodified xterm | 1 | Yes |
| Shrink, cleanup addon | 0 | No |

The tests exercise both xterm's Node/fallback timer path and its browser
`requestIdleCallback` path. The latter loads the unmodified installed bundle in
an isolated JavaScript VM without Node's `process` global, with a controlled idle
scheduler. It does not substitute a parser, buffer or TaskQueue implementation.
This is deterministic lifecycle coverage, not a browser rendering or native
footprint measurement. The canvas warning comes from jsdom's absent canvas
implementation; no renderer is opened by these buffer tests.

The first alternate-screen test incorrectly expected two callbacks. Source
inspection and the actual result corrected that hypothesis: alternate buffers
have no scrollback/reflow compaction. With the alternate screen active, the
inactive normal buffer still schedules one callback. The regression asserts
that behavior and preserves the alternate screen's text.

## Ownership and repair

Installed `src/common/buffer/Buffer.ts` owns `_memoryCleanupQueue`, an
`IdleTaskQueue`, without registering it for disposal. After a sufficiently large
column shrink, it enqueues a closure calling `_batchedMemoryCleanup()`. The
scheduler roots its TaskQueue callback, which roots that closure and Buffer.
`BufferSet.reset()` can replace buffers while their old callbacks remain queued.
The public terminal/addon disposal chain does not cancel these buffer queues.

`TerminalBufferCleanup` attaches through public `loadAddon`, `onResize` and
addon `dispose`. There is no public xterm cancellation interface for this queue;
a confined, guarded compatibility bridge calls the existing queue's `clear()`.
That cancels the scheduler and releases queued closures without executing them.
No node_modules patch ships, no buffer sizes change, and no write, ack, stream,
transport or renderer behavior changes.

The addon records queue identities with WeakRefs on activation and resize so
reset generations are cancellable without introducing strong retention. Disposal
also captures the current generation. The shared terminal factory installs it
for local and cloud views. Tests verify reset generations, repeated disposal,
live compaction, preserved text, ordered queued-write acknowledgements and isolation from another terminal's callback.
An xterm upgrade must rerun the real-distribution controls; remove this bridge
when upstream owns cancellation.

The focused suite passes nine tests. Full required check results are recorded
separately. No new native acceptance result is claimed. Original physical and
guest failures, and the independent CodeBlock/Unicode attribution, remain intact.

## Guest WebKit functional confirmation

An offscreen, nonpersistent WKWebView in `local:tx-queue-232` ran the installed
xterm bundle and the production addon compiled with esbuild 0.28.2. No TerminalX
app or desktop window was driven. The guest's default WKWebView does **not**
expose `requestIdleCallback`; xterm selects its real timer fallback. A wrapper
counted scheduled/cancelled callbacks while forwarding to the native scheduler.
The control had one callback before and after disposal; with the addon, one
before became zero after, with exactly one cancellation. Both preserved text,
and the unprotected callback subsequently drained naturally. The probe exited 0.

The initial probe assumed idle callbacks and failed on that missing API. Its
first fallback edit had a JavaScript initialization-order error; the corrected
probe passed. Both rejected runs are retained alongside the successful result.
This neither measures how long application buffers survive under load nor
establishes WebContent footprint improvement. In particular, idle starvation is
not a supported explanation for this guest's earlier failure.

## Validation and preserved evidence

All four required checks pass: TypeScript; Vitest (287 files, 3,371 tests);
Clippy with warnings denied; and Rust (2,217 library, 6 provider-CLI and 2 naming
tests passed, 14 ignored). Rust used two build jobs, the xcrun macOS SDK and
private disposable TerminalX/Claude stores. The final frontend rerun includes
the additional write-acknowledgement regression; native sources were unchanged.

`resize-disposal-evidence.tar.gz` and `resize-disposal-manifest.json` preserve the
check logs, failed controls, successful guest result, probe/build sources and
source/binary hashes. They do not contain private app state. No native acceptance
or latency measurement was rerun, and no exclusive measurement reservation is
held by this work.
