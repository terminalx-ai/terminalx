# Faithful matched pair: candidate memory acceptance FAIL

One sequential pair, no retries/variants. Exact builds and input hashes are in
[the build packet](../palette-build/README.md). Parent e3f898e8673bf158689cfd8a09c917ca3bd1c434;
candidate c378ada9dd75cd28f5e28cdf2ebed9374e16cd3f. No rebuild or product change.
Both result JSON files report complete=true with all five unchanged steps:
4 sessions, 50 shell terminals, 20 synthetic agent tabs, 200 switches, cleanup.

| Endpoint | Parent WebContent bytes | Parent growth | Candidate WebContent bytes | Candidate growth |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 213011392 | 0% | 219253632 | 0% |
| Shell churn | 375098816 | +76.0933% | 370150784 | +68.8231% |
| Agent churn | 385093056 | +80.7852% | 381275584 | +73.8970% |
| Switches | 393350592 | +84.6618% | 390270400 | +77.9995% |
| Cleanup | 365809024 | **+71.7321% FAIL** | 384388544 | **+75.3168% FAIL** |

Percentages use exact raw bytes, 100*(endpoint/baseline−1), without rounded MB,
subtraction, later samples, forced GC or adjusted thresholds. Neither arm meets
<=10% at switches or cleanup. The palette repair does not resolve acceptance.
This ONE pair is not a statistically meaningful regression or causal small-effect
estimate: candidate starts higher, peaks lower, and ends higher than parent.

## Execution, timing and cleanup

Guest local:terminalx-cua-macos, macOS26.5.2 build25F84, arm64, 4 vCPU /8 GiB.
New private roots from the earlier staging were reverified unchanged and unlaunched.
Both archive hashes, all 20 bundle regular files and deep/strict signatures passed
again. Explicit resource-owner handoffs preceded the start.

Reservation start 10:54:10.585788Z, original hard expiry 11:09:10.585788Z on 2026-10-25.
Both Watchers and #467 were notified before the first launch. No clock reset.

| Arm | App PID | Driver PID | Launch UTC | Driver start UTC | Driver finish UTC | Cleanup finish UTC | Total seconds |
| --- | ---: | ---: | --- | --- | --- | --- | ---: |
| Parent | 15602 | 15686 | 10:54:10.875716 | 10:54:51.744312 | 10:56:19.482044 | 10:56:20.190029 | 129.349 |
| Candidate | 22127 | 22206 | 10:56:51.232434 | 10:57:19.746263 | 10:58:44.514140 | 10:58:45.215626 | 113.985 |

Both drivers exited0; neither five-minute watchdog fired. Each app was terminated
by exact identity-checked TERM only AFTER its original final endpoint/status.
No child fixtures remained at cleanup; no KILL was needed. At10:59:16Z a fresh
exact-PID audit found both apps, both drivers and both supervisors 15599/22124 absent.
The early release was sent immediately after that audit/result extraction; exact
announcement timestamp is in release.json. No heavy hold remains. Only evidence
export followed release; no app or benchmark was restarted. Staged roots and all
other workers' artifacts/processes remain intact.

Both windows were verified foreground and 1000×640 before their workloads; raw page
reports stay visible/focused at 1000×640/DPR1. There was no UI action during either
workload, Inspector, private renderer preference or fallback. Both report 54 WebGL
contexts created, 0 failed, 0 lost. Startup screenshots document readiness, not terminal
glyph acceptance during measurement. No real account/provider/cloud workload ran;
the copied synthetic Claude fixture was used. Logs retain expected unavailable
model/account-refresh warnings, production relay disabled, and a startup warning
that old-helper permissions could not be removed. No helper was launched or consent
granted by this run.

Both arms end 70/70 tracked CHURN terminals collected, zero terminal instances,
panes, attachment/view counts, queued output, backend scrollback/unacked bytes and
running PTYs; no deletion leftovers. Counts are not rounded memory substitutes.
The four baseline terminals are not registered in soakClosed; do not equate70/70
with a complete heap census or proof that every internal buffer/renderer is dead.

## Environment limitations

The resource audit found no active heavy build/container/model workload. Host CPU
was 80.94%idle; normal host UI activity, memory compression and 100 swapins during
the audit interval are retained in host-before.txt. Guest audit was idle with no
swap activity. #439 reported no worker-started audio/model/build work; human manual
mic activity was unobserved, not certified absent. No host GUI/system process was
controlled to improve these conditions.

Guest one-minute load: parent 1.369→6.415; candidate 3.264→4.563. The preceding arm
and this workload contribute to load; no adaptive inter-arm cooldown was inserted.
Readiness took 40.869s parent vs 28.514s candidate because of normal controller/GUI
verification latency; driver timings and fixed endpoint waits were unchanged.
This is scoped guest evidence, not quiet latency, physical-host parity or a
statistical estimate. The original +68.46% guest and +22.29% physical cleanup
failures remain preserved and separate; this run does not overwrite them.

## Validation and artifacts

Original raw results and lifecycle/log bundles are committed alongside this report.
Their hashes are in evidence-manifest.json; local full orchestration/readiness data
remain under /tmp/tx232-palette-execution-20261025. The offline parser reproduced the
old +68.46% failure and rejects incomplete, missing-agent and diagnostic-labelled
controls. Runtime source is unchanged, so no unchanged full test suite was rerun.
The prior four c378ada9 checks remain passed; this native acceptance check FAILED.
See [next-mechanism.md](next-mechanism.md) for bounded source follow-up, including
its evidence limits. No issue completion, merge or external publication is claimed.
