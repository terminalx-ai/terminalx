# PRO-125 desktop events and unread reconciliation

This slice implements accepted SaaS source `b94a5de6fdb2a0cbed5931a879c5092a28eb9561`
and the authoritative `/Users/pareshdudhat/phase2-orch/PRO-125-handoff.md`.
Production activation remains held. The lead has collected the accepted shared
contracts commit `ccbdda8505b58994ac3e3da7cfe74f39b3262486` alongside this slice.
`desktopInbox.ts` implements a concrete typed adapter using the existing `invoke`
wrapper and the exact native command names and arguments from that branch. It
does not cast nonexistent API methods into existence. An absent native readiness
command, rejection, or authoritative false answer leaves new requests disabled. Collecting that branch alone must not enable production.
See its `docs/PHASE2-DESKTOP-CONTRACTS.md` for mandatory SaaS route/schema/auth/
migration integration and the explicit lead authorization needed to lift the gate.
Provider negotiation and multi-org support are not inbox readiness signals.

## Delivery

AppShell starts the account subscriber after privacy boot, alongside the existing
catalog boot. Identity uses native `context.account`, never email or an inbox
user/org selector. Every account/context/privacy transition fences old async work;
identity changes clear the outgoing account's durable cursor and receipts. No
network retry of the held readiness gate runs in a loop. Catalog polling continues
at its existing focused/background/changing cadence regardless of inbox health.

The native stream method returns a page at an SSE checkpoint. Each visible event
is applied and its ID saved before the scanned checkpoint is saved. IDs and cursors
stay canonical decimal bigint strings. Checkpoints advance over fully filtered
pages; `hasMore` long-poll pages continue immediately, including empty pages.
Completed checkpoints provide the durable dedup watermark; partially applied
pages retain their applied IDs. The inbox storage record holds only checkpoint/receipt IDs,
not event payloads, names, session IDs or notification bodies.

A dropped stream immediately falls back to `desktopInbox(cursor, 25000)` and
reconnects with exponential backoff bounded at 60 seconds. Poll failures also
back off. Receipts remain queued durably, retry in batches of at most 100, and
never mark activity read. Receipt retries run on their own timer and time out
after 30 seconds; even a never-settling receipt POST cannot stop polling or
reconnects. Late acknowledgements remove only their own IDs, retaining events
delivered meanwhile. Storage failures
prevent checkpoint advancement. A crash between applying an idempotent cache
invalidation and saving its ID can repeat that invalidation; this creates no
notification or other non-idempotent external action.

## Access and unread

Share-added and reserved reassigned events only request fresh catalog data.
No reassigned producer is claimed. Share-removed uses only the minimal workspace
ID to invalidate every locally known matching organization: rows, session and
pipeline caches, placement/name metadata, read markers, agent stores, mirrors,
terminal/editor views and connections. It does not derive an organization, actor or message from the
event. Pre-invalidation list/feed/cache-load results cannot restore those rows.
Agent cache/checkpoint/live reloads and late operation/runtime callbacks are
blocked by an account-scoped durable denial (including a workspace-only denial
before its organization is known) until a fresh authorized catalog grants
access. This does not permanently
delete native cache files or invent a workspace deletion/tombstone. The existing
native cache authorization remains necessary; physical native cache deletion is
not claimed by this desktop slice. Saved catalog loads also filter those durable
denials before showing cached rows or sessions.

Catalog markers, self-only read-marker events and successful write responses
merge monotonically. Session markers compare the rendered `lastMessageAt` for
that actual runtime session; whole-workspace markers remain independent. An
unknown activity timestamp never clears unread. A delayed snapshot cannot
restore unread already covered by a newer marker. Later activity remains unread.
Revocation clears markers and fences pending writes. Viewing a cloud agent tab
keeps existing local/runtime mark-read behavior, and additionally writes the
rendered activity time using its runtime session ID, never its desktop tab ID.
Future/invalid activity dates are not sent. Denied/unavailable writes preserve
local behavior. No optimistic server marker is fabricated. Marker memory clears
on identity/privacy changes. Context refreshes fence pending writes while
retaining the same account's markers. Ownership is established synchronously
before catalog boot and before asynchronous readiness; enabling writes never
clears markers received during startup, including markers below an already
durable inbox checkpoint.

Accepted events are access hints and self read markers, not completion or needs-
attention events. They intentionally do not call macOS notifications or create
an in-app notification panel. Existing runtime attention still owns the existing
focus-aware `notify.ts` hook and badges. No new error, event type, PRO-167 API,
restart event, or PRO-128 change is introduced.

## Verification and remaining acceptance

Focused tests cover fallback/reconnect, duplicate replay/relaunch, stalled and late receipt retry,
partial-page application, filtered-page checkpoints, bigint validation, account
and readiness races, privacy shutdown, revoke invalidation versus an old list,
same-email native identity changes, monotonic catalog/event/write reconciliation,
late writes and runtime callbacks, startup catalog markers before true/false
readiness, saved catalogs after durable revocation, and existing local
unread/AppShell behavior.

Integrated SaaS live readiness, real native two-account/cross-device delivery and
macOS notification/hidden-window timing, disk cache access enforcement, and
visual/design acceptance remain lead/native/server acceptance. No production
service, compute, deploy, push or activation was used. This is desktop slice
implementation, not whole-ticket certification. Native transport contract checks
use local mocked HTTP responses; frontend checks use mocked native commands.

## Lead integration validation

The accepted native contracts are collected on the desktop wave branch. Production activation remains held until SaaS shared integration and live readiness are confirmed. Contract checks use local HTTP mocks and frontend fixtures; they do not certify live delivery, native two-account timing, or deployed restart/reattachment. Existing catalog polling remains enabled.

## Coalesced hints and retained replay

The integrated SaaS contract at `56c2253d` coalesces read-marker hints and retains
delivered inbox rows for 30 days. A hint's marker payload is folded monotonically
for immediate feedback, then the authorized catalog is invalidated and listed
again to retrieve the latest `readMarkers`; one event per PUT is not assumed.

Startup and recovery from a closed stream or failed polling request explicitly
resynchronize every live authorized organization's full catalog. Old in-flight
lists/feed responses are fenced before a fresh list is requested. The retained
inbox cursor is preserved for deduplication, but is never treated as proof that
all access or read-marker changes remain replayable. Account/context generations,
current membership, and privacy mode fence queued resyncs. Catalog refreshes do
not block inbox delivery, receipts, or long-poll fallback. Normal checkpoint pages
continue the same logical replay; transport failure/recovery triggers resync.
Production activation remains held.
