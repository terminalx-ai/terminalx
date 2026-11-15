# Private PRO-133 native transport checkpoint (activation held)

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

The only added server error-code strings are:

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

No UI, controller, heartbeat/leave lifecycle, inbox parser/subscription, catalog
query/projection, runtime, collaboration, SaaS, PRO-137 or PRO-150 changes are
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
bounded timeout, and stale account/profile/org/session/membership/A-B-A replies.

Source checkpoint verification: tests NOT RUN while the resource hold applies.
Cargo, Vitest, builds and typechecks require BOTH the focused grant marker and
explicit root slot confirmation. The worker must wait for the supported lead
note after committing source. No full suites, dependencies or wrapper changes.

Stored focused donecheck, run only after the resource grant and lead slot:

```sh
test -f "$HOME/phase2-orch/presence-client-prep-focused-granted" && test -s "$HOME/phase2-orch/presence-client-prep/root-slot-confirmation.txt" || { echo 'RESOURCE HOLD: marker and explicit root slot confirmation required'; exit 1; }
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
cd src-tauri || exit 1
log=$(mktemp /tmp/phase2-presence-contract.XXXXXX)
cargo test --lib phase2_presence_contract > "$log" 2>&1
result=$?
cat "$log"
test "$result" -eq 0 && rg -q 'test result: ok\. [1-9][0-9]* passed' "$log"
```

A successful command with zero selected tests is not acceptance. The lead must
collect focused test results before treating this checkpoint as verified. The
full ticket and activation remain open even after the focused tests pass.
