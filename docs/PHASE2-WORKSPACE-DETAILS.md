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

The desktop entry points use explicit per-organization account readiness
`cloud.workspaces.restart-details.v1`. An absent feature keeps them hidden.
Native restart and details enforce the same feature for the requested organization
before network access. Deployment and readiness activation belong to the lead
after verification of the integrated SaaS routes, auth, migrations,
executor/bootstrap fencing and installed runtime. The generic Phase 2 availability
probe concerns the events feature.

Details are loaded once per open/workspace, through the public details
API with an explicit target organization. Server refusals hide metadata and copy
controls. Pending responses are fenced to the current account/profile. Changing
account/profile hides the loaded response and copy fallback, stops telemetry, and
requires reopening the card; it never automatically copies in the new account.
Details show the original repositories and refs, owner (live profile when available,
otherwise the server's creator ID), pinned numeric environment and toolchain
versions, provider, machine ID, actual artifact SHA and epoch-ms dates. The
details card shows the provisioning action when the server returns an HTTPS
manager link. The manager's workspace menu checks for that link on selection
and reports when it is unavailable. Both open the returned console organization
entry through the native URL opener. The console requires independent authentication.
No raw logs, clone credentials or expanded-row selectors are synthesized.
Copy actions use the native-first `copyText` helper with browser fallback.
Successful menu copies close the dialog and announce the copied field. If both
clipboard paths fail, the card exposes selectable read-only text. Support text
includes organization ID, workspace ID, provider and the runtime artifact SHA
alongside the other allowlisted metadata.

After details succeeds, the open card reads `lifecycle.resources` v1 on the
existing connected client at 10-second intervals. Memory and disk use the
reported bytes and sample time uses epoch milliseconds. The optional v1 CPU
reading supplies logical core count and aggregate usage as a fraction of
capacity. A first read can report cores with usage unavailable. An older runtime
can omit CPU. Null, failed, disconnected, stale (older than 20 seconds) and
future samples display unavailable. Changing
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
The header shows Restarting while the catalog identifies an open restart by its
transport action. The confirmation can be closed while the operation is pending. The outcome still appears as a toast.
Success replaces any held transport with `connect`, preserving lease identity,
and shows a Restarted workspace toast. Unused transports close. Terminal failure
shows Couldn't restart workspace with Open workspace to reach the existing
explicit Retry resume action. Request errors appear in the confirmation with Try again
when another restart is eligible. Poll failures and mismatched poll responses retain the
pending guard and retry the same operation with exponential backoff capped at
30 seconds. There is no five-minute cutoff: a later matching success still
reattaches held leases. Account/profile changes end monitoring without applying
old-account results. Existing catalog polling continues independently.

## Screen choices

- **14.05** uses a scrollable header popover with setup, health and machine
  details. The Status row offers Restart through confirmation. Setup shows the
  checkout outcome when available. The checkout contract supplies no setup
  duration. SSH and Sync to this Mac are outside this slice.
- **14.06** uses the existing workspace menu with Copy workspace info, Copy
  machine ID and Restart workspace. The details card offers the provisioning log when the response has a supported URL.
  A successful copy names the field in the toast.
- **14.07** uses the Restarting chip in workspace and session headers. The
  workspace pane shows the health card after 15 seconds of continuous runtime
  recovery for a ready workspace. Restart and Open diagnostics follow their existing authority
  rules. The toast uses the workspace name and server outcome. There is no
  workspace number, measured downtime or verified reattached-tab count in
  the restart response. The runtime artifact SHA identifies the installed
  build and the details contract provides no semantic runtime version.

## Acceptance after deployment

The fixture checks exercise the ready and held UI, connected telemetry timing
and staleness, clipboard paths, the console URL and restart operation polling.
Native live integration still needs verification for target-organization access
and account/profile changes, restart authorization and queuing, runtime CPU
availability, generation and stale-relay fencing, tab reattachment,
filesystem and repository persistence, and checkpoint flush and replay. Verify
native layout, clipboard feedback, and the console log with an authorized
account. The support-copy acceptance for workspace number and semantic runtime
version needs fields from the corresponding contracts.
