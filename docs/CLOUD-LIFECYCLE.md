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

What "resume" brings back depends on the provider, and the Stop tab says
which (PRO-33): `providerCapabilities.preservesProcessesOnResume` in the
disposition facts is `false` for Boat, Hetzner and Machine0 (a cold boot: the
files in the workspace come back and its saved conversations are shown as
before; running programs and terminals do not, and what was installed or
written outside the workspace may not, because Boat keeps only part of the
disk) and `true` only where the machine is frozen as it is
(local Docker in pause mode). An older server does not send it, and the
dialog then promises neither (`resumeBehaviourText`).

## Desktop

- `src/components/cloud/CloudWorkspaceLifecycle.tsx`: one dialog for all
  three, opened from a workspace's Stop, Archive or Delete button, with the
  table above for the chosen action. Before an archive or delete it lists the
  server's facts (`GET …/disposition`: running agent turns, pending
  approvals, an operation in progress) and the runtime's
  (`lifecycle.dispositionFacts`: uncommitted files, unpushed and local-only
  commits, open pull requests, running terminals). The runtime is asked only
  when the workspace is running; a suspended one is reported as not
  checkable rather than woken.
- Export before an archive or delete (the server has no export of its own,
  so these are the choices): **Push**, beside each repository with unpushed
  or local-only commits, pushes its current branch from the dialog
  (`pushRepository`: a `connect`, never a wake, and the facts are read again
  afterwards); **Open workspace** opens it to commit uncommitted files or
  copy files out, which a push cannot do for them; and on Delete, **Archive
  instead** switches to keeping everything for the retention period.
- Retention: the Archive tab offers the periods the server lists
  (`archiveRetentionChoices`: 7, 30 or 90 days), with the workspace's own
  preselected. A chosen period is sent as `retentionDays`; the workspace's
  own is not sent. A server that lists none takes no choice (it would refuse
  the field), and the picker is absent.
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
  in the organization can create, resume or unarchive a workspace. So the
  confirmation first shows how many workspaces it takes, counted by the
  server (`GET …/cloud-teardown/preview`, `cloud_teardown_preview`) because
  an admin's own list leaves out other people's private workspaces, and says
  so ("including 3 private ones that belong to other people"); it cannot be
  started when the count cannot be read. Archive, the choice that can still
  be undone, is preselected, and nothing is sent before the organization's
  name is typed. The confirmation is for one organization at one account
  context: the request carries both, and `request_teardown` sends nothing
  (`account_context_changed`) if the active organization or the context
  changed since it was opened, so a name typed for one organization never
  tears down another; the page also drops an open confirmation when either
  changes. The count shown is the count acted on: the request carries the
  preview's count and token, the native side reads the preview again just
  before sending and sends nothing if it differs, and the server refuses
  (`cloud_teardown_preview_changed`) a teardown of any other set. A
  confirmation is spent by one attempt and void after every read of the
  status (Refresh included): a name typed to archive never carries over to
  "Delete every workspace", which always needs its own count and its own
  freshly typed name. After an outcome that is not known the status is read
  at once. Resources are named with the server's own kinds (`workspace`,
  `runtime`, `build`, `legacy-operation`) and their states in the app's
  words; one it does not know is shown as it comes. A pending archive can only be escalated to deleting now. The section
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

The notice names what ran out: bytes ("100 MB free of 40 GB"), or the
filesystem's limit on the number of files when that is the cause, with the
bytes still free beside it. Its advice follows the person's role: someone who
manages the workspace is told to delete files or build output from a
terminal; a viewer or a plain driver, who has no shell there, is told that
someone who manages it can.

What the runtime does on a full disk, each of which was already so and is now
said in the notice ("a message the workspace could not record is refused, not
half-applied"):

- A command from the mailbox is applied only after its `applying` mark is on
  disk (`cloud_agents/receipts.rs`). If that write fails the agent is not
  touched and the command is answered `rejected` / `receipt-store-failed`
  (`mailbox.rs`); the outbox shows "Not sent: the workspace could not record
  it (its disk may be full)".
- A receipt that cannot be written after the agent was touched leaves the
  `applying` mark, so a redelivery is never applied twice.
- A follow-up that cannot be queued is refused, not dropped silently.
- A checkpoint's cursor is persisted before it is used
  (`checkpoints.rs` `next_cursor`); when that fails the upload is skipped and
  tried again later, and no version is reused.
- Every such file is written to a temporary file and renamed
  (`cloud_bootstrap::write_durable`), so a failed write leaves the previous
  contents whole.

### Low memory during a turn

Memory is what the runtime may actually use: in a container (local Docker,
and any provider that runs the workspace in one) `/proc/meminfo` is the
host's, so `lifecycle.resources` also reads the cgroup limit on the runtime's
own cgroup and its ancestors (v2 `memory.max`/`memory.current`, v1
`memory.limit_in_bytes`/`memory.usage_in_bytes`, less the reclaimable file
cache from `memory.stat`). When that limit is tighter than the machine, the
limit is the total and what is left under it is what is available. A tab
waiting on an approval is not a running turn: the faster readings are for a
tab that is working.

While an agent turn runs in the session being shown (a tab working), the same reading is taken every 10 s instead of 60 s.
Memory is low when `MemAvailable` is under both 10% of RAM and 512 MiB, the
rule the server's worker uses before a relaunch (saas contract 9.5). Three low
readings in a row show "The workspace's machine is almost out of memory (… free
of …). The agent, or a program it runs, may be stopped by the machine." One
reading with room breaks the run and clears the warning; so do the end of the
turn and the loss of the connection. Low memory with nothing running is not
warned about.

Not done: the server is not told, so the workspace list and an admin's
diagnostics do not show a full disk to someone who is not connected to it,
and a stopped workspace's disk is not known.

## Tests

- `src/components/settings/OrganizationCloudTeardown.test.tsx`,
  `ProviderControls.test.tsx`: nothing is sent without a disposition and the
  typed name; the count shown, private workspaces included; a context change
  while the confirmation is open; an archive with an unknown outcome leaves
  no armed delete; Refresh voids the confirmation; one request for a double
  click; the server's real resource kinds; escalation only; what remains; a finished
  teardown; a member; an unknown outcome; archive on disconnect and its
  deadline.
- `src/components/cloud/CloudWorkspaceLifecycle.test.tsx`: what a resume
  brings back, per provider; the retention periods and which is sent; a push
  from the dialog and its refusal; archive instead of delete; dirty files,
  unpushed commits, an open PR and a running turn before an archive; force
  only once confirmed; a refusal for new work; an offline workspace; a
  provider without permanent delete; cleanup progress; retry after a
  provider failure.
- `src/components/layout/cloud/CloudSections.test.tsx`: the archive list,
  unarchive without compute, a failed archive, a tombstone's notice.
- `src/lib/cloudResources.test.tsx`, `src-tauri/src/cloud_resources.rs`,
  `src-tauri/src/remote/server_tests.rs`: the disk levels and their wording;
  only a connected workspace is asked; the notice follows the disk and goes
  with the connection; a runtime that does not report is asked once; the
  low-memory rule, three in a row, only during a turn.
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
