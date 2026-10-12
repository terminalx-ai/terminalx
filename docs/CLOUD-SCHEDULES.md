# Scheduled tasks on a cloud workspace (PRO-37)

A scheduled task wakes a cloud workspace at set times and sends one prompt
to an agent in it, with nobody watching. The server keeps the task and
decides when a run is due (terminalx-saas contract §24); the workspace's
runtime takes the run and reports it (`cloud_agents::scheduled`, see
`CLOUD-AGENT-TABS.md`). This page is the desktop's part.

## Where it is

A workspace's "…" menu has **Scheduled tasks…**
(`WorkspaceActions.tsx`), which opens `CloudSchedulesDialog`.

The item is shown only when the server has answered the organization's
list of tasks (`useSchedulesOffer` in `src/lib/cloudSchedules.ts`). That one
read is how the desktop learns two things at once: the server has the
feature turned on, and this person may manage tasks (an owner or admin of
the organization). Anyone else, and everyone on a server without the
feature, sees no item. A refusal is asked about again after ten minutes.
The read names no workspace and wakes nothing.

## What the dialog does

- **The list.** Each task with when it runs, whether it is active or why it
  is paused, its next run, how its last run went, and what it can cost.
- **Pause** at once. **Resume** after a confirmation: it starts billed
  compute by itself again and the task then runs under the account of the
  person who resumed it.
- **Delete** after a confirmation. While a run still owes its workspace a
  stop the server refuses (`cloud_schedule_cleanup_pending`) and the dialog
  says to pause first.
- **New scheduled task.** Name, prompt, agent, model, effort, permission
  mode, when it runs, the time limit of a run, what happens to the
  workspace after a run and to a missed run.
- **Pause all in the organization**, after a confirmation that says it
  includes tasks on other workspaces.

There is no edit: the server has no route for it. A task is changed by
deleting it and making it again.

## What is shown before a task is saved

The form asks the server what the task would cost
(`POST …/cloud-schedules/estimate`) whenever the times, the time limit or
the after-run setting change. It shows:

- the most one run costs, and the rate it is counted at;
- the most a month costs, or, when the workspace is left running after a
  run, that the machine may be on all month;
- that at most 24 runs start in any 24 hours, and that a run holds a
  running-workspace slot;
- when the first run would be.

The task can be saved only while that answer is on screen and after the
person ticks that it starts billed compute by itself. Changing anything the
cost depends on takes the tick back. If the workspace's runtime cannot run
scheduled tasks yet, the form says so and cannot be saved.

## What is never offered

- **Bypass permissions.** The permission list leaves it out, the form
  refuses it, and the native client refuses to send it
  (`schedule_create` in `cloud_workspaces.rs`). A tab started with no mode
  runs in bypass permissions, so a mode is always sent.
- **A prompt that is a command.** A first line starting with `!` is refused
  in the form; the server refuses slash commands and mentions of files
  outside the project, and its reason is shown.

## Native commands

`cloud_schedules`, `cloud_schedule`, `cloud_schedule_estimate`,
`cloud_schedule_create`, `cloud_schedule_set_active`,
`cloud_schedule_delete`, `cloud_schedules_pause_all`. Like every cloud
command they act in the named organization, check ids before a URL is
built, and check that an answer is about what was asked for.
