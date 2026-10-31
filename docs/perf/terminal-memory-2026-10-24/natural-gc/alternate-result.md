# Alternate guest natural-GC capability result

**Inconclusive: usable child GC logging was not established.** Exactly one
parser probe ran following the coordinator's explicit GO. No full soak,
footprint/latency comparison, forced collection or repeat workload ran. The
production +68.4607671% failure and physical-host failures remain unresolved.

Target was only `local:terminalx-cua-macos`, macOS 26.5.2 (25F84), arm64,
4 CPUs/8 GiB, with the verified isolated artifacts and hostname described in
[preflight](alternate-guest.md). #439's host work was not paused, its guest
artifacts were preserved, and #466's guest and the host GUI were not accessed.
This is not the original guest or a replacement performance baseline.

## Execution and actual exit

The named CUA exec was capped at 120 seconds. Driver/probe source was `cd65d461`.
The native probe, common bundle and workload hashes remained those in preflight.
The actual run record contains:

- Probe PID **901**, WebContent PID **906**.
- Start **2026-10-24T15:54:41.815732Z**.
- Baseline **15:54:48.357Z**.
- Endpoint **15:54:53.655Z**, tracked 24 / alive 21.
- Actual owned-probe exit **15:54:53.705350Z**, intentional termination status -15.

Both phases completed. The subsequent process-name audit found no owned probe
remaining. The driver exited **1**, because the log retrieval failed, not because
the parser phase failed. Preserve that failure; it is not a successful end-to-end
execution of the original driver. No reservation was held or extended.

## Bounded retrieval correction, without another probe

The failed raw query reported:

```
log: Failed to parse timestamp from '@1792857281.815732'
```

Despite advertising `@unixtime`, installed `log show` rejected fractional Unix
seconds. One read-only retrieval of the **same completed PID 906**, with integer
bounds `--start @1792857281 --end @1792857294`, exited 0. Both queries and outputs
are retained separately; the failed files were not overwritten. No logging
configuration, permission, restricted option or system setting was changed.

The recovered JSON contained three startup activity records with
`processImagePath: /usr/libexec/xpcproxy`, PID 906, around
15:54:41.965 UTC. They contain neither JSC option dumps nor GC messages. Parent
stderr was empty. Startup records demonstrate that this query can retrieve some
records for the PID, **not** that WebContent accepted the requested options or
that its GC diagnostics reached the log store. There is no evidence here for
zero collections, restricted/unsupported options, or a native-cache-only cause.

Offline parsing initially rejected Apple's `2026-10-24 08:54:41.964796-0700`
timezone format under Python 3.9. The analyzer now normalizes its explicit offset
without inventing a timezone. Driver retrieval now rounds the query window
outward to integer seconds, while the analyzer still enforces the exact recorded
lifetime. A real-capture regression verifies that an event before the true start
is rejected even if it lies inside the widened retrieval interval.

## Validation and next discriminating question

All **14 offline tests passed**, including the real alternate log schema,
inconclusive interpretation, exact-bound filtering, wrong-host guard and prior
negative controls. No production sources changed; full project checks were not
rerun for these diagnostic-only fixes. The original driver failure remains
recorded rather than relabeled passed. Independent final-head review and full
native acceptance are still outstanding.

The next useful question is whether the same normal logging options work in a
minimal standalone installed JSC process, versus being lost or unrouted in the
WKWebView child. That is a distinct capability control, not another parser soak.
It has **not run** and requires a separately authorized bounded command. Even a
positive standalone result would not prove WKWebView propagation. Read-only
upstream inspection can inform that control, but upstream defaults do not prove
the installed release's option support. No engine change, speculative production
repair or further memory interpretation is supported by this capture.

`alternate-capability-evidence.tar.gz` preserves original run/phases, failed
fractional query/error, recovered integer-query output, analysis, exact recovery
command, and driver-exit evidence. Its manifest contains per-file SHA256 values.
The guest remains running with isolated results preserved; no probe or reservation
remains active. No additional guest workload was started.
