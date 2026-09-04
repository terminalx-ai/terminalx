# TerminalX mobile

The iOS companion is an Expo development build. It connects to one paired Mac at a time and keeps sessions on that Mac as the source of truth.

## Development

```sh
pnpm install
pnpm --dir mobile ios
```

Use a development build rather than Expo Go because pairing credentials require device-only SecureStore storage. `eas.json` includes a simulator development profile; it does not configure a store submission.

The OAuth redirect is `terminalx://auth/callback`, matching the deployed first-party client. iOS allows only one installed app to own that custom scheme reliably, so this companion replaces any other TerminalX mobile build on the same simulator or device. A mobile-specific scheme would require a server registration change and is deliberately not introduced here.

Pairing uses the version 2 desktop offer exactly as issued by TerminalX: the QR contains a short-lived, single-use pairing credential, the Mac's public key, and a relay invite when relay reachability is available—never a long-lived credential. Installation keys, the device-bound E2EE client key, and per-host credentials are stored with the device-only SecureStore accessibility class.
