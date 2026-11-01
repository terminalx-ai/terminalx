# Next mechanism: allocation churn in recycled-line metadata

This is a source/evidence investigation after the failed pair, NOT another native
measurement or a production fix. No guest action follows the evidence export.

## What the new pair narrows

Candidate shell churn alone raises WebContent by 150,897,152 bytes, while all 50
churn terminal wrappers are reported collected and live baseline state is still
four instances / 40,096 lines. Cleanup delta is 165,134,912 bytes. Thus most net growth
is already present before fake-agent metadata and switching. This is phase
localization, not attribution of 91.38% to any allocator or source object.
Parent likewise grows 162,087,424 bytes at shell churn, then releases some footprint
before its final 152,797,632-byte delta. These differing endpoint drops are another
reason not to infer a palette regression/improvement from one pair.

Prior no-xterm JSC evidence establishes a real mechanism by which unreachable
payloads can leave resident native allocator capacity: the WebKit Malloc zone
returned near its baseline allocated bytes while dirty pages persisted, principally
in JS VM reservations. It does NOT quantify that mechanism's share of this run.
See the prior [minimal-regions report](../../terminal-memory-2026-10-24/line-allocation/minimal-regions/README.md).
Do not repeat the disproven canvas-dimension remedy, metadata retention experiment,
JIT-only attribution, resize-disposal fix, palette allocation-count diagnostic or
full soak simply to observe the same failure.

## Concrete source path and one bounded functional probe

Installed xterm 6.0.0 `src/common/services/BufferService.ts`, `scroll()`:
when the normal scrollback is full, it calls `buffer.lines.recycle().copyFrom(newLine)`.
This already recycles the large typed-array storage at unchanged width. Proposing
another app-side line pool would duplicate an existing optimization and violate
xterm's buffer invariants.

In `src/common/buffer/BufferLine.ts`, `copyFrom()` reuses `_data` when widths match,
but unconditionally assigns fresh `{}` objects to BOTH `_combined` and
`_extendedAttrs`, even for a blank source and destination. Plain numbered-line
output has no combined glyphs/extended attributes, so this creates new metadata
dictionaries during the post-capacity portion of each `seq 1 20000` stream. The
prior allocation-shape constructor probe did not exercise this repeated recycle
path. The actual count during the full app workload has not been instrumented;
do not equate the probe count below with a measured production allocation count.

`buffer-recycle-probe.mjs` transpiles and loads the installed source in a disposable
Node process, without modifying node_modules or product code. It checks object
identity over 10,000 copies between two 80-column BufferLines:

- 10,000 new empty `_combined` dictionaries;
- 10,000 new empty `_extendedAttrs` dictionaries;
- 0 replacement typed-array objects.

The same probe checks that actual `copyFrom()` preserves a combined glyph and an
extended underline attribute, then clears them on blank copy without corrupting
the source. It passed once; loaded source hashes are in buffer-recycle-result.json.
This is an allocation-site/functional proof. Node is NOT a substitute for JSC,
and no Node RSS/time/GC result is used to explain WebContent memory.

## Falsifiable hypothesis and control — NOT executed

H: repeated empty metadata replacement on recycled lines adds collectible JSC
object churn that leaves materially more resident allocator capacity than an
otherwise identical recycle path, beyond the already-established typed-array
payload effect. Alternative: these tiny objects are reclaimed/reused cheaply;
the large residual comes from line storage, render resources or other allocations.

A future SEPARATE diagnostic should use the existing verified isolated JSC/native
harness, two sequential bounded processes, actual installed BufferLine code and
identical retained line widths/counts, fill values and recycle count. Control runs
unchanged `copyFrom`; experimental fixture avoids ONLY known-pristine empty-map
replacement. Preserve held and released roots/cell census, fixed sample times,
engine/input hashes and native allocator-region accounting. Keep typed-array
allocations identical; no rendering, transport or Tauri. If allocator-accounted
allocated bytes stay high or maps remain live, investigate ownership instead of
calling it capacity. If cell counts/allocated bytes return but dirty/resident
capacity differs, that supports this mechanism in the isolated case. If no material
native difference appears, reject it as a contributor worth pursuing. This remains
an engine diagnostic, never acceptance, and requires its own authorization/window.
No new run or reservation is requested by this document.

## Smallest repair candidate and exact blocker

The smallest prospective change belongs upstream in `BufferLine.copyFrom`: avoid
replacing dictionaries that are demonstrably pristine/empty while preserving all
populated-copy/reset behavior. It is not safe to blindly reuse every dictionary:
combined glyphs, extended attributes, shrinking/resizing and previously populated
maps can retain capacity or stale entries. Those transitions need explicit functional
and allocation controls before treating a reuse implementation as a memory repair.

There is no public xterm option/addon hook that changes this internal allocation
policy. Monkey-patching BufferLine from TerminalX, shipping a node_modules edit,
shrinking scrollback, forced collection or swapping renderers is not justified.
The source churn is demonstrated; its retained-byte contribution is not. Therefore
NO production patch is made from this probe. An upstream-compatible implementation
and review plus native contribution evidence are the immediate technical blockers,
not a missing product decision or user permission to investigate.

A further ownership caveat remains: the normal soak's 70/70 census tracks churn
Terminal wrappers, not every internal buffer and not the four baseline terminals.
Use the already-existing opt-in terminalMemory inventory in a separately labelled
diagnostic if owner attribution is needed; it tracks buffers/renderers/queues but
its WeakRef dereferences perturb liveness. Do not add it to this acceptance result
or pretend zero app counters are a complete JS heap census. Mapping persistent
native pages to precise libpas size classes/decommit policy still requires engine
allocator diagnostics or symbols absent from the earlier captures.
