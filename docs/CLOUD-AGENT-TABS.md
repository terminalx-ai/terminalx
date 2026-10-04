# Cloud agent tabs (PRO-22)

Agent tabs in a cloud workspace: the runtime (`terminalx-serve`) runs one agent
process per tab with the same PTY-first harness as the desktop, and is the only
writer of each tab's transcript. Desktops talk to it two ways:

- **Live workspace RPC** (`terminalx-workspace-rpc/1` over the relay E2EE,
  `remote/server.rs`) for reading: tab list, transcript replay and live
  events, and for configuration (model, effort, permission mode).
- **The API command mailbox** (terminalx-saas contract §11-13) for every
  command whose replay would be harmful: `send`, `steer`, `stop`,
  `permission-decision`. A desktop never sends these over live RPC, so there
  is exactly one delivery path and one receipt per command, whether the
  runtime is online, reconnecting or suspended.

One more live path exists since PRO-86: the tab's **terminal view** types
into the agent's own terminal with `pty.write` (`agent-pty/1`), as into a
shell. It is keystrokes, not commands: nothing is queued, receipted or
replayed, it only works while the runtime is online, and it has its own
authority rules. See "An agent tab's terminal view" in `CLOUD-SHARING.md`.

The server half is terminalx-saas #109 (`apps/api/docs/cloud-workspace-remote-runtime-contract.md`
§11-14). This document is the runtime/app half of that contract.

## Runtime

`src-tauri/src/cloud_agents/`:

| File | What |
| --- | --- |
| `crypto.rs` | AES-256-GCM with the contract's AAD (shared with the desktop). |
| `keys.rs` | Workspace content keys (WCK): create, store, rotate, retire. |
| `receipts.rs` | Durable receipt store with its `storageIncarnationId`, and the durable follow-up queue. |
| `mailbox.rs` | Lease → apply → receipt → ack loop. |
| `checkpoints.rs` | Transcript projection, gzip, encrypt, upload. |
| `api.rs` | The runtime's mailbox/checkpoint HTTP calls (runtime credential). |
| `mod.rs` | `CloudAgents`: wiring into `serve` and `WorkspaceRpc`. |

State lives under `<data dir>/cloud-agent/` (0700 directory, 0600 files):
`keys.json`, `receipts.jsonl`, `incarnation`, `followups.json`, `checkpoints.json`.

### Keys (`keys/1`, §13)

- A WCK is 32 random bytes; `keyId` is 16 random bytes base64url.
- `keys.get` → `{ currentKeyId, keys: [{ keyId, key, createdAt, retiredAt? }] }`
  (`key` base64url). `manage`, and since PRO-30 a `participate` connection
  whose person the workspace is shared with (`docs/CLOUD-SHARING.md`); anyone
  else is refused. Retired keys stay listed for 7 days so queued commands and
  old checkpoints still decrypt.
- `keys.rotate` (manage, idempotent) → `{ currentKeyId }`.
- The runtime rotates by itself when the bootstrap session's `accessMode`
  narrows to `private`, a new revocation arrives, or someone loses access to
  a shared workspace (PRO-30). After any rotation,
  connections with `keys/1` get a `keys.changed` notification and fetch the
  keys again.
- A command whose `keyId` is unknown, or was retired more than 24 h before the
  command was created, is rejected with category `key-unknown`.

### Command plaintexts

Every plaintext is JSON with `"v": 1`. It is AES-256-GCM encrypted with AAD
`["terminalx-agent-command/1", organizationId, workspaceId, tabId, clientCommandId, kind, keyId]`.

| kind | plaintext | Applying it |
| --- | --- | --- |
| `send` | `{ v, text, model?, effort?, mode? }` | Idle tab: the prompt goes to the agent now. Mid-turn: it joins the tab's durable follow-up queue and goes out when the turn ends. `model`/`effort`/`mode` are applied to the tab first. |
| `steer` | `{ v, text }` | Mid-turn: typed into the running CLI now; Claude Code and Codex take it at their next step. Idle: like `send`. |
| `stop` | `{ v }` | Interrupts the turn and drops the tab's queued follow-ups (listed in the receipt). |
| `permission-decision` | `{ v, requestId, optionId }` or `{ v, requestId, answers }` | Answers that pending request. If it is no longer pending, the command is `rejected` with `request-not-pending`. |

The receipt plaintext is `{ v: 1, outcome, category?, queued?, droppedFollowUps?, requestId?, message? }`. It is
encrypted with AAD `["terminalx-agent-command-result/1", organizationId, workspaceId, clientCommandId, outcome, keyId]`
under the command's own key (`keyId` is the command's), which its author holds. A command whose key is unknown gets a
receipt with no body; its category (`key-unknown`) is enough.

Rejection categories are `key-unknown`, `decrypt-failed`, `payload-invalid`, `tab-unknown`, `forbidden`,
`request-not-pending`, `agent-unavailable` and `apply-failed`.

### Exactly-once (§11.4)

1. `applying(clientCommandId)` is appended and fsynced before the command is
   applied. `receipt(clientCommandId, outcome, result)` is appended and fsynced
   after, and only then is the command acked.
2. A lease whose id already has a receipt acks that stored receipt again.
3. A lease with `applying` but no receipt (the runtime died mid-apply): a `stop`
   is safe to repeat and is applied again. Anything else is acked
   `outcome-unknown` (`runtime-interrupted`) and never applied twice.
4. A missing or unreadable store gets a new `incarnation`. The server then
   settles the old leases as `outcome-unknown`.
5. Follow-ups accepted as `applied` are queued in `followups.json`, so a runtime
   restart still sends them.

The poll runs after every relay registration, immediately after a batch that
leased anything, every 3 s while a client is attached, every 20 s otherwise,
and at once on `session.nudge`. An `ack` that failed transiently is retried
with the same token; `stale-lease` is final; `stale-generation` leases again.

### Checkpoints (§12)

- Projection schema 1 (JSON, then gzip, then AES-GCM with AAD
  `["terminalx-transcript-checkpoint/1", organizationId, workspaceId, tabId, epoch, version, schemaVersion, keyId]`):

  ```jsonc
  { "v": 1, "sessionId", "tabId", "title", "harness", "model", "effort", "permissionMode",
    "status",            // idle | in_progress | waiting | completed
    "process",           // running | exited | not-started
    "events": [AgentEvent],  // newest whole committed events (no deltas), ≤ 1 MiB of JSON
    "truncated": false,
    "followUps": [{ "clientCommandId", "text" }],
    "updatedAt": 0 }
  ```
- Uploads are coalesced to at most one per tab every 5 s while a turn streams,
  and go immediately when a turn settles, a permission is requested, or the
  follow-up queue changes. A failure never blocks the agent; the next change
  retries.
- `(epoch, version)` is kept in `checkpoints.json`. `version` grows by one per
  upload. If the file is missing, the epoch is the current runtime generation.
  A `409 stale` moves to epoch + 1 and retries once.
- Closing a tab with `remove` deletes its checkpoints.

### `session/1` additions (additive)

| Method | Authority | Params → result |
| --- | --- | --- |
| `session.tabs` | participate | `{}` → `{ tabs: [AgentTabInfo] }` |
| `session.configure` | manage, idempotent | `{ sessionId, tabId, model?, effort?, mode? }` → `{ tab: AgentTabInfo }` |
| `session.markRead` | participate | `{ sessionId, tabId }` → `{}` |
| `session.nudge` | participate | `{}` → `{}` (poll the mailbox now) |
| `session.create` | manage, idempotent | unchanged (+ `tab: AgentTabInfo` in the result); one session with one agent tab per call |
| `session.close` | manage, idempotent | `{ sessionId, tabId?, remove? }`. `remove` also drops the tab from the list and its checkpoints |

`AgentTabInfo`:

```jsonc
{ "sessionId", "tabId", "title", "harness", "model", "effort", "permissionMode",
  "status",        // idle | in_progress | waiting | completed (completed = finished, unread)
  "process",       // running | exited | not-started
  "pendingPermissions": [{ "requestId", "toolName", "input", "options" }],
  "followUps": [{ "clientCommandId", "text" }],
  "signIn": { "provider", "state", "reason" },  // only when the agent cannot sign in
  "lastSeq": 0,    // newest committed event seq
  "created", "modified" }
```

`signIn` (PRO-78) is present only when the tab's agent has no way to sign in:
the server's last grant answer listed no usable login for its provider
(`claude`, `codex`, `cursor`), the workspace configuration sets no key for it,
and the session did not start with a credential. `state` is `not-connected`
when the organization has no login for the provider, else the server's state
for the one it has (`revoked`, `disconnected`, `unavailable`, with a `reason`
such as `token-expired` or `shared-use-policy`). It is never set on a guess:
not before the first grant sync, not after a failed one, and never for an
agent the runtime cannot rule out a hand sign-in for (Cursor). Such a tab does not
count as an active turn in the activity report, so it does not hold off the
idle suspend, and the desktop shows it as "Needs sign-in", not "Working". A
first prompt for such an agent fails with the launch category
`agent-sign-in-required` instead of being typed into a sign-in screen.

Subscribers of `session.subscribe` also get `session.status` notifications:
`{ subscriptionId, sessionId, tabId, status }` (the process state comes with
`session.tabs`). Cursors are `<generation>:<process epoch>:<seq>`: a restarted
runtime numbers events again from the last saved one, so a cursor from
before a restart is `cursor_expired` and the client resyncs from a full
replay, merging by event id. Tab list changes
are sent to every connection with `session/1` as `session.tabs` with
`{ tabs }` (no subscription id).

`session.send` stays for older clients. The desktop from PRO-22 on does not
use it.

A runtime restart kills the agent processes. A tab that was mid-turn is marked
`process: "exited"`, and a `status` event says the turn ended with the runtime,
so the UI never shows it as still running. Its saved conversation resumes on
the next `send` (the harness resumes the provider session).

## Desktop

### Rust (`src-tauri/src/cloud_agent_client.rs`)

- **Keys.** When a cloud connection reaches `connected` with `keys/1` granted,
  `cloud_remote` calls `keys.get` itself (request id `keys-…`). The answer never
  reaches the web view. Keys go to the OS keychain (macOS; a 0600 file
  elsewhere) under `(organizationId, workspaceId, keyId)` and are dropped on
  identity change.
- **Outbox.** Stored in `<store root>/cloud-agent-outbox/<org>/<workspace>.json`. Each entry is the exact
  encrypted envelope plus its last known server state. It is written before
  the first POST and resent byte for byte until the server has it.
- Tauri commands, all taking `{ organizationId, workspaceId }` plus:

  | Command | Args | Result |
  | --- | --- | --- |
  | `cloud_agent_enqueue` | `tabId, kind, payload` (the plaintext without `v`) | `OutboxEntry` |
  | `cloud_agent_outbox` | `tabId?` | `OutboxEntry[]` (pending first, then the 20 newest settled per tab) |
  | `cloud_agent_outbox_sync` | | `OutboxEntry[]` after resending unsent entries and polling `/status` |
  | `cloud_agent_cancel` | `clientCommandId` | `OutboxEntry` |
  | `cloud_agent_checkpoints` | | `[{ tabId, epoch, version, … }]` (metadata) |
  | `cloud_agent_checkpoint` | `tabId, afterEpoch?, afterVersion?` | `{ epoch, version, projection } \| null` |
  | `cloud_agent_has_key` | | `boolean` |
  | `cloud_agent_cache_load` | | `{ tabs: Record<tabId, CachedTab> }` |
  | `cloud_agent_cache_save` | `tabId, entry: CachedTab \| null` | `()` |

  `OutboxEntry = { clientCommandId, tabId, kind, text?, requestId?, state, wake?, outcome?, category?, receipt?, createdAt, updatedAt, error? }`.
  `state` is `unsent`, `queued`, `leased`, `applied`, `rejected`, `cancelled` or
  `outcome-unknown`. `text` and `requestId` come from the local plaintext, so
  the UI can show them.

### UI (the agent view of `CloudWorkspaceView`, `src/lib/cloudAgents.ts`)

- Tabs are listed from the local cache first, then from checkpoint metadata,
  then from `session.tabs` when connected.
- Opening a tab loads the local cache, then the checkpoint (only if newer),
  then a live `session.subscribe` if the runtime is already online. Only
  an interactive action (send, steer, decision) enqueues and may wake the
  runtime.
- The existing `Chat`, `Composer`, tool rows and permission cards render it.
  Events go through the same `applyEvent`/`buildTranscript`.
- The page shows three things independently: the connection (relay state),
  the agent turn (tab status plus process), and provisioning (workspace
  state and wake).
- Outbox entries show as pending, queued, applied, rejected, or "may not have
  been sent" (`outcome-unknown`, never resent automatically).
- Ordered events, the cursor, unread and completed state persist in the cache.

Mobile is out of scope for PRO-22. It can reuse the same keys, outbox and
checkpoint formats.

## Development and tests

A `--relay-link` file (development and the relay e2e) may add a mailbox
section. The runtime then leases from and uploads checkpoints to that origin,
standing in for the bootstrap:

```jsonc
{ "v": 1, "hostSecretB64": "…", "relayToken": "…", "directorUrl": "…",
  "mailbox": { "origin": "http://127.0.0.1:PORT", "runtimeCredential": "…",
               "organizationId": "org_…", "workspaceId": "ws_…" } }
```

`scripts/remote-runtime/fake-claude` stands in for Claude Code in tests. It
speaks the harness's hooks and writes a Claude-format transcript, so the real
PTY-first harness runs against it.

## Creating a workspace with a first task (PRO-21)

The create form (`CloudCreateWorkspace`, `src/lib/cloudCreate.ts`) takes the
organization's selected GitHub repositories (PRO-14): a primary one, up to
four more, and a base branch for each. It also takes the first prompt, the
agent, model, effort and permission mode, and who can see the workspace. The
server stores the prompt as an encrypted, expiring **launch intent**
(terminalx-saas contract §19), not as a mailbox command. A desktop that has
never attached holds no workspace content key to encrypt a command with.

- **Before anything is quoted:** names, branch names (`git check-ref-format`
  rules), duplicates and the prompt size are checked on this machine. The
  repositories and refs are then checked against GitHub (`/preflight`).
  Quota and policy refusals (`cloud_workspace_quota_exceeded`,
  `cloud_workspace_policy_denied`, `cloud_provisioning_paused`) are shown in
  words.
- **Retry:** the idempotency key and exact request are kept (in
  `localStorage`) until the server answers. A retry after an unknown outcome
  resends the same bytes and gets back the same workspace and its single
  intent. A failed create whose machine exists is retried with `resume`,
  which reuses that machine.
- **Cancel:** while the operation is cancelable. A canceled intent is never
  delivered.
- **Progress:** allocating, booting, authenticating runtime, syncing
  repository, starting agent, running. These phases come from the
  workspace's `launch.phase`, polled from its operation.

The runtime half is `src-tauri/src/cloud_agents/launch.rs`:

1. Claim the intent with the receipt store's `storageIncarnationId`,
   declaring `launch-clone-v1`.
2. Clone every repository the claim marks `clone` (see below).
3. For each repository, switch to its base ref, then create the workspace's
   own work branch. If the branch already exists, it came from an earlier
   attempt of this same workspace, so switch to it instead.
4. Start the agent tab in the primary repository and send the prompt.
5. Report the outcome.

### Cloning at launch (Boat, Hetzner, Machine0)

A workspace launched from an Environment image already holds its checkouts.
Boat, Hetzner and Machine0 have no Environment images, so their workspaces
start with an empty project root and the claim marks each repository
`"clone": { "provider": "github" }` with a `path` directly inside the
project root. The runtime then:

- builds the URL itself, `https://github.com/<owner>/<name>.git`. The claim
  carries no URL and no credential;
- clones into `.terminalx-clone-<dir>` next to the final path, at the base
  branch, and moves the finished clone into place. A clone that died halfway
  is never mistaken for a checkout, and its leftover is removed on the next
  attempt;
- keeps a checkout that is already there (an earlier attempt of the same
  workspace) when its `origin` is that repository, and refuses anything else
  at the path without deleting it;
- makes a full clone (all history and branches, as a local checkout has),
  capped by time instead of depth: a transfer that stalls for a minute is
  given up, and all of a launch's clones together get 30 minutes
  (`CLONE_BUDGET`). At the deadline Git's whole process group is killed;
- counts as work while it runs (`cloud_activity::launching`): the activity
  report carries it as a running turn, so the server's idle suspend does not
  stop a workspace whose clone is still going with nobody attached;
- stops when the create is canceled: while Git runs, the launcher asks the
  server every 10 s whether the intent is still claimed, and on a cancel
  kills Git's process group and removes the staging directory. An API it
  cannot reach is not a cancel;
- reports why a clone could not be made, each with its own text in the
  desktop (`FAILURES` in `src/lib/cloudCreate.ts`). The agent is not started
  and the prompt is not sent:

  | Category | When |
  | --- | --- |
  | `repository-access-denied` | GitHub or the credential helper refused (no access, repository not found, sign-in failed) |
  | `repository-branch-not-found` | the base branch is not in the repository |
  | `repository-clone-timed-out` | the transfer stalled, or the 30 minutes ran out |
  | `repository-path-occupied` | files, or another repository's checkout, are already at the path; nothing is deleted |
  | `repository-empty` | the repository has no commits |
  | `workspace-disk-full` | the disk or quota ran out while cloning |
  | `repository-clone-failed` | anything else (network, a broken transfer) |

  A desktop from before these categories shows the category itself in
  "The agent did not start (…)".

### Repositories without a first prompt

A workspace created without a first prompt (the web console's Launch dialog
sends the repositories and no `launch`) has no intent, so there is nothing to
deliver. The claim then carries a `checkout` plan: the same repositories and
the workspace's own work branch. The same plan comes with a launch that has
already settled, which covers a launch whose clone failed and a machine whose
disk was replaced.

- Each repository is set up once: cloned as above, then put on the work
  branch. Its path is then written to `checkout.json` next to `launch.json`.
- A path in that record is never touched again. A checkout that is already
  there without a record (made by a launch, or by an older runtime) is
  adopted as it is and recorded. So a later boot never switches a person's
  branch back and never clones again a checkout they removed.
- A replaced disk has neither checkout nor record, so it is cloned again.
  The first prompt is not: its intent is settled.
- No agent is started and nothing is reported to the server. A repository
  that fails is logged and tried again on the next boot; the others are
  still set up.
- It counts as work while it runs, like a launch, so idle suspend does not
  cut a clone short. The same checks apply to the plan as to a launch.

**The GitHub token.** `launch.rs` never holds one. Git asks the credential
helper `cloud_github` installs at boot (PRO-14), which gets a short-lived
token from the API for this workspace's repositories only. The token is not
in the clone URL, the `origin` remote, the Git config, the environment or a
log line; it exists in Git's memory and in the helper's tmpfs cache (or
nowhere, without tmpfs). A public repository clones without asking for one.

A plan that names another provider, an owner or name that is not a plain
GitHub name, or a path that is not a new directory directly in the project
root is refused before Git runs (`payload-invalid`).

`launch.json` (next to `receipts.jsonl`) records `applying` durably before
the agent is touched, and the outcome after. So a restart or a lost
completion reports the stored outcome, and a runtime that died mid-start
reports `outcome-unknown`. In neither case is the prompt sent twice. Tests:
`cloud_agents::launch` unit tests and `serve/tests/launch_intent.rs`. The
latter runs the real runtime with the fake Claude against the fake API and
checks both work branches, one prompt, and no second prompt after a restart.
