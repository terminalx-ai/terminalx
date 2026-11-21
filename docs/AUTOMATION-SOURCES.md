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
  completely, the status says so ("narrow the filter") and it is tried again,
  backing off to once an hour. Whatever the read left out would otherwise look
  new later. A draft filter is part of the pull request search, so only pull
  requests that can match count toward the bound; the fork filter cannot be
  searched for, so forks still count.
- **Later reads go by recent activity.** They read by most recent activity, and
  for Linear they page until a page holds nothing newer than the last read
  (with 5 minutes of overlap), up to 5 pages of 100. Pull requests are read in
  one `gh pr list --search sort:updated-desc` call of up to 250. If a read hits
  its bound, it still wakes on what it read, and a notice says that the rest
  were not looked at.
- **A read that finishes after its trigger changed** writes nothing back.
- **Saving the trigger.** If a save adds the trigger, removes it, or changes
  what it reads, the record (`automations/<id>/source-seen.json`) is deleted.
  Editing only the Linear report settings keeps the record.

## One event, one run

An item wakes once ever. An issue that is labelled, unlabelled and labelled
again does not wake a second time.

For each wake, the run row is written first, then the seen record (which names
the run), and then the run starts. A crash between those steps leaves a run to
inspect; it never leaves an event recorded with no run behind it. A run that
never started (no session) posts no failure comment on its issue.

**First check (PRO-484).** With a first check, the check runs once per read
that has something to wake, before anything is recorded or inserted:

- nothing new, or a failed check: one history row (folded with the last
  identical one), nothing reported on any issue, everything read stays unseen;
- something new: the runs start, and each run's gate reuses that result.

**Reads that leave work for later.** When the per-tick cap, a run in progress
or the rate limit leaves a match unseen, the next read pages back to just
before the oldest one left, so a backlog is never starved.

Pull requests:

- **Events.** A newly seen pull request counts as *opened*, or as its first
  *push* for an automation that asked only for pushes. A head commit wakes
  *pushed* once. A failed check wakes once per head. A review request from the
  signed-in login wakes again only after it was dropped and made again.
- **While a run is going.** Anything that happens to a pull request while a run
  on it is going waits for that run to end, with no other change to the record.
- **A run's own push doesn't wake it.** When a run ends, its worktree's HEAD is
  kept on the run (`leftHeads`). That head is recorded without waking. Nothing
  else counts as the run's own: a push by the same GitHub login from elsewhere
  (the owner's own) wakes once the run has ended.
- **Rate limit.** One pull request wakes at most 4 runs an hour and 12 a day
  for one automation, counting every event kind. Past that its events stay
  unseen; the automation's status names the pull request and when it resumes,
  and keeps saying so until then. When the window opens they wake, pushes and
  failed checks on the newest head only.
- **Forks are off by default.** Pull requests from forks, or with no fork
  information, are ignored unless the trigger allows them. Branches of the
  repository itself can be pushed by bots such as Dependabot and Renovate; use
  the author filter to leave them out.
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

## A bot's duty (PRO-472)

A bot's duty uses the same sources and record, and a few more kinds that only
a duty takes (see [BOTS.md](BOTS.md#what-wakes-a-duty-pro-472)). For a duty a
read wakes at most one run, the first check is given the events in a file
(`TERMINALX_EVENTS`), and the duty wakes at most 6 times an hour and 48 a day
from all its events; past that they stay unseen and the status says until
when. Its Linear issues are never commented on or moved. When its first check
finds nothing new in the event it was given, that event is seen and the next
read checks the one behind it (an ordinary automation's stays unseen). Its
trigger starts when the duty is switched on, even while its bot is paused,
and `gh` reads in a folder of the duty's own, never the bot's home.

## Compatibility

- **Unknown kinds and events.** `eventTrigger.source` is tagged by `kind`. A
  kind, or a pull request event, that this build doesn't know is kept as
  written. It is never polled and is shown as needing a newer TerminalX.
- **Older desktops.** Event automations are saved with `nextRunAt`
  `9999-01-01`, so a build without event triggers never finds them due. An
  `AutomationInput` without an `eventTrigger` field keeps the stored trigger;
  `null` removes it.
