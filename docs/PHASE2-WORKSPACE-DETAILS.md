# PRO-212 desktop continuation

This slice consumes the accepted restart/details contract from worker
`b117bfe47d2274e4df67661db60f8e600dd11171` (SaaS collection `7cc0f6c7`).
Both pinned environment version fields are numbers. Installed/runtime and
workspace dates are epoch milliseconds. The shared native/typed contract worker
on `raccoon/contracts-try2-accepted-pro-125-212-shar` must be collected alongside
this change: this worker does not edit `api.ts`, catalog, notification or native
files. The guarded adapter in `cloudWorkspaceDetails.ts` describes those exact
public method/DTO signatures locally, checks all methods and the public snapshot
projection exist, and refuses with the existing runtime-not-ready code when
collection is absent. It adds no native invocation, endpoint or projection
fallback. Thus the base and the collected shared API both compile. The base
worktree does not yet contain those APIs or
`docs/PHASE2-DESKTOP-CONTRACTS.md`; that document was read from the shared branch.

Production remains held. Details buttons and details/copy/restart menu entries
require `api.phase2DesktopContractsAvailable()` to return true. The shared worker
currently returns false and refuses new requests before network access. Neither
provider negotiation nor existing multi-org support grants readiness. The lead
must confirm integrated/live SaaS routes, auth, migrations, executor/bootstrap
fencing and authorize native gate activation as described in the shared contract
document. There is no new environment variable or implicit feature flag here.
Fixture cards/dialogs can be tested directly without activating production.
Existing sharing, event APIs, lifecycle confirmations, catalog polling and auth
fallbacks remain in place; no PRO-167 endpoint or role model is introduced.

Details are loaded once per open/workspace, through the public details
API with an explicit target organization. Server refusals hide metadata and copy
controls. Pending responses are fenced to the current account/profile. Changing
account/profile hides the loaded response and copy fallback, stops telemetry, and
requires reopening the card; it never automatically copies in the new account.
Details show original repositories/ref, creator ID, pinned numeric environment/toolchain
versions, machine ID, actual artifact SHA and epoch-ms dates. The provisioning
link appears only when the server returns an HTTPS manager link; it is the
console organization entry, opens through the existing native URL opener and
requires independent console authentication.
No raw logs, clone credentials or expanded-row selectors are synthesized.
Copy actions use the existing native-first `copyText` helper with browser
fallback. If both fail, the card exposes selectable read-only text and never
claims success. Support text is an explicit field allowlist, excluding raw DTOs,
connection credentials, clone URLs, tokens and workspace numbers.

After details succeeds, the open card reads `lifecycle.resources` v1 on the
existing connected client at 10-second intervals. It does not retain/wake a connection or poll metadata for
metrics. Memory/storage remain bytes, sample time is epoch milliseconds. CPU is
unavailable because v1 has no CPU field. Null/failed/disconnected samples and
samples older than 20 seconds (or from the future) display unavailable. Changing
client or connection generation clears the prior reading and fences outstanding
responses. A separate expiration timeout clears readings after 20 seconds even
if a subsequent runtime request stalls indefinitely. Closing the card cancels
its interval/subscription. The existing
agent low-memory sampling and streak logic is separate and unchanged.

Restart requires the active target organization and existing lifecycle management
authority; preparation workspaces
additionally require an organization owner/admin. Stopped, archived, deleted and
pending-operation workspaces are excluded. Confirmation explains interrupted
processes and possible checkpoint timeout/in-memory loss. Only the native
`cloudWorkspaceRestart(workspaceId, orgId)` API is called: native sends exact `{}`.
A queued 202 stays pending. Poll `cloudWorkspaceOperationDto` using the returned
operation ID, project exact snapshots with the shared public projection, and
refresh existing catalog state. Account/profile changes stop further polling
and catalog application. Duplicate local requests are refused, server errors
remain authoritative, and no force/status endpoint or restart event is invented.
Failure uses existing projected resume recovery; nothing resumes automatically.
Success replaces any held transport with `connect`, preserving lease identity;
unused transports close. A five-minute UI wait limit leaves catalog polling in
charge and reports pending rather than falsely completing the restart.

Verification covers held entrypoints, metadata/refusals, pinned numeric versions,
queued/running/succeeded polling, account fences, duplicate requests, confirmation,
transport replacement with connect, clipboard failure fallback, and connected
resource timing/disconnect/generation/staleness. This is desktop fixture evidence,
not whole-ticket certification. Remaining acceptance: integrated/live SaaS,
real native two-account/profile checks, actual generation/relay fencing and tab
reattachment, filesystem persistence/checkpoint replay, and visual/design/menu/
clipboard review on the native app. No production cloud, paid compute, deployment,
activation or push is part of this slice.

Local verification:

- Selectively reused the owned details/action/connection files from `raccoon/pro-212-pro-212-workspace-details-restar` after reading `git diff HEAD...raccoon/pro-212-pro-212-workspace-details-restar`. No merge or cherry-pick was performed. Reworked missing-contract compilation, scope fencing, response identity checks, clipboard/log opening and stalled-reading expiry.
- Required `pnpm vitest run src/components/cloud/CloudWorkspaceDetails.test.tsx src/components/cloud/WorkspaceActions.details.test.tsx src/lib/cloudWorkspaceDetails.test.ts`: exit 0, 35 tests.
- Regression `pnpm vitest run src/components/session/SessionView.cloud.test.tsx src/components/cloud/WorkspaceActions.test.tsx src/components/cloud/WorkspaceActions.schedules.test.tsx src/lib/cloudResources.test.tsx src/lib/cloudConnections.test.ts`: exit 0, 122 tests.
- `pnpm exec tsc --noEmit`: exit 0 against the actual worker base, including absent shared APIs.
- Node TypeScript compiler-host check with only `src/lib/api.ts` from shared contract commit `ccbdda85` substituted in memory: exit 0, zero diagnostics; no shared files were written. This verifies compatibility after collection without merging or masking base compilation errors.
- `git diff --check`: exit 0. Tests use fixtures; no native/live acceptance is claimed.
