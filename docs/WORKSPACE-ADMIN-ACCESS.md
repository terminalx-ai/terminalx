# Workspace Admin and pending General access (PRO-167)

This source checkpoint is not ready for publication. The coordinator has asked the
user which Everyone policy to use; no answer has been received. Neither the nullable
server column nor the prepared `CloudGeneralAccess` component grants access.
The component is not mounted by the product and has no API mutation attached.

## Admin contract

A direct share may have `role: manager`, displayed as Admin. It grants workspace
lifecycle and access management, including stop, resume, archive, unarchive, delete,
operation cancellation and visibility. It does not change organization membership
or grant organization administration. Current owners, organization admins and the
creator retain their existing implicit authority. Private workspaces retain their
existing visibility and access rules; explicit shares apply only to organization
visibility.

`canApprove` stays a separate explicit permission. Implicit managers still approve.
A direct manager with false approval cannot answer permission requests. Like other
managers, an Admin can configure the runtime, write files and use shells; absence
of approval is not a sandbox against an Admin running code through those powers.
The runtime preserves legacy version-1 implicit managers and accepts version 2 for
independent Admin approval. When an explicit manager lacks approval the server sends
version 2; older runtimes fail closed on that unknown version. Do not release Admin
grants until the compatible runtime has been deployed. Mixed-runtime behavior and
native compilation/execution remain release gates. Cloud bootstrap treats a missing or
malformed member list as empty authority, including for saved management sockets.
Legacy local management remains unchanged; version-1 cloud managers retain access.

Catalog `you`, attachment scope, share management, mailbox and runtime use current
workspace authority. Phones and public API clients remain participants. Grant writes
lock actor and recipient memberships before the workspace; lifecycle writes check
membership and manager authority again inside the transaction. Downgrades and
approval loss revoke both workspace and session-runtime attachment families,
including management attachments. No revoked share is restored by a member rejoining.

For every nondeleted, nondestroyed organization-visible workspace, at least one
current organization member must be an implicit manager or hold an active manager
share. Unknown member roles do not qualify. This is the effective-admin invariant;
redundant explicit rows do not subtract implicit authority. A deferred database
constraint covers shares, membership changes and workspace visibility. A serialized
organization row version prevents concurrent removals from committing an adminless
workspace, including at repeatable-read isolation. The refusal is
`cloud_workspace_last_admin`: **A workspace must have at least one admin.**
Organization deletion can cascade its workspaces. Private workspaces do not gain
organization access from this constraint. Existing ownership fields are unchanged.

## General access alternatives waiting for the user's answer

The proposed contract is an explicit nullable `defaultOrganizationRole`:
`null` means Only people invited; `viewer` or `driver` means Everyone at the named
organization can Read or Write. Existing and newly migrated workspaces retain null.
Organization visibility alone remains catalog visibility, never an access grant.
A private transition clears the value and all explicit shares transactionally.
There is currently no route that writes or consumes this column as authority.

Both presented choices propose default Read. The actual answered default must be
supplied explicitly; a preselected choice, recommendation or silence does not set it.

| Choice | Required server/runtime behavior before Save can be connected |
| --- | --- |
| Require approvals for Everyone Write | Reject Write when current tab approval state is unavailable or any tab runs without approval. Recheck General-access-only sends against the effective tab mode, including concurrent mode changes and newly created tabs. Explicit stronger grants remain separate. |
| Allow Write after warning | Show “Everyone at <org> will be able to run commands through agents here.” when any tab runs without approval or its approval state is unknown. Persist only an explicit Save for the currently scoped workspace and account. |

For either answer, implement one server-authoritative policy contract with the same
meaning in desktop, catalog, mailbox and runtime. Use current membership and the
actual rollout service; unknown roles or rollout states fail closed. Combine direct,
group and General grants without losing independent approval or resurrecting revoked
authority. Organization-wide Write must respect existing managers-only credentials,
personal credential restrictions and runtime member limits. The approval requirement
cannot be merely a disabled dropdown; the server/runtime must enforce the chosen
answer on actual operations. Private isolation and opt-in migration tests are required.

## Integration and validation gates

Desktop base: `0656e725da564ba1f1838dd79a2d96b52f96192e`.
Server base: `b05ddb86d16b68fded09d951a7390532af1bd099`.
Both were freshly fetched through HTTPS. Shared main checkouts remain untouched.

PRO-171's unmerged effective-share view must preserve `manager > driver > viewer`
and approval OR separately. Its existing author recorded the shared contract in
`PRO-171-PRO-167-interface.md` in the Phase2 coordination directory. Integrate the
actual landed source, including membership-first locking and redundant-grant socket
preservation. PRO-128 roster, PRO-163 identifiers, PRO-191 setup, PRO-215 SSH,
PRO-244 privacy and PRO-252 flags remain integration gates. PRO-248's proposed
`dd807241` design handoff was consulted; it is neither landed nor user approved.

Migration 0117 is provisional. It alters the share constraint, adds a nullable
General-access column, and implements the effective-admin guard. Earlier allocations
0103–0116 are untouched. The branch's clean/incremental fixture checks do not prove
the actual predecessor chain; journal/order/timestamps must be reconciled under
`MIGRATION-ORDER.md` before publication. No applied production migration is rewritten.

The status JSON records exact snapshots, patches and executed checks. Required
Vitest/full/native checks, normal hook-enabled commits, independent exact-commit
review, native/security/current-head CI and healthy server deployment remain open.
Source-only reviewer acceptance cannot satisfy them. The coordinator owns publication
and merge holds. A server main merge uses the existing production poller only.
