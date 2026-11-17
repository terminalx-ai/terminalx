# Accepted Phase 2 desktop contracts (PRO-125 / PRO-212)

Accepted sources: PRO-125 `b94a5de6fdb2a0cbed5931a879c5092a28eb9561`;
PRO-212 `b117bfe47d2274e4df67661db60f8e600dd11171`, collected on SaaS lead
`7cc0f6c7cc6c8f8f50f0ec9700da80dd7233ae44`. The authoritative handoff correction
makes **both `environmentVersion.versionNumber` and `toolchainVersion` integers**.
These accepted contracts do not depend on PRO-167. No roles/share API from
PRO-167 is implemented or assumed here; existing compatible share APIs remain.

## Activation and integration gate

**Production activation remains held.** `api.phase2DesktopContractsAvailable()`
(command `phase2_desktop_contracts_available`) currently returns false. New native
entrypoints reject before network access: inbox/read-marker with retryable
`inbox_unavailable`, restart/details with existing retryable
`cloud_workspace_runtime_not_ready`. Existing catalog/workspace/operation polling
and authentication/provider fallbacks remain available. Provider negotiation and
existing catalog/multi-org capabilities are not readiness signals for these APIs.
No authoritative Phase 2 readiness flag currently exists in the desktop session.
UI workers must hide production entrypoints and retain catalog polling while this
is false; do not retry the held surfaces in a tight loop. Local mock tests enable
the private service gate explicitly and do not enable any production surface.

Before changing `CloudWorkspaceService::new`'s `phase2_enabled: false`, the lead
must explicitly confirm SaaS integration/live readiness and authorize activation.
SaaS integration must register the inbox/read-marker/restart/details routes with
existing desktop Bearer auth, appropriate membership versus active-org middleware,
body limits and authorization tests; integrate inbox schema/barrels/executor and
migration; widen restart lifecycle/action/reason types, operation progress to
`starting`, operation constraint migration and console recovery; keep bootstrap
restart quiesce visible before AND after checkpoint acknowledgement until fencing;
include restart in bootstrap pull reinstall. Accepted/collected worker commits
alone do not establish that SaaS origin/phase-2 or live has those changes. When an
authoritative readiness field is agreed, wire and test it here rather than
inferring availability from providers-v1. No deployment/activation is part of this
slice.

## Public native and TypeScript APIs

All methods are on `api` from `src/lib/api.ts`; every route is under `/v1/desktop`.
Tokens stay native and account/profile generation fences discard stale responses.
All transports send existing `providers-v1`, supported-provider list and
`archive-v1` lifecycle headers. Server visibility, private-creator, role and
policy checks remain authoritative; native membership checks never grant a role.

| TypeScript method | Tauri command | HTTP |
| --- | --- | --- |
| `desktopInbox(after = "0", waitMs = 25000)` | `desktop_inbox` | GET `/organization-inbox?after=…&waitMs=…` |
| `desktopInboxStream(after, lastEventId?)` | `desktop_inbox_stream` | GET `/organization-inbox/stream?after=…`, optional `Last-Event-ID` |
| `desktopInboxReceipts(eventIds)` | `desktop_inbox_receipts` | POST `/organization-inbox/receipts` |
| `cloudWorkspaceReadMarker(orgId, workspaceId, readAt, sessionId?)` | `cloud_workspace_read_marker` | PUT `/orgs/:orgId/cloud-workspaces/:workspaceId/read-marker` |
| `cloudWorkspaceRestart(workspaceId, orgId?)` | `cloud_workspace_restart` | POST `/orgs/:orgId/cloud-workspaces/:workspaceId/restart` |
| `cloudWorkspaceOperationDto(operationId, orgId?)` | `cloud_workspace_operation` (existing) | GET `/orgs/:orgId/cloud-workspace-operations/:operationId` |
| `cloudWorkspaceDetails(workspaceId, orgId?)` | `cloud_workspace_details` | GET `/orgs/:orgId/cloud-workspaces/:workspaceId/details` |

### PRO-125 inbox and markers

`DesktopInboxPage` is `{v:1,cursor:string,hasMore:boolean,events:DesktopInboxEvent[]}`.
IDs/cursors are canonical nonnegative decimal bigint strings through
`9223372036854775807`; never convert them to JS numbers. Inbox identity is the
Bearer account only: no user/org selector, and no active-org requirement.
`waitMs` is 0..25000. Follow `hasMore` immediately even for empty filtered pages;
a cursor may advance without a visible event.

`desktopInboxStream` returns one `DesktopInboxStreamPage` (`{cursor,events}`) at
the first SSE checkpoint, then closes the request. It preserves `Last-Event-ID`
precedence. It bounds frame/page size and rejects incomplete pages or mismatched
SSE/data IDs. Apply/deduplicate event IDs before persisting its checkpoint. Start
another request from that committed cursor. On close/error poll from that same
cursor and reconnect with backoff; native transport does not persist checkpoints
or automatically acknowledge delivery. No JSON error event is invented after SSE
headers. Long-poll remains a complete fallback.

`workspace.share-added` has organizationId and empty payload. `workspace.share-removed`
serializes **only id, type, workspaceId, createdAt**: invalidate caches, disclose no
organization/actor/private metadata. `workspace.read-marker-changed` is self-only
with `{sessionId,readAt}`. `workspace.reassigned` is reserved; no current producer
is claimed. Receipts are `{eventIds:string[]}` (1..100), returning
`{acknowledged:boolean}`; they acknowledge account delivery, not reading, and do
not consume other devices' replay.

Read markers use membership in the target org even when it is inactive. Body is
`{readAt:ISO-string,sessionId?:string}`; omitted session defaults to the workspace
marker `""`. A nonempty session ID must be a real cloud runtime session row,
1..128 characters from `[A-Za-z0-9._:@-]`; never send arbitrary tab IDs. The server
checks existence, collaboration rights, private creator access and future dates.
It returns stored `{sessionId,readAt}` for older/equal writes, without an event.
Workspace/session markers are independent. `CloudWorkspaceListItem.readMarkers?`
preserves catalog ISO timestamps; compare the relevant marker against rendered
activity time. Access revocation hides retained markers server-side.

`inbox_unavailable` (503) is the sole new server domain code added to
`known_error_code` and means fallback/retry, never sign-out. Restart adds only
allowlist coverage for the existing lifecycle codes listed in its handoff. Existing 401 invalid-access-token handling remains;
403/404 privacy, collaboration and profile checks remain in force.

### PRO-212 restart and details

Restart always sends exact JSON `{}` with no force/options. The 202 response is
`CloudWorkspaceSnapshotDto`: **queued**, `operation.action: "restart"`,
`operation.type: "create"`, `cancelable:false`. Poll existing
`api.cloudWorkspaceOperationDto(operationId, orgId)` through succeeded/failed
when the caller needs the exact transport action. It uses the existing operation
command and HTTP endpoint. There is no alternate status route, new operation
type, new error code or restart inbox event. Existing resume is failed-restart recovery against the same machine.
Both new APIs authorize the explicit target organization by membership, as integrated
in SaaS commit `c517cf71aef847e7b51cb83152ad37cbe8ce73e2` (PR #250). The target
need not be active; `active_organization_required` can still reject an invalid token
profile. Membership/privacy/manager checks remain server-authoritative. Restart
body limit is 1 KiB, with oversize requests returning domain 422 rather than 413.
The server enforces ordinary details visibility and owner/admin or own-creator
restart authority; driver/viewer shares do not grant management, and preparation
restart additionally requires owner/admin. A private workspace stays creator-only.

`CloudWorkspaceDetailsResponse` is `{workspace,details}`. `details` exposes IDs,
original repository setup, pinned environment, nullable provider machine ID,
nullable actual runtime `{sha256,protocol:number|null,installedAt:number}` and a
nullable manager-only `{url,operationId}` provisioning-log link. Environment
`versionNumber` and `toolchainVersion` are numbers persisted as integers; Rust
rejects strings/fractions. Workspace createdAt/updatedAt and runtime installedAt
are epoch milliseconds, while inbox/marker times are ISO strings. Do not derive
a display workspace number or semantic runtime version. The log URL is the
configured console organization entry page; it requires its own authentication
and does not select/expand a row. Details are GET without body and server no-store;
no native metadata cache is introduced. Existing workspace launch, preparation,
checkout, installed runtime and operation progress/retries/events/logs/checkpoint/
cleanup fields remain typed and projected without arbitrary provider data.

Details have no telemetry. Reuse `runtimeResources`/`RuntimeResources` from
`@terminalx/portable`'s existing workspaceGit surface: `lifecycle.resources` v1
memory/storage are **bytes**, observedAt is epoch milliseconds; no CPU field
exists. CPU stays unavailable until a separately reviewed/tested compatible
runtime contract exists. Missing/null/disconnected/stale data stays unavailable,
never zero. `WORKSPACE_DETAILS_RESOURCE_INTERVAL_MS` from portable workspace is
10000; the UI should sample only the connected runtime while its card is open,
stop on close/disconnect and discard samples across generation changes. Do not
poll `/details` for metrics or alter the resource RPC shape.

## Verification boundary

Focused `phase2_desktop_contract*` native mock-server tests cover the held gate,
route families, Bearer/provider/lifecycle headers, exact restart body, queued
snapshot and existing operation polling, integer/ms/ISO/string scalar types,
revoke redaction, inactive-member markers, receipt limits, SSE checkpoint and
poll fallback, existing error mappings and resource byte/null semantics.

Remaining acceptance belongs to integrated SaaS and dependent native/UI work:
real two-account/cross-device inbox and notification timing, server live route
readiness, checkpoint delivery/flush/replay, actual native tab reattachment after
generation changes, filesystem/repository persistence, stale relay rejection,
resource sampling/staleness in an open card, and visual/design/menu/toast/copy
acceptance. A checkpoint can time out; do not promise unsaved in-memory work
survives. This desktop transport slice does not certify whole-ticket completion.

### Compatible catalog and recovery projection

`CloudWorkspaceOperationDto`, `CloudWorkspaceSnapshotDto`,
`CloudWorkspaceListItemDto`, `CloudWorkspaceListDto` and `CloudCatalogFeedDto`
describe native transport values, including `operation.action: "restart"`.
`api.cloudWorkspaceRestart` and `api.cloudWorkspaceOperationDto` return those
exact snapshots. Never treat the queued response as completion.

Existing `CloudWorkspaceOperation`, `CloudWorkspaceSnapshot`, list/catalog and
lifecycle APIs keep their compatible recovery action union. At the `api` boundary,
`projectCloudWorkspaceOperation` maps restart to `action: "resume"` and preserves
`transportAction: "restart"`; other action values and all operation metadata stay
unchanged. List, catalog-feed, operation-poll and lifecycle results all pass
through this projection. This lets the existing attention resolver offer **Retry
resume**, against the same machine, and preserves its permission checks. It does
not issue a resume request automatically. Display code can use `transportAction ?? action` to identify a restart without turning it into a retry-restart action.

Use `projectCloudWorkspaceSnapshot(rawSnapshot)` before inserting the new exact
restart/poll response into the existing catalog. A caller displaying the exact
transport can use `api.cloudWorkspaceOperationDto`; existing recovery/catalog
callers can continue using `api.cloudWorkspaceOperation`. Native DTOs always
retain the exact server action. No edits outside the shared contracts ownership
are needed for this compatibility path.

Full `tsc --noEmit` currently reports missing `marked` declarations and resulting
implicit-any diagnostics in mobile UI. There are no new contract/recovery type
diagnostics; transport/native validation does not claim a clean whole-repository
TypeScript check. Validation results for this continuation are recorded in the
worker report; no provider resources are contacted by the mock tests.
