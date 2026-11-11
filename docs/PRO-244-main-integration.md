# PR817 integration with 11 November main

Integrated main `b7127c695b3bd540449cf612e98f0929f5a141e0` into the privacy branch, preserving both parents and its existing unpushed history. Main contributes 386 commits since the previously integrated `d68a1f2c`.

## Conflict decisions

All 24 conflicted files retain both intents. Native session state keeps privacy-bearing pending messages and child epochs alongside held follow-ups, workspace ports, layered configuration and manual status. Creation retains trust review and runtime ownership, capturing privacy authority before its first await. Git helpers retain no-lazy-fetch inspection, admitted transfers and cleanup verification while adding local-only merge support, bounded ignored-file scans and repository file copying. Pipeline fork/base resolution retains its exact repository/object guards and the shared admitted transfer runner. UI resolution retains centre tabs, overlays, activity and local merge controls; external images still use the privacy component. Existing privacy fixtures were adapted to new session/editor/API fields without weakening their assertions.

## New outbound paths covered

- **Header Git actions and account confirmation:** capture before desktop blocking dispatch; retain a single ticket over fetch, account lookup, mutation and fallback. The confirmation UI retains the ticket from the initial click. Completion reconciles local facts only; independent/manual refresh stays separate.
- **Forge classification, GitHub connection status and SSH hostname expansion:** use the existing admitted, cancellable, drained subprocess runner. Known local remote classification remains useful; a denied opaque-host probe is unavailable, never proof that a repository is local-only.
- **Repository creation, PR search, PR-context attachment and PR-start checkout:** retain one logical request scope. The checkout's child Git transport receives the existing repository-specific SSH adapter and Git cancellation grace. Creating a local session carries the original ticket through the authenticated desktop-to-owner RPC rather than acquiring a new one after queueing.
- **Sidebar/session PR status:** the background job captures authority when queued; GraphQL polls use shared subprocess admission. Local activity and refs remain readable. Owner RPCs carry the owner-issued generation across serialization and handover.
- **Interactive GitHub sign-in:** capture at desktop dispatch, forward owner authority, admit before PTY launch and retain admission until the exact owned process group exits. Revocation stops that group. No unrelated terminal is selected for cleanup.
- **Automatic repository setup and lifecycle scripts:** queued setup carries its original ticket; persisted pending setup does not acquire new authority after an owner restart. Explicit Rerun captures a new ticket. Script execution is admitted before launch, cancellation observes revocation and uses the existing script stop/drain lifecycle.
- **Full-size image viewer and copy:** use the same external-image privacy gate as inline images. Copy draws the loaded image rather than issuing a second image request. Loopback, data and local asset images remain usable.
- **Repo-root mirroring and layered configuration metadata:** mark their private Git commands no-lazy-fetch, so missing partial-clone objects fail locally rather than fetching implicitly.

## Intentionally available

- Split panes, centre tabs, transcript search/overlays, held local follow-ups, session sources, handoff/restore metadata, local diff/reviewer comments, local activity and port inspection, configuration/trust review, file copying and repo-root mirroring are local work. Their metadata/file operations remain available.
- Local Git merges, commit inspection, staging and commits use local-only Git builders. Remote fetch/pull/push/PR operations use the admitted boundaries above. Explicitly configured local Git hooks remain user code, as before.
- Agent-owned networking remains allowed by PRO-244's contract. Local handoff and reviewer-agent requests use the existing agent delivery path; remote phone/shared/relay senders still retain the prior privacy/sender protections.
- Named run actions are explicit commands in the person's ordinary terminal, with local port environment variables. These retain the same user-shell behavior as manually entered terminal commands, rather than treating arbitrary user programs as TerminalX service transports. Automatic setup/lifecycle scripts are gated separately above.
- Explicit links opened in the person's external browser (including completion of a requested GitHub login) remain external user actions. The app does not control networking of that browser or of agent/user subprocesses that deliberately detach outside their owned group.

## Limits of this pass

This is merge maintenance and integration coverage, not resolution of the five outstanding review findings or approval to merge. No full suites are requested for this pass. The report distinguishes executed checks from pending checks; old-head results are historical only. Native security/person/CI gates remain for eventual merge.
