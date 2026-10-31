# Natural-GC observation capability probe (prepared, not executed)

Production memory acceptance remains **failed: +68.4607671%**. The earlier
physical failures and the parser-control raw files remain unchanged. This probe
is a logging capability check, not acceptance, a new soak, or attribution of the
production residual. No guest was accessed while preparing it; #466 owns the guest.

The completed parser control retained 21/24 weak references. Its +48,037,888
Gigacage bytes cannot yet be separated into reachable objects, uncollected garbage
and committed allocator capacity. Observing natural collection activity can narrow
that question without forcing GC. A logged collection alone still does not prove
that each tracked object was eligible or that its generation was collected.

## Ready experiment and limit

Request **one two-minute reservation**, after explicit return of
`local:tx-queue-232` from #466 and owner quiet confirmations. Check host/guest load,
record timestamps and actual process exits, and release immediately afterward.
Do not run the command on the host, other guests, or a shared/global CUA target.
No build or system WebKit modification is required. Transfer these small Python
files and use the existing three hash-verified fixture artifacts in a private
guest directory. Obtain its hostname through the explicitly named guest route;
never substitute the host hostname to get past the guard.

`observe.py --help` describes the invocation. Supply `--guest-hostname` with that
verified value, `--scheduled-disposable-guest`, `--fixture` with the existing v2
fixture directory, and a new private `--output` directory. The scheduled flag and
hostname guard prevent accidental use; they are not substitutes for coordinator
handoff or an authorization mechanism.

The driver runs **one** fresh parser process with the unchanged workload and
five-second baseline/endpoint delays. It records phases and actual exit, then
queries only the verified WebContent PID's process lifetime using `log show`.
The two phase reads each time out at 25 seconds; process termination has a
five-second grace plus five-second owned-child kill fallback; log capture times
out at 15 seconds. Other bounded capability/process queries fit within two
minutes. A killed child invalidates the result. No detached runner remains.
There is no footprint command in this capability probe: instrumented logging
must not be presented as a comparable footprint measurement.

Only process-private `JSC_logGC=2`, `JSC_dumpOptions=1`, `JSC_useOSLog=default`
and their `__XPC_` forms are requested, after removing inherited JSC settings.
The upstream [options list](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/OptionsList.h)
marks these as normal options, unlike the restricted DollarVM hook. This is not
proof of support or propagation in the installed guest binary. The driver checks
installed `log show` help before launch. No settings, entitlements, restricted
hooks, logging configuration, permissions, additional allocation pressure,
collection policy, forced GC or longer observation waits are changed.

## Interpretation and failure rules

Keep `run.json`, `phases.jsonl`, parent `stderr.log`, raw `unified-log.json`,
`log-error.txt`, `log-command.json` and any analyzer error. Parent stderr alone
cannot establish WebContent's effective options. Missing child option dumps,
empty logs, redaction, unsupported schema or permissions failures leave logging
capability **unverified**, not evidence that no collection occurred. Do not use
sudo, private entitlements, system logging changes or an alternate protected route.

The analyzer admits only correctly identified, timezone-qualified events within
the exact captured process lifetime. It preserves candidate option lines and GC
fragments, tagged before baseline, during the interval or after endpoint. Review
actual installed-engine output against upstream
[Heap.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/Heap.cpp)
before assigning collection boundaries: logging uses separate messages, and a
start/full-sweep marker does not prove completion. KiB heap statistics are not
raw physical footprint. Never infer completed collections from marker counts.
Effective GC options must be confirmed in child logs before interpreting silence;
even confirmed options do not prove unified-log delivery was complete.

If a natural full collection is demonstrably completed before the endpoint yet
21 references survive, investigate roots/generation semantics rather than calling
all growth uncollected garbage. If no full collection is observed, the result
remains consistent with delayed collection but does not prove it. If collections
occur only after endpoint, preserve the original endpoint; do not move it.
A successful capability check can support a separately scheduled instrumented
experiment; this driver does not automatically start another measurement.

## Offline validation

Run from the repository root:

```sh
python3 -m unittest discover -s docs/perf/terminal-memory-2026-10-24/natural-gc -p 'test_*.py' -v
```

`captured-run.json` is the unchanged real 14:20:45–14:21:08 control/parser record
from the previous evidence archive. Tests preserve its 21/24 result and verify
that absent logging remains unknown. Wrong parent PID, outside-lifetime events,
incomplete/failed/killed runs, invalid counts, timezone ambiguity and invalid
options are rejected or retained as failures. Constructed log envelopes are
explicit parser-negative/fragment grammar controls, **not captured native GC
output**. There is no installed-engine positive logging fixture yet. The real
CLI wrong-host test rejects before creating output or launching a probe.

Eleven offline tests pass; `observe.py --help` passes. No native capability probe
or new memory measurement ran. These files are diagnostic preparation only;
production sources are unchanged. The four runtime checks last passed at the
resize-disposal repair, not rerun for this preparation. Final-head project checks,
independent review and unchanged native acceptance remain required before issue
completion. No reservation is currently held.

## Alternate guest execution update

[The single authorized alternate-guest run](alternate-result.md) completed its
parser phases, but GC logging capability remains inconclusive. The recovered
real log capture supports two diagnostic parsing fixes and 14 passing offline
tests; it supplies no native memory acceptance evidence.
