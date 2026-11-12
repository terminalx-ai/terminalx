# Phone pairing approval, fingerprints and connection paths (PRO-314)

This is the contract the Mac (src-tauri), the desktop UI (src/) and the phone app
(mobile/) share for confirming a phone pairing on the Mac. The TypeScript shapes
live in `src/types/pairing.ts`; the Rust model in `src-tauri/src/pairing/model.rs`
must serialise to exactly those shapes.

## Decisions

- **Approval is required for every QR pairing**, Relay and "Only this network"
  alike. A code that leaks on the local network is as dangerous as one that
  leaks through Relay, and the acceptance criteria ask for approval
  unconditionally. Automatic (account-bound, `provenance: "automatic"`) pairings
  are not gated: the account sign-in on both devices already authorises them.
- **Phones paired before this change stay paired.** They are treated as
  approved. Their fingerprint is derived from the public key the Mac already
  stores for them (`DeviceEntry.public_key`, written on every connection); a
  device that has never connected has no fingerprint until it does.

## Fingerprint

Both sides know both keys before the Mac answers `e2ee_auth`: the host public
key is pinned in the pairing offer (`publicKeyB64`), and the phone's long-lived
X25519 key is sent in `e2ee_hello.clientPublicKeyB64`. So no wire message is
needed to show the same fingerprint on both screens.

```
digest      = SHA-256( "terminalx-pairing-fingerprint.v1" || 0x00 || host_pk[32] || phone_pk[32] )
fingerprint = upper-hex(digest[0..2]) + "·" + upper-hex(digest[2..4])     e.g. "7F3A·91C2"
```

- `host_pk` and `phone_pk` are the raw 32-byte keys (decode the standard base64).
- The separator is U+00B7 MIDDLE DOT.
- The domain string is ASCII, followed by one zero byte.

Test vector (both implementations must assert it):

```
host_pk  = 32 bytes of 0x01
phone_pk = 32 bytes of 0x02
fingerprint = "1177·11ED"
```

## The approval step on the Mac

1. The phone scans the code and opens its direct and Relay candidates as today.
2. On a connection whose `e2ee_auth.deviceToken` belongs to the **pending,
   unclaimed** device of the active code (`Inner.pending_pairing_device`) and that
   has no `approved_at`, the Mac does **not** send `e2ee_authenticated`. It
   records a pending approval (`PairingStatus.pendingApproval`) with the
   fingerprint for that connection's phone key and emits `pairing_status`.
3. Several connections from the same phone (same phone key) share one pending
   approval. A connection with a different phone key while one is pending is
   refused and closed.
4. **Approve** (`pairing_approve(requestId)`): sets `approved_at` and
   `fingerprint` on the device, then every waiting connection continues: the Mac
   sends `e2ee_authenticated` and the pairing finishes exactly as before.
5. **Decline** (`pairing_decline(requestId)`), or no answer within
   `APPROVAL_TTL_MS = 120_000`: the device entry, its keychain token and its Relay
   invite are discarded (`discard_unclaimed_pairing` + relay revoke), the active
   code is cleared, every waiting connection is closed. No paired device is left.
   The dialog then offers "Generate a new code".
6. The code's own expiry does not cut a pending approval short; but once the
   code has expired no *new* approval request can start.

The phone waits for `e2ee_authenticated` for up to `APPROVAL_TTL_MS` plus a
margin (use 150 s) while pairing. A close before `e2ee_authenticated` during
pairing means "not approved on the Mac, or it timed out".

## Phone name

After pairing (and on every connection), the phone calls the RPC

```
device.describe  params { label: string (1..64 chars), platform: "ios" | "android" }
                 result { ok: true }
```

The Mac stores `label`/`platform` on the device entry (trimmed, control characters
stripped, max 64). Allowed for the `driver` scope. A Mac without the method
refuses it; the phone ignores that refusal.

## Connection paths

- Each live connection records its transport (`"direct"` = over LAN/Tailscale,
  `"relay"` = through TerminalX Relay). `PairedDevice.connection` is set while at
  least one is live (the most recent one wins); `lastSeenTransport` is written
  when a connection opens.
- **Revoke** ends live connections at once (already true) and removes the device.
- **Disconnect** (`pairing_disconnect(deviceId)`) keeps the pairing. Before
  closing, the Mac sends the notification
  `{"method":"pairing.disconnected","params":{"reason":"disconnected-on-mac"}}`
  on each of that device's connections. A phone that receives it stops
  reconnecting to that Mac until the person reconnects from the phone.

## Keep this Mac awake

`pairing_set_keep_awake(enabled)` persists the choice (default **on**, as the
screen shows it on). While it is on and at least one phone connection is live,
the Mac holds a `PreventUserIdleSystemSleep` power assertion
(`IOPMAssertionCreateWithName`, reason "A phone is connected to TerminalX"). The
assertion is released when the last connection closes or the setting is turned
off. The power module (`src-tauri/src/power.rs`) is written so PRO-151 ("Keep the
Mac awake while agents work") can hold its own reason on the same mechanism.

## Tauri commands (all return `PairingStatus`)

| Command | Arguments |
| --- | --- |
| `pairing_approve` | `{ requestId }` |
| `pairing_decline` | `{ requestId }` |
| `pairing_disconnect` | `{ deviceId }` |
| `pairing_set_keep_awake` | `{ enabled }` |

Existing: `pairing_status`, `pairing_generate { connectionMode }`,
`pairing_revoke { deviceId }`, `pairing_retry_relay`.

## Where the dialog opens, and differences from the design

The dialog opens from Settings → Devices, the command palette ("Pair a phone…") and
the session view's own menu (the … beside the title). It is not on the sidebar
row menu: that menu holds a few per-conversation actions, and pairing is not one.

Deliberate differences from the Superdesign screen "14.19 Pair a phone · remote
control":

- While a phone waits, the approval prompt (fingerprint, "Decline", "Approve",
  the path and the time left) takes the QR code's place in the left column. The
  screen has no approval state.
- Closing the dialog while a phone waits declines that request.
- A connected device's row has "Disconnect" beside "Revoke"; the screen's row shows
  only "Revoke", the ticket asks for both.
- A "Copy code" link sits under "Generate a new code", for typing the code on a
  phone that cannot scan.
- With Relay down, the Relay line shows the Relay's own message, plus a hint
  to choose "Only this network"; an expired code shows an expired state in place
  of the QR code.
- Dates follow the system locale ("Nov 3, 10:20 PM" where the screen has
  "3 Nov, 18:20").
- Colours, type and spacing come from the app's tokens, not the screen's Tailwind
  values.
