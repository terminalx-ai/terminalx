# Sharing cloud workspaces (PRO-30)

Teammates see the same cloud workspace, know who else is there, talk to each
other in notes, and take turns driving the agent, with explicit authority to
send input and to approve actions. The server half is terminalx-saas
contract §20 (`apps/api/docs/cloud-workspace-remote-runtime-contract.md`);
this document is the runtime and desktop half.

This is not desktop session sharing. `docs/MULTIPLAYER.md` plans sharing a
session of a desktop host with paired phones; nothing here is inferred from
it. A cloud workspace's sharing comes from the API's share records and is
negotiated as its own namespace (`collab/1`).

## Who may do what

Two things decide a connection's rights:

- **Attachment authority** (PRO-13): `manage` for an organization admin's
  desktop, `participate` for everyone else and every phone. Runtime-scope
  work (create or kill terminals, file and Git writes, create, close or
  configure agent tabs, rotate the key) stays `manage`.
- **Role** (per person, from the API): `manager` (owners and admins),
  `driver` (the workspace's creator, and members shared as drivers), `viewer`
  (members shared as viewers), or `none` (any other member). `canApprove` is
  separate: managers and the creator always approve; a share says whether its
  person does. A viewer may approve.

| | none | viewer | driver | manager |
| --- | --- | --- | --- | --- |
| Agent tabs, transcripts, terminals (watch), files, Git (read) | | ✓ | ✓ | ✓ |
| Presence, notes | | ✓ | ✓ | ✓ |
| Workspace content key (`keys.get`) | | ✓ | ✓ | ✓ |
| Send, steer, stop (mailbox) | | | ✓ (lease) | ✓ (lease) |
| Take control of and type into a terminal | | | ✓ | ✓ |
| Take over another person's tab lease | | | | ✓ |
| Permission decisions | `canApprove` | `canApprove` | `canApprove` | ✓ |

The API lists everyone whose role is not `none` on every `/refresh`
(`collaboration`, advertised by the runtime as `collaboration-v1`) and stamps
the actor's role on every mailbox lease. The runtime answers from its latest
list and narrows a stamped role by it, so whichever of the two saw a
revocation first wins.

Until the API has sent a list (an API before PRO-30), participants keep what
they had: reads of files, Git and terminals, and nothing new. A list the
runtime cannot read, or of an unknown version, gives participants nothing.

Note the change for members nobody shared the workspace with: before PRO-30 a
`participate` attachment could read files, Git and terminals of an
organization-visible workspace. With a member list, reading needs a role:
sharing is the authorization.

## Runtime (`terminalx-serve`)

`src-tauri/src/remote/collab.rs` holds the member list, the tab driver
leases and the notes; `remote/server.rs` serves `collab/1` and enforces roles
on every call; `cloud_agents/mailbox.rs` enforces them on every command.

### `collab/1`

Granted in `rpc.hello` when asked for. The hello result then carries
`you: { userId, role, canApprove }`.

| Method | Params → result | Who |
| --- | --- | --- |
| `collab.state` | `{}` → `{ you, participants, leases }` | role ≠ none |
| `presence.update` | `{ tabId?, activity?: viewing \| typing }` → `{}` | role ≠ none |
| `notes.list` | `{ tabId, beforeId?, limit? }` → `{ notes, more }` | role ≠ none |
| `notes.post` | `{ tabId, text, clientRequestId }` → `{ note }` (idempotent) | role ≠ none |
| `lease.acquire` | `{ tabId }` → `{ lease }`, or `lease_held` with `data.lease` | driver, manager |
| `lease.release` | `{ tabId }` → `{}` (the holder, or a manager) | driver, manager |
| `lease.takeOver` | `{ tabId }` → `{ lease }` | manager |

Notifications: `collab.presence { participants }`, `notes.posted { note }`,
`collab.lease { tabId, lease }` and `collab.you { you }` (the connection's own
role changed).

- **Presence** is one row per person over all their connections
  (`surfaces`), with the tab and activity of their most recent update. A
  person leaves with their last connection.
- **Notes** are for people. The author is the connection's verified person,
  never a parameter. They are stored only by the runtime
  (`<data dir>/cloud-agent/notes/<sha256(tabId)>.jsonl`, 0600, the newest 500
  per tab), are never typed to the agent, and are not in transcripts or
  checkpoints.

### Competing input

- **Agent tabs.** One person drives a tab at a time. A `send` or `steer`
  claims the tab's lease for its sender, or is `rejected` with category
  `lease-held` (the receipt says `holderId`) while someone else holds it. A
  `stop` is refused the same way, except for managers. The lease lasts while
  the turn runs and two minutes after the holder's last send. Managers take it
  over explicitly. `AgentTabInfo` carries `lease`, and every queued follow-up
  its sender (`followUps[].actorId`).
- **Terminals.** Unchanged ownership (PRO-26): one controller per terminal.
  Drivers may now take control too. Terminals and `pty.control`
  notifications carry `controllerId`, so clients show who is typing.
- **Permission decisions** are not lease-bound; they need `canApprove`.

### Revocation

While anyone is attached, the runtime refreshes every 5 s (15-30 s when idle)
and re-applies the list:

1. Connections of a person who lost access are closed; attachments the API
   revoked are closed as before.
2. A person who may no longer drive loses terminal control (announced) and
   their tab leases.
3. Queued follow-ups of anyone who may no longer drive are dropped, with a
   note in the transcript. Each follow-up is also re-checked right before it
   is typed.
4. The workspace content key rotates when anyone lost access, as it does for
   revocations and for a workspace turning private.

Live calls check the current list on every call, so a downgraded driver's next
terminal write is refused even before step 2 runs. On the server, queued
mailbox commands are re-checked when leased, and settled `rejected` /
`access-revoked` without ever reaching the runtime (contract §20.4).

### Keys (change to PRO-22)

`keys.get` is open to `participate` connections whose person has a role, not
only to `manage`. The key handout is therefore exactly the authorized sharing:
the runtime hands the key over the E2EE channel only to someone the API lists,
and rotates it when someone is removed. What a removed person already
decrypted, they keep. The server still never holds a key.

## Desktop

### Share records: `src-tauri/src/cloud_workspaces.rs`

| Command | Route | Result |
| --- | --- | --- |
| `cloud_workspace_shares(workspaceId)` | `GET /v1/desktop/orgs/:orgId/cloud-workspaces/:workspaceId/shares` | `{ shares, you: { role, canApprove, canManageShares } }` |
| `cloud_workspace_share_put(workspaceId, userId, role, canApprove)` | `PUT …/shares/:userId` with `{ "v": 1, "role", "canApprove" }` | `{ share, created }` |
| `cloud_workspace_share_revoke(workspaceId, userId)` | `DELETE …/shares/:userId` | `{ share }` |

Like the other cloud workspace commands, the token and organization stay
native, a response that lands after an account or organization switch is
dropped, and ids are checked before anything is sent. A `share` answer for
someone other than the person asked about is treated as an unknown outcome.
The refusals keep their codes (`cloud_workspace_share_redundant`,
`cloud_workspace_share_requires_organization_access`,
`cloud_workspace_share_limit`, `cloud_workspace_share_forbidden`,
`cloud_workspace_share_not_found`, `organization_member_not_found`,
`cloud_workspace_collaboration_forbidden`). Bindings: `api.cloudWorkspaceShares`,
`api.cloudWorkspaceSharePut` and `api.cloudWorkspaceShareRevoke` in
`src/lib/api.ts`.

### `collab/1` client: `packages/portable/src/workspaceCollab.ts`

`WorkspaceCollab` wraps `collab.state`, `presence.update`, `notes.list`,
`notes.post` (with a `clientRequestId` kept across a resend, so a dropped
connection never posts a note twice), `lease.acquire`, `lease.release` and
`lease.takeOver`, and `onEvent` parses `collab.presence`, `notes.posted`,
`collab.lease` and `collab.you`. `presence.*`, `notes.*` and `lease.*` are
granted by `collab/1` (the client refuses them with `capability_not_granted`
on a runtime that did not grant it). A `lease_held` refusal carries the
current lease in its data (`leaseHeldBy(error)`). The connected state carries
`you: { userId, role, canApprove }` from `rpc.hello`.

`src/lib/cloudCollab.ts` keeps, per workspace, `you`, the participants, the
leases by tab and the notes by tab. `startCollab` runs on every connect: it
reads `collab.state` and follows the notifications; with role `none` it asks
nothing (every `collab/1` method refuses `none`) and waits for `collab.you`.
Without `collab/1` the store stays empty and every view behaves as before
sharing existed.

Names: `src/lib/cloudPeople.ts` resolves user ids from the organization
roster (`organization_members`) and the share list, else `User <short id>`.

### What the person sees

**Share dialog** (the Share button in the workspace header). It lists the
active shares with name and email. Someone with `canManageShares` (an
organization owner or admin, or the workspace's creator) can change a
share's role (Viewer or Driver), toggle "Can approve permissions", revoke it,
and add a person from the organization roster (people already shared are not
offered again). Refusals are shown in words:

| Code | Shown |
| --- | --- |
| `cloud_workspace_share_redundant` | "<name> already has access as owner/admin/creator." |
| `cloud_workspace_share_requires_organization_access` | "Make the workspace visible to the organization first." |
| `cloud_workspace_share_limit` | the 64-person limit, revoke someone first |
| `cloud_workspace_share_forbidden` | only admins and the creator can change sharing |
| `organization_member_not_found` | the person is no longer a member |

Everyone else sees the same list read-only, with their own access ("Your
access: Viewer …, can approve permissions").

**Participants bar** (workspace header). One chip per person from
`collab.state` and `collab.presence`: initials, name ("You" for this
person), role badge, `×N` when they have several windows or devices open,
the tab they are on ("on Terminal 1", or the agent tab's title) and a typing
indicator. The desktop reports its own presence with `presence.update`:
`{ tabId, activity: "viewing" }` when the person switches agent tab or
terminal (a terminal's `tabId` is its `ptyId`), and on composer keystrokes
`activity: "typing"` at most every 10 s, back to `"viewing"` after 4 s
without a keystroke. After a reconnect the current tab is sent again.

**Agent tabs** (`src/components/cloud/CloudAgents.tsx`), when `collab/1` is
granted:

* A lease bar above the conversation: "You are driving", "Driving: <name>" or
  "No one is driving". Drivers and managers get "Take the wheel"
  (`lease.acquire`) while it is free and "Release" while they hold it;
  managers get "Take over" (`lease.takeOver`) while someone else holds it. A
  lease counts until its `expiresAt`; the bar updates when it passes.
* The composer is disabled, with the reason above it, for a viewer ("You can
  view this workspace; ask an admin for driver access") and while someone
  else holds a live lease ("<name> is driving this tab. …"). Stop is allowed
  only to the holder and managers.
* Outbox entries rejected with category `lease-held` read "<holder> is
  driving — your message was not sent" (the holder from the receipt's
  `holderId`); `access-revoked` reads "Not sent: your access changed". Queued
  follow-ups show who queued them (`actorId`).
* Permission and question cards can be answered only by a manager or someone
  with `canApprove`; for everyone else their buttons are disabled with
  "Waiting for someone who can approve".
* Notes: a separate "Notes" drawer per agent tab, apart from the chat and
  its composer, with each note's author and time and its own input ("Add a
  note for teammates (not sent to the agent)"). Notes go only through
  `notes.list`/`notes.post`/`notes.posted`; posting one never enqueues an
  agent command.

**Terminals.** A terminal controlled by someone else names them ("Alice is
typing in this terminal", from `controllerId` in the terminal description and
`pty.control`). "Take control" is offered to manage attachments and to
drivers and managers of a shared workspace; viewers never get it.

**Not shared.** A participate connection whose role is `none` sees "This
workspace has not been shared with you" instead of empty terminal and agent
lists, with a People button that opens the read-only share list.

### Tests

`packages/portable/src/workspaceCollab.test.ts`,
`src/components/cloud/CloudShareDialog.test.tsx`, the PRO-30 blocks of
`CloudAgents.test.tsx` and `CloudSessionPage.test.tsx`, and the
`cloud_workspaces::tests::share*` Rust tests.

## Development and tests

A `--relay-link` file may carry the list as the API would:
`"collaboration": { "v": 1, "members": [{ "userId", "role", "canApprove" }] }`,
and attachments may carry `userId`. The file is re-read on every refresh.

- Unit: `remote::collab` (roles, diffs, leases, notes storage),
  `remote::server` tests `roles_decide_…`, `without_a_member_list_…`,
  `presence_and_notes_…` and `the_driver_lease_…`, and `cloud_agents::mailbox`
  tests for viewers, approvers, narrowed roles, the lease and dropped
  follow-ups.
- Relay e2e (`scripts/remote-runtime/e2e.sh`,
  `a_shared_workspace_serializes_input_and_stops_access_when_revoked`): an
  admin, a driver, an approving viewer and an unshared member over the real
  relay. It covers presence, notes, the lease refusing a competing send,
  decisions by approval right, a mid-turn revocation, and a reconnect under
  the new role. The revocation closes the connection, drops the queued
  follow-up and rotates the key. An outsider (not a member) never gets an
  attachment; that is the API's 404 and is tested there.
