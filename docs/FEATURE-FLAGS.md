# Organisation and team feature rollouts (PRO-252)

New Phase 2 features ship disabled. The account service evaluates flags for the
signed-in user in each current organisation and sends booleans in
`organizations[].cloud.flags` on `POST /v1/desktop/auth/capabilities` and session
refresh. Existing provider allowlists and permission checks keep their meaning.
A rollout flag cannot grant membership, a role, billing entitlement or access to
a workspace.

Use `useFeatureFlag(featureFlags.teamRoster, organizationId)` from
`src/lib/featureFlags.ts` for React surfaces. Omit the organisation argument only
for a surface that follows the active organisation. An explicit null, missing
membership, missing field, unknown key, signed-out account or false flag means
o feature. For background subscriptions use
`featureFlagEnabled(getAccount().status, flag, orgId)` and `subscribeAccount`.
The hook uses the existing account subscription; it adds no fetch or timer.

The account store refreshes capabilities about once a minute while visible,
on focus and on return to visibility. Each successful refresh replaces the
flags, including omissions. A killed feature disappears on that refresh without
restarting. An offline client cannot learn about a server change until it
reconnects. A server read failure returns these rollout flags false; the flags
are not positively cached on the server.

## Feature inventory and integration boundaries

| Feature | Key | Gate every new surface and operation |
| --- | --- | --- |
| PRO-125 organisation events and shared read markers | `team.events.v1` | Subscriber, read-marker publication/reconciliation and new notification entry points; use existing catalog polling when off. Stop a live subscription when the flag goes off. |
| PRO-128 roster/profile enhancements | `team.roster.v1` | Cached roster path, profile popover, avatar profile affordances, Copy user info and View profile. Fall back to the existing roster and avatar presentation; close an already open popover when off. |
| PRO-191 guided setup | `organization.setup-flow.v1` | Full-window flow, colour picker/presentation and new setup callouts. Return an open flow to existing Settings when killed, retaining unsent local drafts. |
| PRO-244 privacy controls | `organization.privacy-controls.v1` | New opt-in entry point while signed in and policy inactive. An already enabled or managed privacy policy and its status/recovery control must remain enforced and accessible offline; rollout never switches a security policy off. |

The feature owners integrate these boundaries in their respective tickets;
PRO-252 supplies the common contract. Any later Phase 2 feature must add its own
key and checklist before exposing a surface. Do not use a local Experimental
setting, an environment variable or a default-true fallback to bypass rollout.
Local Native Codex remains its existing independent user preference.

For React, keep the hook in the parent that owns the surface. Render the child
only while enabled, so a refresh unmounts dialogs and cleans up their effects.
For a long-lived account subscriber, reconcile the enabled organisation set on
every account update, cancel removed subscriptions and ignore their late results.
Check again before sending a mutation. Server handlers separately check the
same flag after authentication and current membership/access checks. A flag alone
is never authorization. Do not apply these flags to already shipped cloud or
organisation operations that are outside the new feature.

## Operator controls

Console → Admin → Feature rollouts is restricted to platform administrators.
Select Everyone, Organisation, or User in organisation, load the current rules,
and save the percentage or inherit the broader rule. IDs are explicit so a rule
cannot accidentally target a similarly named organisation. Re-read after a
conflict: the API rejects stale revisions, including a stale attempt to undo a
kill. Every accepted change records operator, time and revision on the flag.

Evaluation order:

1. Missing definition or global switch off: false for everyone.
2. An explicit organisation 0%: false for everyone in that organisation,
   including user overrides.
3. A user override in this organisation: deterministic percentage of this
   `(flag, organisation, user)` hash.
4. An organisation override: deterministic percentage of its members, using the
   same hash. Use 100% for an internal or partner organisation.
5. The global percentage: deterministic percentage of **whole organisations**,
   using `(flag, organisation)` so a team stays together at the 10% stage.

The SHA-256 cohort is stable across requests, instances and restarts; raising a
percentage retains the existing cohort. Flags are independently salted by key.
User exceptions are scoped to membership and deleted when that membership goes.
Use 0% to deny and “Use inherited rule” to remove a scoped exception. They differ.

The global switch is separate from the percentage: start at 0%, add the pilot
organisations at 100%, then enable. Emergency rollback is **Turn off for
everyone**, regardless of the percentage or exceptions. Verify the next
capabilities response for an affected user and an already open desktop surface.
Server operations must stop accepting new feature work immediately; ending an
ongoing stream is the feature owner's responsibility. Existing cloud sessions
and saved user data are not deleted by a rollout change.

## Adding a feature

Add a versioned key to desktop `featureFlags` and server shared `featureFlags.keys`.
Add a migration inserting its definition with defaults (`enabled=false`,
`percentage=0`); there is no automatic all-users enable. Keep unknown keys off.
Add server access enforcement and gate every new entry point, open surface,
background subscription and write path. Add kill-on-refresh and permissions
regression tests. Copy the rollout checklist, nominate an owner and record
release notes and documentation links for every stage before advancing.

Deploy the server migration and API/console first; an older desktop ignores the
additive map, and a new desktop against an older server sees false. Publish the
desktop foundation before dependent feature branches. The first two checklist
applications are [events](rollouts/team-events.md) and
[roster profiles](rollouts/team-roster.md).
