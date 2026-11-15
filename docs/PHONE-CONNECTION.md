# Phone connection: keep-alive, fast reconnect and encrypted push

Research report for issue #989. Nothing here is shipped code. It brings
together three pieces, each with its own detail and citations:

- [How the phone connection works today](./phone-connection/connection-path.md):
  the keep-alive that already exists, every idle timeout on the path, the
  cold-start steps, and whether a resumption ticket is worth it.
- [Measured on a real iPhone](./phone-connection/measurements.md): cold start,
  warm return, drops and idle runs, with the raw marks in
  [`phone-connection/data/`](./phone-connection/data/) and the patches and
  scripts that took them in
  [`phone-connection/measurement-patch/`](./phone-connection/measurement-patch/).
- [End-to-end encrypted Apple push](./phone-connection/push-design.md): the
  design, the relay API, the full who-sees-what table and the Apple
  requirements.

All numbers below come from an iPhone 17 Pro Max on iOS 26.6.2, running a
Release build of main with the measurement patches, on home Wi-Fi, with n = 12
per case unless a row says otherwise. Medians first, p90 in brackets.

## Answers in short

| Question | Answer |
| --- | --- |
| Battery cost of a foreground keep-alive | **Not measured.** Instruments cannot record the phone over Wi-Fi, and the person chose to skip the on-phone trace runs. See [What was not measured](#what-was-not-measured). |
| Best keep-alive interval | **Keep 30 s, foreground only, as one end-to-end request; send nothing in the background.** The range 25 to 45 s stays under every idle timeout on the path (home NAT as low as 60 s, Cloudflare 100 s, the Bun cell 120 s). The idle runs could not separate 20, 30 and 45 s, because the connection dropped every few seconds at all of them for an unrelated reason. Fix that first. |
| Cold start, direct (LAN) | 1609 ms (1759). Already under the 2 s target. |
| Cold start, relay | 7406 ms (7707). 3.7 times the 2 s target. |
| Warm return, direct | Connection kept: the resume probe takes 488 ms (1016). Connection lost in the background: back in 251 ms (355). Both under 1 s at the median; the probe's p90 is not. |
| Warm return, relay | Not measured as a return. Reconnects after a drop in the idle runs took 3.5 to 5.0 s (median per run). |
| Resumption ticket | **Not first.** It saves one E2EE round trip (about 350 ms over the relay) at the cost of a replayable first flight. The serial steps below are larger and touch no protocol. |
| Encrypted push | HPKE Auth from a per-phone Mac sender key to a phone push key that is readable after first unlock. A Notification Service Extension opens it with CryptoKit. The relay holds only the APNs token and two relay ids. Every push has the same size, headers and placeholder. |

## Keep-alive

What runs today: while the app is in the foreground, the phone sends an
encrypted `pairing.getEndpoints` every 30 s and closes the connection if no
answer comes within 5 s (`mobile/src/transport/connection.ts:509`,
`mobile/src/transport/connection.ts:543-547`). It travels phone, relay, Mac, so
it keeps every leg busy and also proves the Mac is still there. WebSocket ping
frames would not: the cell answers them itself.

Timeouts it has to beat, shortest first:

| Where | Idle timeout |
| --- | --- |
| Home router NAT | 60 s at worst in published measurements, often about 4 min |
| Cloudflare, only if it ever proxies the cell | 100 s |
| The Bun cell's WebSocket | 120 s |
| Carrier NAT | 255 s at worst |
| nginx | 3600 s |

Measured, 10 minutes idle per run on the relay path, app on the Settings tab,
which has no timer of its own, so the keep-alive was the only planned traffic:

| Keep-alive | Drops | 1001 / 4408 | Longest connection | Timer keep-alives answered | Reconnect, median (p90) |
| --- | --- | --- | --- | --- | --- |
| none | 13 | 13 / 0 | 29 s | 0 / 0 | 3455 ms (4812) |
| 20 s | 18 | 16 / 2 | 189 s | 18 / 18 | 4392 ms (16470) |
| 30 s | 34 | 33 / 1 | 134 s | 5 / 5 | 4409 ms (7948) |
| 45 s | 25 | 23 / 2 | 129 s | 4 / 4 | 4989 ms (5876) |

Every keep-alive that was sent was answered. The drops are a WebSocket close
1001 "Stream end encountered" that arrives seconds after connecting, at every
interval, on the direct path too (3 of 13 direct and 3 of 12 relay cold
launches). The keep-alive does not cause them and cannot prevent them, and
while they happen no connection lives long enough to reach a NAT timeout. So:

- **Interval:** keep 30 s. It is under the worst home NAT, and with one keep-alive
  lost it still stays under the Cloudflare and cell limits. Shorter intervals buy no margin
  against any listed timeout, only more radio wake-ups.
- **Payload:** replace `pairing.getEndpoints` with a no-op request. Today every
  keep-alive makes the Mac enumerate its network interfaces and the phone write
  the stored host (`src-tauri/src/pairing/mod.rs:1372-1432`,
  `mobile/src/transport/connection.ts:550-554`).
- **Background:** send nothing. iOS suspends the app; the warm-return path
  below handles the reconnect.
- **Battery:** the radio's high-power tail after each exchange costs more than
  the bytes, so the interval is the variable to measure. That waits for the
  drop fix (follow-up 1) and a way to record energy (follow-up 9).

## Fast reconnect

### Cold start over the relay, where the 7.4 s goes

| Step | Median ms | p90 ms | What could change |
| --- | --- | --- | --- |
| Launch to root render (three steps) | 127 | – | nothing large |
| Account check done to `getInitialURL` | 381 | 385 | unexplained; find it (follow-up 6) |
| Director `/v1/resolve` | 452 | 472 | dial the saved cell at the same time (follow-up 4) |
| WSS open to the cell (TCP and TLS) | 769 | 846 | none without a nearer cell |
| Relay socket open to `relay-hello` (the Mac opens a new data socket to the cell) | 1262 | 1474 | a warm spare data socket on the Mac, relay change (follow-up 5) |
| Two E2EE round trips | 712 | – | a ticket would save one (not first) |
| Resume confirmation (`pairing.getEndpoints`) | 724 | 826 | mark usable first, confirm in parallel (follow-up 4) |
| `sync.capabilities` | 465 | 577 | cache per Mac (follow-up 3) |
| `sessions.summaries` (87 sessions) | 2252 | 2400 | show the cached list at once, refresh with its `version` (follow-up 3) |
| **Total, launch to list rendered** | **7406** | **7707** | |

Medians of steps that are added up are sums of per-step medians; their p90 is left out because p90s do not add.

The direct path skips the director, the cell and the confirmation, which is
why it lands at 1609 ms; there `sessions.summaries` (748 ms) and the 370 ms
before `getInitialURL` are the two large steps left.

**Can the relay reach 2 s cold?** Only with all of follow-ups 3, 4 and 5. Taking
out the director wait, the Mac's socket setup, the confirmation, the
capabilities round trip, the summaries wait and the `getInitialURL` gap
removes about 5.5 s of median, which leaves about 1.9 s. That is arithmetic on
the medians above, not a measurement, and it assumes the cached list counts as
the first screen with a refresh behind it. Without the relay change
(follow-up 5) the floor is nearer 3.1 s.

**Can the direct path go further?** Showing the cached session list at once
(follow-up 3) and removing the `getInitialURL` gap would put a full screen up
in well under 1 s, with the live list about 0.8 s later.

### Warm return

| Case | n | Median ms | p90 ms |
| --- | --- | --- | --- |
| Direct, connection kept: resume probe round trip | 8 | 488 | 1016 |
| Direct, connection lost in the background: back to connected | 4 | 251 | 355 |

- The app already keeps the screen, probes once with a 1.5 s limit, and waits up
  to 1 s before it shows "reconnecting" (`mobile/src/transport/connection.ts:25-30`).
- A fresh direct reconnect (251 ms) beat probing a kept one (488 ms).
- The 1.5 s probe limit is tight: direct p90 1016 ms, and over the relay one
  probe on a live connection took 1521 ms and was taken for dead (follow-up 7).
- Warm return over the relay was not measured. Given the reconnect times in the
  idle runs (3.5 to 5.0 s), it misses the 1 s target until follow-ups 1, 4 and 5
  land.

### Resumption ticket

A ticket issued after `e2ee_authenticated` would let the phone send
`e2ee_auth` and a first read together with `e2ee_hello`. It keeps approval,
fingerprint, revoke and disconnect as they are if the Mac checks the device
entry on every use and drops tickets on revoke, sign-out and binding change. It
adds one new risk: the first flight can be replayed by the relay, so it may
carry only reads (`session.sync`, `sessions.summaries`, `sync.capabilities`),
never sends, approvals or answers. It saves about one of the two E2EE round
trips (348 to 364 ms over the relay). Do it only if the E2EE round trips are
still a large share after follow-ups 3 to 5 (follow-up 15).

## End-to-end encrypted push

The full design, sequence and relay API are in
[push-design.md](./phone-connection/push-design.md). In short:

- **Keys.** The phone makes a push-only key pair whose private half is readable
  after first unlock, so the extension can use it on a locked phone. The
  transport key stays unlocked-only. The Mac makes a separate push sender key
  per phone and seals with HPKE Auth mode, so the extension knows which Mac
  sent it. The Mac's host key is not reused.
- **Path.** Mac seals, sends the sealed bytes to the relay over its existing
  control socket, the relay posts them to APNs, the Notification Service
  Extension opens them with CryptoKit and writes the real text. If it cannot,
  the person sees the placeholder.
- **Shape.** Every push is identical outside the encryption: the same headers,
  a padded ciphertext of a fixed 2795 characters, the placeholder "TerminalX /
  New activity on your Mac", no `apns-collapse-id`, no category, no thread id.
- **Relay state.** Per registration: APNs token, environment, `relayHostId`,
  `relayDeviceId`. No keys, text, names or account.
- **Replays.** Each push carries a `pushSeq` counter that the Mac keeps per
  phone and stores across restarts. The extension accepts each value once,
  within a 64-value window for out-of-order delivery, and only with a `sentAt`
  in the last 24 hours. Today's `(epoch, seq)` watermark is not enough: the
  epoch changes at every Mac restart, so the relay could replay an old question
  with live buttons after one.
- **Choices.** The #990 choices are kept on the Mac per device while push is on;
  the Mac filters before sending, the phone applies the lock screen level.
- **Answers.** Approve, Deny and question options ask iOS to unlock first, then
  the app answers over the normal E2EE connection. Nothing the relay holds can
  forge an answer.
- **Privacy mode.** The Mac sends nothing and queues nothing.
- **Not covered:** a phone paired "Only this network" has no relay credential,
  so it gets live notices only while the app is open.

### Who can see what

"Sealed push" means: the relay sees the time, `relayHostId`, `relayDeviceId`
and the fixed-size ciphertext; Apple sees the time, device token, bundle id,
fixed headers, the placeholder and the same ciphertext. Neither sees the kind
of event, its text or the lock screen level.

| Event | Phone | Mac | Relay | Apple |
| --- | --- | --- | --- | --- |
| Register | Its APNs token, push key pair, choices, the Mac's push sender public key | Phone's push public key and choices (inside E2EE); makes the sender key; never the APNs token | APNs token, environment, `relayHostId`, `relayDeviceId` | Token and bundle id, as for any app |
| Question, approval | Text and options after decrypting, as the lock screen level allows | All of it | Sealed push | Sealed push |
| Finished, failed, usage limit | Session name and summary, error or limit, as the lock screen level allows | All of it | Sealed push | Sealed push |
| PR checks failed, PR merged | Session name, pull request and check, as the lock screen level allows | All of it | Sealed push | Sealed push |
| Closed ids on a later push | Which requests closed; removes them | All of it | Sealed push only | Sealed push only |
| Answer from the notification | The answer | The answer, checked as today | E2EE frames and connection timing; not the answer or the request | Nothing |
| Push key rotation | New key pair | New push public key (inside E2EE) | Nothing | Nothing |
| Filtered out by a choice | Nothing | The event | Nothing | Nothing |
| Privacy mode on | Nothing | The event | Nothing | Nothing |
| "Only this network" pairing | Live notices while open | All of it | Nothing | Nothing |
| Unregister or revoke | Its choice | Push record and sender key deleted | Registration deleted | Nothing new |

What is left is metadata: the relay and Apple learn that a Mac pushed to a
phone at a given time and how often, and the relay can see the phone connect
soon after a push. They cannot tell which kind of event it was or read any of
it.

## What was not measured

| Item | Why |
| --- | --- |
| Battery cost at any interval | `xctrace` cannot record the phone over Wi-Fi ("Timed out waiting for device to boot"; the phone has no cable link). The first on-phone Performance Trace run recorded nothing, and the person then chose to skip battery runs. With the drops above, a battery run would mostly measure reconnects. |
| Mobile data | All runs were on home Wi-Fi. |
| Warm return over the relay | Only the direct path was measured for warm return. |
| Transcript and terminal screens | Cold and warm runs ended on the sessions list, which polls every 10 s on its own (`mobile/app/(tabs)/sessions.tsx:36-38`); idle runs used the Settings tab. The transcript (15 s re-read) and the terminal were not run. |
| Home router NAT idle timeout | No relay connection lived past 189 s, so no NAT cut could show. |
| Cause of the 1001 drops | Found and counted, not explained. |

The no-keep-alive idle run (17:02) was taken in a different hour from the 20,
30 and 45 s runs (19:21 to 19:52). The drops came and went within each run,
so the runs are not a clean comparison of intervals.

## Follow-up issues

Sizes: S is a day or two, M up to a week, L more.

| # | Issue | Size | Source |
| --- | --- | --- | --- |
| 1 | Find and fix the 1001 "Stream end encountered" closes seconds after connecting, on both paths and in the background. iOS reports this close when it ends the stream itself, and it happens with both far ends (Mac and cell), so start on the phone | M | measurements |
| 2 | Replace the keep-alive's `pairing.getEndpoints` with a no-op request; refresh addresses less often | S | connection path |
| 3 | Cache `sync.capabilities` and the session list per Mac; show the cached list at once and refresh with its `version` in one request | M | both |
| 4 | Relay cold start: dial the saved cell while the director answers, mark the connection usable before the resume confirmation, and drop the awaited storage writes and the second `getEndpoints` | S | both |
| 5 | Relay: let the Mac keep a warm spare data socket (or multiplex over the control socket) so a phone does not wait for the Mac's TLS setup (relay server change) | L | both |
| 6 | Find the 370 ms between the account check and `getInitialURL`, and run the account check in parallel with the connect | S | both |
| 7 | Raise the 1.5 s resume probe limit, or reconnect fresh on the direct path instead of probing | S | measurements |
| 8 | Measure the home router NAT idle timeout once 1 is fixed: relay idle runs with no keep-alive and 2, 4 and 8 min of quiet | S | measurements |
| 9 | Measure the keep-alive's battery cost once 1 is fixed: cable link or on-phone Performance Trace, Settings tab, none against 30 s | M | measurements |
| 10 | Relay push endpoints: register, unregister, `push-send`, `push-status`, APNs HTTP/2 client with token auth, 410 cleanup, rate limits (relay server) | L | push |
| 11 | Mac push sender: `push.register`, choices per device, filter, HPKE Auth seal with padding, sender key per phone with a persisted `pushSeq` counter, privacy gate, closed ids | M | push |
| 12 | Notification Service Extension and Expo config plugin: CryptoKit HPKE Auth opener with Rust test vectors, `pushSeq` replay window and `sentAt` bound, shared keychain and app group, lock screen levels | M | push |
| 13 | Phone push registration: push key, device token, relay register, `push.register` per Mac, "needs TerminalX Relay" state | M | push |
| 14 | Answer from the notification: categories, actions that need unlock, background connect and answer (after #979 and #990) | M | push |
| 15 | Resumption ticket for 0-RTT reads, only if E2EE round trips still matter after 3 to 5 | M | connection path |
| 16 | Spikes: what the extension may set and remove on a device; whether Expo runs JS for a background action and for how long | S | push |
| 17 | Apple: request the notification filtering entitlement; App Store notes and export compliance for the extension (owner) | S | push |
| 18 | Amend #990: with push on, the Mac keeps the choices per device | S | push |
