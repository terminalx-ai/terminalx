# Sharing cloud workspaces (PRO-30)

Share a cloud workspace with people in its organization, see who else is in
it, leave notes for each other and take turns driving its agent tabs. The
contract is saas section 20 (roles, share records, the runtime's
`collaboration` refresh field, mailbox checks and `collab/1`). Sharing is
never inferred from the desktop pairing plan in `docs/MULTIPLAYER.md`: the
API's share records and the runtime's collaboration map are the only
sources.

<!-- Runtime sections (terminalx-serve: collab/1, leases, revocation) go here. -->

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
