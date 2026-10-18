# Issue pipeline

A session started from a GitHub or Linear issue used to end at "the agent wrote
some code". It now goes on through five stages, each shown on the issue's page:

1. **Work.** The session the issue page (or `terminalx sessions create --issue`)
   started, in a worktree named after the issue.
2. **Pull request.** When the author session reports the work done and its
   checks passing, TerminalX pushes the branch and opens a pull request whose
   description closes the issue (`Closes #n`, or `Fixes ENG-42` for Linear). A
   Linear issue is moved to its team's review state.
3. **Review.** A second session, which did not write the code, reads the pull
   request's head commit and answers with a verdict and findings. TerminalX
   posts them on the pull request.
4. **Address.** Findings go back to the author session. It fixes and commits,
   TerminalX pushes, and the same reviewer reads the new head. At most three
   reviews by default.
5. **Merge.** By default the pipeline stops at *Ready to merge*. With the
   issue's switch on, TerminalX merges if every condition below holds.

It applies to workspaces on this computer and to cloud workspaces. A cloud
workspace carries the pipeline itself and stops at *Ready to merge*; see the
end of this page.

## What the sessions are told, and what they answer

The pipeline never guesses from prose. Each session ends its reply with a
fenced block of JSON, and a reply without one is not a report.

The author's first prompt carries a short brief: commit on this branch, do not
push or open a pull request, run the project's checks, and end every reply with

````
```terminalx-status
{"status": "done", "checks": "passed", "summary": "…"}
```
````

`status` is `done` or `blocked` (with a `reason`); `checks` is `passed`,
`failed`, or `none` for a project with nothing to run. Only `done` with
`passed` or `none` opens a pull request. A reply with no block is asked for it
once; after that the issue shows *Needs you*. So does work that is reported
done with files left uncommitted, or a push that is refused; the pull request
is tried again the next time the author reports done, or from **Try again** on
the issue's page.

The reviewer is a session of its own in the author's checkout. It is given the
pull request, the issue, the commit and the base, and nothing the author said.
It is told to leave the checkout as it found it and to end with

````
```terminalx-review
{"commit": "<sha>", "verdict": "merge", "securityPass": "not_needed", "findings": []}
```
````

Each finding has a `severity` (`critical`, `high`, `medium`, `low`, `nit`), a
`title`, and optionally `file`, `line`, `detail` and `security`. A verdict
counts only for the commit it names, and only if the checkout is still at that
commit with nothing uncommitted when the reviewer finishes: a reviewer that
edited or committed has voided its review.

When the diff touches authorization, secrets, billing, deletion or connection
handling (judged from the changed paths and the added lines), the reviewer is
told a security pass is required, and a verdict that reports none is not
accepted.

## When TerminalX merges

With **Merge automatically when the review is addressed** on for the issue, and
only then, the pull request is merged if all of this is true of its current
head:

- The reviewer's last verdict is for that exact commit, says `merge`, and has
  no finding of medium severity or higher.
- The checks on that commit have passed. Where branch protection names
  required checks, those are the ones that count; where it names none, every
  check reported on the commit counts, except ones the project lists as never
  holding a merge. Nothing is concluded from a commit's checks in its first 90
  seconds on the pull request: CI lists them a moment after the push, and
  until then "nothing is failing" would be true of a commit CI has not seen.
- GitHub says the branch merges without conflicts and branch protection does
  not block it.
- The change is not in a category the project marks as always needing a
  person.
- The project does not require a person for every merge.

The merge is made with `gh pr merge --match-head-commit <sha>`, so a commit
pushed between the decision and the merge is refused by GitHub rather than
merged. TerminalX never passes `--admin` or `--auto`: it uses the reader's own
`gh` credentials and branch protection decides. A required approving review is
reported, not worked around. A merge GitHub refuses is not put to it again
until the head changes or someone asks.

Only one branch is ever pushed: the one the session was on when the pipeline
started. If the session's checkout is later on another branch (the session was
moved to the project's own checkout, say), the pipeline stops and pushes
nothing.

Otherwise the issue shows one of two things, with the reason in a sentence:

| Shown | When |
|---|---|
| *Ready to merge* | Reviewed, checks passed, mergeable, and TerminalX will not merge it itself: the switch is off, the project has a person merge, or the change is in a protected category. **Merge** on the issue page merges the reviewed commit, pinned the same way. |
| *Needs you* | Something is not right: findings still open after the last review, a failed or stalled check, a head that moved after the verdict, conflicts, a draft, branch protection, a pull request closed without merging, a session that stopped, or a step that failed (a refused push, for instance). |

A merge closes the issue, and the Issues view lists open issues. An issue with
a pipeline that the list no longer holds, closed by its merge or outside the
search, is shown below the list under *Pipelines on issues not listed above*,
so its page and record stay within reach. The twenty most recent are shown;
`terminalx pipelines list` has them all.

**Stop** on the issue's page halts a pipeline where it is; while stopped, a
session's report is not acted on, and after **Resume** the stage's own button
(open the pull request, review the changes) carries it on.

The switch can be turned off at any time. It is read again immediately before
the merge is asked for, so turning it off stops a merge that had not yet been
made. The one thing it cannot do is take back a merge GitHub has already
accepted into a merge queue; the record says so when that is the case.

A project's settings are read at each decision. If they cannot be read (the
project was removed, or its file is damaged), nothing is merged automatically.

## What a verdict is worth

The review is an agent's reading of the change, and its verdict is the block
that agent wrote. It can be wrong, and text in the repository or the issue can
try to steer it. That is why a verdict alone merges nothing: the switch is off
unless you turn it on, the checks are GitHub's, the categories and the "a
person does the merge" setting are the project's and no session can change
them from inside its work, and the merge is pinned to the commit that was
read. For a repository where a wrong merge is costly, leave the switch off or
have a person do the merge.

Any process that holds the app's control token, a session's agent included,
can run `terminalx pipelines auto-merge <pipeline> on`. It could equally run
`gh pr merge` with your credentials; the project-level settings above are the
ones that hold regardless.

## Settings

The issue's switch is per issue. Everything else is per project, under
**Issue pipeline…** in the project's menu, and stored with the project in
`~/.raccoon/projects.json`:

| Setting | Default |
|---|---|
| Open a pull request and review it | on |
| Merge automatically by default (what a new issue's switch starts at) | off |
| A person does the merge, whatever the switch says | off |
| Review rounds | 3 |
| Merge method | merge commit |
| Always left for a person: database migrations, deploy configuration, what the security pass flags | all on |
| Paths of your own that are always left for a person (`.gitignore` syntax) | none |
| Checks that never hold a merge, by a part of their name | none |

A session on the project's own checkout (not a worktree) has no branch to open
a pull request from, so it gets no pipeline.

## The record

Every stage, verdict and merge is a line in the pipeline's record, with the
commit it was about and a link to the pull request or the session. It is kept
in `~/.raccoon/issue-pipelines.json` and shown under **Record** on the issue's
page. A merge made somewhere else (GitHub, the PR panel) is noticed at
whatever stage the pipeline was, and recorded as such; so is a pull request
closed without merging.

## From the command line

```text
terminalx sessions create --project <project> --agent <agent> --issue <issue> \
  [--provider github|linear] [--prompt <text>] \
  [--auto-merge|--no-auto-merge] [--no-pipeline] --json
terminalx sessions create --project cloud:<org>:github.com/<owner>/<name> \
  --issue <issue> [--provider github|linear] [--prompt <text>] \
  [--no-pipeline] [--agent <agent>] [--wake] --json
terminalx pipelines list [--project <project>] --json
terminalx pipelines show <pipeline> [--project <project>] --json
terminalx pipelines auto-merge <pipeline> on|off [--project <project>] --json
terminalx pipelines stop|resume|advance|review|refresh <pipeline> [--project <project>] --json
```

`<issue>` is `433`, `#433`, `ENG-42`, or the issue's URL; a GitHub URL must be
for the project's own repository. `<pipeline>` is a pipeline id, the issue it
is for, or the session working on it; when two projects each have a pipeline
for the same issue number, `--project` says which. Merging by hand is done on
the issue page, not here.

A cloud project's issue starts in one of its workspaces (a stopped one only
with `--wake`), never in a new one: a new machine starts with a plain prompt
and no pipeline. `--auto-merge` is refused there, since a cloud workspace
never merges by itself. The `pipelines` commands read this computer's
pipelines; a cloud workspace's are on its issue page.

## In the code

- `src-tauri/src/issue_pipeline/gate.rs`: the merge decision, a pure function
  of the verdict, the pull request and the switches, with a test per reason.
- `engine.rs`: the state machine. It reaches git, `gh`, the sessions and the
  tracker through `engine::Host`; `engine_tests.rs` runs it end to end against
  a host that answers as they would.
- `verdict.rs`, `prompts.rs`, `categories.rs`: the two blocks, what the
  sessions are told, and what a diff touches.
- `host.rs`: the real host, on this computer or in a cloud workspace's
  runtime. `desktop.rs` and `runtime.rs`: the poller, and the hooks a turn
  ending calls, in each.
- `src/lib/issuePipeline.ts`, `src/components/issues/IssuePipelinePanel.tsx`:
  the issue page.

## Cloud workspaces

A session started from an issue in a cloud workspace (from the Issues view
with a cloud project chosen, or with `terminalx sessions create --project
cloud:… --issue`) goes through the same stages, run by the workspace's
runtime (`terminalx-serve`) and not by this computer. It needs no desktop
attached after the start: the runtime hears each turn end as the desktop
does, pushes and opens the pull request with the workspace's own GitHub
token, starts the reviewer session in the author's checkout, and watches the
pull request's checks. While it pushes, opens a pull request or waits for
checks it counts as running work, so the workspace is not suspended halfway.
A wait counts for an hour from when it began and no longer, whether or not
GitHub can be read meanwhile; after that the pipeline stops for a person, as
on this computer.

What is different:

- **It never merges by itself.** The workspace's token is the workspace's,
  not yours, so the pipeline stops at *Ready to merge* whatever the project's
  settings say, and the issue has no switch. **Merge** on the issue page is
  made from this computer with your own `gh`, as `gh pr merge --repo
  <owner>/<name> --match-head-commit <sha>`, after the pull request is read
  again from GitHub and the same gate is applied as for a person pressing
  Merge here (verdict on that exact commit, no open finding of medium or
  higher, checks passed, mergeable). Only a pull request in the cloud
  project's own repository, opened from the pipeline's branch, is merged,
  whatever the workspace reports. The runtime is told of the merge
  (`pipeline.noteMerge`) and reads the pull request itself before recording
  it; if the workspace is asleep, it is told when it next connects.
- **Checks the workspace may not read.** The workspace's token is a GitHub
  App's, which may not have been granted a repository's checks. The runtime
  then reads the pull request without them, never takes them for passed (nor
  a branch GitHub calls blocked, which it does while required checks run),
  and stops at *Ready to merge* saying so; **Merge** reads them with your own
  sign-in before anything is merged.
- **The issue goes with the session.** The workspace cannot read the
  tracker (its GitHub token has no access to issues, and the Linear key stays
  on this computer), so the issue's text is sent with the session for the
  reviewer. A Linear issue is moved to In Review by a desktop that manages
  the workspace and has the Linear key, once it sees the pull request open
  (when it is connected then, or the next time it connects), and the runtime
  records the move (`pipeline.noteTracker`).
- **Settings are this computer's.** **Issue pipeline…** in a cloud project's
  menu sets whether issue sessions are carried on, the review rounds, the
  merge method used by **Merge**, and the checks that never hold a merge.
  They are kept on this computer and sent to the workspace with each issue
  session started from here, where the runtime reads them at each decision.
- **A restart picks up where it was.** A workspace is put to sleep and woken
  as a matter of course. On waking, a pipeline waiting for a session's report
  keeps waiting, and one at the merge stage is looked at again. A report the
  session gave just before the restart, whose step was lost with it, is
  taken from its transcript then. Only a turn the restart ended is reported,
  as *Needs you*.
- **What the page shows.** A desktop reads a workspace's pipelines whenever
  it connects to it (`pipeline.list`), follows them while connected
  (`pipeline.changed`; the newest that fit in one message, without the
  issue's text), and keeps the last ones read with the cloud catalog,
  so the issue page shows them while the workspace sleeps, and says so.
  Stop, Resume and the other buttons are asked of the runtime and wake the
  workspace; the look the page takes when it opens never wakes it.

The pipeline record lives in the runtime's data folder, beside its sessions,
and lasts as they do. A workspace whose runtime predates `pipeline/1` starts
an issue session as a plain session, and the issue page says no pull request
will be opened for it.

In the code: `issue_pipeline/runtime.rs` (the runtime's observer and poller),
`host.rs` (the host for both places), `cloud_merge.rs` (the merge from this
computer), the `pipeline/1` methods in `remote/server.rs`, and
`src/lib/cloudPipelines.ts` on the desktop.
