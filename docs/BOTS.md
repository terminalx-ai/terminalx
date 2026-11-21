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
  only that bot's own notes and its place's. A read-and-report bot may use
  them too. With memory off they answer `forbidden`. A note that looks like a
  secret is refused.
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

## What holds a bot, and what does not

The app, not the agent, holds a bot to its access (PRO-468, PRO-489).

- **macOS and Linux only.** The runtime works out who sent a `terminalx`
  command from the process the kernel names, placed in the pane or agent it
  runs under, and only a person's answer in the window counts as consent.
  Windows has neither yet, so a bot's process that named no session would
  pass as its owner. Off unix Bots stays off whatever the switch says
  (`bots::SUPPORTED`), and every operation says why.
- **Placing a caller takes no tab's lock.** The runtime keeps each agent's
  process id in a map of its own as the agent starts and exits, so one tab
  held mid-launch, or wedged, stalls no one else's command.
- **Outward work needs full access.** Steering an issue pipeline
  (`pipelines.autoMerge`, `pipelines.resolveConflicts`, `pipelines.act`) and
  writing to an issue (`issues.comment`, `issues.create`, `issues.status`,
  `issues.assign`, `issues.label`) act with the owner's own GitHub or Linear
  sign-in. A session that works for a bot does them only when the bot has
  full access and is not paused. Stopping a pipeline, or having it look at
  its pull request again, is left to any session. While any bot is paused, a
  process no tab holds and with no terminal does none of them either, as it
  starts no work: it may be a bot's helper that left its tab. That includes
  the owner's own script with no terminal (launchd, cron, a CI runner), which
  runs them from a terminal, or once the bots are resumed.
- **Only the window writes through the runtime directly.** The control token
  is in every agent tab's environment, and a lease (`runtime.attach`) is
  anyone's for the asking. So while Bots is on, a runtime whose window's key
  is pinned (TerminalX on a Mac) takes for the window only a registrant that
  proves it: `runtime.window.register` carries the consent witness signed
  with the window's Keychain key, as pairing does, and the process that
  proved it, as the kernel names it, is the window. Only that process (pid
  and start time, carried across a runtime update) may then make the
  `runtime.session.*` and `runtime.pty.*` calls that change anything, and
  any `runtime.mobile.*` or `runtime.sharing.*` call, whose actor is in its
  parameters. No other process is placed and let through there, whatever
  session it runs in. The window's credential is its process, proved once,
  rather than a secret it sends: no secret is written for a handover to
  carry, and none can be read out of a request.
- **Where no key can be pinned.** On Linux there is no store that keeps a
  secret from another process of the same user, so the window cannot prove
  itself: there, and on a runtime with no window, a registrant that runs in
  no pane is taken for the window as before, and the changing calls are
  otherwise taken only from a session no bot works for or a terminal of the
  person's own; a paired phone's and a share's calls are placed the same
  way. A bot's sessions still hire, delete and resume no bot there.
  No window can confirm a resume, so a resume, or Resume all, applies only
  when run in a terminal of the person's own (not a TerminalX tab, not under
  the runtime), as `terminalx-serve pair` does.
- **A caller that is gone steers nothing.** One that exited, or closed its
  connection on macOS, before the runtime could place it, or whose place
  could not be read, starts, steers, stops, merges and cleans up no run.
- **What the agent is told fits one argument.** The role (16 KB read, and
  the most a role may be) and each memory file (the newest 16 KB of its
  notes, `memory::SHOWN_BYTES`) are cut again after decoding, without control
  characters, so role, memory and rules stay under 60 KB
  (`chat::INSTRUCTIONS_LIMIT`) whatever the files hold. Twice that, Codex's
  TOML escaping at most, is still under the 128 KB Linux allows one argument
  or variable. A launch whose whole appended prompt, with a workspace's
  prompts, would pass 127 KB is refused with what to shorten, not left to
  fail in the kernel.
- **Every login shell.** The prompt travels in a variable the login shell
  expands as one word: `"$TERMINALX_APPENDED_PROMPT"` in sh, bash, zsh and
  fish, `$TERMINALX_APPENDED_PROMPT:q` in csh and tcsh, which refuse a
  double-quoted variable that holds a newline.
- **Residual: a terminal of its own.** A process that leaves its pane for a
  new session with a pseudo-terminal of its own (`script`, or a tmux server
  that was already running) is placed in no pane and has a terminal that is
  not the runtime's, so it passes as a person. What still holds is the
  agent's permission mode: a bot that asks first must have its owner approve
  the command that does this, and a paused or read-only bot runs in plan
  mode and runs nothing. A full-access bot can do it, as it can run anything
  its owner can. More access is still only ever given in the window. On a
  Mac a resume is too, and such a process cannot register as the window
  either: it has no key to prove it. Where no window can confirm (Linux, a
  headless runtime), a resume is taken from a terminal of the person's own,
  the same trust pairing uses there, so such a process can resume its own
  bot, or every bot: on those runtimes, a pause holds a bot that stays in
  its tabs, not one that has already left them.
- **A window that cannot read its key.** With Bots on, a Mac window whose
  Keychain key is locked, denied or missing still attaches and shows what
  runs, but is not taken for the window: it provides no computer use, and
  its session and terminal changes are refused with what to do (unlock the
  Keychain and allow TerminalX, then Restart runtime in Settings →
  Machines). An unproven registrant never takes the window's services, so
  a process with only the control token cannot stand in for the window.

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
| PRO-468 | Home chat, with the role and memory given to the agent | 23.01, 23.04 | Merged |
| PRO-478 | Settings: runs on, access, works in, channels, who can ask | 23.07 | In review |
| PRO-485 | Automations wake on Linear issues and GitHub pull request events | n/a | In review |
| PRO-469 | Work items and "Needs you" questions | 23.01, 23.02, 23.09 | In review |
| PRO-470 | Role and memory, with history and undo | 23.06 | Merged |
| PRO-471 | Duties on top of automations, with a free check first | 23.05, 23.10 | Merged |
| PRO-472 | Wake a duty on GitHub and Linear events, another bot, or a change | 23.05 | Backlog |
| PRO-473 | Week calendar of duties | 23.13 | Backlog |
| PRO-474 | Pause and Pause all that say what they stopped | 23.12 | Backlog |
| PRO-475 | Hand-offs, the reporting line and the team brief | 23.04 | Backlog |
| PRO-476 | A bot plans and starts orchestration runs | 23.04 | Backlog |
| PRO-477 | Look around, suggestions, nightly memory tidy | n/a | Backlog |
| PRO-479 | Bots on the phone: Bots tab, Needs you, answer from a notification | 23.08 | Backlog |
| PRO-480 | GitHub and Linear as channels | 23.07 | Backlog |
| PRO-481 | Slack and Telegram or WhatsApp as channels | 23.07 | Backlog |
| PRO-482 | A bot that lives on a cloud workspace and stays on | n/a | Backlog (waits for the Cloud VM work) |
| PRO-483 | One bot across several organisations | 23.02, 23.06, 23.07 | Backlog |
| PRO-489 | Hardening left over from reviews | n/a | In review |

## Not in this epic

- The Cloud VM platform itself. PRO-482 only puts a bot on it.
- A public marketplace for bots.
