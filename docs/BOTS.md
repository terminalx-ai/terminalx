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
| Memory | `bots/<id>/MEMORY.md` and `bots/<id>/memory/` |
| Role templates | `src-tauri/src/bots/roles/*.md` and `src-tauri/src/bots/templates.rs`: CTO, Chief of staff, UX designer, QA engineer, Release manager, Docs writer, Security auditor, Watcher |
| CLI | `terminalx bots list / create / show / rename / pause / resume / delete / pause-all / resume-all` |
| Desktop UI | `src/components/bots/` (sidebar section, Bots page, first-bot page, hiring) |

A deleted bot is not removed. Its home folder moves to `trash/bots/<id>/`,
with its record next to it as `bot.json`.

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
  its pull request again, is left to any session.
- **What the agent is told fits one argument.** The role (16 KB read) and the
  memory (32 KB read) are cut again after decoding, without control
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
  its owner can. A resume, or more access, is still only ever given in the
  window.

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
| PRO-469 | Work items and "Needs you" questions | 23.09 | Backlog |
| PRO-470 | Role and memory, with history and undo | 23.06 | Backlog |
| PRO-471 | Duties on top of automations, with a free check first | 23.05, 23.10 | Backlog |
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
| PRO-489 | Hardening left over from reviews | n/a | In progress |

## Not in this epic

- The Cloud VM platform itself. PRO-482 only puts a bot on it.
- A public marketplace for bots.
