# Bots

A bot is an AI employee inside TerminalX. It has a standing role (CTO, UX
designer, security auditor, watcher and so on). It keeps its own memory,
gets work from schedules and events as well as from chat, and reports back in
one place. The epic is PRO-459. The build is split into the sub-issues listed
under [Build map](#build-map). The owner approved the designs (Superdesign
project "TerminalX · 23 Bots", screens 23.01–23.13) on 2026-11-20.

This page is the map for every session that works on a Bots sub-issue: what a
bot is, which existing parts it is built from, the rules that hold across
sub-issues, and what is built so far. Each part's own detail belongs in that
part's code and docs.

## A bot is a thin layer over what exists

A bot owns existing TerminalX parts. It is not a second system beside them.

| Part of a bot | Built from |
| -- | -- |
| Chat | Ordinary sessions and tabs, local or cloud |
| Duties (what wakes it) | Automations whose owner is the bot (`docs/AUTOMATIONS.md`), including the first check (PRO-484) and event sources (`docs/AUTOMATION-SOURCES.md`, PRO-485) |
| Delegated coding work | Orchestration runs with a lead and workers (PRO-269) |
| Questions to the owner | The question and permission cards that sessions already have, on the desktop and the phone |
| Mentions and the people it works for | The teammate roster, profiles and mentions (PRO-128, PRO-150, PRO-141) |

When a sub-issue seems to need a scheduler, a queue or a runner of its own,
extend automations or orchestration runs instead.

## What a bot is made of

| Part | Where it lives |
| -- | -- |
| Record: name, slug, role title, template, agent, model, effort, access, runs on, reports to, works in, paused | `bots.json` (`src-tauri/src/store/bots.rs`, `src-tauri/src/bots/mod.rs`; TypeScript `src/types/bots.ts`) |
| Role ("soul"): standing instructions | `bots/<id>/ROLE.md`, started from a role template |
| Memory | `bots/<id>/MEMORY.md` and `bots/<id>/memory/` (the bot's own notes), `personal/` and `orgs/<org>/` beside them (each place's), `src-tauri/src/bots/memory.rs` |
| History of role and memory | `bot-changes/<id>/` outside the home folder: `changes.jsonl`, `known.json`, `texts/` (`src-tauri/src/bots/changes.rs`) |
| Work items and "Needs you" questions | `bot-items/<id>/items.json`, beside the home folder rather than in it (`src-tauri/src/bots/items.rs`; TypeScript `src/types/botItems.ts`, `src/lib/botItems.ts`). That is no wall: a Full access bot can write the file with its own file tools, the direct-edit class PRO-489 deals with |
| Role templates | `src-tauri/src/bots/roles/*.md` and `src-tauri/src/bots/templates.rs`: CTO, Chief of staff, UX designer, QA engineer, Release manager, Docs writer, Security auditor, Watcher |
| CLI | `terminalx bots list / create / show / rename / pause / resume / delete / pause-all / resume-all`, and `terminalx bots memory add / forget / list`; a bot's own `terminalx bots items list / show / add / set / ask / check / comment / done` |
| Desktop UI | `src/components/bots/` (sidebar section, Bots page, first-bot page, hiring) |

A deleted bot is not removed. Its home folder moves to `trash/bots/<id>/`,
with its record next to it as `bot.json`.

## Role and memory (PRO-470)

- **Places.** A note is kept with the bot (`bot`, it goes everywhere the bot
  works), in an organisation it works in (`orgs/<org>/`, stays with that
  organisation), or as personal notes (`personal/`). A conversation is given
  the newest lines of the bot's own notes and of the place it works in, 200
  in all; past that the oldest move to that place's `memory/archive.md`.
- **The two memory commands.** A bot writes memory only with
  `terminalx bots memory add "<note>"` and `terminalx bots memory forget
  "<words>"` (`list` reads), never by editing the files. From a bot's chat, or
  a session it started (who asks is `Caller`, in `control.rs`), they reach
  only that bot's own notes and its place's; a `--bot` or `--place` naming
  another is refused (`forbidden`). At every access level, and while the bot
  is paused, the access gate lets exactly these three (`add`, `forget`,
  `list`) through with no card (`bots::access`, PRO-478), and so too the
  bot's own work list, `terminalx bots items list|show|add|set|ask|check|
  comment|done` (PRO-469). With memory off
  they answer `forbidden`. A note that looks like a secret is refused.
- **Proof for the owner's changes.** The owner's changes to a role or memory
  in the app (`roleWrite`, `roleRestore`, `memoryAdd`, `memoryForget`,
  `memoryUndo`) and turning memory back on need the window's proof, as hiring
  and resuming do (`enforce::needs_person`). From the command line the owner
  names the bot with `--bot`, from a terminal of their own.
- **History.** Every change, edits made outside the app included, is
  recorded with where it came from and can be undone. A large edit is kept as
  the whole texts by hash. A rotation keeps the newest role change.

## Rules every sub-issue keeps

These come from the owner's decisions (2026-11-20) and from the reviews of
the first sub-issues.

- **Experimental switch.** Everything sits behind Settings → Experimental →
  Bots. When the switch is off, every bot operation refuses with
  `OFF_MESSAGE`, and nothing else in the app changes.
- **Ids, not slugs.** A bot's `id` never changes and is never reused. Its
  `slug` changes on a rename and can be reused after a delete, so never store
  a slug to find a bot again. `owner`, `personal`, `all` and `everyone` are
  reserved and never become a slug.
- **Full access by default.** A new bot runs the way the owner's sessions do,
  with permissions bypassed. Pause is the guard for unattended work. An access
  level this build does not know counts as `readReport`, never as `full`.
- **Only a person's words count as approval.** A message from one bot to
  another is labelled with the sender and the sender's authority. A bot cannot
  grant itself more access, and a bot cannot resume itself after a pause.
- **Access is a mode plus a per-call gate (PRO-478).** A bot's sessions run no
  wider than `bots::chat::permission_mode` allows. Every tool call also passes
  `bots::access`: Ask before outward actions asks before anything that is not
  a known read; Read and report runs known reads, asks before a report, and
  refuses the rest. A paused bot only reads. A known read is a named read
  tool, a shell command vetted read-only, or an exact `terminalx` read (not
  the built-in browser's `wait`). The bot's own memory and work-list
  commands pass at every level (see above). It is not a sandbox. **Web and MCP resource reads
  count as reads**: `WebFetch`, `WebSearch`, a connected server's resource
  reads and a vetted read-only command that fetches a URL run unasked at
  Read and report (and at Ask before outward actions). A web request can
  carry data out of this Mac in its address, and a resource read can carry
  it out to the server it is read from. Keep secrets away from a bot that
  should not send them anywhere.
- **Pause says what it stopped.** Pause and Pause all are recorded with who
  paused the bot. A paused bot still answers its owner in chat (screen 23.12).
- **Templates carry no credentials or permissions.** Every duty in a template
  arrives switched off. A test enforces this
  (`a_template_carries_no_credentials_or_permissions_and_every_duty_is_off`).
- **A free check before the model.** A duty can run a cheap check first. When
  the check finds nothing new, the bot stays silent and notifies no one.
- **Spend is shown, never capped.** Each bot and each work item shows what it
  spent. There is no budget or limit.
- **Hiring asks for a role and a name.** Everything else starts from the
  owner's defaults and sits under "More options". The bot asks for what it
  needs later.
- **A bot belongs to a person, not an organisation.** It works with no account
  at all (`personal`). The same bot works in each of its owner's
  organisations. Its role and skills travel with it. Memory, credentials,
  work items and who may ask it for work stay with each organisation
  (PRO-483).
- **One design for local and cloud.** `runsOn` is `thisMac` today. A cloud
  workspace (PRO-482) uses the same screens. A value written by a newer build
  is kept when this build saves, and never acted on as if it were known.
- **Newer data survives older builds.** A record this build cannot read is
  saved back exactly as it was. Unknown fields on a record, or on a pause,
  are kept too.

## Duties (PRO-471)

A duty is an ordinary automation that names its bot: `automations.json`
keeps `bot: {id, reportsTo, template?}` on it, and the code is
`src-tauri/src/bots/duties.rs`, called from the automation scheduler at
three points: whether a due run wakes (`may_wake`), what a run goes ahead as
(`bind`, and `open_session` / `prompt` after the first check), and what
happens when it ends (`ended`). There is no second scheduler, session or
permission system.

- **Runs as the bot.** A run's session is one of the bot's chats (marked
  `botDuty`, listed under "Duty runs" in its view), in its home folder, on its
  agent, model and effort, in the mode its access maps to
  (`chat::permission_mode`). Its agent gets the role and memory as any chat
  does, then the duty's prompt with the first check's output, a "Your duty"
  section and the duty's own note, fenced as the bot's notes.
- **Free first check.** The automation's first check (PRO-484) runs as the
  owner, never in the bot's home, which the bot can write: in a folder of the
  duty's own, `duty-checks/<duty id>` under the store root, made again empty
  and owner-only (0700) before each run, so nothing the bot left anywhere is
  on its path. A link or a file in place of `duty-checks` is refused, and
  `GIT_CEILING_DIRECTORIES` stops git at the check's folder. The bot's home is named in `TERMINALX_BOT_HOME` for a script
  the owner wants to look there; the editor says where the check runs and
  that it runs as the owner, and the duty page warns when a check reaches
  into the home. Try it runs the check the same way, in a folder apart
  (`try-<duty id>`, or `new-<bot id>` for an unsaved duty), so it never
  empties a running check's (`dutyTryCheck`, which needs a person). Printing nothing ends the run as "nothing new": no
  session, no model, nobody told. A failing check is a failed run, which
  notifies. Its output reaches the agent labelled as information, not
  instructions.
- **Reports to.** `terminalx`: a status line in the bot's home chat and a
  notification (`bot_duty_report`). `lead`: a status line in the lead bot's
  home chat, labelled with the sender and its access, and no notification
  (the owner when the bot reports to the owner). A reply of "Nothing new."
  tells nobody; one that starts "URGENT:" notifies even in quiet hours. A
  target this build does not know is kept and reported to TerminalX.
- **Remembers between runs.** `duties/<duty id>.md` in the bot's home, read
  capped (8 KB) and fenced; the agent is asked to replace it, and a
  read-only bot is told it cannot.
- **Quiet hours** are per bot, in `bot-duties.json` at the store root (not in
  the home folder, which the bot can write). Inside them only urgent reports
  notify; every report still goes in the home chat.
- **Pause.** A paused bot's due runs are recorded as skipped (one folded row)
  and its next run moves to the schedule's next; Run now is refused. A run
  that reaches its start while the bot is paused ends cancelled.
- **One run at a time.** A due run is skipped (one folded row) while the
  duty's previous run has not finished, and Run now answers that it is
  already running. A run that goes on past its timeout
  (30 minutes unless the duty says otherwise) is ended as timed out and its
  agent stopped. The sessions of finished runs past the newest three are
  archived, except a pinned one or one with a turn in progress or waiting on
  a person.
- **Who may change one.** Add, change, run, copy, remove, switch on and quiet
  hours carry the window's proof (`bots::enforce::needs_person`,
  `consent::guards_request`); switching one off is open. The Automations
  page's own routes refuse a duty. A process in a bot's session reads its own
  bot's duties and no other's, and changes none.
- **At hire** the role template's duties that wake on a schedule are created
  switched off; the ones that wake on events wait for PRO-472.
- **With Bots off** a duty does not wake, nothing about it is read, and every
  duty call is refused.
- **Deleting a bot** removes its duties and its quiet hours. Their definitions
  and settings (`duties-removed.json`) and run logs (`duty-runs/`) go into
  its home, which goes to the trash; when that copy cannot be kept they are
  removed all the same and the delete says so. A duty left behind when its bot is gone
  for certain is listed on the Automations page, which can remove it.

## The week of duties (PRO-473)

The calendar (screen 23.13) is a view of what already exists, not a store of
its own. `dutyWeek` (`src-tauri/src/bots/calendar.rs`, a read of the
runtime's `bots` call) reads each duty's run log and its schedule, through
the scheduler's own `next_run_after`, for one bot or every bot, in the
owner's time zone (this computer's), and returns each day's blocks with the
minute they fall on.

- **What ran** comes from the log. A row that folds repeats ("Nothing new"
  again) stands for that many runs: its repeats are put at the schedule's
  times up to its last one, and those with no time the schedule gives (Run
  now, a changed schedule) at the last. So the week counts every run the log
  counts, and "This week so far" agrees with the duty's own counts.
- **What is still to come** comes from the schedule, from now to the end of
  the week, for a duty that is on and a bot that is not paused.
- **Counted, not drawn.** A duty due more than six times on some day, and one
  that wakes on events (or a run an event started), go in the "Often" and
  "Events" rows as counts per day. A schedule with more times in the week than
  are looked at (10,080) says so, and its count is "at least".
- **History not kept.** A log keeps its newest 100 finished runs, so a duty
  that wakes every half hour keeps about two days. The week returns, per duty,
  the oldest instant its log still covers (`logs[].keptFrom`); the days before
  it show "history not kept", never "none ran", and the totals say "at
  least". A log that cannot be read is said on its duty's row
  (`logs[].unreadable`) and its past days are not kept either.
- **Which weeks.** Weeks from 3 January 2000 to the end of 2199 can be shown;
  others are refused, and the arrows stop there. A day whose midnight does not
  exist (clocks moved forward over it) starts at the first valid instant.
- **Changing from the calendar** uses the duties' own guarded routes: a
  click on an empty hour opens the duty editor with a weekly schedule at that
  day and hour, and dragging a block still to come saves its duty with the
  schedule shifted (`dutySave`, which needs the window's proof). A block moves
  from its own time by whole 15-minute steps of the pointer's travel, and only
  with the main button; what changed is said with an Undo. A cron schedule
  moves only when its minute and hours are plain numbers, its days numbered
  as the scheduler numbers them (1 = Sunday … 7 = Saturday,
  `CRON_WEEKDAYS`).
- **Who may read it.** The window and a person's terminal read any bot's
  week or every bot's. A process in a bot's session reads its own bot's week
  only (`control.rs`, `own_duties_read`).

## Build map

State on 2026-11-20. Each sub-issue runs in its own issue session. Do not
build a sub-issue's scope from this epic's session or from another
sub-issue's branch, because that leads to duplicate pull requests for one
issue.

| Issue | Scope | Screens | State |
| -- | -- | -- | -- |
| PRO-466 | Store, home folder, role templates, CLI, experimental switch | n/a | Merged |
| PRO-467 | Sidebar section, Bots page, first-bot page, hiring | 23.02, 23.03, 23.11 | Merged |
| PRO-484 | Automations: first check before the model, in the editor | 23.10 | Merged |
| PRO-468 | Home chat, with the role and memory given to the agent | 23.01, 23.04 | In review |
| PRO-478 | Settings: runs on, access, works in, channels, who can ask | 23.07 | In review |
| PRO-485 | Automations wake on Linear issues and GitHub pull request events | n/a | In review |
| PRO-469 | Work items and "Needs you" questions | 23.01, 23.02, 23.09 | In review |
| PRO-470 | Role and memory, with history and undo | 23.06 | Merged |
| PRO-471 | Duties on top of automations, with a free check first | 23.05, 23.10 | Merged |
| PRO-472 | Wake a duty on GitHub and Linear events, another bot, or a change | 23.05 | Backlog |
| PRO-473 | Week calendar of duties | 23.13 | In review |
| PRO-474 | Pause and Pause all that say what they stopped | 23.12 | Backlog |
| PRO-475 | Hand-offs, the reporting line and the team brief | 23.04 | Backlog |
| PRO-476 | A bot plans and starts orchestration runs | 23.04 | Backlog |
| PRO-477 | Look around, suggestions, nightly memory tidy | n/a | Backlog |
| PRO-479 | Bots on the phone: Bots tab, Needs you, answer from a notification | 23.08 | Backlog |
| PRO-480 | GitHub and Linear as channels | 23.07 | Backlog |
| PRO-481 | Slack and Telegram or WhatsApp as channels | 23.07 | Backlog |
| PRO-482 | A bot that lives on a cloud workspace and stays on | n/a | Backlog (waits for the Cloud VM work) |
| PRO-483 | One bot across several organisations | 23.02, 23.06, 23.07 | Backlog |
| PRO-489 | Hardening left over from reviews | n/a | Backlog |

## Not in this epic

- The Cloud VM platform itself. PRO-482 only puts a bot on it.
- A public marketplace for bots.
