# Issue operations

Managing a GitHub or Linear issue from TerminalX (PRO-91) goes through one
interface. The UI never branches on the provider's name; it reads
`capabilities` from the issue or its options.

| Where | What |
| -- | -- |
| `src-tauri/src/issue_ops/mod.rs` | The types, error kinds and messages, and the dispatch to a provider |
| `src-tauri/src/issue_ops/github.rs` | GitHub through `gh api` REST with the reader's own login |
| `src-tauri/src/issue_ops/linear.rs` | Linear through GraphQL with the API key in Settings |
| `src-tauri/src/commands.rs` | The `issue_*` Tauri commands |
| `src/lib/issueOps.ts` | The TypeScript types and one wrapper per command |
| `src/test/issueOpsMock.ts` | A fake backend with fixture issues for component tests |
| `src/components/issues/NewIssueForm.tsx` | The new-issue form; its draft is kept per project and provider by `src/lib/newIssueDrafts.ts` |

## Commands

All take `projectPath` and `provider` (`github` or `linear`); most take the
issue's `id` (the number on GitHub, the UUID or `ENG-42` on Linear).

| Command | Answers |
| -- | -- |
| `issue_details(id)` | `IssueDetails`: every field of the list's `Issue` (all its assignees among them), plus author, created time, priority, state id and colour, close reason, description and capabilities |
| `issue_comments(id, cursor)` | `CommentsPage`, oldest first; `nextCursor` for the next page |
| `issue_options(id?, teamId?, refresh?)` | `IssueOptions`: workflow states, close reasons, members, labels, priorities |
| `issue_viewer()` | `IssueUser`: the reader, named as `issue_set_assignees` takes people (the `gh` login, the Linear key's owner) |
| `issue_comment_add(id, body)` / `issue_comment_edit(id, commentId, body)` | The `IssueComment` |
| `issue_comment_delete(id, commentId)` | Nothing |
| `issue_set_state(id, change)` | `IssueDetails`. `change` is `{kind: "workflow_state", stateId}` (Linear), `{kind: "close", reason}` or `{kind: "reopen"}` (GitHub) |
| `issue_set_assignees(id, assignees)` | `IssueDetails`. The whole set: Linear user ids (one or none), GitHub logins (up to 10) |
| `issue_set_labels(id, labels)` | `IssueDetails`. The whole set: Linear label ids, GitHub label names |
| `issue_set_priority(id, priority)` | `IssueDetails`. Linear only, 0 (none) to 4 (low) |
| `issue_set_title(id, title)` | `IssueDetails` |
| `issue_set_description(id, edit)` | `IssueDetails`. `edit.expectedDescription` (or, without it, `edit.expectedUpdatedAt`) turns a stale edit into a `conflict` |
| `issue_create(input)` | `IssueDetails`. A GitHub issue in the project's repository, or a Linear one in `input.teamId` |
| `issue_templates()` | `IssueTemplate[]`: the project's Markdown issue templates (`.github/ISSUE_TEMPLATE/*.md` in its checkout; `issue_ops/templates.rs`), with their front matter's name, about, title, labels and assignees, and the body. Takes `projectPath` only |

Every write answers with the issue as re-read from the provider. After a
failed write the UI reads the issue again: part of a write may have landed.

## The list

`issues_list(filter)` (`issues::github_list` / `issues::linear_list`) reads
the Issues view's list, 60 at a time. `filter` takes:

| Field | GitHub | Linear |
| -- | -- | -- |
| `state` | `open` (default), `closed`, `all` | `open` (default: neither completed nor canceled), `all`, or a state type: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled` |
| `assignee` | `{kind: "me"}`, `{kind: "unassigned"}`, `{kind: "person", id}` (a login) | the same, `id` a user id |
| `labels` | names; issues with **all** of them | names; issues with **any** of them |
| `sort` | `updated` (default), `created` (newest), `created_asc` (oldest) | the same, plus `priority` (urgent first, none last) |
| `search` | GitHub's issue search | the title, or the number (`42`, `ENG-42`) |
| `teamId` | | the team |

Each matches what the provider's website shows for the same filter. GitHub
lists are the repository's own (`GET /repos/{repo}/issues` with `state`,
`assignee` (`none` for unassigned), `labels`, `sort` and `direction`, pull
requests left out); only free text goes through `gh issue list --search`,
whose index is the slowest to see a change. Linear's go through
`issues(filter, sort)`. `terminalx issues list` keeps its order: GitHub's
newest first, Linear's recently updated first.

Every GitHub list lags a write by a few seconds (2–7 s measured, the
repository's list included). The view keeps what was
changed here over a read that started before the change, or whose row is
older (by the provider's `updatedAt`) than the one the change answered with.
`assignedToMe` is the older spelling of `assignee: {kind: "me"}`. Rows carry
`workflowStateType` on Linear (the type `stateType` folds together), and a
GitHub issue closed as not planned is `canceled`.

The view keeps the filter per project and tracker (`prefs.issueFilters`). An
issue changed in the detail pane updates its row in place; one that no
longer matches stays, dimmed with the reason, until the next refresh.

`TERMINALX_LIVE_ISSUE_SANDBOX=1 cargo test live_list_filters -- --ignored --nocapture`
compares the GitHub lists with the website's search and checks each Linear
filter, then closes and reopens the two sandbox issues through the closed list.

## Providers

| | Linear | GitHub |
| -- | -- | -- |
| State | The team's workflow states, each with a type | Open or closed; closed with `completed` or `not_planned`; reopen |
| Assignees | One or none, by user id | Up to 10, by login |
| Labels | By id; labels can sit in groups | By name |
| Priority | 0 none, 1 urgent, 2 high, 3 medium, 4 low | None |

## Errors

A failure rejects with `{kind, message}`. `kind` is one of `not_signed_in`,
`missing_scope`, `forbidden`, `not_found`, `conflict`, `rate_limited`,
`network`, plus `unsupported` (the provider has no such thing), `invalid`,
`not_implemented` and `other`. `message` is fixed per kind and provider: it
never holds a token, a key or the provider's reply. `errorMessage` reads it
like any other error.

## GitHub

Every command goes through `gh api` REST (`issue_ops/github.rs`).

* `issue_comments` pages 50 at a time; the cursor is the page number. A
  comment can be changed by its author or anyone with write access.
* Assignable users, labels and the reader's access are kept per repository
  for the session; `issue_options(refresh)` reads them again.
* Labels are named as the repository spells them, and a name it doesn't
  have is refused (`invalid`): GitHub would quietly create it.
* Assignees are set by removing the logins no longer wanted, then adding
  the new ones. GitHub quietly skips a login that can't be assigned; the
  answer shows who is. When adding fails after the removal, the removed
  logins are put back before the error is returned.
* A description edit compares `expectedDescription` (or, without it,
  `expectedUpdatedAt`) with a fresh read just before writing, since GitHub
  has no conditional write. A comment moves `updated_at`, so only
  `expectedDescription` lets an edit through after someone commented.
* Every write, and the comment list, reads the issue first and refuses a
  pull request's number.
* Recorded replies: `src-tauri/src/fixtures/github_issue_ops.json`, replayed
  by `issue_ops/github_tests.rs`.

## Status

The contract is final; the follow-up tickets fill it in. Today both
providers answer every command.

## Linear

* **Comments** page oldest first, 50 at a time. Linear lists comments newest
  first and its cursors walk that order, so a page is the oldest comments
  from the last one shown on; `nextCursor` is that comment's creation time
  and id, so comments made in the same millisecond are neither skipped nor
  repeated. The viewer may edit and delete their own comments only.
* **Options** are the team's workflow states in its order, its active
  members, the labels its issues can take (the team's, its parent teams'
  and the workspace's; a group comes before the labels in it, and each
  label names its group by `groupId` as well as by name) and the five
  priorities. They are
  cached per key and team until `refresh`.
* **Descriptions** are read again before they are written: the edit is a
  `conflict` when the description is no longer `expectedDescription`, or,
  without it, when `updatedAt` is no longer a non-blank `expectedUpdatedAt` (a new
  comment moves Linear's `updatedAt`; editing one doesn't).
* **Comments** are edited and deleted only on the issue they belong to;
  another issue's comment is `not_found`.
* **Errors**: a stale state, label or assignee id is `invalid`; an issue,
  team or comment that is gone is `not_found`.
* **The agent's discussion.** Neither `body` nor `description` carries
  comments any more. A session started from the CLI or the issue pipeline
  reads the issue through `issues::linear_details`, which puts
  `issues::linear_discussion` under the description: the newest 50
  comments, oldest first, cut at about 12,000 characters (a single longer
  comment included) with a note and a link to the rest.
* `LINEAR_LIVE_ISSUE=<sandbox id> cargo test live_ -- --ignored --nocapture`
  runs every operation against the real Linear on a sandbox issue (its
  title must start with "[TerminalX test]") and puts it back afterwards.
