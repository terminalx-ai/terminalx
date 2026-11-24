# PRO-125 desktop events and unread reconciliation

The inbox uses the accepted SaaS contract and the existing native
`phase2_desktop_contracts_available` command. The native gate defaults off
and checks the authenticated session for a member organization with explicit
`team.events.v1` readiness. Notification delivery also checks readiness and
membership for the event's organization. Production rollout remains held.

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
prevent checkpoint advancement. A crash between applying a cache invalidation
and saving its ID can repeat that invalidation. Banner delivery starts after
the event ID is recorded durably. Exiting after that write and before delivery
can suppress the best-effort banner on the next launch.

## Access and unread

Share-added and reassigned events request fresh catalog data. Share-removed uses only the minimal workspace
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

## Notification behavior

The desktop offers a macOS banner for a targeted share grant or permission
change and for a typed reassignment to the current user. The original PRO-125
server slice reserved reassignment. The typed reassignment comes from the
follow/reassign contract and requires that feature's explicit readiness
alongside inbox readiness. Shares require a live member organization with
`team.events.v1`.

After the durable inbox write, a live workspace list confirms access using the
existing native catalog command. One authorization request covers the eligible
events for an organization in a page. The response authorizes only those
events, including when the previous and current requests start in the same
millisecond. Reassignment also requires the catalog's authenticated viewer to
match the new owner. Account or context changes, privacy mode, lost membership
or readiness, and revocation fence pending delivery. A live catalog refresh
that withdraws access while the list request is in flight cancels the event.
The in-app reassignment notice also disappears when authorization lapses,
including after the macOS banner request finishes. Share removal, presence
and self read-marker changes update existing state and caches quietly.

When the inbox starts or its account context changes, it polls the retained
pages without waiting for new events. These pages still repair the catalog and
unread state and can populate authorized in-app reassignment notices. macOS
banners begin with live delivery after catch-up is checkpointed, so signing
back in or leaving data privacy mode cannot repeat banners from the old cursor.

For screen 13.16, the existing sidebar rows show grants and synced unread state.
The existing reassignment notice shows the authorized workspace name, actor
and optional note. The dedicated Notifications panel, unread total, Mark all as
read, and `⌘⌥L` next unread are deferred. For screen 17.06, the main window uses
the existing macOS focus and permission path, with a second authorization and
focus check before sending. Banners use generic copy without names, notes,
identifiers or activation targets. Mention copy and actions belong to the
mention contract. The existing attention badges continue counting session
activity.

## Verification and remaining acceptance

Focused tests cover disabled and enabled readiness, same-millisecond list
authorization, private or revoked access, permission and focus races, failed
delivery writes, fallback/reconnect, duplicate replay/relaunch, stalled and late receipt retry,
partial-page application, filtered-page checkpoints, bigint validation, account
and readiness races, privacy shutdown, revoke invalidation versus an old list,
same-email native identity changes, monotonic catalog/event/write reconciliation,
late writes and runtime callbacks, startup catalog markers before true/false
readiness, saved catalogs after durable revocation, and existing local
unread/AppShell behavior.

With the routes, migration, Redis fan-out, Caddy SSE configuration and explicit
readiness deployed to an authorized environment, verify that a share reaches
the teammate's sidebar within two seconds with the window visible and hidden.
On two Macs signed in to the same account, open a finished session on the
first and verify its bold row clears on the second within two seconds. Also
verify deployed SSE fallback and recovery without duplicate banners, macOS
banner timing and permission behavior, native disk cache authorization, and
private workspace isolation across accounts. This desktop check used frontend
fixtures and mocked native commands. Live timing and visual acceptance remain
pending authorization and an available two-device nonproduction environment.

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
