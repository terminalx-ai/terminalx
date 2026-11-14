# Prepared next diagnostic: common parser in native WKWebView

Update: the corrected comparison subsequently completed; see
[the measured result](wk-parser-control-result.md). This document preserves the
earlier preparation/failure record.

Original preparation record. The first reserved attempt timed out; see
[wk-parser-control-startup.md](wk-parser-control-startup.md) for the preserved
failure and functionally verified revision 2. No comparison result exists.

Status at this original checkpoint: **prepared and compiled, not measured**. The disposal repair is committed
at `a0880b80`; all four required checks pass there. The failed native +68.46%
production result remains unchanged. This diagnostic cannot constitute acceptance.

## Question

Does the small parser-only workload already attributed in standalone JSC produce
native WebKit allocation retention without the TerminalX application, DOM renderer,
WebGL, Tauri channels or session stores? This closes a specific gap between that
JSC cell/CodeBlock result and WKWebView's native allocation categories. It does
not repeat the full soak and does not assume compiled-code caches explain it.

Two fresh processes load the identical common xterm bundle. Both report a
baseline after a fixed five seconds. The control does no terminal work; the parser
process creates eight 80×24 terminals, parses 5,000 ANSI lines in each, verifies
output and disposes them. This is the same parser workload used in the earlier
JSC ownership comparison. Both report their endpoint after a fixed five seconds.
No forced GC, resize, renderer, account, backend or real session is involved.

The driver records raw-byte `footprint` text/JSON at both endpoints for the same
WebContent PID and process/resource observations. It identifies the single new
WebContent process relative to the prelaunch process list and aborts on ambiguity
or PID replacement. The probe is an offscreen nonpersistent WKWebView with no
window and a 90-second watchdog. The driver stops only its own child probe.
Weak references report terminal/buffer liveness without inspecting backing stores.

If tracked objects remain alive, the result cannot distinguish delayed GC from
application ownership or cache retention. If they collect but native categories
grow, those tracked objects are excluded as persistent owners in this minimal
case. A flat result does not exclude effects that require the full application,
renderer, larger workloads or physical macOS 27. Neither outcome relaxes acceptance.

## Ready artifacts and reservation

Both host and assigned guest have `/tmp/tx232-wk-parser-control/` with the workload,
Objective-C probe and Python driver. The guest executable was compiled using its
installed Command Line Tools; no engine build or system changes were made.
Python syntax validation passed. The comparison itself has **not** been executed.

- Guest: `local:tx-queue-232`, macOS 26.5.2 (25F84), arm64, 2 vCPU / 6 GiB.
- Probe SHA256: `6d41743eacc04fb4738c865c9079ebbc84c76b3c924e49022681a5d16ab6d28c`.
- Common bundle SHA256: `01a701e40cc0fc68796b19f6987ce1f0bc25b6fe6124de298787ebc5366d679c`.
- Bundle source provenance is in the earlier JSC capability evidence.
- Prepared scripts and checksums: `wk-parser-control-preparation.tar.gz` and
  `wk-parser-control-preparation-manifest.json`.

Next action: coordinator schedules a quiet window of at most five minutes, after
other owners acknowledge and host/guest contention is checked. Then run only:

```sh
cua sandbox exec local:tx-queue-232 \
  'python3 /tmp/tx232-wk-parser-control/run.py'
```

Retain both modes, failures and raw samples; no retry selected for a better number.
Release the reservation immediately after both bounded processes finish. No
reservation is currently held, and no user/product decision is needed.
