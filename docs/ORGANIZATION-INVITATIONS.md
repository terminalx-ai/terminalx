# Invitations and member welcome (PRO-175)

The sidebar and Settings → Organizations share the signed-in account's pending
invitations. The existing desktop `/invites` list and accept/decline routes are
called by the native organization-members client. Tokens stay native. Each
command requires the caller's account context revision and checks it again when
the response arrives. Invitations do not require an active organization.

The in-memory store invalidates old requests on account/revision changes,
serializes each invitation's actions across surfaces, and prevents a list
started before a successful mutation from restoring that invitation. Catalog
refreshes also refresh invitations; a 30-second visible-window poll covers
accounts with no organizations yet. Expired invitations are removed locally;
revoked, unverified-email, entitlement, permission and unknown-outcome failures
have actionable messages. A lost response is never silently retried as a write.

Acceptance forces a fresh membership read after any older account read. The
existing catalog subscription sees the resulting membership and lists its
organization without restarting or selecting it as the default. A failed
membership read leaves an explicit refresh action, rather than undoing a
successful acceptance.

An expanded organization section or its settings page shows the welcome card
until dismissed. Its dismissal is stored in the webview's durable localStorage,
versioned and keyed by the native account ID and organization ID (not email).
A failed storage write leaves the card visible. The optional personal-route
link opens the existing `organizations.agentRoutes` setting for that account
and organization; it does not open any credential/sign-in dialog.

Readiness is freshly read for the named organization: accessible repositories
from the authorized GitHub App list, each supported login agent's explicit
`agent-credential` preflight check, available compute providers, and admin/owner
names from the existing membership-authorized roster. Missing agent checks on
an older server are unknown, never ready. Read failures are unavailable;
loading, not-ready and unknown are separate states. Preflight describes access
for the member's own private workspace, not a live provider inference check.
Provider discovery currently requires the default organization on the server.
For a newly joined organization that is not the default, the card explains this
and links to that organization's existing Settings page. Only the user's
explicit selection there changes the default; the resulting account revision
triggers a fresh readiness read. This is distinct from transient unavailability.
Compute availability is not a promise of quota, capacity or create permission.
No request starts compute. This does not replace PRO-128 roster/profile,
PRO-191 setup, PRO-200 routes, or PRO-241 introduction/announcements.

Server contract was inspected at fetched server `origin/main`
`b05ddb86d16b68fded09d951a7390532af1bd099`, not the older dirty server checkout.
No server change or migration is needed. New HTTP calls reuse the existing
organization-members client; the compute read uses the existing scoped cloud
client. The pending PRO-244 native privacy transport and PRO-252 rollout must
be reconciled against actual landed code before publication. Neither pending
branch is represented as a dependency already delivered.

Validation includes Vitest components, stale requests/actions, account and
membership refresh integration, durable dismissal isolation, and native HTTP
contract tests. `pnpm test:webkit-invitations` exercises the actual built app in
WebKit with the existing Tauri fixture bridge, including keyboard acceptance,
light/dark sidebar wrapping, decline and dismissal after reload. Authoring or
syntax-checking this script does not count as browser execution. See the
external PRO-175 status/evidence for which checks actually executed; native,
full, normal commit-path and WebKit gates remain required.
