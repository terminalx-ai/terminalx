# Mobile companion integration plan

Status: Approved client-only plan

Date: 2026-09-03

Issue: [#7](https://github.com/terminalx-ai/raccoon/issues/7)

The TerminalX Next companion is an Expo client of the deployed TerminalX account,
pairing, relay, and runtime contracts. The Mac remains the source of truth for
sessions and terminal state. The phone does not need a new hosted backend.

## Product boundary and app shell

**Contract:** `docs/reference/cloud-endpoints.md` § “Scope” and
`docs/reference/relay-server-contract.md` § “Topology”. **Server:**
`apps/api/src/app.ts` mounts `/v1/auth` and `/v1/account`; relay director and
cell entry points are implemented by
`apps/relay/src/director/director-server.ts` and
`apps/relay/src/cell/cell-server.ts`.

Version one is iOS-first and uses an Expo development build. It has four
screens: Machines, Sessions, Session, and Settings. One Mac connection is
active at a time, and switching is explicit. There is no phone-only session or
cloud copy of a transcript.

The Expo app renders native views over shared portable event/fold types. It does
not import desktop UI or Tauri APIs. Version one can discover and pair machines,
read existing sessions and tabs, render chat/transcript and terminal output,
post notes, promote a note, and send write-gated terminal input. It does not
create sessions, worktrees, terminals, files, commits, reviews, issues, or
automations, and it exposes no general-purpose host command surface.

## Mobile OAuth

**Contract:** `docs/reference/cloud-endpoints.md` §
“`login.terminalx.ai` / User-scoped authentication” and § “Conventions”.
**Server:** `apps/api/src/routes/cloudAuth.ts` implements
`GET /v1/auth/authorize` and `POST /v1/auth/session`, `/refresh`, and `/logout`
through `apps/api/src/controllers/desktop/authorize.ts` and
`apps/api/src/controllers/cloud/auth.ts`; accepted values are fixed in
`apps/api/src/lib/cloudAuthContract.ts`.

The app uses the registered client id `terminalx-mobile`, the exact redirect
URI `terminalx://auth/callback`, and scope
`openid profile email offline_access`. It opens the hosted authorize page in
the system authentication browser with fresh state, nonce, and PKCE S256
challenge. It accepts a callback only for that URI and matching state, then
exchanges the code with the original verifier, nonce, redirect URI, and client
id. The hosted page owns account creation and login method selection.

The app stores the returned `{accessToken, refreshToken, expiresAt, user}` in
Expo SecureStore. It refreshes once the expiry is within 60 seconds and keeps
refresh single-flight. Refresh `400`, `401`, or `403` signs out locally;
network errors and `5xx` keep the cached account in an offline state. Auth
requests have a 30-second deadline, use `redirect: error`, and never log codes,
verifiers, or tokens.

The Mac side independently uses the existing `terminalx-desktop` loopback PKCE
flow described in [ACCOUNTS.md](./ACCOUNTS.md). Mobile does not exchange a
mobile token for a desktop session or vice versa.

## Machine discovery and installation identity

**Contract:** `apps/api/docs/account-bound-host-pairing.md` § “Security
boundary” and § “Discovery and installation APIs”. **Server:**
`apps/api/src/app.ts` mounts `/v1/account`; host discovery, installation
listing, registration, logout, and revocation are handled by
`apps/api/src/controllers/accountPairing/account.ts`;
`apps/api/src/routes/desktop.ts` wires host bindings and heartbeats to
`apps/api/src/controllers/accountPairing/host.ts`.

On first sign-in the Expo app creates a P-256 signing key and random client
installation id in device secure storage. It registers the public JWK and exact
capability list with the P1363 ECDSA-SHA256 proof over the
`terminalx-client-installation-registration/v1` transcript. A stale cloud
session may require recent reauthentication; the app repeats registration after
reauth instead of treating a pending installation as trusted. A revoked id is
replaced, never recycled.

Machines displays the existing account directory. It treats a host as
automatically pairable only when its capabilities include the exact
`account-bound-host-pairing.v1` string and its 32-byte public key derives the
advertised 16-character host id. `live`, `unverifiable`, and `exited` are
rendered as distinct reachability states. Repository names, paths, session
lists, and terminal contents are not directory fields and are not requested.

The explicit QR/code path remains available without account discovery and uses
the same version-2 pairing-offer decoder. Explicit pairings remain on the
device when the cloud account signs out.

## Account-bound HPKE pairing

**Contract:** `apps/api/docs/account-bound-host-pairing.md` § “One-time
grant broker” and § “Revocation and generation fences”; the offer shape is in
`src/shared/mobile-relay-pairing-offer.ts`. **Server:** grant request, read,
consume, and revoke operations are handled by
`apps/api/src/controllers/accountPairing/account.ts`; host polling, envelope
publication/rejection, and revocation acknowledgement are wired by
`apps/api/src/routes/desktop.ts` to
`apps/api/src/controllers/accountPairing/host.ts`.

Tapping an eligible machine performs the deployed grant flow:

1. Create a fresh ephemeral X25519 keypair and nonce.
2. Sign the exact `terminalx-pairing-grant-request/v1` transcript for literal
   requested scope `mobile` with the installation key.
3. Create and poll the five-minute grant request.
4. Verify that the response names the selected host and key, then open the
   envelope with `HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305`, passing the
   returned associated-data bytes unchanged.
5. Validate that the decrypted version-2 offer's `publicKeyB64` matches the
   directory key byte-for-byte, persist the pairing, establish E2EE, and only
   then consume the grant.

The offer uses the existing fields and values: direct `endpoint`, fresh
`deviceToken`, pinned `publicKeyB64`, optional `pairedDeviceId`, scope `mobile`,
`identityMode: authenticate`, and an optional version-1 relay bundle with
`e2eeFraming: 2`. Partial failures revoke the grant and remove the partial host
record. The app never invents another scope, passes plaintext device tokens to
the account API, or reuses an HPKE private key.

## Direct networking, Local Network permission, and Tailscale

**Contract:** `docs/reference/relay-server-contract.md` § “Topology” and the
direct endpoint in `src/shared/mobile-relay-pairing-offer.ts`. **Server:** a
direct WebSocket has no hosted route; relay fallback begins at the director and
cell routes in `apps/relay/src/director/director-server.ts` and
`apps/relay/src/cell/cell-server.ts`.

The app tries the paired direct endpoint when the network makes it reachable
and falls back to relay when a relay bundle exists. Direct transport enters the
same E2EE and RPC pipeline as relay; it is not a lower-security mode. Both
paths terminate at the Mac's one runtime listener and one persistent host key,
not transport-specific listeners or identities.

The iOS build includes `NSLocalNetworkUsageDescription`. The app requests Local
Network access just in time when the user pairs or connects to a LAN address,
explains why it is needed, and presents a Settings recovery action after denial.
It does not trigger the prompt merely by opening the app or viewing an
account-provided machine directory.

Tailscale detection recognizes the full IPv4 CGNAT range `100.64.0.0/10`, not
all of `100.0.0.0/8`. A `*.ts.net` endpoint may also be described as Tailscale,
but the label is only a connection hint, never an authentication decision.
Address classification never weakens certificate, pairing-key, or E2EE checks.

## Relay director and cell client

**Contract:** `docs/reference/relay-server-contract.md` § “HTTP”, §
“WebSocket: phone leg”, § “Trust boundary”, and § “Lifecycle”. **Server:**
`POST /v1/resolve` and director moves are implemented by
`apps/relay/src/director/director-server.ts`; the phone leg
`/v1/connect/:relayHostId` is implemented by
`apps/relay/src/cell/cell-server.ts`.

The Expo transport sends the version-1 `relay-auth` frame first, using the
invite credential for the first connection and a resume token thereafter. It
accepts only the strict version-1 `relay-hello` response. If a director socket
returns `relay-moved`, the assignment epoch must be strictly newer. Resolve
sends `{v: 1, relayHostId, resumeToken}` in the body with no Authorization
header and accepts the strict returned placement.

The client keeps current and grace resume credentials during rotation, honors
`Retry-After`, and implements the existing relay close-code meanings. It uses a
single reconnect owner so foregrounding, reachability changes, direct probes,
lease rotation, and socket close cannot create parallel retry loops. When
direct transport recovers, it may upgrade without changing the logical RPC
session.

The relay is treated as a strictly ordered byte pipe after its first control
frame. An unexpected relay field is a fatal contract error; an in-band relay
status frame after attachment would be interpreted as application data and is
never accepted.

## E2EE framing v2 and runtime compatibility

**Contract:** `docs/reference/relay-server-contract.md` § “Trust boundary”,
`docs/reference/remote-wire-compatibility.md` §§ “Rule 1”–“Rule 3”, and
the concrete v2 contracts in `src/shared/mobile-e2ee-v2-contract.ts` and
`src/shared/mobile-e2ee-v2-framing.ts`. **Server:** the cell byte splice is in
`apps/relay/src/cell/cell-server.ts`; the hosted service does not terminate
application E2EE.

Direct and relay connections run the same v2 exchange. Mobile sends
`e2ee_hello` with an ephemeral Curve25519 public key, nonce, framing `[2]`,
payload kinds `text` and `binary`, and the exact
`terminalx-mobile-e2ee`/mobile/desktop context. It verifies `e2ee_ready`, pins
the host key from the pairing offer, derives directional keys and session id,
and sends the device token and client capabilities only inside encrypted
`e2ee_auth`. It accepts RPC only after encrypted `e2ee_authenticated` confirms
the transcript hash.

Secretbox frames use a 24-byte nonce and bind session id, direction, payload
kind, and a strictly increasing uint64 counter. Missing, repeated, reordered,
or injected frames fail closed. The relay can see connection metadata and
handshake frames; it cannot see the device token, RPC, transcript, terminal,
or pairing payloads.

The app keeps the deployed runtime protocol range and existing capability
names. Relevant checks include `account-bound-host-pairing.v1`,
`remote-runtime.shared-control.v1`, `terminal.binary-stream.v1`,
`terminal.multiplex.v1`, `terminal.query-reply-input.v1`,
`agent-message-attribution.v1`, `terminal.paired-parking.v1`,
`terminal.control-lease.v1`, and `session.workspace-access-events.v1`.
Absence means unsupported; the app never guesses support from app version.

## Sessions, chat, and tab-only RPC

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Rule 1 — a
new optional JSON field on an existing frame is safe” and § “Rule 3 —
changing what the host publishes breaks old clients with no wire change”.
**Server:** session RPC is application ciphertext; it has no hosted API route
and is forwarded verbatim by `apps/relay/src/cell/cell-server.ts`.

After `session.authenticate`, Machines opens the selected Mac, Sessions lists
only host-published session summaries, and Session subscribes to one session.
The app follows the existing method families for `session.status`,
`session.roster`, `presence.*`, `chat.*`, `session.tabs.*`, terminal
read/subscription methods, and the session-scoped steering methods documented
in [MULTIPLAYER.md](./MULTIPLAYER.md). Refusals are protocol data and render as
unavailable/forbidden states instead of falling through to broader RPC.

The TerminalX Next mobile API carries public `tabId` values only. It never stores,
accepts, or displays a PTY id, pane id, process handle, host path, or arbitrary
filesystem path. The Rust host resolves each tab id under the session lock and
rechecks that mapping at the point of use.

Chat notes remain distinct from agent messages. Posting uses `chat.post`;
promotion uses `chat.promoteToAgent` and passes the multiplayer write gate.
Presence aggregates multiple surfaces belonging to the same verified person.
The host must still have `multiplayer.use`, and the session must have passed the
Bypass-mode share gate.

## Terminal, steering, and permissions

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Rule 2 — a
new stream opcode is NOT safe; negotiate it” and § “Rule 3 — changing what
the host publishes breaks old clients with no wire change”. **Server:** terminal
and steering payloads have no hosted route and remain encrypted through
`apps/relay/src/cell/cell-server.ts`.

The terminal view decodes the negotiated binary stream, preserves ordered
snapshot/live output, and sends input only through the host's steering gate.
The app may locally crop, scale, or reflow the view, but it never calls
`terminal.updateViewport`; mobile cannot resize the host viewport or PTY.

The UI makes lease ownership, queued input, denial, and disconnection explicit.
Stopping a share, revoking the device, losing the verified identity, entering
Bypass mode, or closing the tab cancels or refuses pending writes. No reconnect
may replay input whose result is unknown.

Permission requests are read-only on mobile in the baseline. There is no
general permission-answer RPC in the allowlist. A future
`permission.respond` operation must use a separately negotiated capability also
named `permission.respond`, revalidate host/session authority, and generate a
local activity record. It is not implied by terminal steering.

## Persistence, sign-out, and privacy

**Contract:** `docs/reference/cloud-endpoints.md` § “User-scoped
authentication”, `apps/api/docs/account-bound-host-pairing.md` § “Revocation
and generation fences”, and `docs/reference/relay-server-contract.md` §
“Trust boundary”. **Server:** installation logout/revocation and pairing-grant
cleanup are handled by `apps/api/src/controllers/accountPairing/account.ts`;
relay credential revocation is handled over host control in
`apps/relay/src/cell/cell-server.ts`.

Expo SecureStore holds the cloud session, installation key/id, host device
credential, pinned host key, and relay resume bundle. AsyncStorage may hold
non-secret UI preferences and redacted cache records. Authorization codes,
PKCE verifiers, HPKE private keys, invite credentials after exchange, E2EE
session keys, and plaintext RPC payloads are never durable.

Sign-out first increments a local account epoch and removes automatic pairing
records and credentials so late async work cannot restore them. It records
cleanup intents before network calls, retries idempotent host/relay revocations,
then makes best-effort installation logout and cloud logout requests. Explicit
QR/code pairings survive. A network outage leaves visible retryable cleanup
state rather than silently declaring remote credentials revoked.

The phone stores only bounded local transcript/terminal cache needed for the UI
and clears it with its paired host. The host, not the phone or cloud, writes
owner-only multiplayer activity to
`$RACCOON_HOME/sessions/<session-id>/activity.jsonl`, without prompt, note,
agent, or terminal content and with 30-day retention.

## Notifications and background behavior

**Contract:** `docs/reference/relay-server-contract.md` § “Lifecycle” and
`docs/reference/remote-wire-compatibility.md` § “Rule 3 — changing what the
host publishes breaks old clients with no wire change”. **Server:** the current
API and relay routes contain no push-notification endpoint; live encrypted
traffic uses `apps/relay/src/cell/cell-server.ts`.

Version one uses local notifications derived from events received while the app
is allowed to run. It does not promise continuous background sockets on iOS and
does not present silence as proof that a host or agent is idle. On foreground,
the app refreshes the cloud session if needed, reconciles account pairing,
reconnects direct/relay transport, reauthenticates the runtime, and catches up
from host-published sequence/cursor state before notifying.

Notification payloads contain the minimum local summary and no prompt,
terminal, secret, token, or host path. Turning notifications off does not alter
pairing, relay demand, or host authorization.

## Verification and delivery

**Contract:** `docs/reference/cloud-endpoints.md` § “Conventions”,
`docs/reference/relay-server-contract.md` § “Lifecycle”, and
`docs/reference/remote-wire-compatibility.md` § “Enforcement”. **Server:**
conformance targets are `apps/api/src/routes/cloudAuth.ts`,
`apps/api/src/routes/desktop.ts`,
`apps/api/src/controllers/accountPairing/account.ts`,
`apps/api/src/controllers/accountPairing/host.ts`,
`apps/relay/src/director/director-server.ts`, and
`apps/relay/src/cell/cell-server.ts`.

Implementation proceeds in client-only vertical slices: OAuth and secure
session storage; installation registration and machine directory; HPKE pairing;
direct E2EE; relay/resume; read-only sessions/chat/terminal; write-gated input;
then local notification and offline polish. Each slice must work against the
already-deployed service before the next depends on it.

Tests cover exact OAuth parameters and callbacks, refresh failure classes,
installation proofs, HPKE vectors and associated data, host-key pinning,
grant cleanup, direct/relay parity, strict relay schemas, E2EE transcript and
counter failures, capability absence, tab-id containment, Bypass gating,
viewport non-mutation, unknown-outcome input, sign-out races, and local cache
redaction. Physical-device checks cover the Local Network prompt, denial
recovery, Tailscale and LAN changes, background/foreground recovery, and
SecureStore persistence.

## Would require a server change (out of scope)

**Contract:** `docs/reference/cloud-endpoints.md` § “User-scoped
authentication” and `docs/reference/relay-server-contract.md` § “Versioning”.
**Server:** accepted OAuth clients/redirects are in
`apps/api/src/lib/cloudAuthContract.ts`; current account and relay surfaces are
implemented by `apps/api/src/controllers/accountPairing/account.ts`,
`apps/api/src/controllers/accountPairing/host.ts`,
`apps/relay/src/director/director-server.ts`, and
`apps/relay/src/cell/cell-server.ts`.

Reusing `terminalx-mobile` with the exact `terminalx://auth/callback` redirect
means the TerminalX Next mobile app must claim the `terminalx://` scheme on the phone.
It therefore cannot be installed alongside the existing TerminalX mobile app.
The owner must choose between the two no-server-change options for this plan:

1. the TerminalX Next mobile app replaces the existing mobile app; or
2. mobile sign-in waits until a distinct server-side client/redirect entry is
   available.

This is an owner decision, not something the client implementation can resolve.
The baseline above otherwise requires no server change. The following are not
part of it:

- a new mobile client id or redirect such as `terminalx-next://...`; the
  deployed API accepts `terminalx-mobile` with exactly
  `terminalx://auth/callback`;
- remote push-notification registration and delivery;
- cloud-stored sessions, transcripts, terminal output, activity, or mobile UI
  cache;
- additional directory fields, pairing scopes, grant behavior, HPKE suites, or
  host capabilities; or
- relay schema extensions, new control messages, or an E2EE framing version
  other than v2.

Any such feature needs a separate server contract and rollout. The Expo app
must not probe undocumented endpoints or send speculative fields.
