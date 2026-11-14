# Standalone JavaScriptCore reproducer: native host result

One authorized experiment, two sequential fresh headless processes, executed from
44d433e1ce0a70ec6093dcf332eba222c9003632 on 2026-10-24. No guests, UI,
TerminalX stores, xterm imports, renderer or transport were used. No external report
has been posted. This directory is a locally prepared upstream evidence packet.

## Reproduction and provenance

The exact input is `minimal-jsc-repro.cjs` inside `capture.tar.gz`, SHA256
`8bc9f9bf812e47d0239e243cf67c7451cb4be02e6aff7685fafe91b0f1bd0d05`.
Run it with the installed JSC shell, once each with `-- control` and `-- raw-lines`.
The archived `run.py` supplies private HOME/TMPDIR and an allowlisted environment,
records provenance and bounds each child to 30 seconds, reaping it on exit or timeout.
Its source-file lookup assumes invocation from this repository. It refuses reused
mode directories. Both actual children exited 0 naturally, without timeout or kill:

- Control PID 8345: 18:28:49.097501–18:28:49.126777 UTC.
- Raw arrays PID 8350: 18:28:49.127261–18:28:49.159138 UTC.

Host: arm64, macOS 27.0 (26A428); system JavaScriptCore bundle version
22625.1.29.11.27, short version 22625. Shell path:
`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`.
Shell SHA256 `1b4278b8b579ecdbfcd3c4fe3e297c7c4b28709e691387b5b0bdb6b813f192e6`.
This hashes the helper, not the entire dyld shared-cache engine; bundle and OS build
pin the installed engine identity. It is a different build from the earlier guest.
Raw source/input hashes, timestamps, outputs, process-name audit and driver are
archived; `manifest.json` here hashes every archived file. Original working files:
`/tmp/tx232-minimal-host-20261024/`.

No quiet reservation: load averages before/after were 9.64/11.76/10.53. This is a
contended functional allocation diagnostic, not comparable performance timing.

## Observations (bytes)

| Arm | Baseline native current | Held native current | Released native current | Released minus baseline |
| --- | ---: | ---: | ---: | ---: |
| Empty control | 7,471,656 | 7,553,576 | 7,619,112 | 147,456 |
| Raw arrays | 7,602,728 | 65,405,600 | 65,684,128 | 58,081,400 |

The raw arm constructs eight rooted groups containing 40,008 Uint32Array(240)
objects, 38,407,680 payload bytes, with the same cell words as the previous shape
experiment. No `.buffer` access occurs. Full diagnostic GC precedes each record.
Roots are 0 → 8 → 0; engine typed-array counts are 0 → 40,008 → 0. The empty
control has zero throughout. Raw heapSize is 108,416 → 51,667,527 → 132,144;
heapCapacity is 489,504 → 53,257,463 → 519,584. These engine heap fields are not
physical footprint and must not be subtracted to label bytes as fragmentation.

The native values here are the shell's `MemoryFootprint().current`, not the earlier
external `footprint` command. The raw held record's peak is 16,384 below current;
preserve this actual non-atomic observation rather than imposing peak >= current
or repairing it. No conclusion uses peak. Reporting itself allocates; the empty
arm controls for reporting and the three GC calls.

## Causal conclusion and limits

Post-collection native residency reproduces without even xterm warmup. Neither
TerminalX application ownership nor xterm code is necessary for this scoped effect.
It is not explained by surviving typed-array wrappers: the held positive control
proves the counter sees them, and the release counter returns to zero while
reported native residency persists. This supports an engine/allocator reclamation
investigation, but does not identify a specific allocator bin, native owner, JIT
cache, or time-to-reclamation. It does not prove a permanent leak, disprove other
application retention, or attribute 58 MB of any production capture to this cause.

The original faithful production +68.46% failure remains unresolved. Explicit GC,
a different process/build, immediate endpoints and contended execution cannot
replace the unchanged native soak acceptance. There is no evidence-backed product
patch to make from this result; do not force GC, pool lines speculatively, shrink
buffers or replace the engine. The smallest justified next step is review of this
minimal upstream-ready packet and allocation-owner analysis of this exact case
with engine symbols/allocator tooling, rather than another whole-app soak. Such a
new run needs separately coordinated scope/resources; none is queued here.

## Validation

Four offline capture tests pass: actual result, retained-array negative control,
failed-child negative control, and missing-phase negative control. The existing
Node source/shape test passes with the pinned core bundle; Node is not a native
measurement. Initial offline test invocation hit Python 3.9's missing tar filter
API and omitted the core argument; both corrected, without rerunning native work.
The extractor now accepts only regular relative files without traversal components.
No application code changed and the four whole-project checks were not rerun for
this evidence-only checkpoint. They remain required on a final reviewable head.
