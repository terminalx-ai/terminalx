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

## Commands

All take `projectPath` and `provider` (`github` or `linear`); most take the
issue's `id` (the number on GitHub, the UUID or `ENG-42` on Linear).

| Command | Answers |
| -- | -- |
| `issue_details(id)` | `IssueDetails`: every field of the list's `Issue`, plus all assignees, author, created time, priority, state id and colour, close reason, description and capabilities |
| `issue_comments(id, cursor)` | `CommentsPage`, oldest first; `nextCursor` for the next page |
| `issue_options(id?, teamId?, refresh?)` | `IssueOptions`: workflow states, close reasons, members, labels, priorities |
| `issue_comment_add(id, body)` / `issue_comment_edit(id, commentId, body)` | The `IssueComment` |
| `issue_comment_delete(id, commentId)` | Nothing |
| `issue_set_state(id, change)` | `IssueDetails`. `change` is `{kind: "workflow_state", stateId}` (Linear), `{kind: "close", reason}` or `{kind: "reopen"}` (GitHub) |
| `issue_set_assignees(id, assignees)` | `IssueDetails`. The whole set: Linear user ids (one or none), GitHub logins (up to 10) |
| `issue_set_labels(id, labels)` | `IssueDetails`. The whole set: Linear label ids, GitHub label names |
| `issue_set_priority(id, priority)` | `IssueDetails`. Linear only, 0 (none) to 4 (low) |
| `issue_set_title(id, title)` | `IssueDetails` |
| `issue_set_description(id, edit)` | `IssueDetails`. `edit.expectedUpdatedAt` turns a stale edit into a `conflict` |
| `issue_create(input)` | `IssueDetails`. A GitHub issue in the project's repository, or a Linear one in `input.teamId` |

Every write answers with the issue as re-read from the provider.

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

## Not built yet

The contract is final; the follow-up tickets fill it in. Today
`issue_details` works for both providers and every other command answers
`not_implemented`. On Linear `body` still carries the first 20 comments
pasted under the description, for the agent prompt; `description` is the
description alone.
