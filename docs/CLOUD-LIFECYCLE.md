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

## Runtime: the final checkpoint

`terminalx-serve` advertises `quiesce-v1`. While an archive waits, the
refresh answer carries `quiesce { operationId, deadline }`, and
`src-tauri/src/cloud_quiesce.rs`:

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

The request is only seen on the relay-token refresh, every 30 s, so up to
half of the server's 60 s window can pass before the checkpoint starts; with
many tabs, or clock skew against the request's `deadline`, the upload may not
finish and the archive records `failed` or `timed-out` (the disk is kept
either way). Refreshing sooner while an archive is pending is a follow-up.

## A full disk (PRO-33)

A workspace whose disk fills up fails in ways that look like something else:
a save that is refused, a commit that stops, an agent that ends mid-turn. The
runtime reports what is left and the desktop says so.

- Runtime: `lifecycle.resources` (`src-tauri/src/cloud_resources.rs`, in
  `lifecycle/1`, for anyone who may look) answers
  `{ v, memory: { totalBytes, availableBytes } | null, storage: { totalBytes,
  availableBytes, totalInodes, availableInodes } | null, observedAt }`. Storage
  is one `statvfs` of the workspace root, counting what an unprivileged
  process may still write; memory is `MemTotal`/`MemAvailable` from
  `/proc/meminfo`. It holds no state and decides nothing: the thresholds are
  the client's. A runtime from before it answers `method_not_found`.
- Desktop: `src/lib/cloudResources.ts` reads it over the connection a session
  already holds, on connect and every 60 s, and never connects or wakes for
  it; a workspace that is not connected is not asked and nothing is shown for
  it. `CloudResourceNotice` (in a cloud session and in the workspace view)
  says **full** below 128 MB free or with no inodes left ("Saves, commits and
  agent work fail until space is freed … Nothing already on the disk is
  lost"), and **almost full** below both 5% and 2 GB, or below 1% of inodes.
  It clears by itself once space is freed.

Not done: the server is not told, so the workspace list and an admin's
diagnostics do not show a full disk to someone who is not connected to it,
and a stopped workspace's disk is not known.

## Tests

- `src/components/cloud/CloudWorkspaceLifecycle.test.tsx`: dirty files,
  unpushed commits, an open PR and a running turn before an archive; force
  only once confirmed; a refusal for new work; an offline workspace; a
  provider without permanent delete; cleanup progress; retry after a
  provider failure.
- `src/components/layout/cloud/CloudSections.test.tsx`: the archive list,
  unarchive without compute, a failed archive, a tombstone's notice.
- `src/lib/cloudResources.test.tsx`, `src-tauri/src/cloud_resources.rs`,
  `src-tauri/src/remote/server_tests.rs`: the disk levels and their wording;
  only a connected workspace is asked; the notice follows the disk and goes
  with the connection; a runtime that does not report is asked once.
- `src/lib/cloudLifecycle.test.ts`: purging a deleted workspace and only it;
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

- The final checkpoint's latency (above): the runtime learns of the request
  on its 30 s refresh.
- Organization teardown and the provider disconnect `archive` disposition
  have no desktop UI yet.
- Preview routes do not exist; scoped runtime secrets are revoked by the
  server.
- The running app has not been checked by hand (computer use is blocked on
  this Mac); the UI is verified by component tests.
