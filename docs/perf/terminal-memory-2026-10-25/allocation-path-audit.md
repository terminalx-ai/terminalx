# Bounded terminal allocation-path audit

Starting head e3f898e8; source/test work only. No guest, GUI, quiet reservation or
native memory run. The original +68.46% production failure remains failed.

## Concrete avoidable churn and repair

`TerminalView.tsx` formerly created a new 1×1 canvas and requested a 2D context for
EACH token-to-sRGB conversion. `themeFor()` converts foreground and background;
terminal creation calls it, and the mounted view's theme effect calls it again.
Thus 200 palette evaluations alone create 400 short-lived canvas/context surfaces,
regardless of whether either color changed. Native allocator residency from these
particular surfaces has not been measured or attributed in the production profile.

The small repair moves conversion to `terminalColor.ts` and keeps ONE private 1×1
context per window. It still converts current CSS values on every call: no token
cache, skipped theme update, OSC behavior change, renderer change or buffer limit.
Before each use, clear pixels and restore default black fillStyle. Without clear,
alpha colors blend with preceding conversions; without the black reset, invalid
CSS colors retain a preceding fillStyle. Both differ from the old fresh canvas.
If context acquisition fails, return that caller's fallback and retry next call.
If the cached context reports loss through the public 2D API, replace it before use.
If readback/another operation throws, discard the context reference before retry.
The intentional bounded retained resource is one detached 1×1 surface, not zero
surfaces at idle. Existing diagnostic terminal-canvas inventory does not track it.

This is an allocation-count reduction with tested functional equivalence, NOT a
claim to explain the large native delta. It may have negligible endpoint benefit.
No pooling of xterm lines, private allocator control or forced product GC is added.

## Other examined paths and why they were not changed

- `api.ts` per-pane raw Channel wraps an ArrayBuffer with Uint8Array, without copying
  the payload. No base64 decoding/string round-trip exists in this local path.
- `terminalFeed.ts` write callbacks reference bytes for byte accounting, but actual
  xterm 6 WriteBuffer simultaneously retains each chunk in its own `_writeBuffer`.
  Changing only callback capture to a scalar does not release payload earlier in
  this implementation. xterm trims processed chunks after 50 offsets when more
  writes remain, and clears both arrays when drained. No new batching/copy layer
  or callback-order change is warranted from this evidence. Existing flow control,
  parsed-byte acknowledgements and hidden-view retirement remain untouched.
- Input writes are serialized with one in flight and combined pending strings;
  stop drops pending input. No parser/backpressure change is justified by the
  allocator results. Large explicit user paste is not the synthetic memory cause.
- `terminalWebgl.ts` reuses an existing held addon on show, bounds hidden contexts
  and explicitly loses disposed contexts. Focus/recovery intentionally rebuilds
  a stale GPU surface; removing this would remove an existing reliability feature.
- Actual addon atlas cache compares configuration and reuses a match; repeated
  equal themes do not prove a new atlas per update. Skipping theme updates could
  also alter OSC color restoration behavior, so that was not combined with this fix.
- Addon context-loss restoration timeout retains its renderer for up to 3s (already
  documented/tested). The failing production run reported no context losses and
  had a 5s cleanup endpoint. That path is not a supported explanation of its delta.
- Normal-buffer per-line Uint32Array allocation is necessary to the current VT
  model. Minimal no-xterm evidence attributes post-collection residency to WebKit
  allocator capacity (see prior minimal-regions report); it does not justify line
  pooling, packing, smaller buffers or an engine replacement in product code.
- Opt-in memory inventory uses weak targets and can perturb liveness when sampled;
  it is not active in the unprofiled acceptance control. No production-ownership
  conclusion follows by treating the probe's temporary enumeration as a leak.

All 70 churn terminals were collected in prior failing soak controls. The source
repair above reduces creation churn; it does not contradict that observation or
relabel retained native capacity as a passing endpoint.

## Functional checks and controls

`terminalColor.test.ts`: repeated palettes use one 1×1 context; acquisition failure
preserves each caller's fallback; failed readback releases the bad context and a
later conversion recovers; a cached context reporting loss is replaced without
reusing its pixels. TerminalView lifecycle tests remain intact.

`scripts/perf/check-terminal-color.mjs` uses the EXISTING Playwright WebKit in
headless mode (no GUI, browser download, user profile or app). It compares the
new converter with the previous fresh-canvas algorithm under real rasterization,
using red/hex, fractional alpha blue/yellow, invalid CSS, transparent and OKLCH.
200 repetitions × 8 inputs = 1600 conversions, one newly created conversion canvas,
zero mismatches. Expected fresh conversion colors include invalid/transparent black,
blue for translucent blue and #68b457 for the selected OKLCH input. This is a color
regression, not native WKWebView memory/visual acceptance. Browser version 26.6.
An initial script invocation failed because esbuild was not a direct dependency;
the runner uses the existing TypeScript compiler instead. No dependency was added.

Initial focused Vitest: 2 files/7 tests passed (3 color, 4 view). A fourth color
regression was then added for public context-loss recovery and the full frontend
checks rerun on that final code. jsdom's absent-canvas warnings
in pre-existing view tests are not successful rasterization evidence. Full project
validation is recorded separately after completion, with private disposable stores
and SDKROOT/jobs2 for native checks. Logs: `/tmp/tx232-color-checks-20261024/`.

## Discriminating future measurement protocol — prepared, NOT scheduled

Hypothesis H: ephemeral palette-conversion canvases contribute measurable allocator
churn during creation/remount; replacing them with one fixed surface reduces native
residency. Alternative: reduction is too small or not relevant to the faithful
workload, and normal-buffer/other allocator capacity dominates unchanged endpoints.

A future bounded reservation would allow at most 2 minutes per arm, two sequential
processes (baseline/candidate), no variants or retries. Actual required steady-state
wait and endpoint timing must be fixed identically before launch, not tuned to the
result. First a separate diagnostic comparison can isolate 200 themeFor evaluations using
identical token values and baseline/candidate builds on ONE verified native target.
Record source/binary/engine hashes, host load, actual conversion counts and temporary
canvas creations WITHOUT changing the raw-byte endpoint or forcing GC. Candidate
must create at most one conversion surface; baseline two per palette. If a native
size effect is sought, retain identical fixed observation times and region captures,
and label profiling/diagnostic runs separately. This tests the allocation mechanism,
not whole-app acceptance. A script-level count reduction alone is already established
by focused tests and does not need another native run merely to repeat that count.

Then, only if coordinated, run the original unprofiled faithful acceptance workload:
4 sessions/50 terminals/200 switches/20 fake agents, original baseline/cleanup timing,
all cleanup tracked, raw-byte WebContent endpoint growth <=10%, no forcedGC, extended
wait or adjusted baseline. Verify the chosen isolated target can actually present
WebGL; keep the affected guest's presentation discrepancy separate. Do not subtract
the remaining 1×1 converter or known allocator capacity from the measured endpoint.
Native timing and memory results must include engine/head/build and contention data.
If the endpoint still fails, report it unchanged; the micro-optimization remains
only its demonstrated bounded allocation improvement. No slot requested or new
native run authorized by this document.

## Completed validation for this repair

All four CONTRIBUTING checks passed: TypeScript, final full Vitest (288 files,
3,375 tests), all-target Clippy with warnings denied, and native cargo test
(2,217 library + 6 CLI + 2 serde tests passed; 14 ignored). Native checks used
SDKROOT from xcrun, jobs2 and private disposable stores. The final frontend
rerun includes the context-loss regression; native source was unchanged afterward.
The additional headless WebKit raster check passed all 1,600 conversions with
one canvas and no color mismatches. Raw local logs remain at the path above.
These are functional checks, not a new production memory acceptance result.
