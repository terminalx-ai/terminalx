# PRO-212 desktop continuation

This slice consumes the accepted restart/details contract from worker
`b117bfe47d2274e4df67661db60f8e600dd11171` (SaaS collection `7cc0f6c7`).
Both pinned environment version fields are numbers. Installed/runtime and
workspace dates are epoch milliseconds. The accepted native/typed contracts
commit `ccbdda8505b58994ac3e3da7cfe74f39b3262486` is collected alongside
this change. The guarded adapter in `cloudWorkspaceDetails.ts` checks the public
methods and snapshot projection before use. It adds no alternate endpoint or
projection fallback. See `docs/PHASE2-DESKTOP-CONTRACTS.md` for native transport
and rollout requirements.

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

Restart requires target organization membership and existing lifecycle management
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
unused transports close. Poll failures and mismatched poll responses retain the
pending guard and retry the same operation with exponential backoff capped at
30 seconds. There is no five-minute cutoff: a later matching success still
reattaches held leases. Account/profile changes end monitoring without applying
old-account results. Existing catalog polling continues independently.

Verification covers held entrypoints, metadata/refusals, pinned numeric versions,
queued/running/succeeded polling, account fences, duplicate requests, confirmation,
transport replacement with connect, clipboard failure fallback, and connected
resource timing/disconnect/generation/staleness. This is desktop fixture evidence,
not whole-ticket certification. Remaining acceptance: integrated/live SaaS,
real native two-account/profile checks, actual generation/relay fencing and tab
reattachment, filesystem persistence/checkpoint replay, and visual/design/menu/
clipboard review on the native app. No production cloud, paid compute, deployment,
activation or push is part of this slice.

Try 3 selectively reapplied the twelve owned-file diffs from try 2 after reviewing
both earlier branches; no merge or cherry-pick was performed. Replaced the
poll-error/timeout exit with persistent operation monitoring and added regression
coverage for prolonged queued state, prolonged outages, mismatched poll responses,
eventual reconnect, duplicate prevention and account changes during retry.
Verification commands and results are recorded in the worker report.

Try 3 local checks:

- Required three-file Vitest command: exit 0, 37 tests.
- SessionView/cloud actions/resources/connections regression command: exit 0,
  122 tests across five files.
- `pnpm exec tsc --noEmit`: exit 0.
- `git diff --check`: exit 0.
- Dependencies were initially absent (`vitest` not found); installed from the
  local cache with `pnpm install --offline --frozen-lockfile` (exit 0), without
  changing the lockfile, then reran the required command successfully.
- TypeScript compiler-host check substituting only the contracts branch's
  `src/lib/api.ts` in memory: exit 0, zero diagnostics. No shared file changed.

## Lead integration validation

The accepted native contracts are collected on the desktop wave branch. Production activation remains held until SaaS shared integration and live readiness are confirmed. Contract checks use local HTTP mocks and frontend fixtures; they do not certify live delivery, native two-account timing, or deployed restart/reattachment. Existing catalog polling remains enabled.

Restart observation retries transient failures with bounded backoff. Permanent authentication/access refusals surface an error and release the local dialog guard; this does not cancel the server operation. Account transition epochs invalidate in-flight work and open details even when switching away and back between polls.
