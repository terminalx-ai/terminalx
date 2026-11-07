# Organisation cloud Git setup (PRO-195)

Repository choices are grouped by GitHub owner in workspace creation and by
installation in organisation settings. Select all changes only that group;
missing or revoked repositories appear under Not connected and cannot be
selected for a new workspace. Clone previews use the actual runtime root,
`/var/lib/terminalx/workspace`, including the server's basename collision suffixes.
Advanced accepts only credential-free GitHub HTTPS repository URLs, without
queries, fragments, traversal segments or alternate hosts.

Settings → Git exposes the active organisation's commit identity and its default
from this computer. A cloud commit resolves the override for the workspace's own
organisation, even when another organisation is active. Removal falls back to the
current global Git identity. No global config is written. New agent processes get
`GIT_AUTHOR_*` and `GIT_COMMITTER_*` from the runtime's authenticated configuration
refresh; existing sessions keep their environment until restarted. The identity
changes the configuration revision, including when removed.

The advanced token form says exactly:

> Clones and pushes will act as the token's owner.

The server already has organisation-owned encrypted GitHub PAT storage in
`organization_cloud_workspace_credentials`, the purpose-specific counterpart of
`organization_cloud_secrets`. PRO-195 reuses its encryption, verification, sharing
scope, revocation and broker rather than storing a second token in the generic
vault. Only owners/admins configure it; sharing with members and cloud machines
requires the existing explicit consent fields. No token is returned by settings.

The preflight and creation paths select that credential only when at least one
requested repository has no selected App coverage. App-covered repositories never
fall back after suspension/revocation. Runtime clone/fetch/push continue through
the existing repository-bound credential helper; clone URLs, launch plans and Git
remotes contain no credential. Preparation workspaces still cannot receive a PAT.
Removal stops future broker grants; previously issued PATs can remain in the
existing one-hour cache and must be revoked on GitHub to invalidate copies.

Desktop routes under `/v1/desktop/orgs/:orgId/github-app`:

- GET/PUT `git-settings`: non-secret identity and token-configured metadata;
  PUT accepts `{ identity: { name, email } | null }`.
- PUT `token`: PAT, managers/organisation scope, and both sharing confirmations.
- DELETE `token`: revoke future grants. Empty JSON body required.

Runtime workspace-config responses add optional `gitIdentity`. Missing/null means
no override and keeps older servers compatible. Native commands use existing
account-context fences and HTTP paths, preserving PRO-244's shared privacy gate
when integrated. PRO-252 is unmerged and assigns no PRO-195 rollout key; this
change does not clone its flag infrastructure or turn on unrelated cohorts.

Migration `0111_organization_git_identity` adds only two nullable organisation
columns. Tokens reuse existing schema. The filename is provisional: current server
main ends at0102; the coordinator must integrate pending0103–0110 and reconcile
journal timestamps before publication. A branch-only clean/incremental schema
check is not proof of production migration order or deployment.
