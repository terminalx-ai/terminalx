# Phone connection: measured on a real iPhone

Part of issue #989. This note holds measured numbers only. Every number below
comes from a raw file under `data/`, and the summary files next to them were
produced from those raw files by `measurement-patch/analyze.py`. Anything not
measured is marked "not measured" with the reason.

Status: cold start, warm return and the drops while connected are measured.
Battery cost is not measured: the person chose to skip the battery runs. The
idle survival runs (10 minutes each at none, 20 s, 30 s and 45 s) are measured.
Not measured: battery cost, mobile data, warm return over the relay, and the
streaming transcript and terminal screens.

## Method

| What | Value |
| --- | --- |
| Phone | iPhone 17 Pro Max (iPhone18,2), iOS 26.6.2 |
| App build | Release configuration, built with Xcode 26.6 (17F113) from main at `5b747503`, plus the throwaway patches in `measurement-patch/`. Installed with `xcrun devicectl device install app`. No Metro, no dev client. |
| Mac | TerminalX desktop 0.2.32, on the same home Wi-Fi as the phone |
| Phone to Mac link | CoreDevice over Wi-Fi only, no cable |
| Network | Home Wi-Fi behind a home router. "Direct" is the phone's LAN socket to the Mac. "Relay" is the pairing's saved relay cell, reached from the same Wi-Fi. |
| Account and data | One signed-in account, two saved Macs, 87 sessions in the list |
| Date | 2026-11-15 |

How the numbers were taken:

- `measurement-patch/js-marks.patch` adds a `mark(name)` call at each step of
  the cold-start path listed in `connection-path.md` (section 3, and its
  "Timing marks" list). Each mark records `Date.now()` and `performance.now()`.
  The marks go to a JSONL file in the app's Documents folder, one file per
  launch. They are pulled with
  `xcrun devicectl device copy from --domain-type appDataContainer`.
  A Release build drops `console.log`, so a file was used rather than os_log.
- `measurement-patch/native-start-stamp.patch` stamps the process start time
  (from `sysctl` `kp_proc.p_starttime`) and the `didFinishLaunching` time into
  NSUserDefaults, before React Native starts. The first mark reads both.
- Launch arguments set each run's options without a rebuild:
  `-TXRunId <name>`, `-TXKeepAliveMs <ms>` (0 turns the keep-alive off; it
  replaces today's fixed 30 s at `mobile/src/transport/connection.ts:188` and
  `:509`), and `-TXNoDirect 1` (skip the LAN paths, so the relay path can be
  measured on the home Wi-Fi).
- Cold start: `xcrun devicectl device process launch --terminate-existing`,
  then a 20 s wait, repeated. Each launch is a new process. iOS prewarming does
  not apply to a launch from devicectl.
- Warm return: the app is sent to the background by launching Settings, left
  there 30 s, then brought back with `devicectl device process launch`
  (no terminate). This was repeated 12 times in one process.
- Percentiles: median, and p90 by nearest rank (the ceil(0.9 n)-th smallest
  value). With n = 12, p90 is the 11th smallest value.

## Cold start, launch to the sessions list

Each row is the time from the previous point to this point, in milliseconds.
"Current content" here is the first render of a non-empty sessions list
(`18.list-rendered`).

### Direct path (LAN), n = 12

Raw: `data/cold-direct/cold-01.jsonl` to `cold-12.jsonl`.
Summary: `data/cold-direct.summary.txt`. The direct path won all 12 races.

| Step | n | median ms | p90 ms |
| --- | --- | --- | --- |
| process start -> didFinishLaunching | 12 | 37 | 46 |
| didFinishLaunching -> JS module eval | 12 | 46 | 47 |
| JS module eval -> root render | 12 | 68 | 101 |
| root render -> storage read done | 12 | 27 | 31 |
| storage read done -> account check done | 12 | 0 | 0 |
| account check done -> initial URL | 12 | 370 | 381 |
| initial URL -> credential read | 12 | 8 | 8 |
| credential read -> E2EE key loaded | 12 | 8 | 8 |
| E2EE key loaded -> race start | 12 | 0 | 0 |
| race start -> first socket open | 12 | 36 | 90 |
| first socket open -> e2ee_ready | 12 | 62 | 162 |
| e2ee_ready -> e2ee_authenticated | 12 | 23 | 155 |
| e2ee_authenticated -> connected | 12 | 0 | 1 |
| connected -> storage writes done | 12 | 9 | 19 |
| storage writes done -> capabilities answered | 12 | 32 | 155 |
| capabilities answered -> summaries answered | 12 | 748 | 890 |
| summaries answered -> list rendered | 12 | 17 | 20 |
| **total: process start -> list rendered** | 12 | **1609** | **1759** |

### Relay path (direct paths skipped), n = 12

Raw: `data/cold-relay/relay-cold-08.jsonl` to `relay-cold-19.jsonl`.
Summary: `data/cold-relay.summary.txt`. The relay path won all 12 (it was the
only path).

| Step | n | median ms | p90 ms |
| --- | --- | --- | --- |
| process start -> didFinishLaunching | 12 | 40 | 48 |
| didFinishLaunching -> JS module eval | 12 | 44 | 46 |
| JS module eval -> root render | 12 | 43 | 44 |
| root render -> storage read done | 12 | 30 | 32 |
| storage read done -> account check done | 12 | 0 | 0 |
| account check done -> initial URL | 12 | 381 | 385 |
| initial URL -> credential read | 12 | 8 | 11 |
| credential read -> E2EE key loaded | 12 | 8 | 8 |
| E2EE key loaded -> race start | 12 | 0 | 1 |
| race start -> relay socket open | 12 | 1254 | 1349 |
| relay socket open -> relay hello | 12 | 1262 | 1474 |
| relay hello -> e2ee_ready | 12 | 364 | 443 |
| e2ee_ready -> e2ee_authenticated | 12 | 348 | 461 |
| e2ee_authenticated -> connected (resume confirmation) | 12 | 724 | 826 |
| connected -> storage writes done | 12 | 28 | 30 |
| storage writes done -> capabilities answered | 12 | 465 | 577 |
| capabilities answered -> summaries answered | 12 | 2252 | 2400 |
| summaries answered -> list rendered | 12 | 16 | 22 |
| **total: process start -> list rendered** | 12 | **7406** | **7707** |

"race start -> relay socket open" splits into two serial parts, computed from
the `09r1.resolve.*` and `09s.socket-*` marks in the same 12 files:

| Part | n | median ms | p90 ms |
| --- | --- | --- | --- |
| director `/v1/resolve` POST (`connection.ts` `resolveRelay`) | 12 | 452 | 472 |
| WSS socket create -> open (TCP and TLS to the cell) | 12 | 769 | 846 |

What the cold-start numbers show:

- **Over the relay, about 4.0 s of the 7.4 s is the connection before
  `connected`** (race start to connected: the sum of the five median rows,
  1254 + 1262 + 364 + 348 + 724 = 3952 ms). The single
  largest step is "relay socket open -> relay hello", 1262 ms. That is the
  cell checking the credential and the Mac opening a new TLS data socket to
  the cell (`connection-path.md` steps 9r.3 to 9r.5).
- **`sessions.summaries` is the largest single step on both paths**: 748 ms
  direct, 2252 ms relay, for 87 sessions. It is also serial behind
  `sync.capabilities`.
- The resume confirmation (`e2ee_authenticated -> connected`, relay only)
  costs 724 ms. `connection-path.md` step 14 says it could run in parallel.
- The director lookup (452 ms) runs before the socket is opened. Dialling the
  saved cell at the same time would overlap it (`connection-path.md` step 9r.1).
- About 370 to 380 ms pass between the account check and the
  `Linking.getInitialURL()` answer on every launch. The marks do not separate
  the native call from the React work that `setSession` and `setHosts` start
  just before it (`mobile/src/state/AppProvider.tsx`, startup effect). Not
  measured: which of the two it is.
- The account token was fresh on all 24 launches (`status: "fresh"`). The
  network refresh path (step 3) was seen once, on the smoke launch
  (`data/smoke/smoke-1.jsonl`: 476 ms, `status: "refreshed"`). It is not part
  of the tables, because n = 1.
- In 7 earlier relay launches (`relay-cold-01` to `-07`),
  `devicectl device process launch` exited 1 and the app wrote no marks. Its
  error text was not captured. The 12 reruns all launched (exit 0). Those 7
  launches are not in the tables.

## Warm return from the background, n = 12

Raw: `data/warm/warm-30s.jsonl` (one process, 12 returns after 30 s in the
background each, keep-alive 30 s). Summary: `data/warm.summary.txt`.

| Case | n | median ms | p90 ms |
| --- | --- | --- | --- |
| Connection kept: resume probe (`pairing.getEndpoints`, 1.5 s limit) round trip | 8 | 488 | 1016 |
| Connection lost in the background: foreground -> reconnected (`14.connected`) | 4 | 251 | 355 |

- In 4 of 12 returns the direct socket had been closed while the app was in
  the background (`conn.lost` with `backgrounded: true`, close 1001 "Stream
  end encountered"). The phone saw the close about 0.4 s before the
  foreground mark, as iOS resumed the app.
- None of the 8 resume probes failed. But the p90 of 1016 ms is close to the
  1.5 s limit (`RESUME_PROBE_MS`), and a slower probe would have been taken
  for dead.
- A fresh direct reconnect (251 ms) was faster than probing a kept connection
  (488 ms median).
- The warm returns were measured on the direct path only. Warm return over the
  relay: not measured yet.

## Drops while connected

Raw: `data/smoke/smoke-1.jsonl`, `data/cold-direct/*.jsonl`,
`data/cold-relay/*.jsonl`, `data/warm/warm-30s.jsonl`. Summary for the smoke run:
`data/smoke.summary.txt`.

- On the smoke launch, the direct connection closed 3 s, 6 s and 30 s after
  connecting, each time with `relay_outer_1001 (reason "Stream end
  encountered", not clean)`. The phone was connected again 1.2 s, 0.4 s and
  0.1 s later (`conn.lost` to the next `09.winner`). After the third drop it
  held for the rest of the 1.7 min run.
- In the cold runs, `cold-01` dropped after 1.2 s and 14.5 s, and `cold-02`
  after 3.4 s. The other 10 launches had no drop within their 20 s.
- In the relay cold runs, 3 of 12 launches dropped, 5 times in all, with the
  same close: `relay-cold-10` after 10.9 s, `relay-cold-12` after 3.3 s,
  2.5 s and 7.6 s, and `relay-cold-17` after 15.1 s. So the drop is not
  specific to the direct path.
- In the warm run, one drop happened in the foreground after 161 s connected.
- The cause is not measured here. A 1001 close is "going away" from the far
  end, so the Mac is the first place to look. It is listed as a follow-up.

## Battery cost of the keep-alive

Status: **not measured, by the person's choice.** No battery or energy number
in this note.

What happened:

- The plan was one hour per run, screen on, for keep-alive none (baseline),
  20 s, 30 s and 45 s, on three screens: 12 runs, about 13 hours with the
  switchovers.
- Instruments on the Mac could not record the phone over Wi-Fi (the phone has
  no cable link):
  - `xcrun xctrace record --template 'Power Profiler' --device <ECID> --attach TerminalX --time-limit 10s`
    failed with "Timed out waiting for device to boot" (exit 13).
    `xctrace list devices` lists the phone under "Devices Offline", while
    `devicectl` shows it connected.
  - `--all-processes` instead recorded the Mac, for 0 s, with
    "Location Energy Model cannot handle a target type of 'All Processes'"
    (exit 2).
  - With the CoreDevice identifier, xctrace said "No devices found" (exit 1).
- The fallback was the phone's own Performance Trace (Settings > Developer),
  started by the person, then AirDropped and read with `xctrace export`
  (xctrace 16.0 on this Mac has the Power Profiler template).
- The first try launched run 1 (sessions list, keep-alive off) at 15:24. At
  16:55 the person checked the phone: no trace was recording. So run 1 gave no
  energy data. Its marks file holds only the first 3 s after launch and is not
  used here.
- The person was then asked to pick a design: the full 12 hours, 4 runs of
  15 min on the terminal view, 2 runs of 30 min (none against 30 s), or no
  battery runs. The person chose no battery runs.

What a later measurement should keep in mind:

- The sessions list asks the Mac for `sessions.summaries` every 10 s while it
  is on screen (`mobile/app/(tabs)/sessions.tsx:36-38`), and an open
  transcript re-reads every 15 s (`mobile/src/data/transcript-sync.ts:198`).
  On those screens the keep-alive is not the only traffic. The Settings tab
  has no timer of its own.
- The measurement build's own file flush runs every 2 s and returns at once
  when there is nothing new (`measurement-patch/js-marks.patch`,
  `mobile/src/measure/marks.ts`). It would be the same in every run.
- With the connection dropping as often as the next section shows, a battery
  run would mostly measure reconnects, not the keep-alive.

## Does the connection survive each interval idle?

Status: **measured** for none, 20 s, 30 s and 45 s, 10 minutes each, on the
relay path. A first attempt at 17:13 stopped when the phone went "unavailable"
in `devicectl list devices` ("CoreDeviceService was unable to locate a device",
error 1011); the four runs below were taken later on the same build, 19:21 to
19:52 for 20 s, 30 s and 45 s. The script exits on the first failed step, so a
run in the table finished every step.

Method: relay path (`-TXNoDirect 1`), home Wi-Fi, Release build, screen on,
app on the Settings tab (no timer of its own), opened by launching with
`--payload-url terminalx://settings`. Each launch is fresh
(`--terminate-existing`). After the idle window the app goes to the background
for 3 s (Settings is launched) and comes back, so the app's resume probe
(`pairing.getEndpoints`, 1.5 s limit, `mobile/src/transport/connection.ts:28`)
tests the old connection end to end. Script: `measurement-patch/idle-test.sh`.
Summary: `measurement-patch/analyze.py idle`.

10-minute runs, raw `data/idle/idle-relay-0s.jsonl`, `idle-relay-20s.jsonl`,
`idle-relay-30s.jsonl` and `idle-relay-45s.jsonl`, summary
`data/idle.summary.txt`:

| keep-alive | span min | connects | drops (1001 / 4408) | connected before drop, median s | p90 s | max s | keep-alives sent / answered | reconnect median ms | p90 ms | probe at the end |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 10.4 | 14 | 13 (13 / 0) | 13 | 27 | 29 | 0 / 0 | 3455 | 4812 | answered in 1426 ms |
| 20 s | 10.5 | 19 | 18 (16 / 2) | 7 | 86 | 189 | 18 / 18 | 4392 | 16470 | answered in 535 ms |
| 30 s | 10.4 | 34 | 34 (33 / 1) | 6 | 22 | 134 | 5 / 5 | 4409 | 7948 | already down at return |
| 45 s | 10.4 | 26 | 25 (23 / 2) | 10 | 49 | 129 | 4 / 4 | 4989 | 5876 | already down at return |

- At every interval the relay connection dropped every few seconds to a few
  minutes: 13 to 34 drops in about 10 minutes, almost all with 1001 "Stream end
  encountered". No interval kept a connection up for the whole run.
- Every keep-alive that was sent got an answer (27 of 27). The drops are not
  idle timeouts: the median connection ended after 6 to 13 s, long before the
  first 20 s keep-alive and the 60 s and longer timeouts in `connection-path.md`.
- The longest connections came with a keep-alive (189 s at 20 s, 134 s at
  30 s, 129 s at 45 s, against 29 s with none). With one 10-minute run per
  interval, that is not enough to rank the intervals.
- Reconnecting took 3.5 to 5.0 s (median) over the relay, with a p90 up to
  16.5 s at 20 s.
- So on this path the 1001 drops, not the keep-alive interval, decide how long
  a connection lives. Fixing the drops comes before choosing an interval.

- With no keep-alive, the relay connection did not stay up for longer than
  29 s once in 10.4 minutes. It dropped 13 times, every time with 1001
  "Stream end encountered", and came back in 3.5 s (median). So on this path
  today the drops, not an idle timeout, decide how long a connection lives.
- The end probe answered in 1426 ms, under the 1.5 s limit by 74 ms.

Dry run, 20 s idle per interval (about 0.8 min per launch), raw
`data/idle-dry/*.jsonl`, summary `data/idle-dry.summary.txt`:

| keep-alive | connects | drops (1001 / 4408) | connected before drop, median s | max s | probe at the end |
| --- | --- | --- | --- | --- | --- |
| none | 4 | 3 (3 / 0) | 8 | 8 | already down at return |
| 20 s | 4 | 3 (2 / 1) | 11 | 15 | answered in 321 ms |
| 30 s | 4 | 3 (2 / 1) | 8 | 18 | answered in 1507 ms |
| 45 s | 3 | 2 (2 / 0) | 3 | 4 | no answer in 1.5 s |

- In this dry run the relay connection never lasted longer than 18 s, at any
  interval, so no keep-alive timer fired before a drop. The drops come long
  before any router or relay idle timeout (60 s and up, `connection-path.md`).
- 4408 is the relay's "peer dropped" close: the Mac's leg ended. 1001 "Stream
  end encountered" is iOS ending the stream (`mobile/src/transport/relay-client.ts:24-31`).
- The 45 s run's resume probe got no answer in 1.5 s on a live connection, and
  the 30 s run's probe took 1507 ms. Relay round trips here were 345 to
  692 ms per keep-alive answer. The 1.5 s limit is tight for the relay.

## Follow-up issues found so far

1. The connection closes with 1001 "Stream end encountered" seconds after
   connecting, on both paths: 3 of 13 direct launches and 3 of 12 relay
   launches. The direct socket also closed in the background on 4 of 12
   returns. Find which side closes it and why.
2. `sessions.summaries` is the largest cold-start step (748 ms direct, 2252 ms
   relay, 87 sessions). Cache the list per Mac and send the cached version,
   and do not wait for `sync.capabilities` first.
3. Over the relay, overlap the director lookup (452 ms) with dialling the
   saved cell, and run the resume confirmation (724 ms) in parallel with
   marking the connection usable.
4. Find what the 370 ms between the account check and `getInitialURL` is.
5. The resume probe's p90 (1016 ms) sits close to its 1.5 s limit.
