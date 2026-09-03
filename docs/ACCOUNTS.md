# Accounts, device pairing and cloud sessions

Status: Phase 1 decision

Date: 2026-09-02

Issue: [#6](https://github.com/terminalx-ai/raccoon/issues/6)

## Decision

**Do not build or operate an account backend yet.** Keep Raccoon account-free,
with no new outbound request, persistent cloud identity or heartbeat. Phases 2
through 5 of issue #6 remain designs, not approved implementation work.

The near-term path is account-free pairing over a network the reader already
controls: QR first, direct LAN or Tailscale transport, and no hosted relay. That
delivers the useful core of remote control and session sharing without making
Raccoon an identity provider or network operator. It belongs in the pairing
issues, not this documentation-only phase.

This is a reversible decision. The service-backed design below is the shape to
use if the operational gates in this memo are met. The current README remains
the truth until then; its proposed replacement privacy text is included below
but must not be applied before the corresponding behavior ships.

## Why not run the service now

An account is not just another settings field. It introduces a continuously
available security boundary and changes a simple product promise: today no
Raccoon account exists and every Raccoon-originated network request is both
enumerated and reader-initiated. The proposed service would add stored personal
identity, ambient liveness traffic while signed in, remotely usable device
credentials and a relay carrying encrypted interactive traffic.

The account-free alternative is narrower but complete on its own:

| Choice | What it enables | What it gives up | Continuing obligation |
| --- | --- | --- | --- |
| QR + direct LAN/Tailscale | Explicit device pairing and encrypted remote control on a reachable network | A machine directory, QR-free pairing and off-network relay | Client security and compatibility |
| Account + directory + relay | “Your machines”, QR-free pairing and connectivity across unrelated networks | The current no-account/no-ambient-traffic posture | Identity, state, uptime, abuse response, privacy operations and relay capacity |

There is not yet an accountable service owner, backup on-call owner, chosen way
to authenticate a person, retention/deletion policy, availability target,
hosting region, relay traffic forecast or approved operating budget. Starting
with those unset would make the client depend on a service whose security and
failure behavior nobody has agreed to own.

## What the service costs

The cost is mostly the obligation to run it correctly, not the number of HTTP
routes. A production decision commits to all of the following.

| Cost area | Minimum commitment | Main growth or failure driver |
| --- | --- | --- |
| Engineering | Authorization server, directory, grant broker, relay, migrations, client integration and operator tooling | Protocol changes, recovery cases and platform clients |
| Stateful infrastructure | Application compute, transactional database, encrypted backups and tested restore | Users, hosts, refresh sessions and grant churn |
| Relay infrastructure | Long-lived connection handling, regional placement, backpressure and frame limits | Concurrent sockets and relayed bytes, especially terminal output |
| Security | Secret rotation, dependency response, abuse controls, rate limits, audit records and external review before pairing ships | Internet exposure and the value of remote terminal access |
| Reliability | Monitoring, alerting, deploy/rollback, database recovery, incident handling and a public status channel | The availability target and number of regions |
| Identity operations | Account bootstrap, email or upstream identity integration, recovery, revocation and support | Login volume, account loss and takeover attempts |
| Privacy operations | Data inventory, retention, export/deletion, incident notification and truthful product documentation | Stored email, host metadata, IP addresses and connection records |
| People | A primary owner and a backup who can respond when the service or a credential is compromised | Continuous coverage, not average traffic |

The monthly cash model is:

```text
fixed = API compute + database + backups + monitoring + identity/email + DNS
variable = relay egress + relay connection capacity + login messages + log volume
total = fixed + variable + paid engineering/on-call time
```

The first capacity estimate can be made without choosing a vendor:

```text
steady heartbeat requests/second = signed-in live hosts / 30
active grant polls/second = in-flight QR-free grants / 2
relay traffic/month = sum of encrypted frame bytes for relayed connections
directory rows = users + cloud sessions + hosts + live/recent grants
```

Those numbers, plus peak concurrency rather than daily averages, are the input
to provider quotes. Relay traffic needs its own hard budget and overload policy;
terminal streams can dominate every other cost even when the directory is tiny.

No dollar estimate is defensible until a provider, region, availability target,
retention period and relay traffic envelope are chosen. Before approval, those
inputs need written quotes, a monthly cap and an owner for overages. A cheap
single-instance prototype is not a production cost estimate: it omits the
database recovery, monitoring and human response that hold credentials safely.

Cloud machines are a separate cost centre and remain out of scope. They add a
compute provider, attested images, a durable provisioning controller, quote and
spend confirmation, billing, lifecycle reconciliation and protection against
billable leaked machines. They must not be smuggled into the account service.

## Gates for revisiting the decision

All of these must be answered before Phase 2 starts:

1. Name a primary service owner and a backup, with an incident path.
2. Choose how a person authenticates and recovers an account. Running an OAuth
   authorization server does not itself answer how the user proves identity.
3. Choose hosting regions, an availability target and the precise offline UX.
   A service outage must never impair unsigned-in use or sign a reader out.
4. Approve a data inventory, retention periods and account/host deletion rules.
5. Approve a monthly fixed budget, relay egress cap and overload behavior.
6. Specify abuse prevention for authorize, token, pairing-code and relay paths.
7. Complete an independent review of OAuth, pairing, credential storage and
   channel cryptography before any remote terminal capability ships.
8. Resolve the protocol gaps called out under pairing and freeze versioned wire
   contracts before client implementation.

## Invariants if the decision changes

The following constraints are load-bearing:

- Sign-in is optional. A reader who never signs in gets exactly today’s app,
  with no account request, host key, heartbeat or degraded feature.
- Cloud sign-in answers who the reader is. Device pairing authorizes one
  installation to reach one host. Workspace authorization decides what that
  device may do now. None substitutes for another.
- A cloud access token is never accepted by a host as a device credential.
- The service synchronizes authority and liveness, not terminal contents.
- Transcripts, scrollback, prompts, project paths, worktree names, session lists,
  agent output, files, git data and raw device tokens are never uploaded.
- QR/code pairing remains independent of accounts and continues to work while
  signed out or while the service is unavailable.
- Direct and relayed application traffic is end-to-end encrypted. A relay sees
  routing metadata and ciphertext, not device tokens or RPC payloads.
- Device RPC is deny-by-default. A refusal is protocol data that clients render,
  not an exceptional condition that crashes either side.
- Sign-out is a local destructive fence first and a best-effort server request
  last. A late async result cannot restore anything removed by sign-out.

## Smallest hosted service

If approved, v1 is one first-party OAuth 2.0 authorization service, a small
host/grant directory and a ciphertext relay. It has no organisations, roles,
seats, billing, licensing, admin console, workspace catalogue or transcript
store.

### Endpoint inventory

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/auth/authorize` | Start authorization-code sign-in in the system browser |
| `POST /v1/auth/token` | Exchange a PKCE code or rotate an opaque refresh session |
| `GET /v1/me` | Return user id, email and display name |
| `POST /v1/logout` | Best-effort revocation of the server-side cloud session |
| `POST /v1/hosts` | Register or replace the signed-in user’s host binding |
| `DELETE /v1/hosts/:hostId` | Unregister that binding |
| `POST /v1/hosts/:hostId/heartbeat` | Prove liveness and fence on binding generation |
| `GET /v1/hosts` | List the signed-in user’s machines and directory public keys |
| `POST /v1/pairing-grant-requests` | Create a signed QR-free pairing request |
| `GET /v1/pairing-grant-requests/:id` | Read request state or its encrypted offer |
| `POST /v1/pairing-grant-requests/:id/consume` | Atomically consume an installed grant |
| `POST /v1/relay/assign` | Assign a short-lived relay placement |
| `GET /v1/relay/resolve` | Resolve a placement without exposing application plaintext |
| `wss://relay…/connect` | Carry framed ciphertext with backpressure and size limits |

This is the intended public surface, but it is not yet an implementation-ready
grant contract. The list has no operation for a host to discover a pending
request or publish the HPKE envelope, and no explicit revocation operation for
a failed grant. Before Phase 4, the protocol must either define those actions
as versioned semantics on the listed routes or add explicit routes. They must
not be hidden in an undocumented heartbeat response.

The installation-registration step is likewise absent. It must be explicitly
defined as part of grant creation or receive its own route; a server cannot
verify the request signature against an installation key it has never bound.

Account enrolment, verification, recovery and deletion are also not explained
by these routes. Whether the authorization service performs those jobs or
delegates the initial proof of identity is a prerequisite decision, not client
implementation detail.

### Cloud sessions

Access and refresh tokens are opaque server-side session identifiers. They are
stored in the macOS keychain under a Raccoon service name, never in
`settings.json` or another file under `$RACCOON_HOME`. The client refreshes 60
seconds before access expiry. Refresh rotates the refresh token; retrying the
same predecessor during a 60-second idempotency window returns the already
minted result rather than being classified as theft.

An HTTP `400`, `401` or `403` from refresh is terminal for that cloud session.
Timeouts, transport errors, `408`, `429` and `5xx` are transient: the client
reports offline and retries without deleting the local session. The server
must rate-limit the idempotency window and bind its cached response to the same
client session so the tolerance does not become a replay oracle.

Desktop authorization uses a distinct public client id, authorization code +
PKCE with `S256`, scopes `openid profile email offline_access`, the system
browser and a random-port loopback IP redirect. The listener binds only to
`127.0.0.1` or `::1`, validates state and the exact callback path, accepts one
result, and closes on success, rejection or a five-minute timeout. Mobile uses
a distinct public client id and an app-claimed redirect appropriate to that
platform.

## Host identity and binding

`$RACCOON_HOME/host.key` contains a stable Curve25519 private/public keypair.
It is generated lazily after the first successful sign-in, written atomically
with mode `0600` inside the `0700` Raccoon home, and never uploaded in private
form. Losing the file makes a new machine identity; a display-name match must
never silently rebind it.

`hostId` is the first 16 characters of unpadded base64url encoding of the
SHA-256 digest of the canonical raw public-key bytes:

```text
hostId = base64url_no_pad(sha256(curve25519_public_key_bytes))[0..16]
```

The registration payload has exactly these keys:

| Key | Meaning |
| --- | --- |
| `hostId` | Cryptographic id derived from `publicKey` |
| `publicKey` | Canonically encoded Curve25519 public key |
| `bindingGeneration` | Monotonic fence for credentials and async work |
| `displayName` | Reader-editable name; never used as identity |
| `platform` | Coarse platform value, initially `macOS` |
| `appVersion` | Raccoon version used for compatibility decisions |
| `environmentKind` | Coarse host kind, initially local desktop |
| `capabilities` | Versioned public capability identifiers, never session state |

The heartbeat request body contains only `bindingGeneration`; `hostId` is in
the path and the access session supplies the owner. The service derives
`lastSeenAt` from receipt time so a bad client clock cannot fake freshness. A
host is stale after two missed 30-second heartbeats. Registration, heartbeat
and every automatic device credential fail closed when their generation is not
the current server generation.

The Account UI must name the registration fields and the heartbeat in plain
language. It must also say that the service does not receive sessions,
projects, worktrees, paths, prompts, transcripts, scrollback, files, git data,
agent output or device tokens. A future payload-key test must compare the
serialized key set to the table above so adding a field requires an explicit
privacy decision.

## Pairing model

Every successful path installs an ordinary, independently revocable per-device
credential. The host stores only a hash of its random device token. The device
stores the token in device-only secure storage and presents proof inside the
encrypted channel.

Raccoon uses two RPC scopes:

| Scope | Allowed method families |
| --- | --- |
| `viewer` | Presence, shared transcript read, terminal read and shared chat |
| `driver` | Everything in `viewer`, plus gated terminal input and lease operations |

Files, git, settings, session creation, unshared sessions and process creation
are absent from both allowlists. There is no `owner` scope in this design;
adding one must start with its own method-by-method threat review.

A pairing offer contains:

- `endpoint`
- the raw, random `deviceToken`
- `publicKeyB64`, the host key that the channel must pin
- `scope`, either `viewer` or `driver`
- `identityMode`, `inherit` for explicit account-free pairing or
  `authenticate` for an account-bound automatic grant
- an optional relay invite with a maximum ten-minute lifetime

The reference system’s transport-role labels are not reused as authorization
scopes; mixing those two concepts would make the deny-by-default allowlist
ambiguous.

### QR pairing

1. The host creates a single-use offer with a short expiry and displays the
   whole offer as a QR code. It stores only the device-token hash.
2. The client scans and validates the offer version, expiry, endpoint, scope
   and key encoding before opening a connection.
3. The client opens the direct WebSocket, pins `publicKeyB64`, establishes the
   NaCl-box encrypted channel and proves possession of the device token inside
   that channel.
4. The client supplies its installation public key and label through the
   encrypted channel. The host writes `devices.json` atomically only after the
   handshake and acknowledgement both succeed.
5. The offer becomes consumed. Any timeout or failure leaves no device row,
   raw credential or partially trusted connection.

This path does not read or create a cloud account, host binding or cloud token.

### Short-code pairing

A human-sized code cannot carry the endpoint, token and pinned host key. It
therefore needs a rendezvous, and treating the code as an unauthenticated LAN
lookup key would let an observer steal the offer.

For an account-free implementation, the client must first discover and reach
the host on LAN/Tailscale, then use a reviewed password-authenticated exchange
with the short code to recover the same offer securely. Codes are random,
single-use, short-lived and attempt-limited per host and source. The selected
exchange, code entropy and discovery contract must be specified and reviewed
before this path is built.

Off-network code entry would require a hosted rendezvous and therefore is not
part of the no-backend decision. It must never be described as account-free if
it depends on the account service.

### HPKE QR-free pairing

1. A signed-in installation keeps a random installation id and P-256 signing
   key in device-only secure storage excluded from backups. The service binds
   that public identity to one account. Switching the account in place is
   refused; the installation must be reset explicitly.
2. The client reads `GET /v1/hosts`, chooses a live host and remembers the
   directory `publicKey` and `bindingGeneration`.
3. It creates a request id, nonce and ephemeral X25519 key, signs all bound
   fields with the installation key, and posts the grant request. The service
   can validate the account and signature but receives no pairing plaintext.
4. The host verifies the request and generation, creates an ordinary pairing
   offer, and seals it to the ephemeral key with
   `HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305`. Associated data binds the
   protocol version, request id, host id, binding generation, requester
   installation id and both relevant public keys.
5. The client polls every two seconds, opens the envelope with the same
   associated data, then compares the offer’s host public key byte-for-byte
   with the directory key before storing anything.
6. Only after the credential and host record are installed atomically does the
   client consume the grant. Failure revokes the grant and removes any
   provisional local host or credential record; it does not silently keep a
   half-paired device.

The pairing coordinator captures a logout epoch before step 2 and checks it
before every state mutation. Sign-out increments the epoch first. A response
that arrives after sign-out can be decrypted for cleanup if necessary, but it
cannot install a host, device or credential.

HPKE Base mode encrypts to the recipient but does not authenticate the sender.
The installation signature authenticates the requester to the host, while the
subsequent pinned NaCl-box handshake proves that the peer holds the selected
host’s private key. Associated-data checks and host-key comparison prevent
cross-request substitution, but do not replace that handshake. No privileged
RPC may run before it succeeds; cloud authorization alone never proves that an
offer came from the directory host the reader selected.

## Local and server data

Local files under `$RACCOON_HOME` remain inside its `0700` directory:

| Path | Contents and rule |
| --- | --- |
| `host.key` | Curve25519 keypair, `0600`, created on first signed-in binding only |
| `devices.json` | Atomic-rewritten paired-device records; token hashes only |
| `account.json` | Non-secret user id, email, display name and binding generation |

Access tokens, refresh tokens and raw device credentials are absent from these
files. OAuth tokens live in the macOS keychain. Device credentials live in the
platform’s device-only secure storage.

Each `devices.json` entry has exactly these fields:

| Field | Meaning |
| --- | --- |
| `id` | Device UUID |
| `label` | Reader-visible device name |
| `token` | Hash of the device credential, never the credential itself |
| `scope` | `viewer` or `driver` |
| `provenance` | `automatic` or `explicit`; absence is treated as explicit |
| `boundUserId` | Account user id for an automatic device, otherwise absent |
| `bindingGeneration` | Host-binding fence captured when paired |
| `publicKey` | Device public key used by the encrypted channel |
| `createdAt` | RFC 3339 creation time |
| `lastSeenAt` | RFC 3339 last authenticated connection time |
| `revokedAt` | RFC 3339 revocation time, otherwise absent |

The minimum server data is `users`, opaque cloud sessions, `hosts`,
`pairing_grant_requests` and `relay_placements`. There is deliberately no
workspace, session, transcript, prompt, scrollback, project or worktree table.
Connection IPs and timestamps can still be personal metadata; logs must use
short documented retention and must never contain tokens, pairing plaintext or
decrypted relay frames.

## Sign-out and revocation

Sign-out is local-first and destructive for account-derived authority:

1. Increment the logout epoch and durably enqueue unregistration/revocation.
2. Close every live connection authenticated by an automatic pairing.
3. Clear the account-bound installation identity from secure storage.
4. Settle every in-flight automatic grant so late results cannot install.
5. Delete automatic device credentials and their local host records.
6. Delete access and refresh tokens from the keychain and clear
   `account.json`.
7. Attempt cloud host unregistration and `POST /v1/logout`; retain the durable
   record for retry if the service is unreachable.

Explicit QR/code pairings and their sockets survive sign-out by design. Running
agent processes are untouched. Confirmation copy must say all three facts:

> Sign out of your Raccoon account? Automatic pairings will be removed and
> disconnected. Devices paired by QR or code will keep working, and running
> agents will not be stopped.

Revoking a paired device is separate from sign-out. It marks the row revoked,
invalidates the credential and closes its live socket within one second. A
disconnect or lost transport makes remote process state `unverifiable`; it
must never synthesize an `exited` event.

## Reconnect behavior

The retry delays are 0.5, 1, 2, 4, 8, 15, 30 and 60 seconds, capped at 60
seconds through attempt 12, followed by a 90-second trickle indefinitely. At
attempt 3 the client says “Can’t connect”. At attempt 12, or once directory
liveness is at least 60 seconds stale, it says “Unreachable — re-pair?” The
connection does not silently give up and an outage does not sign the reader
out.

## Security note

### Trust boundaries

Cloud, device and workspace authority must use different credentials and
validation paths. A bearer token accepted by the directory is meaningless to
the host RPC server. A device credential proves only its device and scope; it
does not make every workspace visible. A workspace must be explicitly shared
before scoped methods can address it.

The host key is pinned by an explicit offer or checked against the signed-in
directory before a credential is installed. Application messages use a
NaCl-box encrypted channel on both direct and relay transports. The relay is a
dumb framed pipe: it may learn connection ids, public keys, IP addresses,
timing and byte counts, but not device tokens, RPC methods, terminal bytes or
pairing offers.

### Credential rules

- Use a cryptographically secure operating-system random source for every key,
  token, nonce, code and request id.
- Never log authorization codes, PKCE verifiers, access/refresh tokens, raw
  device tokens, HPKE plaintext, keychain values or decrypted frames.
- Keep OAuth tokens in the keychain and host private keys in a `0600` file.
- Generate device credentials with at least 256 bits of entropy, store only a
  cryptographic hash, and compare presented credentials in constant time.
- Make offers, grants, codes and relay invites short-lived and single-use.
- Fence every request and credential with `bindingGeneration`; reject stale
  generations instead of repairing them by display name.
- Rotate refresh tokens and preserve only the one-minute idempotent retry state
  needed to return a lost successful response.
- Return structured `refused` RPC results for methods outside a scope. Unknown
  methods are denied, and adding a method never adds it to a scope implicitly.

### Failure and abuse rules

Authorization and token routes need state validation, PKCE `S256`, exact
redirect matching, rate limits and account-takeover monitoring. The loopback
listener exists only during one attempt, binds only to loopback IP addresses
and closes after one response or five minutes.

Grant requests bind all identities and keys in the installation signature and
HPKE associated data. A mismatch, expiry, replay, bad signature, bad envelope,
host-key mismatch or stale generation fails closed and triggers cleanup.
Pairing codes need strict attempt limits; relay connections need authenticated
placement, frame-size limits, bounded queues and backpressure.

Availability is not authority. If the account service is down, signed-in
features show offline while local work and explicit pairings continue. If a
relay disconnects, no process-exit claim is made. If cleanup cannot reach the
service, local credentials are still gone and durable logout retries later.

### Known exposure

End-to-end encryption does not hide traffic metadata from the relay or network
operator. A reader who shares a `driver` credential grants the ability to type
into a terminal, which can be equivalent to local code execution within the
shared process context. A compromised local user account can read Raccoon’s
files and control its processes; this design does not claim to defend against
an attacker already executing as that user.

Before release, the security policy must add the account service, keychain
tokens, host/device credentials, pairing protocols, direct listener and relay
to its vulnerability scope, and must name a private response path that reaches
the service owner.

The relevant protocol baselines are [OAuth for native apps
(RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252), [PKCE
(RFC 7636)](https://www.rfc-editor.org/rfc/rfc7636), [OAuth 2.0 Security Best
Current Practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700) and [HPKE
(RFC 9180)](https://www.rfc-editor.org/rfc/rfc9180).

## Proposed README privacy diff

Do not apply this patch while the decision is “no backend”: it describes the
eventual service-backed product, not the current build. Apply it in the first
release that makes sign-in available, adjusted to the exact production domains
and shipped phases.

```diff
 ## What leaves your machine

 Raccoon has **no telemetry, no analytics and no crash reporting**. There is no
-account, no sign-in, and nothing is phoned home about how you use it. The only
-outbound connections it makes are these four, all of them things you asked for:
+background connection when you are signed out, and everything that works
+without an account keeps working. If you choose to sign in, Raccoon stores a
+cloud identity and sends the machine metadata and liveness described below.
+The outbound connections it makes are:

 | To | When | Carrying |
 | --- | --- | --- |
 | GitHub | You open the Issues view or a PR panel | Nothing of Raccoon's own — it shells out to your `gh`, which uses your existing credentials |
 | Linear | You open the Issues view with a Linear key configured | A GraphQL query to `api.linear.app`, authorized with the key you pasted |
 | Hugging Face | You press Download on a transcription model | A plain GET for the weights, at a pinned revision |
 | The update endpoint | You press "Check for updates" | The current version and your channel |
+| A directly paired device | You explicitly pair by QR/code or reconnect that device over LAN/Tailscale | The pairing handshake and, after you share a workspace, its allowed RPC and terminal data. The channel is end-to-end encrypted; the network still exposes endpoint addresses, timing and byte counts |
+| Raccoon account, directory and relay service | After you choose to sign in, for identity and the 30-second host heartbeat; or when an explicit pairing offer includes a relay invite and a paired connection cannot go direct | Your user id, email and display name; host id and public key; binding generation; the machine display name, platform, app version, environment kind, capabilities and liveness. A relay also sees connection ids, public keys, IP addresses, timing, byte counts and encrypted frames |

 Some detail on each:

+- **Accounts are optional.** An unsigned-in Raccoon makes no account,
+  directory or heartbeat request. It contacts a relay only when an explicit
+  pairing offer includes an invite and you connect through it. Signing in opens
+  your system browser.
+  Access and refresh tokens are opaque server-side sessions stored in the
+  macOS keychain, not under `$RACCOON_HOME`. Signing in does not pair a device
+  or authorize a workspace.
+- **The host directory contains metadata only.** It receives the host id,
+  public key, binding generation, display name, platform, app version,
+  environment kind, capabilities and a heartbeat used to calculate last seen.
+  It never receives session lists, project or worktree names, paths, prompts,
+  transcripts, scrollback, files, git data, agent output or device tokens.
+- **Remote traffic is end-to-end encrypted.** Direct and relayed connections
+  pin the host key from the pairing offer. The relay routes ciphertext and
+  cannot read pairing offers, device tokens, RPC calls or terminal contents.
 - **The agents themselves.** `claude` and `codex` talk to Anthropic and OpenAI
   the same way they do in your terminal, under your own login. Raccoon does not
   proxy, inspect or re-send any of it; it reads the transcript files the CLIs
   write on disk.
```

The same release must extend “What Raccoon touches outside your repo” with:

```diff
+- **`$RACCOON_HOME/host.key`** — the host’s Curve25519 identity, created only
+  after the first signed-in binding and written `0600`. Losing it creates a
+  new host identity.
+- **`$RACCOON_HOME/devices.json`** — paired-device metadata and credential
+  hashes, atomically rewritten. Raw device tokens are never stored here.
+- **`$RACCOON_HOME/account.json`** — a non-secret mirror of user id, email,
+  display name and binding generation. OAuth tokens live in the macOS
+  keychain, not this file.
```

The “Security” section must also link to this memo’s security note when the
service-backed feature ships. Until then, the existing README and security
policy accurately describe the released product and should not claim that an
unimplemented account or relay exists.
