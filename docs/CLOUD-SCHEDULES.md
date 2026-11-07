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

A **private** workspace's tasks are its creator's alone, and the list does
not say whose a workspace is. For a private workspace the desktop therefore
also asks the server about that workspace (an estimate, which reads and
wakes nothing): an admin the workspace is only shared with is answered "not
found" and sees no item.

## What the dialog does

- **The list.** Each task with when it runs, whether it is active or why it
  is paused, its next run, how its last run went, and what it can cost.
- **Pause** at once. **Resume** after a confirmation: it starts billed
  compute by itself again and the task then runs under the account of the
  person who resumed it. Resume is disabled, with the reason, where the
  server would only refuse it or pause the task again at once: the
  provider is not connected, the workspace is archived or deleted, the
  prompt is one it refuses, or the workspace's runtime cannot run
  scheduled tasks (`resumeBlocked`).
- **Delete** after a confirmation. While a run still owes its workspace a
  stop the server refuses (`cloud_schedule_cleanup_pending`) and the dialog
  says to pause first.
- **New scheduled task.** Name, prompt, agent, model, effort, permission
  mode, when it runs, the time limit of a run, what happens to the
  workspace after a run and to a missed run.
- **Pause all in the organization**, after a confirmation that says it
  includes tasks on other workspaces. It is the emergency stop: it is the
  first thing in the dialog, above a list of any length, and stays
  reachable while the list cannot be read and while the form is open.

There is no edit: the server has no route for it. A task is changed by
deleting it and making it again.

## What is shown before a task is saved

The form asks the server what the task would cost
(`POST …/cloud-schedules/estimate`) whenever the times, the time limit or
the after-run setting change. It shows:

- the most one run costs, the rate it is counted at, and the minutes that
  is for. The server's figure covers every minute it lets a run keep the
  workspace on: up to 20 minutes for the workspace to start and take the
  run, the time limit, and 5 minutes after it (`perRunMaxMinutes`). The
  moment the provider takes to stop the machine afterwards is not in it,
  and the form says so. Against a server that priced the time limit alone
  (no `perRunMaxMinutes`) the figures are worded "about", not "up to", and
  the form says what they leave out;
- the most a month costs, or, when the workspace is left running after a
  run, that the machine may be on all month;
- that at most 24 runs start in any 24 hours, and that a run holds a
  running-workspace slot;
- when the first run would be.

The task can be saved only while the answer for the settings on screen is
shown, and after the person ticks that it starts billed compute by itself.
The answer is kept with the settings it was asked for: the moment one of
them changes, the old cost is gone, the tick is gone and cannot be made,
and Create is disabled until the new answer is in (if it never comes, the
task cannot be saved). The tick itself is kept as "these settings were
agreed to", so it cannot carry over to another cost.

The answer also says when a create would be refused whatever the form says
(`refusal`: the provider is not connected, or there are already 10 tasks on
the workspace or 50 in the organization) and whether the workspace's
runtime can run scheduled tasks. Either is shown with the cost, before the
tick, and the form cannot be saved. A server without the estimate route is
said to be one that cannot state the cost yet
(`cloud_schedule_estimate_not_supported`), not one that cannot be reached.

A run that stops at a permission request with nobody attached who could
answer it is ended by the runtime after a few minutes (`needs-approval`)
instead of holding the workspace until the time limit, and the server
pauses the task at once with that reason. The list says so, and which
modes ask less. Such a task is not resumed (the server refuses it with
`cloud_schedule_needs_approval`, since neither mode nor prompt can be
changed): Resume is disabled and says to make the task again.

Under the permission list the form says what the chosen mode means with
nobody watching: "Ask every time" ends at the agent's first edit or
command, and the other modes end at the first thing they have to ask for.

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


## New workspace per run (PRO-228)

The form's **New workspace per run** option uses the selected workspace as a template for repository refs and machine settings. Each run gets a new workspace, a unique work branch and the organization's published environment. It shows **Creating workspace** until checkout is complete, then delivers the prompt through the existing unattended permission checks. Run history and the last run link to the exact workspace.

Fresh runs suspend after completion. Choose archive after 1–90 days (default 7), or earlier when the associated PR merges. The server verifies the recorded repository and branch with GitHub; no runtime-provided PR URL is trusted. A workspace used or shared by a person is retained. Archive preserves run history and follows ordinary retained-storage policy. Removing a fresh schedule clears its prompt and stops new runs while existing cleanup and audit history survive.

The estimate includes one create per run and its 30-minute creation bound. Storage can still be billed after compute stops. Changing workspace or cleanup policy clears spend consent. A server must advertise `freshWorkspacesSupported`; an older server cannot silently save this as an existing-workspace schedule.

The native scheduled runner advertises `fresh-workspace-v1`, reads the completed launch receipt to choose the repository directory, and verifies the expected branch before starting a session. It never accepts a network-supplied working-directory path. Checkout-only launches do not open an empty agent tab. Existing schedules and ordinary launch prompts keep their existing contracts.

Server and runtime changes are paired with this desktop change. See server `apps/api/docs/fresh-scheduled-workspaces.md` for ownership, retry, cleanup, PRO-195/PRO-171 shared seams, provisional migration ordering and the required real local-Docker API integration gate. PRO-252 flags and PRO-244 privacy foundations remain owned by their authors; use their landed shared interfaces without duplicating them.
