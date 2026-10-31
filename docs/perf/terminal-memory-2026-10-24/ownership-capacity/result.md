# Collected ownership versus native residency — 24 October 2026

**The deliberate ownership control passed. Substantial native residency persists
after the terminal typed arrays are collected in this standalone process.** This
is a narrower result than attributing the production +68.4607671% failure. That
failure and all physical-host measurements remain unchanged. No production repair
or acceptance pass is claimed.

## Exact run and resource release

After two missed fixed windows, the coordinator authorized an adaptive start
following #467's actual exit and a fresh quiet check, latest start 16:42 UTC,
hard expiry 16:45. #467 confirmed actual combined-runner exit at 16:37:32 and no
further heavy queue. No existing process was interrupted.

Fresh host samples showed 81.87–81.89% idle, load 2.77/3.68/3.64, and zero sampled
swap-ins/outs. Normal host WindowServer (43.7% of one CPU) and WebContent (22.1%)
activity remained; no Cargo/rustc/model workload was present. Guest load was
0.91/1.08/1.17 with no busy process identified. Raw observations remain archived;
this is not a physical-host timing/latency benchmark.

Only assigned `local:terminalx-cua-macos` was used: macOS 26.5.2 (25F84), arm64,
4 CPUs/8 GiB, installed JSC hash
`ac4ab8952b32a3d2110cde476f096e7884d0ad4c879b0e7bd0b9919be8c8728e`.
#466's guest and the host GUI were not accessed. #439 artifacts were preserved.
Fixture source is `80ca3545`; repository checkpoint at launch was `2b92b589`
(documentation-only subsequent changes). All four transferred input hashes matched.

| Arm | PID | Start UTC | Actual exit UTC | Exit |
| --- | ---: | --- | --- | ---: |
| Library control | 1553 | 16:38:33.646415 | 16:38:33.793306 | 0 |
| Disposed terminals | 1558 | 16:38:33.793644 | 16:38:34.066699 | 0 |
| Intentionally retained terminals | 1562 | 16:38:34.066935 | 16:38:34.320359 | 0 |

Driver exited **0** at 16:38:34.320476. All three phase sequences completed,
exactly 16 terminals were constructed, and all nine external footprint samples
contain byte units, matching PIDs and no warnings/errors. No owned JSC process
remained. The direct release to #467 was recorded at **16:38:51 UTC**, before
retrieval and analysis. No further diagnostic or extension ran. No reservation
is held.

## Paired observations (integer bytes)

Every checkpoint below is explicitly collected. The unforced intermediate
counters are retained in raw JSON and are not substituted for these checkpoints.
The retained arm keeps disposed terminals rooted until the final checkpoint.

| Arm / checkpoint | Deliberate roots | Uint32Array count | Engine heap size | Engine heap capacity | External native footprint |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control baseline | 0 | 0 | 613983 | 1275503 | 9995904 |
| Control after collection | 0 | 0 | 625541 | 1282805 | 10094208 |
| Control after release/collection | 0 | 0 | 626292 | 1283108 | 9635456 |
| Disposed baseline | 0 | 0 | 614255 | 1275887 | 9930368 |
| Disposed after collection | 0 | 0 | 1699921 | 2560129 | 77285184 |
| Disposed after release/collection | 0 | 0 | 1699637 | 2560645 | 76859200 |
| Retained baseline | 0 | 0 | 613871 | 1275503 | 10028672 |
| Retained after collection | 8 | 40024 | 66336295 | 74009175 | 108365696 |
| Retained after release/collection | 0 | 0 | 1688240 | 2600880 | 107792256 |

The positive control detects **40024** live Uint32Array objects with eight roots,
then zero after clearing those roots. On that transition:

- Engine heap size falls **64648055** bytes.
- Engine heap capacity falls **71408295** bytes.
- Engine extra-memory accounting falls **4198439** bytes (5193687 → 995248).
- Object count falls **243757** (252315 → 8558).
- Native footprint falls only **573440** bytes.

The array census is therefore sensitive to known ownership and release; a zero
count is not merely an unsupported counter returning zero. The terminal/parser
Uint32Array instances no longer explain the remaining residency in this arm.
This is not proof that every other live allocation is gone.

The disposed arm is **67354816 bytes above its own baseline** after collection,
with zero Uint32Array instances. Its dirty-category differences are:

| Native category | Difference from disposed baseline |
| --- | ---: |
| WebKit malloc | +36798464 |
| JS VM Gigacage | +28377088 |
| JS JIT generated code | +1835008 |
| Stack | +294912 |
| Page table | +49344 |

These sum to its native difference. The library control changes by +98304 bytes
at the corresponding point; do not subtract it as an exact causal adjustment.
For the retained arm, Gigacage dirty bytes stay **54886400 above baseline** even
after release/collection; WebKit malloc changes from +41238528 to +40697856.
Full categories, auxiliary process footprint and peaks remain in the raw files.
Shell `MemoryFootprint.current` and external footprint were sampled at different
instants and are not mixed.

## What the source now explains

Installed xterm stores a normal 80-column line in a 240-element Uint32Array
(three cells per column), while its exercised parser array has 131072 elements.
Upstream [JSArrayBufferView.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/JSArrayBufferView.cpp)
and [JSArrayBufferView.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/JSArrayBufferView.h)
route arrays at or below a 1000-element limit through GC-managed primitive
Gigacage auxiliary space. Larger arrays use a separate allocation path with
extra-memory accounting and a finalizer. This provides a concrete candidate
allocation path for the line/parser storage, rather than identifying owners by
16-KiB block size alone. Source hashes and the unsuccessful obsolete Gigacage
header-path lookup are preserved; upstream main is not the installed build's
source revision.

This explains why extra-memory accounting alone cannot represent all line data.
It does **not** identify all residual native blocks, establish decommit timing,
or prove an allocator defect. Nor does a heap-capacity drop mean those physical
pages must immediately be returned. The matched census plus physical categories
is stronger evidence than the earlier unforced WKWebView liveness observation,
but remains a standalone-shell experiment with explicit GC.

## Implication for a fix and the next useful step

The large residual can occur without TerminalX application roots, PTY transport,
React, DOM, WebGL or rendering. Replacing transport/renderer again is not supported
as a remedy for this scoped effect. The existing metadata and resize-disposal
repairs remain valid but are not promoted to the whole memory cause.

There is no demonstrated additional application lifetime fix in this capture.
The reproducible actual-xterm driver is now suitable as an **upstream engine
residency reproducer**, with a positive ownership control and native accounting.
No upstream issue/message has been sent. The next source-focused discriminant is
whether the matched line-array allocation shape alone reproduces this category
residual, versus xterm parser/JIT work being necessary. A minimal typed-array
control would isolate that engine path; it must be separately specified and
scheduled, not silently added to this run. A subsequent event-loop/scavenger
study would also be diagnostic only and could not extend acceptance waits.

Do not ship forced collection, materialize `.buffer`, shrink scrollback, pool
buffers speculatively or switch engines on this evidence. A WASM/native terminal
alternative would still need measured allocator/release behavior; merely moving
the allocations does not establish lower steady-state memory.

## Validation and artifacts

Six offline regressions against the **actual captured result** pass: positive
ownership/release, failed-process rejection, missing-arm rejection, wrong root
count, wrong-PID/non-byte rejection, and failure to detect the positive control.
The previous fourteen GC-log analyzer regressions also pass. The actual-xterm
source/control checks passed during preparation. Full project checks were not
rerun for this diagnostic evidence; final-head project checks, independent review
and native acceptance remain outstanding.

`captured-results.tar.gz` contains all three raw phase streams, stderr, run record,
nine byte-unit native JSON captures and nine footprint command logs. The companion
`run-evidence.tar.gz` and manifest retain executed inputs/hashes, offline analysis,
source-reference hashes, resource/coordination observations and actual start/end/
release records. Original failing production evidence is preserved unchanged.
