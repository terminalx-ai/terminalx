# Bounded parser ownership comparison — 2026-10-24

The two prepared diagnostic processes completed successfully. This experiment
attributes most **GC-graph reported growth in a parser-only process** to compiled
function metadata/code and identifies one persistent xterm cache. It does not
attribute the whole application's WebKit-malloc residual or pass acceptance.
The unprofiled guest **+68.4607671% FAIL** and original physical failure remain
unchanged. No full soak, renderer change, buffer reduction or production
configuration change was made.

## Reservation, environment and provenance

The initial fixed window was not used: #467's existing native suite overlapped
its start. The revised fixed window was also unused after the host contention
check found VM PID 67333 at 183–184% CPU. The coordinator subsequently identified
that as another guest's WindowServer activity and quiesced that guest. #232 did
not inspect or operate the other guest, stop another worker, or bypass consent.

Under the coordinator's adaptive reservation, #439 explicitly confirmed
source-only work and #467 confirmed its native suite and queued follow-up runner
had exited. The new check found no native builds, no former busy VM, host load
1.40/2.87/3.84 and **85.42–85.53% CPU idle** across two samples. Normal desktop
activity remained and is recorded; this is not a latency/timing benchmark.
The assigned guest's load was 1.24/1.09/1.09 before and after the run.

Actual announced reservation: **12:59:20 UTC**, hard end 13:09:20 UTC.
Both owners received the start announcement. Execution:

| Process | Start UTC | End UTC | Exit |
| --- | --- | --- | ---: |
| Library-only control | 12:59:38.242796 | 12:59:38.829197 | 0 |
| Parser create/dispose | 12:59:38.829655 | 12:59:39.568982 | 0 |

Both completion markers were verified, and a process-name check found no JSC
process remaining. The reservation was released directly to both owners and
the coordinator immediately afterward, before graph analysis. No reservation
is held and no diagnostic process remains running.

- Assigned guest only: `local:tx-queue-232`, macOS 26.5.2 (25F84), arm64,
  2 vCPU/6 GiB. This is not the original macOS 27 physical host.
- Runtime repository source remains `550d4522`; preceding evidence head
  `fd1b2b61`. No runtime source changed for this experiment.
- Installed JSC SHA-256:
  `ac4ab8952b32a3d2110cde476f096e7884d0ad4c879b0e7bd0b9919be8c8728e`.
- Common xterm 6.0.0 bundle SHA-256:
  `01a701e40cc0fc68796b19f6987ce1f0bc25b6fe6124de298787ebc5366d679c`.
- Workload SHA-256:
  `ae8de18fc319c36b90922a406c7015b59111cb9328cf4f249118955b1020d23e`.
- The bundle is the unmodified installed common TypeScript implementation
  transformed to an unminified IIFE with esbuild, as documented in
  [the capability probe](jsc-capability.md). It excludes the browser renderer,
  React, Tauri transport and application stores. Each subprocess had a separate
  disposable HOME and a 30-second timeout.

## Workload and interpretation

Both fresh processes load the same bundle and diagnostic script. The control
captures two snapshots without constructing terminals. The parser process
creates eight terminals sequentially, each at **80×24, scrollback 10000**, parses
5000 synthetic ANSI lines synchronously, checks output, and disposes it. The
workload rejects unexpected asynchronous parsing. Its function returns before
the endpoint snapshot; no terminal reference is intentionally held by the
harness. The prepared workload was not expanded after reservation approval.

Each `$vm.dumpHeapSnapshot()` performs full GC. These are diagnostic collected
heaps, **never acceptance endpoints**. Node-reported size can include external
memory and is not physical residency, allocator capacity, or a byte-exact
breakdown of the native WebKit-malloc category. JIT tiering and collection also
mean the two baseline graphs need not have identical sizes.

| Mode | Baseline nodes | Endpoint nodes | Baseline reported bytes | Endpoint reported bytes | Difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control | 6455 | 6453 | 558081 | 557937 | -144 |
| Parser | 6453 | 8475 | 561720 | 1581280 | +1019560 |

## Concrete ownership findings

In the parser process, linked `FunctionCodeBlock` reported size increases by
**713936 bytes** (47 → 326 nodes), and `UnlinkedFunctionCodeBlock` by **106731
bytes** (46 → 248 nodes). Together they account for **820667 bytes / 80.4923%**
of the reported increase. This is attribution of the graph's size increase,
not of the earlier native footprint increase. Twenty largest linked blocks
and their available direct Function → FunctionExecutable → FunctionCodeBlock
paths are saved in `attribution.json`. Examples with verified direct owners:

| Function label | CodeBlock address | Endpoint reported bytes |
| --- | --- | ---: |
| `parse` | `0x1119aabe0` | 52536 |
| `print` | `0x1119ab120` | 39080 |
| `charAttributes` | `0x1119aaf60` | 27752 |
| `parse` | `0x111b8f040` | 15928 |
| `scroll` | `0x1119d50c0` | 13856 |

Labels alone do not distinguish every same-named method. Some optimized blocks
lack that direct two-edge owner chain; the report preserves empty paths rather
than inventing ownership. This shows code retained after first exercising the
parser, but one cycle does not establish a long-term bound or an engine leak.

The extra **65584-byte Uint8Array** has a graph edge of type `Variable`, named
**`table`**, from the bundle's lexical environment. Installed source
`@xterm/xterm/src/common/input/UnicodeV6.ts` declares module-level `table` and
initializes `new Uint8Array(65536)` on first construction. The graph edge and
source therefore identify a specific shared Unicode-width cache, not a deleted
tab's character buffer. Its source hash is recorded. Do not shrink or remove
this required table to improve a memory number.

There are **zero `Uint32Array` instances** in the parser endpoint graph (the
prototype remains). This supports collection of the character/parser typed
arrays exercised here. It does not establish that all terminal objects in the
browser app are collected: object naming differs, there is no renderer, and
this small test omits resizing and application ownership.

The remaining 133309 bytes of net reported growth includes structures,
executables, functions and other categories; the complete census is preserved.
No full native allocation attribution is inferred by subtracting these JS
numbers from the physical failure.

## Next source-level target

A separate **source-only, untested** hypothesis found while waiting concerns
xterm 6.0.0 `Buffer._memoryCleanupQueue`. Width shrinking can enqueue a callback
bound to that buffer; the queue is not registered in the disposable store, and
`BufferSet` does not clear these plain Buffer queues on inherited disposal.
A deterministic idle-scheduler regression can establish whether disposing a
resized terminal leaves that callback and its buffer reachable. This is a
bounded frontend lifetime test, requires no further guest reservation, and
must precede any repair. It was **not** added to the authorized comparison and
is not claimed to explain the physical failure. The successful no-resize parser
comparison does not test or reject it.

## Checks and retained artifacts

- Both guest processes exited 0 with complete baseline/endpoint graphs and
  expected completion markers.
- The graph parser checked snapshot version/type, node/edge strides and phase
  order. A fixture reusing the same captured graph twice produced zero class,
  count and size deltas for both modes.
- Attribution assertions verified the Unicode table variable edge; direct
  function ownership paths are retained as native-addressed graph records.
- Input hashes, timestamps, resource observations, raw stdout/stderr, scripts
  and analysis are in `jsc-comparison-evidence.tar.gz`; per-file size/SHA-256 is
  in `jsc-comparison-manifest.json`, verified against the archive.
- This evidence-only change does not alter runtime source. The four repository
  checks previously passed on `550d4522`; they were not rerun or relabelled as
  native acceptance here. Independent review and actual acceptance remain open.
