# Mobile pairing investigation (#163)

## Confirmed locally

The scanner UI could invoke `pairCode` twice when native barcode callbacks arrived
before React committed its busy state. A failed scan also left detection disabled
after closing and reopening the sheet. The component tests reproduced both before
the fix. They do not establish the cause of the reported manual-code failure.

The sheet now guards QR, manual and retry submissions synchronously. It pauses a
failed QR until **Scan again**, **Use QR code**, or **Scan** is selected. Reopening
clears the old code and rearms detection. Closing and switching input modes are
disabled during submission. The camera unmounts when the sheet closes; restarting
or rearming it creates a new camera instance.

Locked dependencies inspected: app package version 0.1.0, Expo 57.0.19,
React Native 0.86.3 and Expo Camera 57.0.4. These are checkout versions, not a
verified installed phone build. In this Expo Camera version, `autofocus="off"`
maps to iOS `continuousAutoFocus`; `"on"` focuses once and locks. Continuous focus
was already the default. The explicit setting preserves it and is not evidence
that the reported autofocus problem is resolved. See the
[Expo Camera FocusMode reference](https://docs.expo.dev/versions/latest/sdk/camera/#focusmode)
and the locked package's `ios/Current/CameraEnums.swift`.

## Shared pairing flow and diagnostics

QR links and bare manual codes run through the same parser and pairing operation.
Tests cover both forms with simulated direct and relay peers, credential install
reconciliation, saving the host and resume credential, and recovery after a host
storage failure. Separate transport tests exercise the real mobile encryption
and RelayClient against an in-memory peer: direct, relay invite, relay resume,
status and session-list RPCs. They do not contact a production relay or desktop.

Failures now display an allowlisted diagnostic suffix and recovery instructions:

| Stage | Safe category | Next action |
| --- | --- | --- |
| parsing | invalid-offer / expired-offer | Generate and copy a fresh offer; check clocks for repeated expiry |
| transport | connection-failed / relay-rejected | Check connectivity; recover an interrupted attempt or use a fresh offer |
| host-verification | invalid-host | Update both apps and generate a fresh offer |
| credential-installation | credential-rejected | Retry to reconcile the journal; otherwise generate a fresh offer |
| persistence | save-failed | Unlock the phone and retry |

Transport covers socket connection and the encrypted handshake; host verification
covers the authenticated `status.get` response. A relay rejection can include its
numeric close/refusal code. It does not prove an invite was already used; expired,
used or otherwise refused offers must not be conflated without relay evidence.
Raw peer messages, schema details, storage errors, codes, addresses and secrets
are not included in these pairing error messages.

## Automated verification

- `pnpm --dir mobile test`
- `pnpm --dir mobile typecheck`
- `pnpm --dir mobile lint`

After integration with current main on 2026-09-28: **71 mobile tests across
15 files** pass, and mobile typechecking passes. Lint has only the existing
`import/first` warning in `transport/connection.test.ts:23`. The full root suite
passes **480 tests across 76 files**; desktop typechecking, Rust clippy with
warnings denied, and the full Rust test suite also pass locally.

Relevant tests: `pairing-screen.test.tsx`, `pairing-sheet.test.tsx`,
`pairing/parse.test.ts`, `pairing/pair.test.ts`,
`transport/relay-client.test.ts`, and desktop `DevicesTab.test.tsx`.

## QR rendering and guided scanner follow-up

Physical testing on 2026-09-16 used an **iPhone 17 Pro Max, iOS 26.6.2
(23G90)**. The current mobile bundle was verified as `com.terminalx.next.mobile`,
version **0.1.0**, first build **163**, then build **164** with guided scanning.
Both were standalone Release builds installed from this investigation's checkout.

The first observed build 163 attempt rejected an expired offer before transport.
A later fresh pasted code completed pairing, saved one host, and connected
directly on the same Wi-Fi. The user separately confirmed manual relay pairing
on a different network; no matching relay-path log was captured.

The small desktop QR looked sharp but produced no response. A user-supplied
image decoded offline through Apple Vision: QR version 24, **113 modules** and
**869 payload characters**. No image or decoded offer contents are included in
this record. The desktop compressed this into a fixed 220-pixel bitmap and a
132-CSS-pixel display, with only a two-module white margin. QR codes require a
[four-module quiet zone](https://www.qrcode.com/en/howto/code.html).

The desktop now uses a **320-CSS-pixel display**, **eight source pixels per
module**, and a **four-module margin**. Controls wrap below the QR as needed.
The user tested a fresh copied offer in a loopback-only preview using these
same settings and confirmed **“bigger QR worked”** and **“It completed the
pairing.”** That confirms physical decoding and pairing completion. Size,
resolution and margin changed together, so their individual effects were not
isolated. The phone was disconnected at the follow-up log read; this QR result
is user-confirmed, without an independently captured completion trace.

The mobile aiming rectangle was also incorrectly nested in `CameraView`, which
Expo does not support. Supported iPhones now use Apple's guided scanner through
Expo, with detection outlines, guidance and pinch-to-zoom. Other devices, or a
failed native scanner launch, use the embedded camera with continuous autofocus
and an aiming overlay rendered as a sibling. Duplicate detections, listener
cleanup, close/reopen, and failed-scan recovery retain the existing protections.
Physical focus after reopening and at specified distances is still unconfirmed.

The preview retained no offer on disk, disabled caching and logged no offer
contents; it was stopped and its temporary fixtures removed. A local desktop
app was built and signature-verified on 2026-09-28 before synchronizing this
branch with main. That build was not installed over the running desktop app.

PR integration preserves main's diagnostics and retry changes from #165 and
relay recovery work from #171. The new scope is QR rendering, guided scanning,
their regression coverage, and these physical validation results. The earlier
test phone builds predate this integration; they do not establish a physical
test of the final merged source.

## Physical validation

Use a fresh, unused desktop offer for every independent attempt. Record a UTC
start/end time, input form (QR/manual), intended/observed path (relay/direct),
phone model, OS, mobile app version/build and desktop version. Never record names,
account/device IDs, QR images, full links/codes, tokens, keys or private addresses.

| Check | Result |
| --- | --- |
| QR focuses at normal screen-scanning distance and decodes | Larger QR decoded and paired; exact distance not recorded |
| Focus and detection work after close/reopen and Restart camera | Pending physical phone |
| Fresh QR completes pairing while Relay is connected | Confirmed by user with larger rendering |
| Fresh manually pasted code completes pairing | Confirmed by user and build 163 completion log |
| Different-network pairing completes over relay | Manual pairing confirmed by user; QR not separately tested across networks |
| Nearby LAN pairing completes where supported | Direct connection confirmed by phone log |
| Failure allows Retry and a fresh scan/code without duplicate operations | Automated UI pass; physical pending |
| Invalid, expired and used offers allow recovery with a fresh offer | Expired rejection and fresh-code recovery observed; invalid/used physical cases pending |
| Host survives app restart and its sessions open | Host saved and retained after build replacement; cold restart/session access pending |

For QR, distinguish **no decode** from **decoded but pairing failed**. On failure,
record only the displayed safe diagnostic category/stage (and numeric relay code
if present). Correlate desktop/relay events within the UTC attempt window only
where redacted logs are available. No new production pairing trace was captured.
Remaining physical checks are listed explicitly above; do not infer them from
the automated suite or successful pairing alone.
