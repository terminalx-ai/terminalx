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
- The workspace list shows archived workspaces apart, with their deadline,
  what the final save did, Read conversations (never wakes), Unarchive (it
  stays suspended), Delete now, and Retry archive for an archive that failed.
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

If the request is gone and the runtime is still running ten minutes later
(the archive failed, or was undone before compute stopped), it takes work
again. The refresh runs every 30 s, so the request is seen within 30 s of the
archive asking; the server waits 60 s.

## Tests

- `src/components/cloud/CloudWorkspaceLifecycle.test.tsx`: dirty files,
  unpushed commits, an open PR and a running turn before an archive; force
  only once confirmed; a refusal for new work; an offline workspace; a
  provider without permanent delete; cleanup progress; retry after a
  provider failure.
- `src/components/cloud/CloudSessionPage.test.tsx`: the archive list,
  unarchive without compute, a failed archive, a tombstone's notice.
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

- Organization teardown and the provider disconnect `archive` disposition
  have no desktop UI yet.
- Preview routes do not exist; scoped runtime secrets are revoked by the
  server.
- The running app has not been checked by hand (computer use is blocked on
  this Mac); the UI is verified by component tests.
