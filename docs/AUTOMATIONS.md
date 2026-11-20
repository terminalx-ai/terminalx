# Automations

An automation is a saved prompt that becomes an ordinary session on a
schedule, when a person presses **Run now**, or for each GitHub issue a search
finds. Definitions live in `automations.json`; each automation's run history
is `automations/<id>/runs.jsonl` (the newest 100 finished runs are kept).
The code is `src-tauri/src/automations.rs`; the editor and run history are
`src/components/automations/`.

## First check (PRO-484)

An automation can run a cheap shell command first and skip the model when
there is nothing new. It is optional: an automation without one runs exactly
as before.

The check runs before any session is created, for scheduled runs, Run now and
issue-triggered runs (not for a missed run, which is recorded without running
anything):

- through `/bin/sh -c`, in the folder the run would use: the project folder
  for a "new worktree per run" automation (never the run's new worktree, which
  does not exist yet), the chosen session's folder for an "existing session"
  one;
- with an agent session's login-shell `PATH` and the environment overrides an
  automation session gets (Settings → Environment); when they are unavailable the run fails, as an agent run
  would, rather than running with a different set of variables;
- with no input, and its own process group: whatever it starts in the
  background ends with it;
- within its timeout: 60 seconds by default, at most 300.

The scheduler evaluates an automation that has a check on a thread of its
own, so a slow check never delays the other automations; while one is still
going, that automation's next tick is skipped. An issue poll runs the check
once and reuses the result for every issue it starts a run for.

What happens next depends only on its exit status and standard output:

| The check… | The run |
| --- | --- |
| exits 0 and prints nothing (after trimming whitespace) | ends as **Nothing new** (`skippedPrecheck`): no session, no model call, no notification, and no comment or label on a triggering issue |
| exits 0 and prints something | goes ahead; the output is added to the prompt under the heading "Output of this automation's first check" |
| exits non-zero, times out, or cannot start | **fails** with the reason and what it printed; the agent never starts (an issue run reports the failure as any failed run does) |

Standard error never decides anything; it is kept to explain a failure.

The run records the result in `runs.jsonl` as `precheck`: `exitCode`,
`stdoutTail` and `stderrTail` (the first 32 KB of standard output and 8 KB of
standard error), `truncated`, `timedOut` and `durationMs`.

In the editor, **First check** takes the command and its timeout. **Try it**
runs the command once, exactly as a run would (same folder, same environment),
and shows what it printed and what the run would have done. Nothing is
recorded.

In the run history a "Nothing new" run has a neutral marker, not a warning or
failure colour; **Check output** in its row opens what the check printed.

Write a check so that "nothing to do" prints nothing, for example
`gh pr list --search 'review-requested:@me' --json number --jq '.[].number'`.
A check that wants to stop a run should exit non-zero, which reads as a
failure, not as "nothing new".

The `terminalx` CLI does not expose automations.
