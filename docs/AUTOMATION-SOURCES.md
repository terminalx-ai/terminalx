# Automation trigger sources (PRO-485)

A local automation can be woken by a schedule, by a GitHub issue search, or by
an event source. There are two event sources: **Linear issues** (read with the
Linear API key from Settings) and **GitHub pull request events** (read with
`gh`). The code is in `src-tauri/src/automations/sources.rs`.

## Start from now

Whatever matches when the trigger starts is the baseline, and it never wakes a
run. A trigger starts when it is switched on, when its source or filter
changes, when the automation is enabled again, or when its record is cleared.
After that, anything that comes to match wakes exactly one run, however old it
is. Examples are a months-old issue that gets the watched label today, or a
pull request opened long ago that is marked ready now.

- **The first read is the baseline.** It pages through everything that matches
  and records it as seen without waking anything. The bound is 20 Linear pages
  of 100, or 1000 pull requests.
- **An incomplete baseline wakes nothing.** If the baseline cannot be read
  completely, the status says so ("narrow the filter") and the next poll tries
  again. There is no back-off. Whatever the read left out would otherwise look
  new later.
- **Later reads go by recent activity.** They read by most recent activity, and
  for Linear they page until a page holds nothing newer than the last read
  (with 5 minutes of overlap), up to 5 pages of 100. Pull requests are read in
  one `gh pr list --search sort:updated-desc` call of up to 250. If a read hits
  its bound, it still wakes on what it read, and a notice says that the rest
  were not looked at.
- **Saving the trigger.** If a save adds the trigger, removes it, or changes
  what it reads, the record (`automations/<id>/source-seen.json`) is deleted.
  Editing only the Linear report settings keeps the record.

## One event, one run

For each wake, the run row is written first, then the seen record (which names
the run), and then the run starts. A crash between those steps leaves a run to
inspect. It never leaves an event recorded with no run behind it, and a restart
does not start the same event again.

Pull requests:

- **Events.** A newly seen pull request counts as *opened*, or as its first
  *push* for an automation that asked only for pushes. A head commit wakes
  *pushed* once. A failed check wakes once per head. A review request from the
  signed-in login wakes again only after it was dropped and made again.
- **A run's own push doesn't wake it.** When a run ends, the head it left is
  kept on the run (`leftHeads`): its worktree's HEAD, plus the pull request's
  head if that head's last commit is by the `gh` login. That head is recorded
  without waking.
- **At most 3 runs in a row.** One pull request wakes at most 3 runs in a row
  without a push from someone else in between. After that it is recorded
  without waking, and a notice names the pull request.
- **Forks are off by default.** Pull requests from forks are ignored unless the
  trigger allows them. Branches of the repository itself can be pushed by bots
  such as Dependabot and Renovate; use the author filter to leave them out.
- **The prompt treats pull request details as untrusted.** It quotes the title,
  branch names, author and URL as untrusted data on single lines. It tells the
  run to use `gh pr checkout N --repo owner/name --detach`.

## Polling and status

- **Polling rate and back-off.** Each source is read at most once per interval.
  Failed reads back off: the interval doubles up to an hour, with at least 15
  minutes after a rate limit.
- **What retries at once.** A saved trigger, re-enabling the automation, or a
  changed Linear key clears the back-off and the old error. When `gh` is signed
  out, the cached login is forgotten.
- **What the status shows.** `automation_issue_state` carries `lastPollError`
  (the source cannot be read) and `notice` (something to know that isn't a
  failure).
- **A damaged record.** A damaged `source-seen.json` is moved aside as
  `.json.damaged`, and the trigger starts again from now.

## Compatibility

- **Unknown kinds and events.** `eventTrigger.source` is tagged by `kind`. A
  kind, or a pull request event, that this build doesn't know is kept as
  written. It is never polled and is shown as needing a newer TerminalX.
- **Older desktops.** Event automations are saved with `nextRunAt`
  `9999-01-01`, so a build without event triggers never finds them due. An
  `AutomationInput` without an `eventTrigger` field keeps the stored trigger;
  `null` removes it.
