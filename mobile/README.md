# TerminalX mobile

The iOS companion is an Expo development build. It connects to one paired Mac at a time and keeps sessions on that Mac as the source of truth.

## Development

```sh
pnpm install
pnpm --dir mobile ios
```

Use a development build rather than Expo Go because pairing credentials require device-only SecureStore storage. `eas.json` includes a simulator development profile; it does not configure a store submission.

Local `ios` builds and the EAS development profile use the orange D icon.
Preview/default builds use the unbadged Legacy artwork. The `ios` command runs
prebuild to refresh native assets before building. See `docs/RELEASING.md` in
the repo root for icon regeneration and restoring the committed release catalog.

The standalone simulator command requires Pillow
(`python3 -m pip install Pillow==11.1.0`) and always builds the production icon,
even when the parent shell has `APP_VARIANT=development`. It rejects an incorrect
packaged icon before installing. For IPA and installed-app checks, see
[release icon validation](../docs/RELEASING.md#validate-the-delivered-icons).

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

## Transcript viewport regression fixture

The synthetic fixture renders the production `TranscriptList` and `TurnCard` with
real native layout. It does not connect to a host or read session data. Run the
measurement server and Expo fixture in separate terminals (after `pnpm install`):

```sh
node mobile/scripts/transcript-viewport/server.mjs
```

```sh
cd mobile/scripts/transcript-viewport
../../node_modules/.bin/expo start --go --ios --port 8089
```

Expo Go is sufficient for this isolated UI fixture; the paired app still requires
a development build. Dismiss Expo's developer menu before checking the viewport.
From the repository root, run:

```sh
node mobile/scripts/transcript-viewport/check.mjs suite
```

This checks empty/short/long histories, delayed cold loads, cached content followed
by host data, live output, reconnect data, agent switches, streaming height changes,
a delayed image resize, and a permission card. Assertions use native scroll events
and measured marker positions within the viewport, not mocked scroll methods.
Measurements are saved to `mobile/dist/viewport/`. Synthetic simulator screenshots
are included in [light](scripts/transcript-viewport/screenshots/light.png) and
[dark](scripts/transcript-viewport/screenshots/dark.png) appearance.

Scroll up into history on the simulator, confirm **Jump to latest** appears, then run:

```sh
node mobile/scripts/transcript-viewport/check.mjs live preserve
node mobile/scripts/transcript-viewport/check.mjs reconnect preserve
node mobile/scripts/transcript-viewport/check.mjs grow preserve
node mobile/scripts/transcript-viewport/check.mjs image preserve
node mobile/scripts/transcript-viewport/check.mjs earlier preserve
```

Each command checks that a visible history marker keeps its screen position. To
exercise the cache/host race, run `check.mjs cached bottom`, scroll up, then run
`check.mjs host preserve`. Tap **Jump to latest**, then run `check.mjs measure bottom`.
Focus the synthetic composer and repeat that measurement with the keyboard open.
While reading history, `check.mjs dismiss away` dismisses the keyboard and checks
that layout changes do not return the reader to latest. These commands use the
same script path as above. If Expo Go fails during hot reload, terminate and reopen
the fixture; the checker rejects stale measurements.

Validated on 2026-10-04 with an iPhone 17 / iOS 27.0 simulator in Expo Go 57.0.9.
Bottom scenarios settled at native offset zero; a history marker retained its
exact y coordinate through live/reconnect/growth/image/pagination updates. Android
and physical-device validation remain outstanding. The fixture substitutes data
arrival for transport; cache loading, reconnect epochs, and agent selection are
also covered by `src/conversation-screen.test.tsx`.
