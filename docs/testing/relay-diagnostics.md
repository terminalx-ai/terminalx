# Relay outages and client diagnostics (#162)

## Scope

The server-side outage is handled separately. This change addresses the desktop
client's diagnosis, persistent logging, and recovery behavior from issue #162.

## Client behavior

Failures retain a typed stage: local identity, authorization, assignment, control
WebSocket connection, host proof, or established control session. Categories are
service unavailable (HTTP 5xx), authentication (401), access denied (403), account
entitlement, rate limited (429), network, timeout, protocol, local storage, and
unknown. A 403 alone is not classified as lack of entitlement. Unknown errors are
not classified by searching their text.

Settings → Devices displays the corresponding safe message. Service failures
identify the service and explain automatic retries and the LAN alternative.
They do not become network/account errors after 12 attempts. Relay code creation
waits for a connected control channel; LAN remains available during reconnection.

Successful host proof resets the consecutive attempt count and backoff. A later
control close clears the live sender and retries with the director's reconnect
hint. Retries continue indefinitely, with the existing maximum 90-second delay.

## Diagnostic file

The pairing manager initializes `relay-diagnostics.json` in Tauri's app log
directory before starting the supervisor. With the current macOS production
identifier this is:

```text
~/Library/Logs/com.terminalx.next/relay-diagnostics.json
```

Development builds use `com.terminalx.next.dev`. The file is written directly,
independently of `env_logger`, stderr, `RUST_LOG`, and macOS unified logging.
There is no upload. It retains the latest 128 events with a hard 64 KiB cap,
including bounded reads on startup. Each write atomically replaces the snapshot;
files are mode 0600 on Unix. Invalid or non-allowlisted old records are discarded.

Records contain only timestamp, event (`started`, `failed`, `connected`), attempt,
retry count, and optional typed failure stage/category/HTTP status. Attempt 1 is
the initial connection, retry count 0. A control-session failure after a successful
connection has attempt/retry count 0, before the next connection attempt starts.
The connected event records the successful attempt before resetting the counter.

No arbitrary string fields accept exception text, response bodies, headers, URLs,
account identifiers, host/device identifiers, local addresses, paths, tokens,
keys, or pairing material. The supervisor's stderr warning uses the same safe
fields. Disk-write failures do not prevent relay recovery; a safe local-storage
warning is emitted and a later event retries the write.

## Automated checks

```sh
cargo test --manifest-path src-tauri/Cargo.toml pairing:: --lib
pnpm exec vitest run src/components/settings/DevicesTab.test.tsx
```

Coverage includes:

- Real authenticated HTTP requests against loopback fixtures: token issuance,
  assignment 502 with a sensitive response body, then successful reassignment.
- The real supervisor's retries, encrypted host proof and control WebSocket
  against a loopback server, invite creation after recovery, a subsequent remote
  close, fresh invite creation, retry reset and retained reconnect hint.
- HTTP/auth/access/rate-limit categories; WebSocket HTTP headers/body and nested
  error redaction; network/timeout distinction and unknown-error handling.
- A subprocess with stdout/stderr discarded that still writes a safe diagnostic.
- Retention across log reinitialization, bounds, Unix permissions, corrupt or
  oversized input, and disk failure without blocking status updates.
- Devices status updates through the actual frontend store: outage explanation,
  disabled Relay pairing during outage/reconnection, and a code after recovery.

The loopback supervisor fixture supplies assignment failures and generated host
identity at the connection boundary; HTTP authorization/assignment are exercised
separately. It does not use a real account, production endpoint, or Keychain.

## Validation result

Validated locally against current main on September 28, 2026:

- `cargo test`: 484 passed, 4 existing ignored tests; binary/doc tests passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec vitest run`: 480 passed across 76 files.

The physical iPhone Release build was installed and launched successfully. The
user confirmed successful pairing. This does not establish recovery after a
controlled outage on the newly packaged desktop.

## Remaining release verification

On a packaged build containing this change, use a signed-in desktop and a test
phone to verify a fresh Relay pairing after a controlled outage, including the
phone's encrypted connection. Confirm the diagnostic file records failure and
recovery without relying on stderr. The tests verify invite creation; they do
not claim a completed phone pairing in production. Avoid a production outage
solely for this check; use a controlled relay environment or interrupt only the
test desktop's relay connectivity.
