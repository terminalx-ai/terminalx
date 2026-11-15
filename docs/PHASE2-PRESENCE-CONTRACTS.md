# Private PRO-133 + PRO-137 native transport checkpoint (activation held)

This is a transport preparation checkpoint, not full PRO-133 acceptance or a PR.
Accepted SaaS source: `d45e74d7d42b15c6b89155b22de6eb136e995bbb`, collected
as `1693f6e5bad1ce90596ae31aea5796d908edbca5` on `raccoon/saas-phase2-wave3`.
It is branch-only and NOT deployed. The accepted handoff and presence contract
in `~/phase2-orch/saas-wave3/` govern this preparation.

## Native surface and hold

Internal Tauri commands `desktop_presence_put` and `desktop_presence_read` take
`orgId` and an `input` object. Their TS wrappers are `desktopPresencePut` and
`desktopPresenceRead`. The native service accepts JSON at this boundary so its
strict DTO parser rejects missing, extra and mistyped input before HTTP.
There is no account, profile, user or session selector in input.

Both methods refuse locally with typed `presence_unavailable` while the existing
private `phase2_enabled` is false. Production construction remains false; only
embedded test fixtures enable it. This adds no production setting, activation
header, body flag, or capability advertisement. No presence request is sent
by registration alone.

| Method | Path | Exact JSON input | Success |
| --- | --- | --- | --- |
| PUT | `/v1/desktop/orgs/:orgId/presence` | `{deviceId, sequence, workspaceId}` | `{applied: boolean, ttlSeconds: 45}` |
| POST | `/v1/desktop/orgs/:orgId/presence/read` | `{workspaceIds: string[]}` | `{ttlSeconds: 45, activeMembers: Person[], workspaces: PresenceWorkspace[]}` |

`deviceId` must be lowercase RFC 4122 UUIDv4, version 4 and variant 8/9/a/b.
`sequence` is an integer in 1..9007199254740991. `workspaceId` is a required
string or explicit null (leave). Read takes 0..100 distinct workspace IDs.
Numeric `1.0` is accepted as a JS safe integer and serialized as `1`;
numeric strings, fractional values, booleans and null are rejected.
Organization, workspace and person IDs use `[A-Za-z0-9_-]{1,128}`; this is stricter
than the older generic workspace ID helper, which remains unchanged.
The transport does not generate UUIDs, own sequence counters, retry requests,
manage launches, send heartbeats, or retain pending leaves.

`Person = {userId, displayName: string|null, photoUrl: string|null}` with all
three fields required. `PresenceWorkspace = {workspaceId, owner: Person,
activeMembers: Person[]}`. No email fallback or additional identity fields are
accepted. Owner is the server's current `cloud_workspaces.created_by` joined to
current identity, including null identities for a former member. It is not
inferred from active members, made immutable, or duplicated as a second assignee.

Input and output DTO boundaries require JSON objects, including nested output
people and workspace entries; positional arrays cannot stand in for objects.
Output DTOs reject wrong types, missing/extra fields, TTL other than 45, invalid
person IDs, duplicate people/workspaces, unrequested workspace IDs, and workspace
active members absent from the org aggregate. Person lists are bounded to the
accepted 500-member limit. Requested missing/invisible workspace omissions are
successful authorized subsets, never filled from a cache. The top aggregate
covers all visible workspaces, including those outside the requested batch;
`workspaceIds: []` therefore remains a meaningful org read.

## Authorization, freshness and errors

Both calls reuse the existing native Bearer token, bounded HTTP timeout and
bounded response/error body capture. No actor credentials reach the webview.
Target-org membership is resolved with the existing member-context helpers;
the target need not be active and does not require CS-18 capability opt-in.
The original account generation, profile, active org, current session token and
target membership are checked before returning successes or errors. Generation
fences late A-B-A replies. Server authorization/visibility checks remain necessary
on every call; this transport has no cached-success path after authorization or
visibility loss and cannot revoke a reply already delivered before a later change.
There is no offline or 503 success fallback.

The added PRO-133 server error-code strings are:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 429 | `presence_rate_limited` | Account/org mutation budget exhausted |
| 429 | `presence_device_limit` | Account/org live lease limit reached |
| 503 | `presence_capacity_exceeded` | Organization or pending-work capacity exceeded |
| 503 | `presence_unavailable` | Dependency or transaction unavailable |

The existing compatible `CloudWorkspaceClientError` shape is unchanged.
`retryAfterSeconds` captures integer `Retry-After` through the existing parser
(trimmed unsigned seconds, capped at 3600; invalid/date values yield null).
The server's presence 429 contract supplies at least one second. This metadata
is advice for a future lifecycle owner, not an automatic retry instruction;
a rate-limited leave has not cleared a lease, and a device-limit delay may be
extended by renewal. Existing read retryability and mutation/original-context
uncertainty flags are preserved. Error HTTP bodies remain exactly `{error: code}`;
no Retry-After property is added to wire JSON and no old error behavior is changed.

401 `invalid_access_token` remains available to existing refresh/signout handling;
403 `active_organization_required`, 404 `cloud_workspace_not_found`, and 422
`cloud_workspace_request_invalid` retain status/code. Framework 413 retains its
status even when its body is not a desktop JSON envelope. No error is converted
to empty successful presence.

## Scope and collection

No UI, heartbeat/leave lifecycle, inbox parser/subscription, catalog
query/projection, runtime, collaboration, SaaS or PRO-150 changes are
included. Server opt-in `presence=1` inbox/catalog integrations are separate
activation gates and are out of scope. Existing inbox/catalog remain unchanged.
Future collection must preserve the root's unmerged automation changes in
`cloud_workspaces.rs` and `api.ts`; neither import nor discard those changes
while syncing this checkpoint. Review and collect only this owned diff.

## Verification and resource hold

Embedded mocked HTTP tests all contain `phase2_presence_contract` in their names.
They cover exact paths/auth/body, nonactive membership, strict input/no HTTP,
production hold, nullable/current owner identities, authorized subsets, foreign
IDs, malformed outputs, integer Retry-After and four new errors, framework 413,
bounded timeout/body capture, and stale account/profile/org/session/membership/
A-B-A replies. Stale-context cases preserve target membership when testing other
fields and cover both successful and unauthorized late replies.

Source checkpoint verification: tests NOT RUN. This continuation is SOURCE ONLY:
no Cargo, Vitest, build, typecheck, donecheck or verifier command was run, including
blocked checks. Static source/diff inspection and `git diff --check` alone are
allowed. Future execution requires the existing focused grant, explicit root slot
confirmation AND a fresh release from root; an old marker is insufficient.
SaaS PR253 retains the next heavy slot. After committing, the worker records
`READY_FOR_SUPPORTED_STOP` in the designated combined worker status file and
keeps the turn open for supported stop. No full suites, dependencies or wrapper
changes. Prior 133 tests were authored, not accepted or run in this continuation.

Stored focused commands for a future explicitly released slot (NOT RUN here):

```sh
test -f "$HOME/phase2-orch/presence-client-prep-focused-granted" && test -s "$HOME/phase2-orch/presence-client-prep/root-slot-confirmation.txt" || { echo 'RESOURCE HOLD: marker and explicit root slot confirmation required'; exit 1; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
cd src-tauri || exit 1
for filter in phase2_presence_contract phase2_following_contract; do
 log=$(mktemp /tmp/phase2-client-contract.XXXXXX)
 cargo test --lib "$filter" > "$log" 2>&1
 result=$?
 cat "$log"
 test "$result" -eq 0 && rg -q 'test result: ok\. [1-9][0-9]* passed' "$log" || exit 1
done
```

A successful command with zero selected tests is not acceptance. The lead must
collect focused test results before treating this checkpoint as verified. The
full ticket and activation remain open even after the focused tests pass.


## PRO-137 source-only continuation

Read-first evidence: `PRO-137-accepted-contract.md`,
`PRO-137-contract-status-for-desktop.txt`, and
`PRO-137-integration-handoff-pending.txt` in `~/phase2-orch/saas-wave3/`.
Accepted worker `88a949fc722654f0ff8c6b71554f0e9e70e0e4cd` was collected as
`38154a7a70f2570a813c800b6e259b0138f4e48b` locally on the SaaS wave branch.
Shared integration remains uncommitted/unpublished in that handoff; published
PR253 head `60c5e25e` excludes 137. This is NOT SaaS phase-2 or deployed.
The root/chief source-only authorization does not activate any endpoint.

The five-file 133 diff from `ac570f05` was inspected and selectively applied to
baseline `a823c209`, including its stricter validation, fencing and valid-response
timeout fixture. Original `d4dc843d`, try 2 `d818e9b1` and try 3 `ac570f05`
branches/worktrees remain intact. No root wave4 source was imported or reset.

| Method | Existing path under `/v1/desktop/orgs/:orgId/cloud-workspaces/:workspaceId` | Exact input | 200 top-level response |
| --- | --- | --- | --- |
| PUT | `/follow` | `{}` JSON | `{workspaceId, following: true}` |
| DELETE | `/follow` | `{}` JSON body required | `{workspaceId, following: false}` |
| POST | `/reassign` | `{targetUserId, expectedOwnerId, requestId, confirmPrivate?, note?}` | `{workspaceId, ownerId, previousOwnerId, reassigned: boolean}` |

Internal Tauri commands are `cloud_workspace_follow_put`,
`cloud_workspace_follow_delete`, and `cloud_workspace_reassign`. TS wrappers are
`cloudWorkspaceFollow`, `cloudWorkspaceUnfollow`, and `cloudWorkspaceReassign`.
No UI calls them. The native JSON boundary rejects nonobjects, unknown fields,
missing required fields and wrong types before HTTP. IDs use the independent
137 rule `[A-Za-z0-9._:@-]{1,128}` with full-string validation (including newline
rejection); the stricter 133 rule remains unchanged. Standalone `.`/`..` in URL
path positions are refused locally because URL parsers normalize dot segments;
they never silently address a different endpoint. Other bounded dots, colons and
`@` characters are accepted. Target/owner IDs remain JSON fields.

`requestId` is a full canonical hyphenated hex UUID, version 1..8, RFC variant
8/9/a/b, accepting upper/lowercase hex. No whitespace, braces or trailing newline
is accepted. `confirmPrivate` is optional boolean only. `note` is optional STRING
only, at most 500 UTF-16 code units: LF and TAB are allowed; other ASCII controls,
DEL, `<` and `>` are forbidden. Explicit `note: null` and `confirmPrivate: null`
are rejected. Absent options are omitted on wire. An explicitly supplied empty
string remains a string consistently on wire; the server omits its notification
note. There is no HTML/Markdown interpretation.

All success responses require exact object fields and typed booleans. Follow
must echo the captured workspace and requested boolean. Reassign must echo that
workspace, target as owner, and expected owner as previous owner. Both true and
false are accepted. **`reassigned: false` is an exact committed retry receipt,
not a fresh owner projection**: a later transfer may have occurred. The transport
does not update a current-owner cache, generate/manage UUIDs, automatically retry,
or invent an HTTP endpoint, idempotency header or handshake.

The existing private `phase2_enabled` is false in production constructors, so
all three routes are held before HTTP with `workspace_following_unavailable`.
Only embedded test fixtures enable calls. There is no setting, header or body
activation flag. Requests reuse existing machine0 desktop opaque Bearer auth,
HTTP timeouts, bounded success/error capture and target-org membership helpers;
the target org need not be active. Original account/generation/profile/active-org,
session token and current target membership are fenced before and after HTTP,
including late error replies and A-B-A. Server current profile/account/member and
visibility rechecks remain authoritative; Following never grants access.

Added native/TS known error codes (all 409 except the final 503):

- `workspace_owner_changed`
- `workspace_reassign_same_owner`
- `workspace_reassign_private_confirmation_required`
- `workspace_reassign_target_not_visible`
- `workspace_reassign_busy`
- `workspace_reassign_personal_route_held`
- `workspace_reassign_credential_restricted`
- `workspace_reassign_runtime_unsupported`
- `workspace_reassign_idempotency_conflict`
- `cloud_workspace_last_admin`
- `workspace_following_unavailable` (503)

Existing `cloud_workspace_member_concurrency_exceeded` and
`cloud_teardown_in_progress` (409) remain allowlisted. 401 `invalid_access_token`
remains available to refresh/signout handling. Existing 403
`active_organization_required` / `cloud_workspace_manager_required`, 404
`cloud_workspace_not_found`, 422 `cloud_workspace_request_invalid` and framework
413 statuses remain intact. Server refusal is never converted to success or
retried automatically. Existing mutation uncertainty flags remain intact.

ANY bootstrap-backed runtime handover is **explicitly unsupported**, including
ready/suspended workspaces and revoked, expired or unredeemed bootstrap grants.
No state or provider stop is inferred to certify credential cleanup. Private
cross-owner handover remains held: missing confirmation refuses; confirmation
still cannot grant target visibility. Busy, personal-route, credential restriction,
capacity, privacy and idempotency errors remain server authoritative. No native
tabs, credentials, runtime or session migration is claimed. The typed existing
`workspace.reassigned` inbox payload belongs to a separate future wave and is
excluded, along with inbox/events/catalog/UI/runtime/SaaS/150 changes.

Authored `phase2_following_contract` mocked HTTP test source covers exact routes,
JSON DELETE body/auth, inactive target membership, omitted/string-only note,
UUID versions/variants, UTF-16 boundaries, controls/path/extra/type rejection with
no HTTP, production hold, response scope/boolean/receipt validation, every accepted
error including runtime/privacy/idempotency/personal-route/busy restrictions,
no automatic retry, timeouts/body bounds and stale context success/error replies.
The prior `phase2_presence_contract` test source is preserved. **Neither focused
filter nor any build/typecheck/verifier was RUN here; no passing result or native
acceptance is claimed.**
