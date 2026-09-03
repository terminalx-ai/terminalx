# Multiplayer integration plan

Status: Approved client-only plan

Date: 2026-09-03

Issue: [#5](https://github.com/terminalx-ai/raccoon/issues/5)

Raccoon implements multiplayer on the client and host sides while reusing the
deployed TerminalX identity and relay services. The services authenticate
people, report organization membership and capabilities, and carry opaque E2EE
bytes. They do not own Raccoon sessions, chat, presence, permissions, or
terminal state.

## Product and service boundary

**Contract:** `docs/reference/cloud-endpoints.md` § “Scope” and
`docs/reference/relay-server-contract.md` § “Topology” and § “Trust
boundary”. **Server:** `apps/api/src/app.ts` mounts `/v1/desktop` and
`/v1/auth`; `apps/relay/src/director/director-server.ts` and
`apps/relay/src/cell/cell-server.ts` provide director and cell transport.

The Rust host owns session-scoped authorization, presence, notes, steering
leases, write admission, and the activity log. Desktop and Expo clients render
those states and invoke the host's deny-by-default RPC surface. There is no
cloud room record or transcript store.

The shared invariants are:

- sharing is opt-in per session and exists only for the current host process;
  restarting Raccoon returns every session to unshared;
- a participant is one verified person and may have several connected surfaces;
  presence aggregates those surfaces;
- notes are separate from agent input, and promotion to the agent is an explicit
  write-gated action;
- every remote write passes one host-side admission evaluator and one terminal
  writer; and
- conflict resolution is turn-taking through a lease, not OT or a CRDT.

## Identity and capability gate

**Contract:** `docs/reference/cloud-endpoints.md` § “Desktop authentication”,
§ “Session response”, and § “User-scoped authentication”. **Server:**
`POST /v1/desktop/auth/capabilities` is implemented by
`apps/api/src/routes/desktop.ts` and
`apps/api/src/controllers/desktop/auth.ts`; organization roster reads are
implemented by the `/v1/desktop/orgs/:orgId/members` route in
`apps/api/src/routes/desktop.ts` and
`apps/api/src/controllers/desktop/orgMembers.ts`.

The host must have a valid cloud session, an active organization, and the exact
cloud flag `multiplayer.use`. Raccoon reads that flag from the desktop session
or capabilities response and checks it both when rendering `Share session` and
when opening a share. A hidden or stale UI cannot bypass the host check.

A remote surface pairs with device scope `session` and
`identityMode: authenticate`, then sends its `terminalx-mobile` access token
only inside E2EE with `session.authenticate`. The Rust host presents that token
to the existing capabilities endpoint, binds the verified user to the host's
organization, and obtains current authority from the organization roster. The
paired-device credential proves access to the host; the cloud token proves the
person; current roster membership supplies the role. No one of those proofs
substitutes for another.

The host caches a successful principal only for a bounded period, invalidates
it on organization/account changes, and releases presence and leases when a
connection or identity disappears. It never accepts a display name or role
asserted by the guest.

## Share gating and lifecycle

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Rule 3 —
changing what the host publishes breaks old clients with no wire change” and
`docs/reference/relay-server-contract.md` § “Lifecycle”. **Server:** relay
invite and connection lifecycle is implemented by
`apps/relay/src/director/director-server.ts` and the host-control and phone-leg
routes in `apps/relay/src/cell/cell-server.ts`; the per-session policy itself
has no hosted route.

`Share session` remains in the session menu. The Rust host refuses to share if
any tab in that session uses Bypass permission mode. While the session is
shared, changing any of its tabs to Bypass is also refused. The dialog warns
that steering can ask an agent to modify the worktree and that existing
transcript and terminal content may be sensitive.

Opening a share creates an in-memory record keyed by session id, installs a
session-scoped device entry, and produces an existing version-2 pairing offer
for direct and optional relay transport. It does not start a second runtime
listener or create a second E2EE key. Pending invites have a finite lifetime,
are displayed as secrets, and are revocable independently.

Stopping a share is a kill switch. The host rejects new joins, closes all
session-scoped sockets, deletes session device entries, revokes relay
credentials through the control outbox, clears participant bindings, leases,
and queued input, and invalidates invitations and resumption secrets. A stopped
share cannot be revived by reconnecting with old material.

## One host transport and E2EE channel

**Contract:** `docs/reference/relay-server-contract.md` § “WebSocket: host
data”, § “WebSocket: phone leg”, and § “Trust boundary”; the application
handshake is defined by `src/shared/mobile-e2ee-v2-contract.ts` and
`src/shared/mobile-e2ee-v2-framing.ts`. **Server:**
`apps/relay/src/cell/cell-server.ts` implements `/v1/host/data/:connId` and
`/v1/connect/:relayHostId` as the two sides of the byte splice.

The Rust process owns one runtime WebSocket listener and one persistent
Curve25519 host key. Direct and relay sockets enter the same authentication and
RPC pipeline. Individual shares add scoped credentials and policy records; they
never add listeners or host identities.

Every connection completes the existing E2EE v2 hello/ready exchange with
framing 2, text and binary payload kinds, context `terminalx-mobile-e2ee`, and a
desktop public key pinned from the pairing offer. `e2ee_auth` and
`e2ee_authenticated` are encrypted, and the relay-side device identity must
match the authenticated inner device. Data frames use directional keys and
strictly increasing counters. Missing, duplicate, reordered, or injected bytes
fail the channel.

The relay sees routing metadata and plaintext handshake frames, but not device
tokens, RPC bodies, notes, transcript rows, terminal output, or input. Direct
and relay paths therefore have the same application security and host policy.

An unreachable direct endpoint in the Tailscale IPv4 range `100.64.0.0/10` or
under `*.ts.net` adds a hint to check Tailscale on both devices. That
classification is only a connection hint; it never weakens host-key pinning,
credential checks, E2EE, or session authorization.

### Local network permission

macOS Sequoia and iOS require Local Network authorization for direct LAN
pairing and sharing. The iOS app includes `NSLocalNetworkUsageDescription` with
copy explaining that it connects to a Mac the user explicitly pairs. The Mac
can also show a separate incoming-connections firewall prompt when the host
listener first accepts traffic.

The first-run flow is explicit:

1. Before triggering either system prompt, Raccoon explains that the requested
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

## Scoped RPC and tab identifiers

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Rule 1 — a
new optional JSON field on an existing frame is safe” and § “Rule 2 — a new
stream opcode is NOT safe; negotiate it”. **Server:** application RPC is opaque
to the hosted service; relayed frames pass unchanged through
`apps/relay/src/cell/cell-server.ts`.

The host exposes an exact session-scoped router, never a method-prefix escape
hatch. The first implementation uses the established method families:

- identity and host state: `session.status`, `session.authenticate`,
  `session.clearAuthentication`, `session.roster`, and `session.hostControls`;
- presence: `presence.join`, `presence.leave`, `presence.heartbeat`, and
  `presence.list`;
- notes: `chat.list`, `chat.post`, `chat.mentions`, and
  `chat.promoteToAgent`;
- session tabs: `session.tabs.list`, `session.tabs.activate`,
  `session.tabs.subscribe`, and their established all/unsubscribe variants;
- terminal reads and subscriptions: the read-only subset of `terminal.list`,
  `terminal.show`, `terminal.read`, `terminal.subscribe`,
  `terminal.unsubscribe`, and `terminal.multiplex`; and
- steering for a session-scoped participant: `steerLease.queueInput` and
  `steerLease.release`. The broader `get`, `acquire`, `takeOver`, and
  `forceTake` methods remain outside the session-scope allowlist.

All Raccoon remote APIs accept a session/worktree id and public `tabId` only.
They never accept or disclose a PTY id, pane id, raw process handle, checkout
path, or arbitrary filesystem path. Rust resolves `tabId` to the current local
terminal under the session lock, checks that it is still live and still belongs
to the shared session, then applies the operation. Resolution is repeated at
the write boundary so a stale tab mapping cannot target a replacement process.

The allowlist excludes terminal creation, process spawning, files, Git,
settings, repository mutation, host controls, and every desktop IPC/Tauri
command. Unknown methods and params are explicit RPC refusals.

## Presence, notes, and attribution

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Rule 3 —
changing what the host publishes breaks old clients with no wire change” and
`docs/reference/cloud-endpoints.md` § “Session response”. **Server:** identity
and membership are served by the capabilities and organization-member routes
in `apps/api/src/routes/desktop.ts`; presence and note payloads have no hosted
route and traverse the relay cell opaquely.

`presence.join` establishes access to one shared session. Heartbeats describe
surface activity, while the host publishes one participant row per verified
user. A second phone or window increments that participant's live surfaces
rather than inventing a second person. Disconnect and heartbeat expiry remove
only the affected surface; the person leaves when their last surface does.

`chat.post` adds an attributed human note to the local session transcript. It
does not write to the terminal or agent. `chat.promoteToAgent` creates a new
attributed input from an existing note and must pass the same share,
membership, permission-mode, and lease checks as typed terminal input. The host
records the verified user id on every remote note and write; clients may render
the current roster display name but cannot rewrite authorship.

## Steering and viewport policy

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Rule 2 — a
new stream opcode is NOT safe; negotiate it” and § “Rule 3 — changing what
the host publishes breaks old clients with no wire change”. **Server:** the
relay cell forwards steering frames through
`apps/relay/src/cell/cell-server.ts`; steering authority is local to the Rust
host.

One participant may hold the lease for a tab at a time. An accepted remote write
claims the advisory lease; in strict mode, input from a non-holder is parked by
`steerLease.queueInput` until the holder releases or the host ends the turn.
Host-only takeover remains explicit and visible. Input is ordered through the
host queue and rechecked immediately before the single terminal writer;
stopping the share, losing identity or steering permission, changing
organization, entering Bypass mode, or closing the tab rejects queued input.

Remote viewport resize is deliberately unsupported. The remote client renders
the host-published terminal dimensions and may crop, scale, or reflow its local
view, but it never calls `terminal.updateViewport` and never changes the host
PTY geometry. This remains true even when a peer advertises broader TerminalX
mobile methods.

Permission decisions remain host-only. `permission.respond` is not in the
initial router. If implemented later, it must be a separately negotiated future
capability named `permission.respond`, with its own authorization and activity
record; it must never be inferred from general steering access.

## Capability and version rules

**Contract:** `docs/reference/remote-wire-compatibility.md` §§ “Rule 1”–“Rule
3” and `docs/reference/relay-server-contract.md` § “Versioning”. **Server:**
`apps/api/src/controllers/desktop/buildDesktopSession.ts` supplies cloud flags;
relay v1 schemas are enforced in
`apps/relay/src/director/director-server.ts` and
`apps/relay/src/cell/cell-server.ts`.

Raccoon preserves the deployed names and meanings. The cloud gate is
`multiplayer.use`; account-bound host discovery is
`account-bound-host-pairing.v1`; relevant runtime negotiations retain
`remote-runtime.shared-control.v1`, `terminal.binary-stream.v1`,
`terminal.multiplex.v1`, `terminal.query-reply-input.v1`,
`agent-message-attribution.v1`, `terminal.paired-parking.v1`,
`terminal.control-lease.v1`, and `session.workspace-access-events.v1`.

An absent capability means unsupported. Optional JSON additions remain
optional. A new stream opcode, required field, changed field meaning, or changed
publication behavior needs capability negotiation and mixed-version tests.
Relay messages remain literal v1 strict schemas, and the application channel
remains E2EE framing v2.

## Activity log and privacy

**Contract:** `docs/reference/relay-server-contract.md` § “Trust boundary”
and `docs/reference/remote-wire-compatibility.md` § “Rule 3 — changing what
the host publishes breaks old clients with no wire change”. **Server:** there is
no activity-log route; relay traffic is forwarded by
`apps/relay/src/cell/cell-server.ts` without application inspection.

The Rust host appends owner-only JSON Lines to
`$RACCOON_HOME/sessions/<session-id>/activity.jsonl`. Records contain timestamp,
verified actor id, surface/device id, action, tab id when relevant, outcome,
reason code, and input/output byte counts. They never contain prompt text, note
text, agent output, terminal output, secrets, tokens, paths, environment values,
or file contents. Retention is 30 days and cleanup is local.

The hosted services receive only the identity, account-pairing, capability,
relay-routing, and connection metadata their existing contracts require. They
do not receive the activity log, Raccoon session index, tab list, transcript,
or terminal content.

## Verification plan

**Contract:** `docs/reference/remote-wire-compatibility.md` § “Enforcement”,
`docs/reference/relay-server-contract.md` § “Lifecycle”, and
`docs/reference/cloud-endpoints.md` § “Conventions”. **Server:** conformance
targets are the auth routes in `apps/api/src/routes/desktop.ts` and
`apps/api/src/routes/cloudAuth.ts` plus director/cell routes in
`apps/relay/src/director/director-server.ts` and
`apps/relay/src/cell/cell-server.ts`.

Implementation tests must cover capability and organization refusal, Bypass
share gating, exact session-scope allowlists, tab-id containment, identity
changes, multiple surfaces, note/promotion separation, lease races, queued
input invalidation, kill-switch cleanup, and content-free activity records.
Transport tests must run the same scenario over direct and relay E2EE v2,
including corrupted/reordered frames, director moves, drain, reconnect, token
rotation, and relay credential revocation. Mixed-version tests prove that an
absent capability degrades to unavailable rather than silently changing
behavior.

## Would require a server change (out of scope)

**Contract:** `docs/reference/cloud-endpoints.md` § “Scope” and
`docs/reference/relay-server-contract.md` § “Trust boundary” and §
“Versioning”. **Server:** the current boundaries are
`apps/api/src/routes/desktop.ts`, `apps/api/src/routes/cloudAuth.ts`,
`apps/relay/src/director/director-server.ts`, and
`apps/relay/src/cell/cell-server.ts`.

The baseline above requires no server change. These future ideas would:

- durable cloud-hosted share rooms, invitations, presence, notes, transcripts,
  activity logs, or resumption state;
- collaboration outside the organizations and membership data the current API
  can verify;
- server-delivered mobile push notifications for session activity; or
- new cloud capability flags, pairing scopes, relay protocol messages, or E2EE
  framing versions.

They are separate service proposals. Raccoon does not emulate them with
undocumented fields or endpoints.
