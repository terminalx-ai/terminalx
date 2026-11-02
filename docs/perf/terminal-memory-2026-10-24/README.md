# Issue 232: allocation diagnosis, 24 October 2026

## Summary, 31 October 2026

**The web view memory target is still unmet; keep #232 open.** The physical-Mac
soak on 24 October ended at +12.74% after 200 switches and +22.29% after
cleanup, against the issue's 10% target. All 70 tracked terminals were
collected and every resource counter returned to zero.

Fixed along the way, each with a regression test:

- Removed tabs kept their command metadata in `tabViews.ts` (39.07 KB in the
  heap comparison), and a late start reply could adopt a pane for a tab that
  no longer existed.
- xterm 6 keeps a pending buffer-compaction callback after `dispose()`, which
  keeps the disposed buffers alive until it runs. `terminalBufferCleanup.ts`
  cancels it.
- Palette conversion created two canvases per palette; it now reuses one.
- The WebGL atlas warm-up outlived its last owner; fixed separately in #652.

None of these closes the gap. What remains is allocator capacity, not live
terminal objects:

- A standalone JavaScriptCore script, with no xterm or TerminalX, allocated and
  released 40,008 line-sized typed arrays. All were collected, yet the
  footprint stayed 59,457,632 bytes above baseline, and WebKit Malloc reported
  60.0 MB dirty with 1.3 MB allocated
  ([minimal regions](line-allocation/minimal-regions/README.md)).
- Packing the same payload into fewer arrays still left 41,091,136 bytes
  ([line allocation result](line-allocation/result.md)).
- A guest diagnostic on 29 October (macOS 26.5.2 VM) opened and closed 50
  shells: footprint rose 47.7%, mostly JS VM Gigacage (+62.9 MB) and WebKit
  malloc (+52.4 MB), while the tracked scrollback, parser and renderer bytes
  did not change.

xterm allocates one `Uint32Array` per buffer line, so terminal churn is exactly
this allocation pattern. The remaining options change behaviour and need an
owner decision: a smaller default scrollback, an LRU cap on idle xterm
instances restored from the backend scrollback, moving to xterm.js 7, or
accepting the residual as WebKit behaviour.

Raw evidence (archives, manifests, probe scripts, screenshots and logs) is not
kept in the repository's history. It was pushed with the first review round of
PR #687, in commit
[`bed0e737`](https://github.com/terminalx-ai/terminalx/tree/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf),
before the branch was squashed, and is reachable through that pull request's
history. File names quoted in these reports refer to that tree. Paths under
`/tmp` were local to the investigation machine.

**Memory acceptance still fails.** The initial checkpoint added diagnostics and
corrected an observer effect. Later follow-ups repair demonstrated metadata and
resize-callback retention, but neither establishes the required native memory
result. Keep #232 open; these checkpoints remain partial work.

## Evidence and environment

The original physical macOS 27 result is preserved at
`/tmp/tx232-audit-20261024/RESULTS.txt` and `native-soak.json`:

| Endpoint | WebContent bytes | Growth from baseline |
| --- | ---: | ---: |
| Baseline | 329252864 | — |
| 200 switches | 371195904 | 12.7388535% |
| Cleanup | 402653184 | 22.2929936% |

All 70 tracked closures collected and final resource counters were zero. The
later unforced drop below baseline is not a substitute endpoint. Historical
measurements retain their original rounding; the new driver requests integer
bytes from `footprint`.

Guest experiments used only `local:tx-queue-232`: macOS 26.5.2 (25F84), arm64,
2 vCPUs, 6 GiB, WebKit 21624.2.5.11.8, a 1024×675/678 window at scale 1,
private homes and synthetic provider fixtures. No host desktop, live app,
credentials, real sessions or other guest was used. VM results cannot replace
physical evidence or prove authenticated provider/cloud behavior.

Initial guest source: `feb67f3c4485a168764fe60c4910c900e9c9f06f`;
app SHA256: `c0d35855fc4a35200961acb8920111c76ca4f3cb28b0e2e645a9c89b9c85642b`.
Corrected source: `99574cfd651b37f7b178a68d79c045970f4c8cc3`.
Corrected app SHA256: `b3517113b15cb7a407c955c964ea0e0503f1fe2f37e2a28c4b441b5c1c47bd14`.

[guest-evidence.tar.gz](https://github.com/terminalx-ai/terminalx/blob/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf/terminal-memory-2026-10-24/guest-evidence.tar.gz) preserves JSON results, failed
runs, profile text, offline reference traces, temporary experiment drivers,
probe source and check logs. [manifest.json](https://github.com/terminalx-ai/terminalx/blob/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf/terminal-memory-2026-10-24/manifest.json) records SHA256 and
sizes, including the two large memgraphs kept outside Git at
`/tmp/tx232-vm-20261024/results/` and in the assigned guest. The archive does
not include those binary graphs. Source/binary hashes and host load are also
recorded in the results/provenance. All disposable app processes are stopped.

## What the runs establish

Both full soaks used 4 sessions, 50 shell terminals, 20 fake agents and 200
switches, without forced GC or extending endpoint waits:

| Guest run | Baseline bytes | Switch bytes | Cleanup bytes |
| --- | ---: | ---: | ---: |
| Original diagnostic | 241437760 | 417058560 (+72.74%) | 361795264 (+49.85%) |
| Unprofiled control | 221842496 | 391941760 (+76.68%) | 397315776 (+79.10%) |

Both completed, collected all 70 tracked closures and ended with zero resource
counters. The control establishes that growth also occurs without the new
inventory. Diagnostic load averages went from 11.19/14.33/6.98 to
15.77/14.09/7.81; timings are not quiet physical-host acceptance.

In the original diagnostic cleanup, all 74 observed terminals, 148 buffers,
74 parsers, 74 write queues, 54 renderers, 108 geometry objects, 110 canvases
and the shared atlas were dead. Observed bytes, pending writes, blink and
recovery timers were zero. Tauri callbacks were 46 at baseline/switches and
42 at cleanup; document nodes were 306/306/262. Persistent ownership of these
tracked terminal objects does not explain that endpoint. This does not exclude
untracked JS objects or native storage.

The matched native profiles showed WebKit-zone allocated bytes increasing
204909956 → 322002396 (+117092440). Exact 16 KiB allocations increased
5297 → 12510 (+118177792 bytes); other sizes net decreased 1085352 bytes.
Dirty WebKit malloc rose 149766144 → 225492992 bytes; JIT code
22921216 → 36880384; JS VM Gigacage 55361536 → 65159168. Owned unmapped
graphics fell 17481728 → 0. The profile baseline was captured after the
endpoint baseline and was already 282840256 bytes: never mix those baselines.

## Correcting the observer

The first inventory read typed arrays' `.buffer` to deduplicate backing stores.
A fresh-process JavaScriptCore probe with 40000 `Uint32Array(531)` objects
measured +16203840 bytes while exposing buffers, versus +4308992 bytes while
reading view lengths. This demonstrates measurement allocations, not their
exact contribution to the soak. WebKit's
[JSArrayBufferView implementation](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/JSArrayBufferView.h)
distinguishes fast arrays from exposed buffers.

Commit `99574cfd` counts unique view spans without touching `.buffer`; a real
xterm regression throws on buffer access. Distinct views can overlap or keep
larger backing stores alive, so these totals are neither heap size nor exact
backing capacity. The original diagnostic remains useful with that limitation.

The corrected run captured baseline, tabs and agents, then the Node driver
exited 13 with “unsettled top-level await” during switches. Its report remains
`complete=false`. The control promise lacks an EOF handler, which can leave
an unanswered closed socket unresolved; the actual server-side cause was not
captured. A separate temporary continuation adds EOF rejection and captures
late ownership/cleanup without repeating the workload. **Neither file supplies
a valid completed soak or acceptance endpoints.**

At late cleanup, all 70 churn terminals were collected, but four retired
baseline terminals, eight buffers, four parsers, four renderers and the atlas
were still observed alive: 22137408 scrollback view bytes, 835116 parser bytes,
713568 geometry bytes. Timers and queued output were zero, callbacks 42,
document nodes 262. Do not generalize the original run's complete collection
to this endpoint. A weak dereference also temporarily keeps its target alive.

## Native graph result and remaining attribution gap

The corrected baseline/late-cleanup profiles showed WebKit-zone allocated
bytes 164368748 → 349105924, and 16 KiB blocks 5115 → 13437
(+136347648 bytes). These endpoints have different timing and profiling,
including `leaks` graph captures; this is allocation diagnosis, not acceptance.

Offline graph comparison and three bounded reverse traces demonstrate why
allocation size alone cannot identify the cause:

- New block `0x15057c000` reaches an
  `AppleParavirtDevice._commandBufferStoragePool`, with paths through Metal,
  CoreAnimation, IOSurface and canvas infrastructure.
- New blocks `0x15dfc8000` and `0x165684000` both reach an unnamed 266240-byte
  allocation (`0x14b121000`), then an unnamed 131072-byte allocation
  (`0x10b400000`). No allocation stacks were recorded. The conservative
  reference graph includes unaligned references and does not identify JS roots.

Although [JSC MarkedBlock](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/MarkedBlock.h)
uses this block size, the traces explicitly prevent attributing every 16 KiB
block to it. Neither fragmentation, empty JSC blocks nor an application root is
proven. The remaining technical need is allocation-stack provenance for the
WebContent zone and JS heap occupancy/retainer paths, not another uninstrumented
soak. A next bounded experiment should first verify that stack logging actually
reaches the isolated WebContent child; app-only logging is insufficient. Capture
matched baseline/cleanup stack groups and JS retainers in a diagnostic run,
separate from the original unprofiled acceptance workload. If platform tools
cannot expose those stacks, retain that exact limitation rather than declaring
an engine leak. No runtime buffer shrink or engine replacement is justified.

## Functional coverage and checks

The 15-case, 1/8/20-terminal matrix completed. 50 MiB drains were
1370/1879/2842 ms; parser echo p95 3/5/14 ms; frame echo p95 18/19/22 ms;
Ctrl+C output-stop 6/4/5 ms. Frame echo fails a strict 16.7 ms interpretation.
No lost echo, discarded writes, foreground DOM fallback, refused or lost WebGL
contexts occurred. Three cases each recorded one main-thread task over 50 ms.
Matrix load went from 3.87/10.37/7.08 to 3.70/7.13/6.35.

Five 30-terminal churn cases completed with collection counts 27/28/29/29/29
at fixed checkpoints, not proof of total collection. Covered output consumed
142166 bytes over 10 seconds with zero renders. A synthetic hide failed and
its incomplete report is preserved. Native menu Hide via explicit-target guest
MCP then verified `document.hidden=true` for both shell and agent-style 50 MiB
producers (2268/1432 ms exit). This does not test sleep or prolonged suspension.

All four CONTRIBUTING checks passed for the corrected source: TypeScript,
3342 Vitest tests across 285 files, Clippy all-targets with warnings denied,
and 2203 Rust tests (14 ignored). Native commands used jobs=2, SDKROOT from
xcrun, and disposable config/home paths. The subsequent changes are evidence
and documentation only. The memory and frame-latency acceptance failures remain.

## Follow-up: allocation stacks captured successfully

A further bounded diagnostic on the same corrected binary enabled
`MallocStackLogging=lite` and `__XPC_MallocStackLogging=lite` in a fresh private
home `/tmp/tx232-stacks`. The guest has no `xctrace`, but `malloc_history`
works. Verify the **WebContent child**, not merely the app: the first
`-callTree malloc[16384]` query returned no stacks, whereas `-allBySize`
returned symbolicated stacks for child PID 41841, responsible to app 41839.
The empty filtered result was not a permission failure or proof logging failed.

The complete original 4/50/200/20 workload ran once, with stack captures at
baseline and cleanup. An initial command-line placement error exited before
starting a workload; that log is preserved. The temporary driver includes
explicit control-socket EOF rejection and streams large stack reports to files.
It does not change workload counts, waits or production code. Supported named
guest CUA verified window 82 was foreground at 1024×675; a later screenshot
confirmed cleanup. The app was stopped after capture. No native files changed.

[stack-evidence.tar.gz](https://github.com/terminalx-ai/terminalx/blob/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf/terminal-memory-2026-10-24/stack-evidence.tar.gz) contains results, native profiles,
representative full stacks, aggregation scripts, per-category deltas and the
exact temporary driver. [stack-manifest.json](https://github.com/terminalx-ai/terminalx/blob/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf/terminal-memory-2026-10-24/stack-manifest.json) hashes these
and the large full stack reports retained under
`/tmp/tx232-vm-20261024/stacks/`. The complete raw archive is
`/tmp/tx232-vm-20261024/stacks-results.tar.gz` (also retained in the guest).
This supplements, and does not overwrite, the earlier evidence.

The run completed with all 70 churn terminals collected, zero final resource
counters, no pending writes and no blink/recovery timers. Four retired baseline
terminals remained observable at cleanup, with the same 22137408 scrollback
view bytes as baseline; parser bytes were 609832 and renderer bytes 713568 at
both checkpoints. Callback counts fell 46 → 42 and document nodes 306 → 262.
This isolates a surviving baseline set; it does not explain growing terminal
ownership across the churn.

Recorded WebContent endpoints were 339430528 baseline, 639472256 after
switches, and 649335424 cleanup. **These are not acceptance measurements.**
Load changed from 1.19/1.02/1.72 to 20.75/9.80/5.12. More importantly,
logging replaced the ordinary WebKit malloc zone with
`MallocStackLoggingLiteZone`. Its allocated bytes grew
257888176 → 321645568 (+63757392). `vmmap` reported dirty “Performance tool
data” increasing from 63.5 MiB to 249.5 MiB (rounded values); the logging
metadata itself accounts for a substantial part of this diagnostic footprint.
Neither that zone nor these deltas can be substituted for the original run.

The nearest named caller groups provide more specific attribution than the
previous allocation-size hypothesis:

| Stack group | Baseline bytes | Cleanup bytes | Delta |
| --- | ---: | ---: | ---: |
| `JSC::LocalAllocator::allocateSlowCase` | 123387920 | 149230512 | +25842592 |
| IOSurface paths | 17598656 | 37551808 | +19953152 |
| JIT paths | 20548768 | 39937904 | +19389136 |
| `JSC::FastMallocAlignedMemoryAllocator::tryAllocateMemory` | 5326048 | 10429344 | +5103296 |
| `JSC::UnlinkedMetadataTable::finalize` | 5182368 | 9398656 | +4216288 |
| `JSC::JSRopeString::resolveRope` | 491392 | 4210432 | +3719040 |
| ArrayBuffer paths | 53747488 | 53138496 | −608992 |

Aggregation is reproducible in `summarize-stacks-callers.py`: explicit category
matches take precedence, then the closest named WebKit/JSC caller excluding
generic allocation functions. Many allocator frames are
`<deduplicated_symbol>`. “JIT” and “IOSurface” are broad stack-substring groups,
not exclusive physical VM categories. The raw tool includes VM reservations
as well as malloc allocations (notably an unchanged 4 GiB reservation);
**do not sum this table to explain physical footprint**, or treat stacks as JS
retainer paths. A representative typed-array stack specifically passes through
`operationNewUint32ArrayWithOneArgument`,
`JSArrayBufferView::ConstructionContext`, `LocalAllocator::allocateSlowCase`,
`Gigacage::tryAlignedMalloc`, and bmalloc. Other stacks show bytecode metadata,
rope resolution and CSS parsing allocations.

This completes the previously requested stack-capability experiment. The
remaining question is **occupancy and JS retainers within the allocator blocks**:
which cells are live, what retains them, and which blocks are partially empty?
The stacks establish allocation origins, not that these allocations form a leak
or bounded cache. Repeated plain soaks cannot answer that question. The next
useful diagnostic is matched JavaScript heap/retainer snapshots via WebKit's
inspector in the assigned guest, correlated with the weak terminal inventory.
Any collection caused by heap inspection must be labeled diagnostic and kept
out of acceptance. There is no missing product decision and no demonstrated
permission blocker; inspector capability remains to be checked. No runtime
repair is justified by these stacks alone. All four code checks reported above
still apply to the unchanged runtime source; this follow-up adds evidence only.

## Follow-up: matched Inspector snapshots and a concrete metadata survivor

Web Inspector is available in the assigned guest's existing diagnostic build.
The supported PID-targeted UI opened it, detached it into window 105, enabled
JavaScript Allocations, and captured snapshots after baseline and cleanup.
App PID 48939 used fresh private home `/tmp/tx232-inspector`, unchanged binary
SHA256 `b3517113b15cb7a407c955c964ea0e0503f1fe2f37e2a28c4b441b5c1c47bd14`,
and no malloc stack logging. Inspected WebContent was PID 48941; Inspector
created an additional WebContent process, PID 49005. Aggregate footprint
includes both, so it is not comparable to acceptance.

The temporary driver preserves the 4/50/200/20 workload but explicitly pauses
at baseline/cleanup for the Inspector operations. It completed with all 70
churn terminals collected and zero final resource counters. Baseline and
cleanup inventories before the snapshots observed four baseline terminals;
cleanup marked them retired. Load changed from 1.86/2.35/3.07 to
4.53/3.43/3.02. The long baseline pause while attempting export is recorded
in `inspectorGateReleasedAt`; it must not be hidden or treated as the normal
soak schedule.

**Heap snapshots perform full collection.** This is documented by
[WebKit](https://webkit.org/blog/6425/memory-debugging-with-web-inspector/).
They answer reachability questions after collection and cannot establish the
unforced 10% physical-memory criterion. No acceptance result is replaced.

The Inspector's displayed sizes (rounded, not raw bytes) were:

| Snapshot | Size when captured | Baseline objects still live at comparison |
| --- | ---: | ---: |
| Baseline, Page Snapshot 1 | 55.97 MB | 16.74 MB |
| Cleanup, Page Snapshot 2 | 29.90 MB | — |

Thus roughly 13.16 MB of cleanup objects were created after the baseline.
This does not establish a 13.16 MB leak: initialization, code metadata and
changed UI state also allocate. In the comparison's Instances view, newer
`Object` instances had 4.52 MB aggregate retained size (16974 instances),
React fiber objects had 1.37 MB (1277 instances), lexical environments
468.86 KB, functions 404.67 KB, arrays 385.32 KB and strings 284.46 KB.
Retained sizes can overlap and must not be summed. The minified `$ke` class
was matched to the built asset's React fiber constructor (`tag`, `key`,
`alternate`, `memoizedState`, etc.), not guessed from the class name.

Expanding the largest individual newer `Object` instances exposed a concrete
application survivor: object `@369419`, displayed retained size **42.62 KB**,
with `{views: {}, info: Object, errors: Object, switching: {}}`. Its `info`
object `@369453` retained **39.07 KB** and contained command/harness metadata
for closed synthetic agent tab IDs from this run. Source inspection matches
this directly to module-level `state` in `src/lib/tabViews.ts`:

- `registerTabPty` and `adoptTabPane` add `info[tabId]`.
- `startTabAgent` adds error state; view switching adds further keyed state.
- `forgetTabView` deletes only `views[tabId]`.
- Only the test-only reset clears all maps. Normal PTY-first exit from terminal
  view deliberately preserves info because the tab remains live.
- `src/lib/sessions.ts` removes tabs/sessions and drops terminal instances,
  but does not release this per-tab metadata on permanent removal.

This is evidence of stale application ownership after tab deletion, independent
of the much larger native allocator question. The entire surviving map is
about 39 KB in this workload, so fixing it cannot honestly be claimed to repair
the original 73 MB physical cleanup increase. A fix should clear per-tab
metadata on authoritative removal, prevent late asynchronous start/adoption
completion from recreating it, and preserve live tabs, reopening, cloud view
state and provider history. The exact runtime dependency is
`src/lib/tabViews.ts` plus lifecycle hooks in `src/lib/sessions.ts`. Ownership
clearance was requested from the coordinator before editing those files; no
backend, native PTY, store or shared-session files were changed.

### Export limitation and preserved evidence

Snapshot export opened a native Save panel. Its Go to Folder sheet rendered
blank in both accessibility and a full named-guest screenshot. Text delivery
was unverified; Return did not dismiss the sheet. Both dialogs were cancelled
through their verified window IDs. No permission boundary was bypassed and no
alternative host/global-input route was used. Consequently there is **no
exported machine-readable heap graph**. The evidence is the Inspector's tables,
comparison, expanded object previews and screenshots, not an offline full-root
analysis. Some selected object IDs were clicked after both captures; Inspector
may log/pin such values, so later liveness is not used as evidence.

[inspector-evidence.tar.gz](https://github.com/terminalx-ai/terminalx/blob/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf/terminal-memory-2026-10-24/inspector-evidence.tar.gz) preserves the run,
per-process profiles, exact checkpoint driver, UI action/read responses,
comparison tables and screenshots.
[inspector-manifest.json](https://github.com/terminalx-ai/terminalx/blob/bed0e737b364920e0f7c84deba960008bd126f02/docs/perf/terminal-memory-2026-10-24/inspector-manifest.json) records their hashes.
The source snapshot and native hashes are unchanged; all four prior code checks
still apply, and archive/hash/JSON validation was run for these evidence-only
changes. The disposable app and Inspector were stopped after evidence capture;
the guest measurement reservation is released. #232 remains open.

## Repair: deleted tab metadata and delayed adoption

After merging main at `15f6cbc6`, the frontend now releases `tabViews`' view,
command/harness, error and switching entries when an authoritative session-index
update removes an active tab. This covers successful tab removal, session
removal, refresh and backend updates. Archiving or retaining a removed worktree
without removing its tabs keeps that metadata. No persisted history or unknown
session fields are rewritten by this hook.

Each active local tab's asynchronous work has a lifetime token. Removal drops
that token and the shared start promise. Old start successes, failures and pane
lookups cannot repopulate the maps; pane adoption also checks the token after
waiting for terminal subscriptions. Reopening the same retained tab obtains a
new token and can reattach to its runtime independently of the older promise.
There is no growing set of deleted IDs. Cloud view choices are unaffected by an
unrelated local deletion. The native PTY, store and runtime contracts are unchanged.

Five integration regressions use the real frontend session, terminal and view
stores with a simulated IPC boundary: retained archive/unknown fields versus
actual tab removal; failed removal followed by authoritative refresh; delayed
pane replies after reopening; successful removal and cancelled adoption; and
late start errors during a view switch. The existing workspace-deletion UI
fixture now supplies the newly used cleanup export; its assertions are unchanged.

This repair targets the observed **39.07 KB** metadata survivor. It is not a
quantitative explanation of the physical cleanup increase from **329252864** to
**402653184** bytes (**+22.2929936%**). The physical raw results remain untouched.
No new native acceptance result is implied by the frontend regression tests.

The larger attribution question remains open: the diagnostic heap shrank from
55.97 MB to 29.90 MB while native profiles retained allocation blocks, IOSurfaces
and JIT-related memory. These measurements cannot be subtracted to infer a leak:
heap capture collects garbage, profiling changes allocation policy, and the
runs have different timing and OS versions. The next discriminating experiment
is a fresh guest build with this repair, matched baseline/cleanup snapshots to
confirm removal of the stale map, and retainer-path inspection of the largest
remaining new React/lexical objects. If they are no longer rooted, allocator
block occupancy (rather than another total-footprint soak) is needed to attribute
native retention. Keep those diagnostics separate from an unforced faithful
4-session/50-terminal/200-switch/20-agent acceptance run and its unchanged 10%
raw-byte threshold. The guest OS cannot replace the original physical-host result.

Repair validation on the merged source: `pnpm exec tsc --noEmit`,
`pnpm vitest run` (286 files, 3362 tests),
`cargo clippy --all-targets -- -D warnings`, and `cargo test`
(2217 library + 6 provider + 2 field-naming tests passed; 14 ignored) all exited
0. Native commands used `CARGO_BUILD_JOBS=2`, the `xcrun` macOS SDK and private
`CLAUDE_CONFIG_DIR`/`TERMINALX_HOME` under `/tmp/tx232-fix-checks`; raw check logs
remain there. These are code checks, not guest or physical performance acceptance.

## Repaired-build follow-up

[The repaired-build guest report](repair-followup.md) records the heap
corroboration of `550d4522`, paired native samples around collection, an
independent canvas disposal experiment, and the final unprofiled control.
The control completed but failed the unchanged memory threshold (+68.46%)
on the loaded macOS 26 guest. The original physical-host failure remains
unchanged. The report identifies the remaining allocator-occupancy question
and links a manifest-verified archive of the new evidence.

## Offline owner tracing follow-up

[Native owner tracing](owner-trace.md) records the bounded JIT graph probe after
checkpoint `102983e9`, allocation-type deltas, and the exact missing JSC
cell-ownership capability. No new soak or acceptance result is claimed. Raw
outputs are in `owner-trace-evidence.tar.gz`, with `owner-trace-manifest.json`.

## Installed JSC capability follow-up

[Installed JSC attribution](jsc-capability.md) verifies a synthetic function-to-
CodeBlock graph and a real xterm common-parser probe without an engine build.
It documents the rejected WKWebView hook and the prepared, unrun comparison.
Raw evidence is in `jsc-capability-evidence.tar.gz` with its manifest. This
supersedes a giant-build prerequisite for shell diagnostics, not the failed
production memory acceptance.

## Completed bounded JSC comparison

[Parser ownership comparison](jsc-comparison.md) records the two authorized
processes, exact reservation/exit times, CodeBlock attribution and the Unicode
cache retainer. Both diagnostic runs completed, and the reservation was released.
The original native acceptance remains failed. Raw graphs and scripts are in
`jsc-comparison-evidence.tar.gz`, verified by its manifest.

## Resize disposal follow-up

[The real-xterm disposal regression](resize-disposal.md) demonstrates and fixes
a scheduled compaction callback retaining closed buffers. It cannot explain the
previous native endpoint after those buffers were collected, and does not change
the failed acceptance result.

## Native parser control

[The corrected WKWebView comparison](wk-parser-control-result.md) completed with
+16,384 bytes in the empty control and +71,172,224 bytes in the parser process.
Because 21/24 tracked objects remained alive, this does not isolate native caches
or explain the production endpoint after all buffers collected.

## Natural-GC observation preparation

[The bounded logging protocol and offline-tested driver](natural-gc/README.md)
are ready for a two-minute capability check after the guest returns from #466.
No positive native GC logging capture or new acceptance measurement exists yet.

## Prepared ownership/capacity discrimination

[The three-process counter/native-footprint protocol](ownership-capacity/README.md)
adds a deliberate JS-root positive control and collected same-PID measurements.
Installed shell APIs and real-xterm control logic were checked; the comparative
run awaits a coordinated three-minute window and is never acceptance evidence.

[Completed ownership/capacity result](ownership-capacity/result.md): matched
collected counters and native samples now demonstrate residual residency after
the deliberate terminal-array roots are released. Production failure is unchanged.

## Line allocation-shape preparation

[The four-arm source-only discriminant](line-allocation/README.md) separates raw
line arrays, actual BufferLine objects and equal-payload large arrays. Offline
controls pass; no guest measurement has run. Guest ownership was released to #467.

[Completed line allocation-shape result](line-allocation/result.md): all ownership
controls passed; raw line arrays reproduce substantial immediate post-GC native
residency. Production acceptance remains failed; both guest holds are released.
