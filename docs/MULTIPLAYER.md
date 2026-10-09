# Local session sharing

Issue: [#397](https://github.com/terminalx-ai/terminalx/issues/397), following the
original [#5 multiplayer plan](https://github.com/terminalx-ai/terminalx/issues/5).

Local sharing is implemented on the desktop host and guest. Cloud workspace
sharing continues to use `collab/1`; see [CLOUD-SHARING.md](CLOUD-SHARING.md).
Mobile joining is a follow-up. Anonymous and browser-only clients are excluded.

## Service boundary and rollout

The host owns invitations, people, approval, roles, notes, leases, the input
queue, and the activity log. The relay carries encrypted frames; it stores no
session content or account access tokens. Sharing requires host sign-in, but
neither a common organization nor a `multiplayer.use` entitlement. Relay
transport requires the host's existing `relay.use` entitlement.

The companion server implementation is
[terminalx-saas#185](https://github.com/dudhatparesh/terminalx-saas/pull/185).
A snapshot is included in
[patches/397-terminalx-server.patch](patches/397-terminalx-server.patch), based on
server commit `cbd7a536`. It adds the public HTTPS `/join` landing page on
`console.terminalx.ai`, a verified email assertion in the
capabilities response, and reusable, revocable session relay invitations.
Deploy these before releasing the desktop feature. Older APIs fail closed for
named-account links; older relays cannot mint session invitations. No database
migration is required. The patch includes API and relay tests and all fourteen
landing-page translations.

Normal production deployment remains a merge to `main` followed by the existing
poller, including the console's join page. The marketing site's join route is
also included for a future website release; new links use the deployed console.

## Invitations and policy

Choose **Share session…** from a local session's sidebar menu or its header.
Create several independent links, copy a concealed secret or its QR, and edit or
revoke each link in the same dialog. The dialog explains that guests see prior
transcript and terminal content, and drivers can ask an agent to run commands
and change files on the host machine. Forwarding an unrestricted link admits
another signed-in person.

Defaults: any signed-in account, can drive, one-hour expiry, eight guests,
approval off, permission approval off, and reusable. Options are:

- Any signed-in person, verified named accounts, or host organization members.
- Driver or read only; named accounts may each have their own role.
- Expiry from fifteen minutes through twenty-four hours, manual admission,
  separate permission approval, a one-to-thirty-two-person cap, and single use.
- Direct transport only, or direct with relay fallback.

The named-account gate requires the API's `cloud.emailVerified` assertion and
an exact normalized email match. A guest's claimed name, email, role, and user
id never enter admission. Restriction checks run before creating an approval
request, so outsiders are never shown to the host as pending people.

Settings edits use the same link. The encrypted invitation is bounded to
24 hours from creation; the editable admission expiry can be extended within
that bound. Expiry prevents new joins; existing admitted people remain until
removed. A single-use link is consumed when a person is actually admitted,
including manual admission. Enabling single use on a live link retains one
admitted person and removes the others. Pending approval counts toward caps.

Live edits remove newly disallowed people, apply roles and permission grants,
release demoted drivers' leases, and discard their pending inputs. Lowering a
cap removes excess people immediately. Approval applies to new people; enabling
it preserves people the host has already admitted. Disabling it admits eligible
pending people, subject to single use and caps.

## Identity and lifecycle

A fragment-only HTTPS link offers to open `terminalx://join#…` or install the
app. Neither the bearer secret nor host key is sent in the browser's HTTP
request. The desktop handles cold-start and already-open deep links, retains a
pending join across normal sign-in, and renders a guest session after sign-in.

The invitation pins the host key and proves invitation possession. Inside the
existing pairing E2EE channel, the native guest sends its account access token
with `session.authenticate`. The host verifies it with
`POST /v1/desktop/auth/capabilities`, which returns a stable user id, display
identity, verified-email assertion, and memberships even without a shared
organization. Access tokens stay in native code and are never given to the
renderer or relay.

The host rechecks account validity every thirty seconds, with at most a
sixty-second verified-identity lifetime. Native guests renew changed access
tokens and close on sign-out or account changes. Failed verification closes
access. Revocation interrupts an identity lookup that is still waiting.

Share links, admissions, and connections exist only in host process memory.
They are never installed in the persistent host-wide pairing registry. Removing
someone closes their connections and blocks that user from the same link.
Revocation normally removes all guests; the CLI can keep existing guests while
preventing new joins. **Stop sharing** destroys all links, people, leases, and
pending inputs. A restart starts unshared; old credentials cannot restore it.
Host sign-out also stops sharing.

## Scoped RPC and write admission

`DeviceScope::Session` uses a separate pairing route after the common E2EE
handshake. It never enters the mobile runtime's host-wide subscriptions or RPC
router. Even a disk entry claiming session scope is refused by that router.
The guest sees exactly the invited session and public agent tab IDs.

The exact allowlist is:

| Methods | Authority |
| --- | --- |
| `session.authenticate`, `session.status` | Sign-in / pending admission |
| `session.tabs.list`, `session.tail`, `terminal.read` | Admitted reader |
| `presence.heartbeat`, `chat.post`, `chat.list` | Admitted reader |
| `session.send`, `session.queue`, `session.steer`, `session.stop` | Driver and tab lease |
| `steerLease.release` | Current person |
| `permission.respond` | Separate `canApprove` grant |

Unknown methods and extra parameters are refused. Every request includes the
bound session id. Writes resolve the public tab again against that session.
There is no remote PTY ID, filesystem path, process handle, tab creation,
terminal creation, shell input, git, model/effort/mode change, or settings route.
Only the existing safe cloud slash-command set is accepted; direct `!` shell
messages and other slash commands are refused. Permission approval does not
open those other routes.

A single host admission evaluator checks admitted identity, role, the separate
permission grant, and tab lease. Mode changes and link lifecycle operations
serialize with writes using the sharing mutex. A session containing any Bypass
tab cannot be shared. A shared session cannot switch a tab to Bypass or add a
Bypass tab.

The guest queue remains on the host, outside opaque agent queues. Input is
checked again when an idle tab receives it. CLI input that waits for readiness
is checked a third time at the actual PTY writer, with a connection revision,
tab cancellation generation, current public-tab resolution, and mode check.
Demotion followed by promotion cannot revive an old waiting input. Host
takeover, stop, or release cancels waiting input even after a lease expires.
Steering interrupts the active turn, then resumes the agent with the steering
prompt; it does not leave a guest prompt in an agent-owned queue.

## Presence, content, and bounds

Presence aggregates windows and devices by verified user id. The host dialog
shows verified identities, viewing/typing, approval requests, driver leases,
removal, takeover, notes, and activity. Prompt events preserve the verified
sender through the portable transcript and chat renderer. Notes are separate
from agent prompts; both host and guests can post them.

The guest view reuses the portable transcript builder and desktop chat. It reads
bounded transcript pages, subscribes only to that session's agent events, and
renders agent and session shell terminals at the host's PTY dimensions without input or remote
resize. Shells have ephemeral public tab IDs that resolve only to that session's live
PTYs; they never accept input. Terminal snapshots refresh once per second; tab state refreshes every
two seconds. A slow event reader is disconnected rather than silently losing
transcript updates.

Limits: 32 distinct guests per session, 128 open connections, 32 links per
session, 64 queued follow-ups, 16 KiB messages, 60 invitation attempts per minute
per link, 30 RPC requests per second per connection, and writes no faster than
four per second. Notes and in-memory activity are bounded. Activity also appends
to the host session's `share-activity.jsonl`, without credentials or link URLs.
A driver lease lasts thirty seconds after the last accepted write. The host can
always take over, including by sending a prompt.

## Verification

Rust tests cover unrelated-organization identities, verified email and
per-person roles, approval, live edits, caps, single use, expiry, identity
renewal, lease arbitration, permanent cancellation of delayed inputs,
revocation, the real scoped router, exact parameter allowlists, and both Bypass
boundaries. An HTTP fixture verifies capabilities authentication and refuses
invalid or incomplete principals.

Frontend tests cover sign-in gating, policy defaults, per-account roles,
permission approval, native session binding, connection-specific closure,
early revocation, and visible sender attribution. Server tests cover stable
identity without organizations, verified-email failures, anonymous/invalid
credentials, reusable and expiring relay invitations, revocation, and unchanged
single-use phone pairing. WebKit exercises the host dialog and guest view.
