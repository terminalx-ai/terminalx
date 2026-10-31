# Repaired-build guest diagnostics — 2026-10-24

Issue #232 remains open. The repair at `550d4522` releases the demonstrated
closed-tab metadata and rejects stale asynchronous adoption. These follow-up
experiments corroborate that repair and narrow the remaining allocation
question; they do not establish the original physical-host acceptance.

## Provenance and boundaries

- Source: `550d4522`, clean at build time, after merging main at `15f6cbc6`.
- Native binary SHA-256:
  `7425510b3c4c24e48ddd79f83d5caff71a92e6c9b1c14154a535645ee1d1dd97`.
- Build: `pnpm tauri build --debug --bundles app --no-sign --config src-tauri/tauri.dev.conf.json`,
  `CARGO_BUILD_JOBS=2`, SDK from `xcrun`, private configuration/store directories.
  The production frontend is embedded in the debug native bundle.
- Assigned guest: `local:tx-queue-232`, macOS **26.5.2 (25F84)**, arm64,
  2 vCPU, 6 GiB RAM. The original failure was macOS **27** on physical hardware.
- Named guest MCP operations only; no host desktop or other guest was operated.
  Each run used a fresh private home and fake Claude CLI, with verified app PID,
  executable path and control socket. No credentials or real provider history
  were transferred. App and Inspector WebContent PIDs were distinguished.
- Each full soak used **4 sessions, 50 shell terminals, 200 switches and 20 fake
  agent tabs**. Snapshot runs have explicit gates and are diagnostics. They
  cannot supply acceptance endpoints or be compared as timing benchmarks.
- All four repository code checks passed on the repaired source (see README).
  This follow-up adds evidence, not another runtime change. The isolated canvas
  probe compiled successfully and all four valid cases exited 0.

## Repaired application heap

App PID **60140**, application WebContent **60143**, Inspector WebContent
**60511**, private home `/tmp/tx232-repair550d4522`.

The full soak completed, all **70/70** tracked churn terminals collected, and
final panes, instances, views, queued output, scrollback and WebGL counts were
zero. The Inspector snapshots show:

| Observation | Baseline | Cleanup |
| --- | ---: | ---: |
| JS heap shown by Inspector | 50.48 MB | 29.70 MB |
| Baseline objects still live at cleanup | — | 12.69 MB |

The old comparison's largest new plain object was the **42.62 KB** `tabViews`
state with a **39.07 KB** command/harness map for removed fake-agent tabs. In the
repaired comparison, the largest new plain object is **14.45 KB**, a React hook.
Expanding it reveals `memoizedState` pointing to the **current** session store:
`loaded: true`, the synthetic project, and `sessions: []`. Its queue has
`value` and `getSnapshot`, consistent with `useSyncExternalStore`. This is
concrete corroboration of the metadata repair and identifies that inspected
survivor as current UI state, not a deleted conversation. It does not prove
that every remaining object is necessary.

The aggregate new `Object` row is 4.48 MB / 17,285 instances; the React fiber
constructor is `n3e`, 1.45 MB / 1,359 instances. Retained sizes overlap and must
not be summed. The former large metadata object is absent from the top of the
retained-size ordering; the small fix is not inferred from total heap movement.

Native profiles before the snapshots show application WebContent growing from
**226184256** to **431067328** bytes. Inspector itself grew to **983536512**
bytes and is **not** part of that application-only comparison. Summing all
responsible WebContent processes would confound the app with Inspector.
The first run's 1-minute guest load was 4.57 before and 4.10 after; no latency
or physical-host comparability is claimed.

## Paired native samples around heap collection

A second fresh run used app **68759**, application WebContent **68761**, and
`/tmp/tx232-paired550d4522`. It also completed the full workload with **70/70**
tracked churn terminals collected and zero final terminal resource counters.

Unlike the previous profiles, these samples bracket each verified Inspector
snapshot while the workload is paused. They use the same application WebContent
PID, exclude Inspector, and retain exact timestamps. The baseline pair spans
9.65 seconds; the cleanup pair spans 4.55 seconds, including UI snapshot work.
Collection and elapsed reclamation are not independently randomized here.

| Paused checkpoint | Before snapshot, bytes | After snapshot, bytes | Change, bytes |
| --- | ---: | ---: | ---: |
| Baseline | 253332736 | 187027136 | -66305600 |
| Cleanup | 348082496 | 233197888 | -114884608 |

Inspector reported 49.73 MB at baseline, 29.39 MB at cleanup, with 11.98 MB of
baseline objects remaining. Even after both collections, native footprint is
**46170752 bytes higher** at cleanup. Therefore delayed collection explains
substantial transient memory in this experiment but is not a complete
explanation of the residual native increase.

Post-snapshot native category observations (dirty + swapped bytes) include:

| Category | Baseline | Cleanup | Difference |
| --- | ---: | ---: | ---: |
| WebKit malloc | 97370112 | 191840256 | +94470144 |
| JS JIT generated code | 7979008 | 24231936 | +16252928 |
| IOSurface | 15220736 | 21790720 | +6569984 |

These are allocation categories, not object retainers or additive attribution
of physical footprint. Other categories decrease, and accounting includes
shared/reclaimable memory. `WebKit malloc` covers more than JS objects; the
snapshot's JS size cannot simply be subtracted from it to calculate fragmentation.
Occupancy and native allocation ownership within this category remain unresolved.
The guest's 1-minute load was 1.50 before and 5.74 after this profiled run.

## Matched canvas disposal probe

An independent Cocoa/WKWebView executable uses a nonpersistent data store and a
synthetic page. It creates one baseline 1024×1024 canvas, then creates, paints,
presents and disposes 70 more sequentially. It tests 2D (`willReadFrequently`)
and WebGL2 separately. Both WebGL variants call `WEBGL_lose_context.loseContext()`;
one additionally sets disposed canvas dimensions to zero. No live canvas is
shrunk, and **no GC is forced**. Weak canvas references and native footprint are
sampled at prescribed checkpoints, including 500 ms and 5 s after cleanup.
This is an engine experiment, not the terminal workload or its acceptance test.

The source audit motivating it is xterm addon-webgl 0.19's `TextureAtlas.dispose`
(removes canvases) and `WebglRenderer` disposal (removes its canvas and releases
its atlas-cache ownership). Because atlases are shared, indiscriminate clearing
would damage other terminals. No production disposal changes were made.

| Mode | Clear dimensions after disposal | Baseline bytes | Cleanup +5 s bytes | Next prescribed sample bytes |
| --- | --- | ---: | ---: | ---: |
| 2D | No | 28051712 | 31770944 | 31770944 |
| 2D | Yes | 28133632 | 26593664 | 26544512 |
| WebGL2 | No | 59656448 | 627149312 | 90737088 |
| WebGL2 | Yes | 59640064 | 627149376 | 90606016 |

Both WebGL runs still had **71 live canvas wrappers at +5 s**, then **1** at the
next prescribed sample roughly 500 ms later. In the no-clear run, the category
`Owned physical footprint (unmapped) (graphics)` fell from **603979776** to
**67108864** bytes: exactly **512 MiB** released. Its baseline was 37748736 bytes.
The one remaining canvas wrapper and residual footprint are reported,
not treated as zero. This independently reproduces delayed graphics reclamation
without TerminalX's stores, parser or transport. It does not establish that all
of the application's residual `WebKit malloc` growth is the same mechanism.

Dimension clearing helps the small 2D residue in this single matched pair, but
makes essentially no difference to WebGL. The experiment does **not** justify
shipping that change as a solution to #232. Nor does one cycle prove a bounded
cache over arbitrarily long sessions.

Two incomplete harness attempts are retained: the first exited on WKWebView's
unsupported Promise result (corrected by returning `undefined`), and the second
ran the page but sampled no native process because CLI-launched WebContent had
a shared responsibility root. Valid cases require exactly one newly created
WebContent in the probe's responsibility family, excluding preexisting
WebContent PIDs; the recorded PID and root accompany every sample. All four
valid cases exited 0. Guest 1-minute loads stayed between 1.23 and 1.41 for them.

## Final unprofiled control

App **76517**, private home `/tmp/tx232-control550d4522`, same binary. This run
used the repository `terminal-bench.mjs`, without Inspector, diagnostic weak
inventories, heap profiles, snapshot gates, forced collection or changed waits.
It completed the faithful workload and reports **70/70** tracked churn terminals
collected, zero final terminal resource counters and no failed/lost WebGL contexts.

| Endpoint | WebContent bytes | Growth from baseline |
| --- | ---: | ---: |
| Baseline | 230657024 | — |
| 50 shell terminals closed | 365153792 | +58.3102850% |
| 20 fake-agent tabs closed | 375770624 | +62.9131502% |
| 200 switches | 387878464 | +68.1624332% |
| Cleanup | 388566592 | **+68.4607671% — FAIL** |

The 1-minute guest load rose from **1.375 to 14.351** on 2 vCPU. Preserve this
observed failure, but do not use the run as a quiet latency benchmark or a
physical-host comparison. It demonstrates that Inspector is not necessary for
large endpoint growth in this guest; it does not isolate load sensitivity or
prove the same allocation breakdown as the profiled runs. No extra wait or
collection was used to replace its cleanup endpoint.

## Decision and precise handoff

- Keep the scoped metadata repair for independent review: frontend regressions and the repaired heap
  corroborate it. Do not claim its roughly 39 KB explains the physical failure.
- Do not ship canvas-dimension clearing as a WebGL remedy. The independent
  matched probe showed essentially identical delayed WebGL graphics reclamation.
- The original physical result remains **329252864 → 402653184 bytes,
  +22.2929936%**. Its raw `RESULTS.txt` SHA-256 remains
  `80b69669bf358d427b059ba3b937cf0c16832c621c5e2204cc80b38fcb803c7e`.
  Nothing here overwrites that result or relaxes the 10% threshold.
- The remaining specific question is occupancy and native ownership inside
  **WebKit malloc after collection**, including WebCore/Inspector allocations,
  versus retained allocator blocks. Paired samples establish a residual increase
  but not its individual owners. The existing `footprint`, `vmmap`, malloc-stack
  and JS snapshot data cannot supply that missing mapping. A symbolized WebKit
  allocator/cell-occupancy trace, with the unprofiled workload as control, is the
  next discriminating investigation; repeating total-footprint soaks is not.
  The small canvas source is also a reproducible engine-only case of delayed
  graphics reclamation, suitable for an upstream investigation, not proof that
  graphics explains all of the application's WebKit-malloc residual.

No product decision or permission prompt blocked these experiments. No native
PTY/runtime/store source was edited, no engine was replaced, and no active
buffer was reduced. The verified disposable app PIDs **60140, 68759 and 76517**
were stopped; the standalone probes exited. The desktop/native measurement
reservation can be released. No host desktop was used, and no other app or
agent process was stopped. Independent final-head review and actual acceptance
remain outstanding; #232 must stay open.

## Evidence and reproducibility

`repair-evidence.tar.gz` contains the three run reports and native profiles,
paired samples/timestamps, all canvas attempts, the canvas probe source and
runner, exact UI responses/tables, binary/source provenance and build log.
`repair-manifest.json` records each archived file's SHA-256 and size. It excludes
app binaries, app homes, credentials and control tokens. Raw copies also remain
under `/tmp/tx232-repair-550d4522` on the host and the private guest paths above.

The canvas executable was compiled with:

```sh
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" xcrun clang -fobjc-arc \
  -mmacosx-version-min=26.0 -framework Cocoa -framework WebKit \
  canvas-probe.m -o canvas-probe
```

The archived runner deliberately names only its disposable guest path. Run it
only in an assigned disposable guest with those paths prepared; it opens a
small window. The measured valid variants are `2d-0`, `2d-1`, `webgl2-0`, and
`webgl2-1`, each with attempt tag `r3`. Raw process inventories and the matched
new WebContent PID/root accompany each sample. The first app diagnostic uses
`inspector-driver.mjs` with explicit snapshot gates; the last control uses the
unmodified repository driver. These are retained reproduction artifacts, not a
new application API or a supported performance guarantee.
