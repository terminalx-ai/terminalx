# PRO-125 desktop events and unread reconciliation

This slice builds on accepted SaaS source `b94a5de6fdb2a0cbed5931a879c5092a28eb9561`
and the shared desktop contracts. The inbox uses the existing native commands and
waits for `phase2_desktop_contracts_available` to return true. The native check
requires the authenticated session to advertise `team.events.v1` for a member
organization. Per-organization readiness also applies to banner delivery.
Catalog polling continues when readiness is absent, denied, or unavailable.

## Delivery

AppShell starts the account subscriber after privacy boot, alongside the existing
catalog boot. Identity uses native `context.account`, never email or an inbox
user/org selector. Every account/context/privacy transition fences old async work.
Sign-out, account switches and entering privacy mode clear the outgoing durable
cursor and receipts, so a later sign-in can replay retained events. No
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
the event ID has been recorded durably. A crash or exit after recording but
before the banner can suppress that best-effort banner on the next launch.

## Access and unread

Share-added and reassigned events request fresh catalog data. Share-removed uses
only the minimal workspace
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

The server addresses share grants and permission changes to the grantee. The
desktop offers a macOS banner for a share after a fresh live list confirms
organization workspace access. It also offers a banner for the typed reassignment
event when both organization features are ready and the current catalog
identifies the recipient as the new owner. The original PRO-125 server slice
reserved reassignment, with the typed payload supplied by the follow/reassign
contract. The existing in-app reassignment notice can show the authorized
workspace name, actor and note. Banners use generic copy and carry no names,
notes, organization or workspace IDs, or activation targets.

The main window uses the existing focus and notification permission path.
Banners require TerminalX to be out of focus and recheck focus and authorization
after the permission check. Catalog access loss, an inbox revocation, and an
account, context or privacy change fence pending banners. Share removal,
presence and self read-marker changes only update existing state and caches.

For screen 13.16, the sidebar and existing unread rows show grants and synced
read state. The existing reassignment notice handles its in-app presentation.
The dedicated Notifications panel, unread total, Mark all as read, and
`⌘⌥L` next unread remain deferred under the screen-review decision. For
17.06, reuse the macOS banner behavior with generic share and reassignment
copy. Mention copy and associated actions belong to their own event contract.
The runtime's existing attention notices and dock badge count session activity.

## Verification and remaining acceptance

Focused tests cover readiness, authorized share/reassignment banners, quiet hints,
cached and denied rows, privacy, revocation, focus and permission races, a failed
delivery write, fallback/reconnect, duplicate replay/relaunch, stalled and late receipt retry,
partial-page application, filtered-page checkpoints, bigint validation, account
and readiness races, privacy shutdown, revoke invalidation versus an old list,
same-email native identity changes, monotonic catalog/event/write reconciliation,
late writes and runtime callbacks, startup catalog markers before true/false
readiness, saved catalogs after durable revocation, and existing local
unread/AppShell behavior.

After the routes, migration, Redis fan-out, Caddy SSE configuration and explicit
readiness are available in an authorized environment, verify a grant reaches a
teammate's sidebar within two seconds with the window visible and hidden. On two
Macs signed into the same account, open a finished session on the first and verify
its bold row clears on the second within two seconds. Also verify deployed SSE
drop and recovery without duplicate banners, real macOS banner timing and
permission behavior, and private workspace isolation across accounts. This slice
used frontend fixtures and mocked native commands. An authorized nonproduction
two-device environment was unavailable for the live checks.

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
