# Cloud workspace Git and pull requests (PRO-27)

Review, commit, push and open pull requests in a cloud workspace from the
desktop. The runtime (`terminalx-serve`) serves `git/1` of
`terminalx-workspace-rpc/1` over the relay E2EE channel (PRO-13); the
desktop's existing Repo and PR panels drive it. The checkouts stay on the
runtime.

## Principles

- **Every call names its repository.** A workspace is one repository (its
  root) or several clones below it (the setup's `targetDirectory`, up to two
  levels deep; hidden, `node_modules`, `target`, `vendor`, `dist` and
  `build` directories are not searched, at most 20 are listed). Calls take
  `repo` (workspace-relative, as `git.repositories` lists it). Without `repo`
  a workspace with exactly one repository uses it; with several the call is
  refused as `ambiguous_repository`, reads included. The desktop shows
  nothing until the person chooses.
- **Authorship is the person's; credentials are the workspace's.**
  `git.commit` requires `author: { name, email }`, which the desktop takes from
  the person's global Git config (`git_identity`). It is both author and
  committer; the runtime has no identity of its own. Push, fetch and pull
  requests authenticate with the workspace's GitHub App token through the
  PRO-14 credential helper and `gh` shim; no credential crosses the RPC.
- **Uncertain outcomes are reconciled, never repeated blindly.** See below.
- **Participants read.** Status, diffs, history, branches, pull requests and
  disposition facts are `participate`; everything that writes or publishes
  is `manage` and carries a `clientRequestId`.

## Runtime: `src-tauri/src/remote/git.rs`

| Method | Authority | What |
| --- | --- | --- |
| `git.repositories` | participate | `[{ repo, branch, head, remote, defaultBranch }]` (credentials stripped from `remote`), `truncated`. |
| `git.status` | participate | Porcelain files, `branch`, `upstream`, `ahead`/`behind`, `defaultBranch`, `aheadOfBase`, `conflicted` (unmerged paths), `operation` (`merge`/`rebase`/`cherry-pick` in progress). `{ repository: false }` when the workspace has none and no `repo` was named. |
| `git.diff` | participate | Unified diff (≤ 768 KiB, `truncated`). |
| `git.workingChanges` | participate | The desktop's `working_changes`: HEAD's tree and the changed files against it, untracked included (≤ 2000). |
| `git.changesBetween` | participate | Files changed between two tree ids (a commit's changes from `git.log`'s `tree`/`parent`). |
| `git.fileContents` | participate | One file at tree `base` and at tree `head` or in the working tree; each side ≤ 384 KiB. A working-tree read never follows a link out of the workspace. |
| `git.log` | participate | Commits (`from` a commit id), bodies ≤ 4 KiB. |
| `git.branches` | participate | Local and remote branches, `current`, `defaultBranch`. |
| `git.prs` | participate | Pull requests whose head is `branch` (default: current), with checks and `mergeable`. |
| `git.checkout` | manage | Switch, or `create` (optionally `from` a ref). |
| `git.stage` / `git.unstage` | manage | Paths are repository-relative; `GIT_LITERAL_PATHSPECS` makes `:(top)`-style magic plain names. |
| `git.commit` | manage | `message`, `author` (required); everything by default, `paths`, or `staged: true` for the index only. Nothing to commit is `invalid_params`. |
| `git.fetch` / `git.pull` | manage | `fetch --prune origin`; `pull --ff-only` (divergence is `conflict`). |
| `git.push` | manage | `branch` (default current) to `origin`, never forced. See below. |
| `git.prCreate` | manage | `title`, `body`, `base` (default: the default branch), `draft`. See below. |
| `git.prReady` / `git.prMerge` | manage | Answered by what GitHub reports afterwards (a merge that went through before an error is a success). |
| `lifecycle.dispositionFacts` | participate | saas contract 10.2; see below. |

Network calls are bounded (120 s; the process group is killed on timeout)
and run off the connection's ordered loop (`host.rs` `SLOW_METHODS`).

### Errors

| Code | Meaning | The desktop says |
| --- | --- | --- |
| `ambiguous_repository` | several repositories and no `repo` | choose one |
| `auth_failed` | GitHub refused or could not mint the workspace's token (expired, uninstalled, repository not selected) | try again; an admin may need to reconnect GitHub |
| `conflict` | a push was rejected as non-fast-forward, a pull cannot fast-forward, a merge conflicts | pull first; nothing was forced |
| `unpushed` | a pull request for a branch GitHub does not have at the local head | push first |
| `outcome_unknown` | GitHub could not be reached, so whether it happened is unknown | trying again checks first |

### Uncertain outcomes

- A resend of the same request (the connection dropped before the answer)
  is answered from the idempotency cache: the push or create runs once.
- **Push** asks the remote for the branch head first (`ls-remote`). When it
  already equals the local head, nothing is pushed (`pushed: false,
  reconciled: true`) and the upstream is set. So a retry after a lost answer,
  a runtime restart (empty cache) or another device's push is safe. A push
  that fails ambiguously (a dropped connection, a timeout, an unclassified
  error) asks again; if the remote has the head, it succeeded
  (`pushed: true, reconciled: true`). A rejection is `conflict` and is never
  retried with force.
- **Pull request create** first looks for an open pull request for the
  branch and answers with it (`existing: true`), so a second create (a lost
  answer, another device) links the one there. It refuses a branch GitHub
  does not have at the local head (`unpushed`). After `gh pr create` fails,
  it looks again; one found is the answer (`reconciled: true`).

### `lifecycle.dispositionFacts`

As defined in the saas contract (10.2), plus `localOnlyCommits` (commits on
no remote-tracking branch, what a delete would lose even without an
upstream) and `tabId` on active tasks. Per repository: `path`, `branch`,
`dirtyFiles`, `untrackedFiles`, `unpushedCommits` (null without upstream),
`hasUpstream`, `openPullRequests` (null when GitHub could not be asked within
the 2 s per-repository budget). `activeTasks` are agent tabs in progress or
waiting on a permission; `runningProcesses` are terminals whose shell has not
exited.

## Client

- `packages/portable/src/workspaceGit.ts`: `RemoteGit` (one repository;
  reads carry `repo`, writes are mutations with a stable `clientRequestId`),
  `listRepositories`, `dispositionFacts` (null from a runtime without
  `lifecycle/1`), `gitErrorMessage`.
- `src/lib/gitSource.ts`: a `GitSource` is the local checkout (the Tauri
  commands, unchanged behaviour) or a cloud repository. `RepoPanel` and
  `PrPanel` take either; a cloud source adds Fetch, conflict and
  in-progress-operation banners, and notices for reconciled pushes and
  existing pull requests. Discarding a file stays local-only.
- `PrPanel`: the base branch is chosen when creating (default: the default
  branch; remote branches first), for local checkouts too.
- `src/components/cloud/CloudGit.tsx`: the Git view of a cloud session:
  repository picker (none chosen while ambiguous), branch and new branch,
  Changes/History and Pull request, and **Before archiving or deleting**
  (`lifecycle.dispositionFacts`: uncommitted, unpushed and local-only
  commits, open pull requests, running turns and terminals; "offline" when it
  cannot be asked). A participant gets no commit box or publishing controls.
- The file tree's Git badges read every repository of a multi-repository
  workspace.

## Tests

- `src-tauri/src/remote/git_tests.rs`: repository discovery and ambiguity,
  explicit authorship, literal pathspecs and link escapes, a push that lands
  before the connection drops, a lost answer after a restart, a rejected
  push, an HTTP remote answering 401 (`auth_failed`) and an unreachable one
  (`outcome_unknown`), pull requests created once into the chosen base,
  a create whose answer is lost, conflicting pull requests and an expired
  GitHub token, disposition facts with GitHub offline.
- `src-tauri/src/remote/server_tests.rs`: participants read but never publish.
- `packages/portable/src/workspaceGit.test.ts`, `src/components/cloud/CloudGit.test.tsx`.
- `src-tauri/serve/tests/relay_e2e.rs` `cloud_git_…`: edit, review, commit,
  push (resent across a relay restart), GitHub refusing the token, a draft
  pull request into `develop` created once, disposition facts and a
  participant, through the real relay (`scripts/remote-runtime/e2e.sh`).

## Open

- No real GitHub: everything ran against a local bare remote and
  `scripts/remote-runtime/fake-gh`.
- The archive/delete dialog itself (PRO-34 desktop UI) is not built; the
  facts are shown in the Git view and are ready for it.
- The running app has not been checked by hand (computer use is blocked on
  this machine); the views are covered by component tests.
