# Accounts, device pairing and cloud sessions

Status: Approved integration plan

Date: 2026-09-03

Issue: [#6](https://github.com/terminalx-ai/raccoon/issues/6)

TerminalX Next reuses the deployed TerminalX identity, account-pairing, and relay
services. It is a client of `login.terminalx.ai` and `relay.terminalx.ai`; this
plan does not require a change to those services.

## Reuse boundary

**Contract:** `docs/reference/cloud-endpoints.md` § “Scope” and §
“Conventions”. **Server:** `apps/api/src/app.ts` mounts `/v1/auth`,
`/v1/desktop`, and `/v1/account`; `apps/relay/src/director/director-server.ts`
and `apps/relay/src/cell/cell-server.ts` implement the relay surface.

TerminalX Next implements only client behavior:

- the desktop/Tauri side implements OAuth, secure token persistence, host
  account binding, grant servicing, and relay control in Rust;
- the Expo app implements mobile OAuth, installation registration, pairing,
  secure device storage, and direct/relay connections; and
- both clients use the existing runtime wire format and capability names.

Authentication methods, account creation, token issuance, the machine
directory, one-time grant coordination, relay placement, and relay cells remain
owned by the deployed services. Auth JSON is normalized field by field and may
ignore unknown fields. Relay JSON is strict: an unexpected field is a contract
failure, not a value TerminalX Next may accept speculatively. Times named `expiresAt`,
`refreshedAt`, or `...At` are epoch milliseconds.

## Desktop OAuth and session lifecycle

**Contract:** `docs/reference/cloud-endpoints.md` §
“`login.terminalx.ai` / Desktop authentication”, § “Authorize (browser)”,
and § “JSON endpoints”. **Server:** `apps/api/src/routes/desktop.ts`
delegates `/v1/desktop/auth/authorize`, `/session`, `/refresh`,
`/capabilities`, `/org`, `/profile`, `/logout`, and `/relay-token` to
`apps/api/src/controllers/desktop/auth.ts` and
`apps/api/src/controllers/desktop/relayToken.ts`; redirect validation is in
`apps/api/src/controllers/desktop/authorize.ts` and
`apps/api/src/lib/cloudAuthContract.ts`.

The Rust desktop client copies the shipped desktop flow exactly:

1. Bind a one-shot HTTP listener to `127.0.0.1:0` and use the resulting
   `http://127.0.0.1:<port>/auth/callback` URL.
2. Open `/v1/desktop/auth/authorize` in the system browser with client id
   `terminalx-desktop`, response type `code`, scope
   `openid profile email offline_access`, a fresh `state`, `nonce`, and PKCE
   S256 challenge, plus TerminalX Next's local profile id.
3. Accept only the exact callback path and matching `state`; ignore unrelated
   loopback probes. Close the listener after success, denial, or five minutes.
4. Exchange the code at `/v1/desktop/auth/session` using the original verifier,
   nonce, redirect URI, state, and local profile id.

The client stores the full returned desktop session: access token, rotating
refresh token, expiry, user, cloud/local profile ids, active organization, and
capabilities. It stores tokens in an OS-protected secret; if protected storage
is unavailable in a production build, it keeps the session in memory rather
than writing plaintext. It never logs authorization codes, verifiers, access
tokens, refresh tokens, or relay credentials.

The request policy is also identical: 30-second auth deadlines,
`redirect: error`, proactive refresh within 60 seconds of expiry, and at most
one refresh-and-retry after an authenticated `401` or `403`. A repeated `401`
ends the local session. A repeated `403` fails that operation without signing
the user out. Desktop sign-out tombstones the local session first, then makes a
best-effort `/logout` request.

## Mobile OAuth and session lifecycle

**Contract:** `docs/reference/cloud-endpoints.md` §
“`login.terminalx.ai` / User-scoped authentication”. **Server:**
`apps/api/src/routes/cloudAuth.ts` delegates `/v1/auth/authorize`, `/session`,
`/refresh`, and `/logout` to `apps/api/src/controllers/desktop/authorize.ts`
and `apps/api/src/controllers/cloud/auth.ts`;
`apps/api/src/lib/cloudAuthContract.ts` registers the accepted client and
redirect URI.

The Expo app uses client id `terminalx-mobile` and the exact redirect URI
`terminalx://auth/callback`. It registers that scheme in the native app, opens
the hosted authorize page, and sends the same scope, state, nonce, and PKCE S256
values as the existing mobile client. It sends no identity-provider preference
and never renders account credentials itself.

`/v1/auth/session` and `/v1/auth/refresh` return the user-scoped shape
`{accessToken, refreshToken, expiresAt, user}`. The app persists it with Expo
SecureStore, refreshes within 60 seconds of expiry, and serializes refreshes so
only one rotation is in flight. Refresh `400`, `401`, or `403` definitively
ends the cloud session. A network failure or `5xx` preserves the cached session
as offline. On sign-out, automatic account pairings are removed before the app
makes a best-effort `/v1/auth/logout` call.

The server rotates refresh tokens with the already-deployed 30-day sliding
lifetime and a 60-second replay/idempotency window. TerminalX Next treats each complete
refresh response as the only current token pair and never attempts to implement
rotation policy locally.

## Host identity and account binding

**Contract:** `docs/reference/cloud-endpoints.md` § “Relay token response”
and `apps/api/docs/account-bound-host-pairing.md` § “Security boundary” and
§ “Discovery and installation APIs”. **Server:**
`apps/api/src/routes/desktop.ts` delegates `/v1/desktop/host-account-bindings`,
`/:hostId/heartbeat`, and `DELETE /:hostId` to
`apps/api/src/controllers/accountPairing/host.ts`; relay proof is checked via
`POST /v1/attest` in `apps/relay/src/director/director-server.ts`.

The Rust host creates one persistent Curve25519 E2EE keypair and uses it for the
single runtime listener shared by direct and relay transports. It does not make
a key or listener per share. The local key file is owner-only and follows the
existing `terminalx-e2ee-keypair.json` versioned shape; the public key is safe
to publish, while the secret key never leaves the host.

The host derives
`hostId = base64url(SHA-256(decoded 32-byte public key)).slice(0, 16)`. After
desktop sign-in it obtains a relay token, proves possession of that same key to
the relay director, and registers this exact binding shape:

```json
{
  "hostId": "derived-host-id",
  "hostPublicKeyB64": "padded-base64-32-byte-key",
  "bindingGeneration": 1,
  "displayName": "This Mac",
  "platform": "darwin",
  "environmentKind": "native",
  "capabilities": ["account-bound-host-pairing.v1"]
}
```

`environmentKind` is one of `native`, `wsl`, or `ssh`. TerminalX Next sends no
repository, folder, session, or terminal metadata. A `live` heartbeat is sent
only with a fresh relay attestation; otherwise the host reports
`unverifiable` or `exited`. The implementation follows the existing 30-second
heartbeat cadence and fences every operation with `bindingGeneration`.

## Account-bound installation and HPKE grant

**Contract:** `apps/api/docs/account-bound-host-pairing.md` § “Discovery and
installation APIs”, § “One-time grant broker”, and § “Revocation and
generation fences”. **Server:** `apps/api/src/app.ts` mounts `/v1/account`,
whose host discovery, client-installation, and pairing-grant operations are
handled by `apps/api/src/controllers/accountPairing/account.ts`;
`apps/api/src/routes/desktop.ts` wires host grant polling, envelope/reject, and
revocation acknowledgement to
`apps/api/src/controllers/accountPairing/host.ts`.

The Expo app creates a P-256 installation signing key and UUID in device secure
storage. It registers the JWK, exact sorted capability list, and P1363
ECDSA-SHA256 proof over the
`terminalx-client-installation-registration/v1` transcript. A session not
recent enough for trusted registration may return pending; the UI asks the user
to reauthenticate and repeat rather than weakening the proof. A revoked
installation id is never reused.

For account-bound pairing the app:

1. reads `/v1/account/hosts` and verifies that the selected directory
   `hostPublicKeyB64` derives its `hostId`;
2. creates an ephemeral X25519 keypair and nonce, signs the exact
   `terminalx-pairing-grant-request/v1` transcript, and requests literal scope
   `mobile`;
3. polls the five-minute grant through the account API; and
4. opens the returned envelope with
   `HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305`, using the returned
   `associatedData` bytes exactly as supplied.

The Rust host polls pending requests, compares the requested host key
byte-for-byte with its own, and creates a fresh ordinary `mobile` device entry
with `identityMode: authenticate`. It never copies another device's token. Its
encrypted offer uses the existing version-2 pairing offer, including the
direct endpoint and, when provisioned, the version-1 relay bundle with
`e2eeFraming: 2`. The app validates the decrypted offer public key against the
directory key, completes local pairing, and only then consumes the grant. Any
partial failure revokes the grant and deletes partial local credentials.

Automatic pairing is generation-fenced. Account sign-out or installation
revocation removes account-derived device entries, queues relay credential
revocation idempotently, and acknowledges the server record only after local
cleanup. Explicit QR/code pairings remain independent and survive account
sign-out, matching the deployed contract.

## Direct pairing and E2EE framing v2

**Contract:** `docs/reference/relay-server-contract.md` § “Trust boundary”,
`docs/reference/remote-wire-compatibility.md` § “Rule 2 — a new stream opcode
is NOT safe; negotiate it”, and the v2 offer/handshake contracts in
`src/shared/mobile-relay-pairing-offer.ts` and
`src/shared/mobile-e2ee-v2-contract.ts`. **Server:** explicit direct pairing
has no hosted route; relayed bytes use the cell routes in
`apps/relay/src/cell/cell-server.ts`, which forward them verbatim.

TerminalX Next keeps the existing explicit QR/code path for pairing without an
account. Its offer is version 2 and uses only the deployed fields: `endpoint`,
`deviceToken`, `publicKeyB64`, optional `pairedDeviceId`, literal scope
`mobile`, an identity mode, and the optional version-1 relay offer. It does not
invent viewer/driver scopes or another envelope.

Both direct and relay transports then run the same E2EE v2 state machine. The
mobile `e2ee_hello` offers framing 2 and text/binary payload kinds with context
`terminalx-mobile-e2ee`; `e2ee_ready` selects those exact values. The transcript
binds both ephemeral Curve25519 keys, nonces, roles, transport, and relay host
when present. The app pins the desktop public key from the pairing offer.

After the key schedule, the app sends the device token only inside encrypted
`e2ee_auth`; the host returns encrypted `e2ee_authenticated`. Secretbox frames
carry a session id, direction, payload kind, and strictly increasing uint64
counter with a 24-byte nonce. A duplicate, reordered, injected, or skipped
frame fails the channel. RPC and terminal bytes never appear outside this
framing.

### Local network permission

macOS Sequoia and iOS require Local Network authorization for direct LAN
pairing and sharing. The iOS app includes `NSLocalNetworkUsageDescription` with
copy explaining that it connects to a Mac the user explicitly pairs. The Mac
can also show a separate incoming-connections firewall prompt when the host
listener first accepts traffic.

The first-run flow is explicit:

1. Before triggering either system prompt, TerminalX Next explains that the requested
   pairing, join, or share will connect directly to another device on the local
   network.
2. It asks for Local Network access only after the user chooses that action,
   never at app launch, sign-in, or directory browsing.
3. After authorization, the Mac starts its single host listener and explains
   that the incoming-connections firewall prompt must also be allowed. A
   denial produces a visible direct-unavailable state with System Settings and
   Retry actions, never a false successful connection.
4. A joining iPhone requests access only after the user taps Pair or Join. If
   denied, the invite or grant remains unconsumed while valid and the UI shows
   how to enable access in Settings before retrying.

## Relay director and cell

**Contract:** `docs/reference/relay-server-contract.md` § “HTTP”, §
“WebSocket: host control”, § “WebSocket: host data”, § “WebSocket: phone
leg”, § “Host proof”, and § “Lifecycle”. **Server:** relay-token issuance
is `/v1/desktop/auth/relay-token` in `apps/api/src/routes/desktop.ts`;
assignment, resolve, attestation, and director moves are in
`apps/relay/src/director/director-server.ts`; `/v1/host/control`,
`/v1/host/data/:connId`, and `/v1/connect/:relayHostId` are in
`apps/relay/src/cell/cell-server.ts`.

The Rust host exchanges its desktop access token and key identity for a relay
token, calls strict `POST /v1/assign`, and establishes the cell control socket.
It implements the deployed 15-second challenge/ack deadline and exact 16-field
host-proof transcript, generation fencing, relay-driven ping/pong, lease
rotation, drain/reassignment, idempotent credential install/revoke request ids,
and demand gating. It holds a control socket only while a paired phone, pending
invite, queued revoke, or pairing operation needs it, with the existing
ten-minute linger after demand disappears.

The Expo app connects with the invite credential from the pairing offer, then
uses the current and grace resume tokens. On stale placement it calls strict
`POST /v1/resolve` without an Authorization header and follows only a director
move with a strictly newer assignment epoch. Both clients honor `Retry-After`
and deployed close codes. After `host-data-auth` or `relay-auth`/`relay-hello`,
the cell is a byte pipe; TerminalX Next never expects or emits a relay status frame in
the E2EE byte stream.

The relay may see identities, relay/device ids, routing metadata, socket
metadata, and plaintext E2EE handshake frames. It cannot see the device token,
RPC requests, terminal payloads, or HPKE pairing payload. Those remain inside
E2EE v2.

## Compatibility, persistence, and observability

**Contract:** `docs/reference/cloud-endpoints.md` § “Conventions”,
`docs/reference/relay-server-contract.md` § “Versioning”, and
`docs/reference/remote-wire-compatibility.md` §§ “Rule 1”–“Rule 3”.
**Server:** schema enforcement occurs in
`apps/api/src/controllers/desktop/auth.ts`,
`apps/api/src/controllers/cloud/auth.ts`,
`apps/api/src/controllers/accountPairing/account.ts`,
`apps/api/src/controllers/accountPairing/host.ts`,
`apps/relay/src/director/director-server.ts`, and
`apps/relay/src/cell/cell-server.ts`.

TerminalX Next persists only what a client needs: protected cloud sessions, the host
key and device registry on desktop, and the installation key plus paired-host
records in Expo SecureStore. It keeps plaintext pairing secrets, HPKE private
keys, authorization codes, relay invite credentials, and active E2EE session
keys in memory only for their protocol lifetime.

Rust and Expo decoders accept auth extensions only where the auth contract does,
but use exact strict relay schemas. Optional RPC JSON fields remain optional;
new stream opcodes or behavior-changing payload content are sent only after a
named capability is negotiated. Logs identify the stage and a redacted request
id, never credentials or payload content.

## Would require a server change (out of scope)

**Contract:** `docs/reference/cloud-endpoints.md` § “User-scoped
authentication” and `docs/reference/relay-server-contract.md` §
“Versioning”. **Server:** the current allowlist is
`apps/api/src/lib/cloudAuthContract.ts`; current account handlers and relay
schemas are in `apps/api/src/controllers/accountPairing/account.ts`,
`apps/api/src/controllers/accountPairing/host.ts`,
`apps/relay/src/director/director-server.ts`, and
`apps/relay/src/cell/cell-server.ts`.

None of the following is required by this plan:

- a new OAuth client id or redirect such as `terminalx-next://...`; the API
  currently accepts `terminalx-desktop` loopback callbacks and the exact
  `terminalx-mobile` / `terminalx://auth/callback` mobile pair;
- extra host-directory metadata, new installation or grant fields, different
  pairing scopes, or a new HPKE suite;
- a relay protocol version other than v1, E2EE framing other than v2, extra
  keys in strict relay responses, or new control/data message types; or
- server-stored session transcripts, terminal content, multiplayer room state,
  or push-notification delivery.

If a future product requires one of these, it needs a separate server proposal,
compatibility plan, rollout, and operational approval. TerminalX Next's baseline ships
without it.
