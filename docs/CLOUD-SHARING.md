# Sharing cloud workspaces (PRO-30)

Teammates see the same cloud workspace, know who else is there, talk to each
other in notes, and take turns driving the agent, with explicit authority to
send input and to approve actions. The server half is terminalx-saas
contract §21 (`apps/api/docs/cloud-workspace-remote-runtime-contract.md`);
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
| Slash commands `/clear`, `/compact`, `/help` and the project's own | | | ✓ (lease) | ✓ (lease) |
| Any other slash command (`/model`, `/permissions`, `/login`, `/mcp`, …) | | | `canApprove` | ✓ |
| Model, effort and permission mode | | | `canApprove` | ✓ |
| Take control of and type into a terminal (a shell) | | | `canApprove` | ✓ |
| Take over another person's tab lease | | | | ✓ |
| Permission decisions | `canApprove` | `canApprove` | `canApprove` | ✓ |

### What each role can really do (PRO-88)

The table is what the runtime checks. This is what it adds up to, so that
nobody shares a workspace expecting a tighter line than there is.

- **Viewer.** Reads everything the workspace shows: transcripts, terminal
  output (whatever was printed there, secrets included), files, Git, and
  holds the content key. Changes nothing. A viewer with `canApprove` answers
  the agent's permission requests: they decide whether a command the agent
  asked for runs, never which command.
- **Driver without `canApprove`** (a "plain" driver). Sends, steers and stops
  the agent, and sends `/clear`, `/compact`, `/help` and the project's own
  commands. They cannot change a tab's model, effort or permission mode by
  any route (the pickers, a message's settings, a slash command), cannot
  answer permission requests, and cannot type into a terminal.
  **How much that holds them depends on the tab's permission mode.** The
  agent does what a driver's message asks within that mode. In a mode that
  asks (`manual`, `plan`, `acceptEdits`), each tool use the mode does not
  cover waits for someone who can approve. In `bypassPermissions`, which is
  the mode a new tab starts in unless another is chosen
  (`DEFAULT_PERMISSION_MODE`), the agent runs anything without asking, so a
  plain driver can have any code run as the workspace's user just by asking
  for it. Sharing as a plain driver limits what the person does only on tabs
  a manager or an approver has put in a mode that asks; the plain driver
  cannot change that mode back.
  The project's own commands are part of the repository
  (`.claude/commands`, `.claude/skills`); one can name tools it may use
  without asking (`allowed-tools`). A plain driver can run them, and cannot
  write them except through the agent.
- **Driver with `canApprove`**, which the workspace's creator always is.
  Everything above, and decides what the agent may do on its own: its
  settings, every slash command, the permission requests. They also type
  into shells, which is code execution as the workspace's user with nothing
  in between: a shell can read the tokens in the environment, edit the
  agent's settings files, or start an agent with other flags. Give
  `canApprove` to a driver only if they may do all of that.
- **Manager** (organization owners and admins). Everything, plus the
  runtime-scope work of a `manage` attachment (create and kill terminals,
  file and Git writes, tabs and sessions, the key) and other people's leases.

`canApprove` is therefore one right with three effects: answering permission
requests (any role), and, for a driver, the tab's settings with the slash
commands that change them, and shells. PRO-86 applies the same right to an
agent tab's terminal view.

The API lists everyone whose role is not `none` on every `/refresh`
(`collaboration`, advertised by the runtime as `collaboration-v1`) and stamps
the actor's role on every mailbox lease. The runtime answers from its latest
list and narrows a stamped role by it, so whichever of the two saw a
revocation first wins.

Until the API has sent a list (an API before PRO-30), participants keep what
they had: reads of files, Git and terminals, and nothing new. `you` then
says `listed: false`, and the desktop does not read its role as "not
shared". The runtime applies the list it fetched before it registers with
the relay, so this window is only as long as an API before PRO-30 lasts. A
list the runtime cannot read, or of an unknown version, gives participants
nothing.

A `manage` attachment manages only while the list says its person is a
manager. An admin demoted since the attachment was issued acts with the
role the list gives them now (the API also revokes their manage
attachments on demotion).

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
  A driver who may approve permissions may take control too; a plain driver
  and a viewer watch (PRO-88: `pty.write`, `pty.resize` and `pty.control`
  answer `forbidden` with `data.reason: "approval-required"`). Terminals and
  `pty.control` notifications carry `controllerId`, so clients show who is
  typing.
- **Taking the wheel (fair use).** `lease.acquire` without input holds an
  idle tab for two minutes. Asking again while holding it does not extend it
  (only input the agent receives does), and after one's own idle lease lapses
  or is released, the same person waits another two minutes before taking
  that tab again (`lease_cooldown` with `retryAt`), so one driver cannot keep
  every tab to themselves by re-acquiring. A running turn is not idle.
- **Settings.** Model, effort and permission mode change what the agent may do
  on its own (`bypassPermissions`). A queued `send`/`steer` applies them only
  from a manager or someone with `canApprove`; from a plain driver the message
  is applied without them and the receipt says `settingsIgnored: true`. The
  live `session.configure` needs manage. The desktop follows both rules, so no
  picker ever does nothing: a manage connection whose person is a manager
  configures live; an approving driver's change (a participate connection)
  is kept as the tab's pending settings, shown as chosen, and sent with their
  next message, with "Model, effort and mode changes apply with your next
  message" under the composer until it goes; everyone else's pickers are
  disabled with the reason. If approval rights are taken back in between,
  the note goes, the unsent change is dropped rather than sent, and the
  composer says "Your model, effort or mode change was not applied: you can
  no longer approve permissions"; the same is said when a receipt arrives
  with `settingsIgnored`.
- **Slash commands** (PRO-88). A message that starts with `/` is typed into
  the agent's CLI as keys and runs as a command, so `/model`,
  `/permissions`, `/login` or `/mcp` would change what the settings rule
  above keeps from a plain driver. The runtime decides
  (`cloud_agents/slash.rs`), wherever input reaches an agent: a mailbox
  `send` or `steer` (also one that waited in the mailbox while the workspace
  was stopped: it is judged when it is leased, by the sender's access then),
  a queued follow-up right before it is typed, and the live `session.send`.
  From a manager or someone with `canApprove` every command passes. From a
  plain driver only these do:
  - `/clear` (also `/reset`, `/new`), `/compact` and `/help`, typed exactly;
  - a command or skill the session's project defines for Claude Code
    (`<cwd>/.claude/commands/<name>.md`, `a:b` for `a/b.md`, or
    `<cwd>/.claude/skills/<name>/SKILL.md`), unless its name is one of the
    CLI's own that change settings (a file named `model.md` unlocks nothing).

  Everything else that starts with `/` is refused, not only the commands
  known to be sensitive: the CLI completes `/mod` to `/model`, and gains
  commands the runtime has not heard of. The check reads the message as the
  CLI could: leading whitespace and invisible characters are skipped; every
  line is looked at (a later line is refused only when it reads as `/name`,
  so a path in pasted output passes); and an allowed command that carries a
  control character is refused, since typed as keys a Ctrl+U would clear it
  and leave what follows. A plain driver who wants to start a message with a
  path starts it with a word.
  A refused mailbox command settles `rejected` with category
  `slash-command-forbidden`, never reaches the agent and does not claim the
  tab; its receipt carries `command` (as typed, shortened) and `message`.
  `session.send` answers `forbidden` with `data.reason` of the same name. A
  queued follow-up that became refusable (its sender lost `canApprove` while
  it waited) is dropped with a note in the transcript. The desktop shows the
  outbox entry as "Not sent: /model needs someone who can approve
  permissions. You can send /clear, /compact, /help and this project's own
  commands."
- **Permission decisions** are not lease-bound; they need `canApprove`.

### Revocation

The runtime refreshes every 5 s, attached or not (PRO-12), and re-applies the
list:

1. Connections of a person who lost access are closed, `manage` ones included;
   attachments the API revoked are closed as before. Streams (terminals,
   file watches, agent tabs) of anyone left without access are ended, also
   on the first list after a start.
2. A person who may no longer drive loses their tab leases. A person who
   may no longer type into terminals (no longer a driver, or no longer an
   approver) loses terminal control (announced).
3. Queued follow-ups of anyone who may no longer drive are dropped, with a
   note in the transcript; so are queued slash commands of a driver who may
   no longer approve. Each follow-up is also re-checked right before it is
   typed.
4. The workspace content key rotates when anyone lost access, as it does for
   revocations and for a workspace turning private. Who was handed the
   current key is recorded durably (`<data dir>/cloud-agent/key-holders.json`),
   so a person removed while the runtime was suspended also causes a rotation
   on the first list after it wakes.

A `manage` attachment that names no person (a device saved before
attachments carried one) cannot be matched to the list: once the runtime has
one, it has no access and its connections are closed, and it is never a key
holder. The API's migration 0082 also revokes live `manage` attachments of
people who are not owners or admins.

`keys.get` is authorized when the call arrives and again inside its handout,
under the same lock as rotations, so a revocation's rotation cannot slip
between the check and the handout; if the holder cannot be recorded, no key is
handed out (`unavailable`).

Live calls check the current list on every call, so a downgraded driver's next
terminal write is refused even before step 2 runs. On the server, queued
mailbox commands are re-checked when leased, and settled `rejected` /
`access-revoked` without ever reaching the runtime (contract §21.4).

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
| `cloud_workspace_set_access(workspaceId, accessMode)` | `POST …/cloud-workspaces/:workspaceId/access` with `{ "accessMode": "private" \| "organization" }` | the workspace |

`set_access` is the PRO-29 visibility switch: only an organization owner or
admin may (`organization_admin_required` otherwise). `private` revokes every
share in the same transaction and hides the workspace from everyone but its
creator. An answer about another workspace or organization is treated as an
unknown outcome. Binding: `api.cloudWorkspaceSetAccess`.

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

**Share dialog.** "Share…" is offered to whoever manages the shares (owners,
admins and the creator) on every workspace they see, private ones included;
everyone else gets "Who has access…" once the workspace is
organization-visible. A workspace created from the sidebar starts private
(only its creator sees it), so the dialog is also where it becomes shareable:

* While it is private the dialog says so in plain words: sharing makes the
  workspace visible in the organization's sidebar; the people added and
  organization admins can open it; other members see only that it exists.
* Sharing with the first person asks for a confirmation ("Make visible and
  share"), then switches the access mode to `organization` and grants the
  share, in that order. Cancel changes nothing.
* "Make private again" (after a confirmation that names how many people lose
  access, and that an admin who did not create it stops seeing it too)
  switches back to `private`; the server revokes every share with it.
* Someone who cannot manage shares gets the same list titled "Who has
  access", with neutral copy.
* Visibility is the API's owner-or-admin switch. A creator who is a plain
  member (`you.role` is not `manager`) manages the shares of a workspace that
  is already organization-visible; "Share…" on their private workspace and
  "Make private again" are disabled with the reason.
* The two calls of "make visible and share" can part ways. If the share is
  refused after the workspace became visible, the dialog says so plainly
  ("… is now visible to the organization, but it is not shared with … yet"),
  with "Retry sharing" and "Make private again". If the visibility change
  gets no answer (`cloud_workspace_request_outcome_unknown`), the workspace
  is read back from the list before any state is shown; if it cannot be
  read, the dialog says the visibility is not known and offers "Check
  again", and nothing is shared or made private on a guess.
* People are offered from the workspace's own organization, which need not
  be the default one: `organization_members_in(orgId)` reads
  `GET /v1/desktop/orgs/:orgId/members` (authorized by membership in the path
  organization) for a member organization, read only. If it cannot be read
  the dialog says why and offers Retry; the shares above stay manageable.

It lists the active shares with name and email. Someone with `canManageShares` (an
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
| `organization_admin_required` | only an owner or admin can change whether a workspace is private or visible to the organization |

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
  with `canApprove`; for everyone else every button is off and looks it (the
  same quiet outline for Allow as for Deny, no accent fill, no Return hint),
  with "Waiting for someone who can approve" under them, inside the card.
* Notes: a separate "Notes" drawer per agent tab, apart from the chat and
  its composer, with each note's author and time and its own input ("Add a
  note for teammates (not sent to the agent)"). Notes go only through
  `notes.list`/`notes.post`/`notes.posted`; posting one never enqueues an
  agent command.

**Terminals.** A terminal controlled by someone else names them ("Alice is
typing in this terminal", from `controllerId` in the terminal description and
`pty.control`). "Take control" is offered to manage attachments and to
managers and approving drivers of a shared workspace (`canTypeInTerminals`).
A viewer never gets it; a plain driver reads "You can watch; typing in a
terminal needs the right to approve permissions; ask an admin."

**Not shared.** A participate connection whose role is `none` sees "This
workspace has not been shared with you" instead of empty terminal and agent
lists, with a People button that opens the read-only share list.

### In the unified sidebar and SessionView (PRO-23)

Cloud sessions now open in the same SessionView as local ones, and every
organization is live in the sidebar. Sharing follows them there:

* **Rows.** The workspace list carries this person's role and the share
  count (saas contract §21.2, `you` and `sharedWith`), so rows are badged
  without attaching: a lock chip ("View only" or "Not shared") for a viewer or
  someone it is not shared with, else a people icon with the share count. It
  shows on a workspace group row, and on session rows next to their location
  chip when the project has one workspace. An older server sends neither
  field and nothing is drawn.
* **Your access.** The share dialog names this person's real role: "Owner"
  or "Admin" for the API's `manager` (told apart by their role in the
  organization, from the account or the roster; "Owner or admin" when
  neither says), "Creator" for the member who created the workspace (a driver
  who manages its shares), else "Driver" or "Viewer", with ", can approve
  permissions" where that is separate.
* **Share dialog.** "Share…" (managers) or "Sharing…" is the first item of
  the workspace menu wherever it shows: a project or workspace row's "…" menu
  and the session header's location chip. One dialog host is mounted in
  `AppShell`; every call carries the workspace's organization (`orgId`), as
  the share routes are authorized by membership in it. For a workspace in an
  organization other than the default, the dialog lists and changes shares
  but does not offer the default organization's roster for adding people.
* **Session header.** One connection chip ("Live", "Stopped", "Connecting…",
  …: whether the workspace runs, never what this person may do; "Starting"
  only while the list says the machine is being provisioned or resumed, so a
  member attaching to a running workspace reads "Connecting…") and one role
  chip ("View only", "Driver" or "Not shared"; none for a manager; "View
  only" too for a read-only attachment whose sharing is unknown). Then the
  other people in the workspace as initials (ringed while typing; name, role,
  activity and tab in the tooltip; at most three, then "+N").
* **Agent tabs** (`TabView`). The same rules as the workspace page, shared
  through `tabGate` in `src/lib/cloudCollab.ts`: the lease bar and Notes
  drawer, the composer closed for viewers and while someone else holds the
  lease, Stop only for the holder and managers, and approvals only for
  approvers (the cards are disabled with the reason). The cloud session
  backend (`cloudReadOnlyReason`) reads the role, so a driver on a
  `participate` attachment can send; with no role known (an older server or
  runtime, or before the runtime has a member list) the attachment rule stays:
  only `manage` sends.
* **While asleep.** The list's `you`, else the last access this desktop saw,
  gates the same controls, so a sleeping workspace never shows a viewer an
  open composer. The "+" menu's Terminal wakes a stopped workspace only for
  someone who would manage it (terminals are a manager's); a viewer or driver
  is not offered a wake that would end in a refusal.
* **Terminals.** Managers and approving drivers get "Take control"; everyone
  sees who is typing, and a plain driver reads why they only watch.
* **Workspace actions.** Resume, Stop, Archive and Delete are the API's
  manage actions (organization owners and admins), so only a `manager` is
  offered them, in the project menu, a workspace row's menu and the header
  chip; everyone else reads one disabled line saying who can. A **new
  session** creates a workspace, resumes one from the sidebar or adds a
  session to a running one (`session.create`), all three an owner's or
  admin's, so a member is not offered one anywhere: no "+" on a project, the
  project menu's and the new-session picker's items disabled with the reason,
  and `startCloudSessionIn` (which every way into the form passes) only
  focuses the project. The organization header follows the same rule
  (`mayStartCloudSessions`): its "+" keeps "From repository…" for a member
  (it only pins a repository to this sidebar) and shows "New project…"
  disabled with the reason, and its "…" menu shows "New cloud workspace…"
  disabled with the reason; "Refresh cloud workspaces" is everyone's. While
  the account's role in the organization is not known yet nothing is offered
  either: no "+" on the header, and no "New cloud workspace…". (A driver's message to an existing
  session still wakes a stopped workspace it is shared on: that is sending,
  not starting a session.) Closing a tab from the sidebar is a manager's,
  like the session menu.
* **No access.** A session of a workspace this person may not open shows the
  lock pane instead of its body, with Back, and nothing of the workspace (no
  tabs, transcript, lease bar, Working state, Stop, Notes, presence or
  connection chip). Which pane:
  * "Your access to this workspace was removed." only for a real transition:
    the runtime gave this person a role in this view and then none, or this
    desktop holds the session's conversation and the list now says none.
  * "This workspace has not been shared with you" when they never had it.
  * "Checking access…" while the workspace list says it is shared with them
    and the runtime says role `none`. That is normal for the few seconds
    until the runtime reads its member list after a share. After 15 s it
    reads "This workspace has not been shared with you yet". Neither chip is
    shown meanwhile, and "removed" is never said on a first connect.

  The connection is **kept** while the runtime says `none`: it costs nothing,
  never wakes compute, and the runtime's `collab.you` opens the session the
  moment a share arrives. The list and the runtime disagreeing never
  reconnects anything. Only a reconnect the API refuses
  (`cloud_workspace_not_found`: the workspace went private, the person left
  the organization, or it was deleted; the one reason the attach really
  reports for lost access) closes the connection, and a list **asked for**
  after that refusal (not merely answered after it) reopens it. While any
  lock pane shows, the list is read again after 5, 10, 20 and then every
  30 s, so a share made meanwhile is seen where no connection can tell. In
  the sidebar an unshared workspace lists one row named after it, with no
  cached session title, tab, terminal or status.

  When access ends (`onWorkspaceAccess` in `cloudCollab.ts`: the runtime's
  role `none`, or the refused reconnect) `cloudSessions.ts` forgets what the
  sidebar shows of the workspace at once: its live and saved session lists,
  its terminals with their views and the pty list they came from, and the tab
  asked for in each of its sessions. The session stays selected, as the one
  row that opens the lock pane; no tab or terminal row is left under it. The
  catalog also drops the saved session list of any workspace a list reports
  as role `none` or no longer reports at all. A role given back on the same
  connection reads the session list again; terminals return with the session
  view's next read.
* **Loading.** Until the runtime answers, a member's session shows the one
  line "Loading the session…" and is named after its workspace.
* **Permission requests** quote the command, file, URL or tool they are
  about, for approvers and for everyone waiting on one.
* **Notes** show a count on their toggle for notes from other people that
  arrived while the drawer was closed.
* **What each person is offered.** Attach files and Dictate are off with the
  composer; Stop is hidden unless this person may stop
  (the lease holder or a manager); the model, effort and mode pickers are
  disabled with the reason for anyone who is neither a manager nor an
  approver; a `manage` attachment whose person is no longer a manager (a
  demoted admin) gets no terminal control, Git or file writes, or new tabs;
  session row menus (rename, pin, archive, delete) show only to managers; the
  workspace's creator reads "Share…", like a manager.
* **Leaving an organization** drops its workspaces' presence, notes and
  leases with the rest of its cloud state.

**Share state without a manual refresh.** The catalog lists an organization
every 30 s while the window can be seen **or** has the focus, and every 2 min
while it is hidden and unfocused; it is never paused. WKWebView reports
`visibilityState` "hidden" not only for a minimized window but for one wholly
covered by other windows (its window occlusion detection), and WebKit
throttles a hidden page's timers, so the 2 min is a floor rather than a
promise. For that reason the fast poll never depends on visibility alone (a
focused window polls fast whatever it reports), and coming back lists at
once: on window focus, and on a visibility change to visible, whatever the
age of the rows (two such events within 2 s are one list). It also lists at
once (debounced) when access changes: this person's
role (`collab.you`, or a hello that differs from the last one seen), the
people the runtime lists (`collab.presence` with a different set of people,
roles or approval rights), or a share or visibility change made in the
dialog. All of these only list; none attaches to or resumes a workspace.

Not moved yet: the full participants bar (names, windows, tabs) stays on the
workspace page; SessionView shows the compact avatars.

### Tests

`src/lib/cloudCollab.test.ts` (gating, authority, lost access, unread notes),
the "live two-user test" blocks of `SessionView.cloud.test.tsx`,
`CloudSections.test.tsx` and `CloudShareDialog.test.tsx`, the PRO-30 blocks of
`src/components/session/SessionView.cloud.test.tsx` and
`src/components/layout/cloud/CloudSections.test.tsx`,
`packages/portable/src/workspaceCollab.test.ts`,
`src/components/cloud/CloudShareDialog.test.tsx`, the PRO-30 blocks of
`CloudAgents.test.tsx` and `CloudSessionPage.test.tsx`, and the
`cloud_workspaces::tests::share*` Rust tests. `src/lib/cloudSessions.access.test.ts`
covers what is forgotten when access ends and read again when it returns.
`pnpm test:webkit-layout` (after `pnpm build`) measures in WebKit what jsdom
cannot: the composer's toolbar at 1000x520 and 1280x760 with the Notes drawer
open (no control overlaps another), and a modal dialog's overlay covering the
Notes drawer.

## Development and tests

A `--relay-link` file may carry the list as the API would:
`"collaboration": { "v": 1, "members": [{ "userId", "role", "canApprove" }] }`,
and attachments may carry `userId`. The file is re-read on every refresh.

- Unit: `remote::collab` (roles, diffs, leases, notes storage),
  `remote::server` tests `roles_decide_…`, `without_a_member_list_…`,
  `presence_and_notes_…` and `the_driver_lease_…`, and `cloud_agents::mailbox`
  tests for viewers, approvers, narrowed roles, the lease and dropped
  follow-ups.
- PRO-88: `cloud_agents::slash` (the rule itself: whitespace, lines,
  prefixes, hidden keys, project commands); `cloud_agents::mailbox`
  `a_plain_drivers_slash_command_is_refused_…`,
  `a_slash_command_queued_while_the_workspace_slept_…`,
  `a_queued_slash_command_is_dropped_…` and
  `a_plain_driver_sends_the_projects_own_commands`; `remote::server`
  `a_plain_drivers_slash_command_is_refused_on_the_live_send_too` and
  `a_shell_needs_the_approval_right_and_loses_its_controller_when_it_is_withdrawn`.
- Relay e2e (`scripts/remote-runtime/e2e.sh`,
  `a_shared_workspace_serializes_input_and_stops_access_when_revoked`): an
  admin, a driver, an approving viewer and an unshared member over the real
  relay. It covers presence, notes, the lease refusing a competing send,
  decisions by approval right, a mid-turn revocation, and a reconnect under
  the new role. The revocation closes the connection, drops the queued
  follow-up and rotates the key. An outsider (not a member) never gets an
  attachment; that is the API's 404 and is tested there.
