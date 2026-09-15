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

Local results: 67 tests passed across 14 files; typechecking passed. After the
final scanner lifecycle adjustment, all 5 scanner tests passed again. Lint passed
with one existing `import/first` warning in `transport/connection.test.ts:23`.

Relevant tests: `pairing-screen.test.tsx`, `pairing/parse.test.ts`,
`pairing/pair.test.ts`, and `transport/relay-client.test.ts`.

## Physical validation — pending

No physical QR/manual pairing or autofocus result is claimed. Local device
inventory lists paired phones, but their developer connections were unavailable
or disconnected. The reported installed app build, phone/OS and failure stage
remain unconfirmed. Automated checks are not substitutes for these criteria.

Use a fresh, unused desktop offer for every independent attempt. Record a UTC
start/end time, input form (QR/manual), intended/observed path (relay/direct),
phone model, OS, mobile app version/build and desktop version. Never record names,
account/device IDs, QR images, full links/codes, tokens, keys or private addresses.

| Check | Result |
| --- | --- |
| QR focuses at normal screen-scanning distance and decodes | Pending physical phone |
| Focus and detection work after close/reopen and Restart camera | Pending physical phone |
| Fresh QR completes pairing while Relay is connected | Pending physical phone |
| Fresh manually pasted code completes pairing | Pending physical phone |
| Different-network pairing completes over relay | Pending physical phone |
| Nearby LAN pairing completes where supported | Pending physical phone |
| Failure allows Retry and a fresh scan/code without duplicate operations | Automated UI pass; physical pending |
| Invalid, expired and used offers allow recovery with a fresh offer | Automated parse/refusal coverage; physical pending |
| Host survives app restart and its sessions open | Automated storage/RPC coverage; physical pending |

For QR, distinguish **no decode** from **decoded but pairing failed**. On failure,
record only the displayed safe diagnostic category/stage (and numeric relay code
if present). Correlate desktop/relay events within the UTC attempt window only
where redacted logs are available. No new production pairing trace was captured.
Keep #163 open until the physical checks and reported manual-code failure are
resolved.
