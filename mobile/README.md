# TerminalX mobile

The iOS companion is an Expo development build. It connects to one paired Mac at a time and keeps sessions on that Mac as the source of truth.

## Development

```sh
pnpm install
pnpm --dir mobile ios
```

Use a development build rather than Expo Go because pairing credentials require device-only SecureStore storage. `eas.json` includes a simulator development profile; it does not configure a store submission.

## Standalone simulator build and pairing smoke test

With full Xcode, an installed iOS simulator runtime, and Python 3, boot an iPhone
in Simulator and run:

```sh
pnpm --dir mobile ios:simulator
# Or select a simulator explicitly (list IDs with xcrun simctl list devices available):
pnpm --dir mobile ios:simulator --device <simulator-UDID>
```

This generates the native project if needed, builds Release with bundled JavaScript
(no Metro server), verifies the executable's Keychain entitlement, then installs and
launches it. Build output is cached in `mobile/dist/simulator-build`; use
`--derived-data <path>` to choose another cache. No paid Apple account or signing
certificate is required. This command targets simulators only.

Keep simulator ad-hoc signing enabled. **Do not use `CODE_SIGNING_ALLOWED=NO`:**
that can remove the embedded `application-identifier` used by Simulator's Keychain,
causing SecureStore pairing to fail with “A required entitlement isn't present.”
An empty result from `codesign --entitlements` alone is inconclusive: Xcode puts
simulator entitlements in the executable's `__TEXT,__entitlements` section. To
check an existing build without installing it:

```sh
pnpm --dir mobile ios:simulator --verify-only /path/to/TerminalX.app
```

For an end-to-end check, open desktop Settings → Devices, generate a fresh LAN
pairing code, and use mobile Machines → Use QR code or pairing code → Type code.
Confirm pairing succeeds and Sessions shows a live encrypted connection and the
Mac's sessions. Terminate and relaunch the mobile app, then confirm it reconnects
without another code. Also check that malformed codes show a recoverable error.
Keep pairing codes and QR screenshots private. JavaScript unit tests alone cannot
catch a missing entitlement in a packaged native executable.

The OAuth redirect is `terminalx://auth/callback`, matching the deployed first-party client. iOS allows only one installed app to own that custom scheme reliably, so this companion replaces any other TerminalX mobile build on the same simulator or device. A mobile-specific scheme would require a server registration change and is deliberately not introduced here.

Pairing uses the version 2 desktop offer exactly as issued by TerminalX: the QR contains a short-lived, single-use pairing credential, the Mac's public key, and a relay invite when relay reachability is available—never a long-lived credential. Installation keys, the device-bound E2EE client key, and per-host credentials are stored with the device-only SecureStore accessibility class.
