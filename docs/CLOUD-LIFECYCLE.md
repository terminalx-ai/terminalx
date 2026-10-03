# Stop, archive and delete cloud workspaces (PRO-34)

The desktop half of terminalx-saas contract §10. Every cloud workspace request
sends `X-TerminalX-Cloud-Workspace-Lifecycle: archive-v1`, so the API answers
with `archived` workspaces, `archive` operations, `archivedAt`/`deleteAfter`,
an archive's `checkpoint`, a delete's `cleanup` report and the list's
`tombstones`.

| Action  | Compute | Data                                     | Charges                        | Undo                   |
| ------- | ------- | ---------------------------------------- | ------------------------------ | ---------------------- |
| Stop    | stops   | kept                                     | storage keeps billing          | resume                 |
| Archive | stops   | kept until `deleteAfter` (30 days)       | storage keeps billing          | unarchive, then resume |
| Delete  | removed | removed once the provider confirms       | stop once the provider confirms | none; a tombstone stays |

## Desktop

- `src/components/cloud/CloudWorkspaceLifecycle.tsx`: one dialog for all
  three, opened from a workspace's Stop, Archive or Delete button, with the
  table above for the chosen action. Before an archive or delete it lists the
  server's facts (`GET …/disposition`: running agent turns, pending
  approvals, an operation in progress) and the runtime's
  (`lifecycle.dispositionFacts`: uncommitted files, unpushed and local-only
  commits, open pull requests, running terminals). The runtime is asked only
  when the workspace is running; a suspended one is reported as not
  checkable rather than woken. "Open workspace" opens it to push or copy
  files out first (the server has no export of its own).
- Running agent work: archive, and a lifecycle client's delete, are refused
  with `409 cloud_workspace_active_work`. The dialog sends `force` only after
  "Stop the running agent work" is ticked, and a refusal for work that
  started after the facts were read asks again. A delete also needs "I
  understand this cannot be undone", and is refused for a provider
  connection without permanent delete.
- `DeletionProgress` polls a delete's operation and lists what is removed
  and what remains (`pending` with the provider's stage, `retained-by-provider`,
  `unconfirmed`) until the provider confirms. A delete that stopped (a
  provider credential needing repair) is retried from the row; the retry
  resumes the same operation.
- The sidebar shows archived workspaces apart, under each organization's
  "Archived workspaces" node, with their deadline and what the final save
  did. A row's menu has Read conversations (it selects the workspace, which
  connects without waking), Unarchive (it stays suspended), Delete, and Retry
  archive for an archive that failed (the row says why it did not finish).
  What this Mac dropped of a workspace deleted elsewhere is said once above
  the organization sections. The full-window cloud page that used to hold
  this list is gone (PRO-68).
- Tombstones (`src/lib/cloudLifecycle.ts` `purgeTombstones`): for each deleted
  workspace the desktop closes its connection, drops its terminals, agent
  tabs and cloud editors (unsaved text included) and, natively, its agent
  outbox, transcript cache and content keys
  (`cloud_agent_purge_workspace`). The list then says what went with it
  ("2 agent messages that never reached it, unsaved edits in 1 file").
- An archived workspace opens read-only from its checkpoints; `wake` on it
  answers `cloud_workspace_archived` (`src-tauri/src/cloud_remote.rs`).

## Organization teardown and provider disconnect (PRO-34)

The server half is saas contract §10.7; both paths run the same inventory and
cleanup as a single workspace's archive and delete.

- **Provider disconnect** (`src/components/settings/ProviderControls.tsx`)
  offers three choices: retain the resources, destroy them, or **archive**
  the workspaces (stopped, kept 30 days with one shared deadline, then
  deleted). The server reports an archiving disconnect as
  `disconnectRetention: "archive"` with `retentionDeadline`, apart from
  `disconnectDisposition` (which an older desktop decodes as retain or
  destroy only); the section then reads "Disconnect pending — workspaces are
  archived and deleted on …".
- **Organization teardown** (`OrganizationCloudTeardown.tsx`, in Settings →
  Account, for owners and administrators): archive every workspace of the
  organization with one deadline, or delete them now
  (`GET`/`POST …/cloud-teardown`, `cloud_teardown_status` and
  `cloud_teardown_request`). It cannot be cancelled, and while it runs nobody
  in the organization can create, resume or unarchive a workspace, so nothing
  is sent before a disposition is chosen and the organization's name is
  typed. A pending archive can only be escalated to deleting now. The section
  shows the deadline, what still remains at the providers (with each
  resource's own deadline and whether its cleanup is unresolved), that
  session runtimes and build templates are not removed by it, and released
  workspaces the provider kept. It is not offered when the status could not
  be read, and it is absent for a member (the server refuses the read).

## Runtime: the final checkpoint

`terminalx-serve` advertises `quiesce-v1`. While an archive or a stop waits
(the server asks before either, PRO-33; `reason` is `archive` or `suspend`
and is not read here), the refresh answer carries
`quiesce { operationId, deadline }`, and `src-tauri/src/cloud_quiesce.rs`:

1. stops taking new work: nothing is leased from the mailbox and no queued
   follow-up is typed (`CloudAgents::quiesce`); the running turn is not
   interrupted, and its committed events are part of the checkpoint;
2. uploads every tab's checkpoint now (`checkpoints::final_checkpoint`),
   retrying until the request's deadline less 5 s, at most 55 s;
3. reports once: `POST /v1/cloud-workspace-bootstrap/checkpoint`
   `{"v":1,"operationId","result":"committed"|"failed"}`. A 401 (no longer
   wanted) is not retried.

If the request is gone and a device attaches again (an archive revokes every
attachment), or the runtime is still running ten minutes later (the archive
failed, or was undone before compute stopped), it takes work again. The
request is read leniently: a malformed one is dropped without failing the
refresh.

The request is seen on the relay-token refresh, every 5 s
(`cloud_bootstrap::REFRESH_INTERVAL`, 30 s before PRO-30), and the watcher
looks every 2 s, so the checkpoint starts within about 7 s of the server's
60 s window opening. With many tabs, or clock skew against the request's
`deadline`, the upload may still not finish and the operation records `failed`
or `timed-out` (the disk is kept either way).

## Last saved, on a stopped workspace

A stop's operation carries `checkpoint` and, when the runtime answered,
`checkpointAt`. `lastSavedText` (`src/lib/cloudLifecycle.ts`) turns the
workspace's latest operation into one line, shown under "Stopped" in the
workspace view and in a stopped session: "Last saved 3 Oct, 14:05.", or that
the save did not finish and conversations may end earlier than the work did.
It says nothing when the server said nothing (an older server, a workspace
that was not running), and nothing once another operation (a failed resume)
is the latest: the list carries only the latest operation.

## Tests

- `src/components/settings/OrganizationCloudTeardown.test.tsx`,
  `ProviderControls.test.tsx`: nothing is sent without a disposition and the
  typed name; escalation only; what remains; a finished teardown; a member;
  an unknown outcome; archive on disconnect and its deadline.

- `src/components/cloud/CloudWorkspaceLifecycle.test.tsx`: dirty files,
  unpushed commits, an open PR and a running turn before an archive; force
  only once confirmed; a refusal for new work; an offline workspace; a
  provider without permanent delete; cleanup progress; retry after a
  provider failure.
- `src/components/layout/cloud/CloudSections.test.tsx`: the archive list,
  unarchive without compute, a failed archive, a tombstone's notice.
- `src/lib/cloudLifecycle.test.ts`: the last-saved line; purging a deleted workspace and only it;
  an already-purged tombstone; a failed native purge retried.
- `src-tauri/src/cloud_workspaces.rs`: the header, force, the archive
  vocabulary, refusal codes, unarchive, tombstones, disposition.
- `src-tauri/src/cloud_agent_client_tests.rs`: the native purge.
- `src-tauri/src/cloud_agents/mailbox_tests.rs`, `src-tauri/src/cloud_quiesce.rs`,
  `src-tauri/src/cloud_bootstrap.rs`: quiesce, final upload with a retry, the
  deadline, one report per archive, resuming work.
- `src-tauri/serve/tests/final_checkpoint.rs`: the real binary against a
  fake API reports its final checkpoint once.

## Open

- There is no endpoint to delete an organization, so nothing yet requires a
  completed teardown first; a teardown cannot be cancelled; the console has
  no archive or unarchive.
- Preview routes do not exist; scoped runtime secrets are revoked by the
  server.
- The running app has not been checked by hand (computer use is blocked on
  this Mac); the UI is verified by component tests.
