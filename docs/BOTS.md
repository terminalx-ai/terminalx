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
| CLI | `terminalx bots list / create / show / rename / pause / resume / delete / pause-all / resume-all`, `terminalx bots memory add / forget / list` and `terminalx bots message`; a bot's own `terminalx bots items list / show / add / set / ask / check / comment / done / plan / ask-merge` (PRO-476), and its `terminalx bots post / reply` (PRO-480) |
| Desktop UI | `src/components/bots/` (sidebar section, Bots page, first-bot page, hiring) |

A deleted bot is not removed. Its home folder moves to `trash/bots/<id>/`,
with its record next to it as `bot.json`.

## Role and memory (PRO-470)

- **Places.** A note is kept with the bot (`bot`, it goes everywhere the bot
  works), in an organisation it works in (`orgs/<org>/`, stays with that
  organisation), or as personal notes (`personal/`). A conversation is given
  the newest lines of the bot's own notes and of the place it works in, 200
  in all; past that the oldest move to that place's `memory/archive.md`.
  The place a conversation works in is the bot's first organisation (or
  personal): a conversation carries no organisation of its own until one bot
  works across several (PRO-483). An organisation's folder is its id when
  that is a plain lower-case name, else `x-<hash>`, so ids that differ only
  in case never share a folder on a Mac; a folder an earlier build kept by an
  id with capitals is moved on the next look.
- **Line numbers.** A memory past 64 KB is listed from its end (its newest
  notes). `forget --line N`, a tidy's line numbers and the screen's Forget
  count from the first line listed, as `terminalx bots memory list` shows
  them, not from the top of the file.
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
  recorded with where it came from and can be undone. A large edit, the
  app's own move to the archive included, is kept as the whole texts by
  hash. The log rotates past 1 MB, or once the texts its past changes keep
  pass 16 MB; a rotation keeps the newest role change. Files are written by
  direction (those that gain lines first, those that lose lines last), so a
  crash between two writes of a move or of its undo leaves a line in both,
  never in neither. A look (every chat launch) reads again only the files
  whose size, times or inode changed, and follows topic files of any name
  without control characters, line breaks, `\` or `:`. An unreadable
  `known.json` is set aside and rebuilt from the log.
- **The window's key in memory.** The window reads its consent key from
  Keychain once and holds it in memory only (`consent::witness_for`), so a
  guarded write does not read Keychain each time; the key a launch pins
  replaces it, and it is forgotten wherever the launch key is
  (`consent::forget_launch_key`), so the next write reads Keychain again. A
  failed read is not held.

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
  the built-in browser's `wait`). A help or version flag is a read after one
  of the command line's own groups only, never after a command of the
  headless runtime's binary (`terminalx-serve service|update|pair…`), and a
  `terminalx` the session's path finds in a relative folder before the app's
  own is not the app's (PRO-494). A sub-agent's calls come on its session's
  hooks and meet the same gate. A bot's Claude Code sessions are launched
  with `disableSkillShellExecution`: a skill's inline `!` command runs as the
  skill loads, with no tool call for the gate to see, so it is replaced by a
  placeholder. The bot's own memory and work-list
  commands pass at every level (see above). It is not a sandbox. **Fetching
  a web page is outward (PRO-496)**: below Full access `WebFetch` asks, at
  Read and report as a report does, and the card names the address, since
  the address can carry what the bot read to the host it names. A paused bot
  and a built-in's unattended run fetch none. Claude Code's own mode does not
  ask for it: plan mode fetches any host, and its default mode some hosts it
  trusts, unasked (checked on 2.1.330). No shell command vetted read-only
  fetches a URL; `curl` and the like meet the gate as any command does.
  **Web searches and MCP resource reads still count as reads**: `WebSearch`,
  Codex's `web_search` and a connected server's resource reads run unasked.
  A search's query goes to the model provider's search, not to a host a page
  names, and a resource read can carry data out to the server it is read
  from. The access picker says so. Keep secrets away from a bot that should
  not send them anywhere.
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
  The Windows port (`docs/LOCAL-RUNTIME.md`, "Windows") pins the window's key
  (sealed with DPAPI) and judges pairing by the console a caller sits in,
  but its control service does not yet ask which process sent a command
  (`hooks::caller` has no pipe peer there), and it checks no window proof
  for Bots: a bot's process that named no session would pass as its owner.
  So off unix Bots stays off whatever the switch says (`bots::SUPPORTED`),
  and every operation says why.
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
  anyone's for the asking. So a runtime whose window's key is pinned
  (TerminalX on a Mac) takes for the window only a registrant that proves it,
  Bots on or off: `runtime.window.register` carries the consent witness
  signed with the window's Keychain key, as pairing does, and the process
  that proved it, as the kernel names it, is the window. A terminal of the
  registrant's own proves nothing here (`consent::verify_window_for`): it
  pairs where a person's would, but registers as the window only with the
  key. With Bots off an unproven window still provides its services, as
  nothing is guarded then; it is not recognised, so turning Bots on later
  leaves its writes refused until it proves itself. Only that process (pid
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
  way. A bot's sessions still hire, delete and resume no bot there. The same
  holds on a Mac runtime launched unpinned (Keychain could not be read at
  its launch): the window says so, with the way to restart it with the key
  (Settings → Machines → Create pairing code).
  No window can confirm a resume, so a resume, or Resume all, applies only
  when run in a terminal of the person's own (not a TerminalX tab, not under
  the runtime), as `terminalx-serve pair` does.
- **A caller that is gone steers nothing.** One that exited, or closed its
  connection on macOS, before the runtime could place it, or whose place
  could not be read, starts, steers, stops, merges and cleans up no run.
- **What the agent is told fits one argument.** The role (16 KB read, and
  the most a role may be; the editor shows up to 32 KB, the limit before
  PRO-489, so an older role is read whole there and says how much a
  conversation cuts, and is saved once shortened) and each memory file (the newest 16 KB of its
  notes, `memory::SHOWN_BYTES`) are cut again after decoding, without control
  characters, so role, memory and rules stay under 60 KB
  (`chat::INSTRUCTIONS_LIMIT`) whatever the files hold. Twice that, Codex's
  TOML escaping at most, is still under the 128 KB Linux allows one argument
  or variable. What follows the instructions (how it posts on GitHub and
  Linear, its work items, and the team's: the reporting line, open hand-offs
  and the team brief) keeps the whole note within 80 KB
  (`chat::LAUNCH_NOTE_LIMIT`): a section that would pass it is left out
  whole, never cut inside its fence, and the note says which. Only what
  Bots adds is held to 127 KB (PRO-507, `session::cli_prompt`): a bot's
  chat whose note takes its appended prompt past 127 KB is refused with what
  to shorten, not left to fail in the kernel. An ordinary session launches
  as it did before Bots, whatever its workspace's prompts, and so does a
  bot's chat whose workspace prompts were already past 127 KB without the
  note (on Linux such a launch fails in the kernel, as it did before).
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
  Mac whose runtime pinned the window's key a resume is too, and such a
  process cannot register as the window either: a terminal of its own
  proves nothing there, and it has no key. This class is narrowed, not
  closed: on Linux, on a headless runtime and on a Mac runtime launched
  unpinned, such a process passes as a person for session and terminal
  writes, may register as the window when none has, and a resume is taken
  from a terminal of the person's own, the same trust pairing uses there,
  so it can resume its own bot, or every bot: on those runtimes, a pause
  holds a bot that stays in its tabs, not one that has already left them.
- **A window that cannot read its key.** With Bots on, a Mac window whose
  Keychain key is locked, denied or missing still attaches and shows what
  runs, but is not taken for the window: it provides no computer use, and
  its session and terminal changes are refused. The window says so at once,
  with why ("This window can't change sessions or terminals"), and Try
  again registers again with the key's proof once Keychain is unlocked and
  TerminalX allowed (`local_runtime_prove_window`); nothing is restarted.
  An unproven registrant never takes the window's services while Bots is
  on, so a process with only the control token cannot stand in for the
  window. The window still reads its key at every registration with Bots
  off: that proof is what keeps it the window when Bots is turned on.

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
  session, no model, nobody told. A failing check is a failed run, which is
  reported as the duty reports and notifies the owner outside the bot's quiet
  hours; the window raises no failure notice of its own for a duty (PRO-492). Its output reaches the agent labelled as information, not
  instructions.
- **Reports to.** `terminalx`: a status line in the bot's home chat and a
  notification (`bot_duty_report`). `lead`: a status line in the lead bot's
  home chat, labelled with the sender and its access, and no notification
  (the owner when the bot reports to the owner). A reply of "Nothing new."
  tells nobody; a run that ends with no reply at all is reported as "The run
  ended without a reply." (PRO-492); one that starts "URGENT:" notifies even in quiet hours. A
  target this build does not know is kept and reported to TerminalX.
- **Remembers between runs.** `duties/<duty id>.md` in the bot's home, read
  capped (8 KB) and fenced; the agent is asked to replace it, and a
  read-only bot is told it cannot.
- **Quiet hours** are per bot, in `bot-duties.json` at the store root (not in
  the home folder, which the bot can write). Inside them only urgent reports
  notify (a failure is noted and not notified); every report still goes in the
  home chat.
- **Pause.** A paused bot's due runs are recorded as skipped (one folded row)
  and its next run moves to the schedule's next; Run now is refused. A run
  that reaches its start while the bot is paused ends cancelled, and so does
  one whose bot is paused while its session opens: pause is checked again just
  before the prompt is sent, and after, so no turn runs (PRO-492).
- **One run at a time.** A due run is skipped (one folded row) while the
  duty's previous run has not finished, and Run now answers that it is
  already running; the duty's last run is still the one going, not the skip
  (PRO-492). A run that goes on past its timeout
  (30 minutes unless the duty says otherwise) is ended as timed out and its
  agent stopped, once, even when its session was deleted. The page shows the
  model its runs use: the bot's, as it is now. The sessions of finished runs past the newest three are
  archived, except a pinned one or one with a turn in progress or waiting on
  a person.
- **Who may change one.** Add, change, run, copy, remove, switch on and quiet
  hours carry the window's proof (`bots::enforce::needs_person`,
  `consent::guards_request`); switching one off is open. A bot switches off
  one of its own duties from its own session with `terminalx bots duty-off
  "<duty name or id>"` (PRO-492), never another bot's; anyone else names the
  bot with `--bot`, which a process outside every pane with no terminal of
  its own may not do (`person_required`). A bot's own switch leaves a line in
  its home chat, in TerminalX's words, saying the bot switched it off.
  Switching one on stays the window's. The Automations
  page's own routes refuse a duty. A process in a bot's session reads its own
  bot's duties and no other's, and changes none.
- **At hire** the role template's duties that wake on a schedule or on
  another bot's message are created switched off; one that wakes on a pull
  request or a Linear issue needs its repository or team, and is added on the
  Duties tab. The built-in Look around and Tidy memory (PRO-477) are
  created switched on.
- **With Bots off** a duty does not wake, nothing about it is read, and every
  duty call is refused.
- **Deleting a bot** removes its duties and its quiet hours. Their definitions
  and settings (`duties-removed.json`) and run logs (`duty-runs/`) go into
  its home, which goes to the trash; when that copy cannot be kept they are
  removed all the same and the delete says so. A duty left behind when its bot is gone
  for certain is listed on the Automations page, which can remove it.

## What wakes a duty (PRO-472)

A duty wakes on its schedule or on one event source: the automation's
`eventTrigger` (`docs/AUTOMATION-SOURCES.md`), read by the same poll. Pull
requests and Linear issues are PRO-485's sources. The ones only a bot has are
in `src-tauri/src/bots/wakes.rs` (`kind`: `githubMention`,
`githubSecurityAlert`, `githubBranchCheck`, `linearMention`, `botMessage`,
`watch`); the Automations page refuses them.

- **Once per event.** The trigger's seen record (`source-seen.json`) keeps
  what woke it; a mention, an alert or a message from before the trigger
  started is never news. For a mention, an alert or a message, a
  trigger starts when the duty is saved on, switched on, or saved with a
  changed wake (`sources::switched`, PRO-503), paused bot or not; switched
  off, it starts again from when it is switched back on, so nothing that came
  while it was off wakes it. A watch and a branch's checks have no "before":
  they wake on each change after their first read. A Linear issue a duty wakes on is never commented on
  or moved: the report goes to the owner or the lead.
- **Who can wake it.** A GitHub mention wakes a duty only from the
  repository's owner, members and collaborators (`author_association`
  `OWNER`, `MEMBER`, `COLLABORATOR`) unless the owner chooses "Anyone who can
  comment" (`onlyFrom: "anyone"`) in the editor, saved through the guarded
  `dutySave`, with a warning beside it; a value this build does not know is
  kept and read as members. A comment by the signed-in `gh` user, or by the
  Linear key's own user, never wakes it, so a bot quoting its own handle does
  not wake itself. When the bot's `gh` or Linear key is the owner's own, the
  owner's comments do not wake it either: that is the rule, not a gap
  (PRO-503); give the bot its own account for the owner to mention it. A
  comment edited to add a mention wakes the duty once: a comment is dated by
  its last change (PRO-503). Linear mentions come from the workspace's own people,
  never an integration's comment (one with no user). A `gh` that does not
  say who it is signed in as stops the read, with the status saying so.
  Whatever any of them writes can be untrusted, and the editor says so.
- **What it is given.** The first check gets the events a read would wake on
  as a JSON file named in `TERMINALX_EVENTS`, in its own folder. The agent
  gets them after the duty's prompt, under "What woke this duty", with what
  others wrote capped and fenced (`chat::fenced`) as information. One-line
  fields keep no control character, line or paragraph separator,
  bidirectional override or zero-width character (`chat::breaks_line`). A
  watched URL is shown without its name, password, query or fragment.
- **A quiet first check.** When a duty's check finds nothing new in the event
  it was given, that event is seen, so the next read checks the one behind
  it. A check that fails leaves it unseen, to be tried again.
- **Paused.** A paused bot's duties are not read, so what arrives waits and
  wakes them on resume. A bot paused while a read was under way records
  nothing from it, so what it found wakes the duty on resume too. A schedule's due runs are still skipped, not run late.
- **Bounded.** One run at a time (a read wakes one); a duty wakes at most
  6 times an hour and 48 a day from all its events, past which they wait and
  its status says until when; one pull request wakes at most 4 runs an hour
  (PRO-485). A read of GitHub mentions looks at the repository's comments
  changed since the last read, oldest first, up to 1000, each page starting
  from the last comment the one before it read, so a comment edited between
  two pages moves none past it (PRO-503); past that the next read goes on
  from the last one read, and the status says so. A read of
  Linear mentions pages up to 1000 too, and says when it stopped there. A
  duty's event read runs on a thread of its own, as a first check does, so a
  watched command (up to 300 s) or a slow page holds up no other automation.
  A watched command runs as the owner in `duty-checks/watch-<id>`, `gh` reads
  in `duty-checks/read-<id>`, never in the bot's home, and a watched file
  that is a link is not followed.
- **Another bot.** `terminalx bots message <bot> "<text>" --kind
  handoff|question|status` runs only from a bot's own session (who sends is
  `Caller`), and a duty that reports to its lead leaves the lead a status.
  It keeps to the reporting line as `bots tell` does (PRO-475): a question or
  a status goes to the sender's lead or a bot that reports to it, a
  `--kind handoff` only where `handoffs::may_hand_off` lets work go.
  Messages are kept in `bot-messages.json` at the store root and go once
  every duty of the receiving bot that may wake on them has seen them; one no
  duty waits for goes with the next message, and the sender's answer says it
  wakes nothing. A message no duty has read is never let go to make room:
  when 100 (or 256 KB) wait unread for one bot, or the file is full, the
  sender is refused and told why. One bot leaves at most 30 an hour. They go
  when the bot is deleted. Each carries how many times it has passed between
  bots: a run woken by a message sends one more, as does any session started
  from it and the work chat of a hand-off made from it (PRO-503), and one that has passed three times wakes nobody (the status and a
  row in the duty's history say so, and so does the sender's answer), so two
  bots cannot keep waking each other. A bot does not message itself. The
  hired CTO's "Take problems from the other bots" waits for hand-offs and
  questions only, not the status every reporting duty sends.
- **Not covered.** Security alerts are Dependabot's only, not code scanning
  or secret scanning. Mentions are conversation comments only, not review
  comments, reviews or a pull request's or issue's own text.
- **Not here yet.** Duties woken by Slack, Telegram or WhatsApp and
  webhooks; their tiles stay off. A message from Slack or Telegram reaches
  the bot as a chat message (PRO-481), not as a duty's wake.

## Hand-offs, the reporting line and the team brief (PRO-475)

- **Hand-off.** `terminalx bots handoff --to BOT --title … --scope …
  [--due …]`, from a bot's session (`control::Caller` places the bot; a
  command run elsewhere is refused). The receiving bot gets a new chat of its
  own (`chat::work_chat`) whose first message is the work, and an item on its
  list. It answers with `terminalx bots tell --to BOT --about N --text …`
  (`--failed` when it could not); the answer is sent to the session the work
  was handed from. Records live in `bot-handoffs.json` at the store root
  (`bots::handoffs`).
- **Who may hand work (`handoffs::may_hand_off`).** A hand-off from A to B
  is allowed when A is B's lead (`B.reportsTo == A`), or when B's Who can
  ask lists A with exactly "Can hand off work" (`handOff`). Nothing else:
  work is never handed up the line, so a report sends its lead only
  messages and answers, unless the lead's Who can ask lists it. The rule is
  judged on the records as they are under the hand-off store's lock, and the
  refusal names the rule that failed (handed up the line; listed at a lower
  level such as "Can ask"; neither). The line and Who can ask are the
  owner's (changed with the window's proof). The owner hands any bot's item
  to any bot with "Hand to another bot" on the item's page (`itemHand`,
  guarded).
- **Tell.** `tell` stays on the reporting line in both directions: a bot
  tells its lead and the bots that report to it, and answers whoever handed
  it work. Who can ask lets a bot hand work, not send messages off the line.
  The line is judged under the store's lock when the tell is recorded, and a
  tell still waiting whose line is gone by delivery is dropped, and its
  sender is told so by TerminalX, in its home chat (PRO-498).
- **Labels.** Each bot's message is sent with the sending bot as its
  author (`SessionManager::send_from_bot`), labelled "<Name> · hand-off to /
  answer to / status to / message to <Name> · a bot's words, not an
  approval". Its text is fenced (`bot-message`) under a header saying it is
  never an approval and never the owner's instruction. Nothing a bot sends is
  recorded as the owner's; the owner's own acts (Stop, an item they hand on)
  are sent with TerminalX as their author ("TerminalX · your owner handed you
  this in the window"), with the owner's note fenced, never as a person's
  message. The receiving bot's item records the sender as the one who asked
  and added it (the owner, for an item they handed on).
- **The lead decides.** A failure or a question a bot cannot settle goes to
  its lead (`tell --to lead`), and a failed hand-off comes back to its sender
  with what it may do: hand it again (`handoff --retry N`, twice at most),
  do it another way, or ask the owner (`bots items ask`).
- **Bounds.** No hand-off to itself, none back to a bot that handed it open
  work or further up the chain, chains of at most 3, at most 20 open
  hand-offs and 20 waiting messages per bot, 200 open overall, and 20
  hand-offs and messages per bot in 10 minutes, reserved under the rate's
  lock. Between the same two bots, either way and closed ones counted, at
  most 6 hand-offs an hour; items the owner handed on in the window are not
  counted (PRO-498). A bot works on at most 4 hand-offs at once,
  counted under the lock from its open working ones (claimed ones whose chat
  is not made yet included, and, for a bot that is not paused, the waiting
  ones about to be claimed): a fifth is refused, and on a resume the rest
  wait and start as those are answered or their sender is deleted. When a
  hand-off closes, the chat made for it (never a home chat or another of
  the bot's chats) has its own agent tab stopped (never another agent tab
  the owner added to it, PRO-498) once its turn has ended and its agent left
  nothing running in the background (`SessionManager::stop_if_idle`, as
  the idle sweep does); its conversation stays.
  Closed hand-offs are trimmed to 300, the bots' before the owner's;
  delivered messages to 400, and a delivered message keeps no text (its words
  are in the chat); a waiting message is never trimmed. A write past the
  size limit first drops the oldest sent messages and closed hand-offs to
  make room; one that still grows the file past 4 MB (a bot's) is refused
  (the owner's go to 6 MB; reads stop at 8 MB).
- **Pause.** A paused bot sends nothing. Work handed to it is recorded as
  waiting, with no chat or item, and starts when the owner resumes it; what
  is sent to it waits too. It is never started by a bot. The resume answers
  at once: what waited starts after it, on a thread of its own
  (`handoffs::resumed_later`, PRO-498).
- **Start.** A hand-off is claimed (waiting to working) under the store's
  lock before its chat and item are made; a Stop that lands meanwhile
  archives that chat and drops the item, so nothing is left behind. The
  claim judges `may_hand_off` again on the records as they are then: when
  the owner removed the line or the Who can ask entry since it was handed
  (to a paused bot, say), it fails naming the rule, with no chat, no item
  and nothing sent to the receiver, and its sender is told. When its chat
  cannot be made, or its start cannot be recorded, it fails and its sender
  is told; it is never left working with no chat. One left waiting for a
  bot that is not paused (a start cut short, or the cap of 4 reached) is
  shown as "Waiting to start" and starts at the next launch of one of its
  chats, a resume, or when another of its hand-offs closes.
- **Delivery.** A message is kept with a pending mark until its chat takes
  it: sent at once, or once after the chat's next successful launch
  (`chat::launched`), three automatic tries; then a hand-off it carried fails
  and its sender is told. A message or an answer is never given up: after
  its tries it is held, shown on the card (or in a strip above the chat)
  as not delivered with why and a Resend (`handoffResend`, open: it sends
  only what was recorded), and sent after the bot's next launch. Pending
  messages are never put in a launch note.
- **Stop.** The card's Stop (`handoffStop`, which narrows and needs no
  proof) is recorded first, under the store's lock and only while the
  hand-off is open, then stops the receiving bot's chat for that hand-off
  and the sessions it started for its item, drops the item, and tells the
  sender, as TerminalX, that the owner stopped it. Its other chats, and the sender's, go on.
  Work the owner stopped is not handed on again for 24 hours after the
  stop: a new hand-off from the same sender with the same title (case,
  spacing and punctuation aside; a title with no letters or digits is never
  matched), to any bot, is refused, and its sender is told to ask the owner,
  who can hand it on from the window. After that, recurring work (a daily
  duty's hand-off) goes on (PRO-498).
- **Team brief.** `bot-team/BRIEF.md`, written by the owner in the window
  (`briefWrite`, guarded) under "Every bot reads"; 8 KB and 200 lines at
  most. Every launch of a bot's chat is given it as the owner's standing
  instruction, or, when the file no longer has the hash the owner saved, as
  information only. The hash in `bot-team/brief.json` is a plain record,
  not a secret: a Full access bot that rewrites both files with its own
  tools is not held (PRO-489).
- **Deleting a bot** moves its closed hand-offs and its messages to
  `trash/bot-handoffs/<id>.json`. An open one it handed out is stopped
  (`stoppedBy: deleted`, "Stopped · its sender was deleted"), the work and
  item for it are dropped, and it stays on the other bot's list, which is
  told. One given to it and still open fails, stays on its sender's list,
  and its sender is told.
- **What a bot is given back.** `bots handoffs` shows a bot only its own
  side's session of each hand-off, never the other bot's.
- **Who a message is from** is worked out when it is sent, from the sending
  and receiving bots' records, never from the stored label. Nothing kept in
  `bot-handoffs.json` is ever sent as the owner's own message: the owner's
  acts reach a bot as TerminalX's ("TerminalX · your owner stopped hand-off
  4"). The file itself is not guarded against a Full access bot's own file
  tools (PRO-489), so its text is only ever given as a bot's or the app's.

## A bot leads orchestration runs (PRO-476)

A lead bot coordinates; its workers build. Large work becomes an
orchestration run the owner approves from the bot's chat. Nothing new is in
the engine: the bot drives the existing `terminalx runs …` commands, and
`bots::runs` only links a run to a work item, asks, and wakes the bot.

- **Who leads.** A bot's chat lives in its home folder, which is not a git
  project, and `engine::create` needs one. The bot starts a session in the
  project (`sessions create --project`); it is marked `botStarted`, so it works
  for the bot, and it runs `runs create` as the lead. `Caller::gate` and
  `may_steer` are unchanged: a bot steers only runs led by its own sessions,
  and a run's workers inherit the bot through their parent, so they are held to
  its access and its pause and cannot create or steer runs (`guard::limited`).
- **The plan and the question.** `bots items plan ITEM --run RUN` checks that
  the bot leads the run and that it has not started, links it, keeps the bot's
  minutes, and asks "Approve the plan and start the run?" with "Approve and
  start" (recommended by default), "Start, but ask before merging" and "Not
  now". The question carries its purpose (`startRun`) and the run's id, so the
  app acts on the answer's number, never on its words.
- **The approval is the owner's act.** Answering with 1 or 2 needs the
  person's proof (`enforce::needs_person`). The run is approved
  (`AwaitingApproval`) or started (`Planned`) before the answer is recorded; a
  failed start leaves the question open and says why. A run that already started
  is not started again. The person check reads the call as the app does and
  counts anything it cannot read as an approval; it is only a preview, since
  the question can change before the answer lands. The binding check is under
  the list's lock: the control socket passes down whether the window's proof
  held (`bots::BY_PERSON`), and an approving answer is refused unless it did
  and names the question the owner read. "Start, but ask before merging" sets the merge hold
  first: `runs merge` from the bot is then refused with `merge_held` until the
  bot asks `ask-merge` and the owner answers Merge.
- **Only the owner starts it.** A run an item asked about is refused
  `runs start` (`awaits_owner`) while it has not started (`AwaitingApproval`
  or `Planned`) and the owner chose no start, "Not now" included, and a held
  run is refused `runs merge` (`merge_held`) until they said Merge. Both are
  judged by the run, whoever calls the control socket, so a process a bot
  starts outside its sessions is held too; the owner's own Start and Merge are
  the window's and do not come that way. The window witnesses every chosen
  answer (`consent::guards_request`), so its proof reaches the runtime.
- **Started from the Run view.** The owner may approve or start the run from
  its Run view instead of the item's question. The item is then settled as
  "Approve and start" there would settle it (`runs::started_from_run_view`):
  the start is recorded with no merge hold, since the Run view's start holds
  none, and the item's question about the run is closed. Once the run has
  started by any route, the lead's `runs start` goes through, to launch pieces
  that became ready or to go on after a stop (PRO-501).
- **Done means the run ended.** An item that links a run that is not done or
  stopped cannot be closed with `done`. A failed run counts as open: its pieces
  may still merge, so it also keeps its merge hold and its place on the item.
- **Checking back.** `set ITEM --check-back TIME|report|off`. The automation
  scheduler's tick (about every 30 s) wakes a bot whose time has come, and the
  orchestrator's `tell_lead` wakes it when a worker of a linked run reports;
  nothing else runs while it waits. The wake goes to the session that set it,
  or the home chat, as TerminalX's own words, never a worker's; a lead already
  told by the run is not woken twice, and its check-back's time still stands. A wake that cannot be sent is tried again
  five minutes later and logged.
- **What the owner sees.** The run plan card above the chat the plan was asked
  from (or the home chat, for a plan asked from a project session): the goal,
  "3 pieces · est. $4–$6 · 40 min", each piece and its worker, and the question.
  "Started by <bot>" shows each run once ("Run · goal", "plan waits for you",
  "2 workers running") with its lead and workers folded under it. The item's
  page lists the run and its workers under "Sessions and links", each hand-off
  to a worker in its activity with the worktree, the worker's report (as its
  words, not an approval) and its cost, and "Checks back" with the line
  "Nothing runs and nothing is spent while it waits." Home shows "Run plan · N
  pieces" or "N workers running".
- **The two switches.** Bots off: nothing of this exists. Bots on and
  Orchestrator runs off: `plan` and an approving answer are refused with the
  reason, the run rows in "Started by" are not read, and items keep what they
  link. Both on: all of the above.

## Pause (PRO-474)

Pause is a thin layer over the pause record (`BotPause` in `bots.json`) and
`bots::enforce::reconcile`. Nothing else decides what a paused bot may do.

- **Where it came from and what it stopped.** `bots::enforce::pause` looks at
  the bot's sessions before pausing (`bots::pause::look`), records the pause
  with `from` (`app`, `shortcut`, `phone`, `cli`), reconciles, and then writes
  `stopped` once: what it was doing (`was`), its chats, workers and duty runs
  in a turn, and what it had spent today. A second pause keeps the first one's
  record. The `terminalx` CLI pauses with `from: cli`; the window cannot claim
  it.
- **A worker finishes its step.** A run worker's tab in a turn is not stopped.
  `reconcile` asks for plan mode, applied when the turn ends, and keeps the
  mode it had for resume. Every other tab in a turn is stopped, as before.
  The orchestration engine starts no worker in a run led by a paused bot
  (`Host::held_by_pause`; starting one by hand fails with `bot_paused`, and a
  run not started yet counts as started, so its resume starts it). On
  resume, `orchestration::engine::bot_resumed` starts what became ready, once,
  and tells the lead.
- **What is kept and what is skipped.** Due scheduled duty runs are skipped
  (PRO-471). A paused bot's event duties are not read, so events wait at their
  source and wake it on resume (PRO-472). Hand-offs and messages to it wait
  (PRO-475). The owner's answers, comments and work on its items are kept on
  the item (`undelivered`) and sent on resume (`items::deliver_waiting`).
- **Direct chat.** A paused bot still answers in its chats, in plan mode, and
  its rules tell it to say first that it is paused.
- **What is held.** `bots_pause_held` (`bots::pause::held`) reads, where each
  is kept: skipped runs since the pause, event duties, waiting hand-offs and
  messages, and kept answers, with every bot's run workers still in a turn
  (not its chats answering the owner) and open questions. A part that cannot be read is listed in `errors`. Spend is read
  apart (`bot_spent_today`); since the pause is today's spend less the pause's
  record. The window reads it only while some bot is paused
  (`src/lib/botPause.ts`).
- **Screens.** The 23.12 page shows when every bot is paused
  (`BotsPaused.tsx`). With some paused, the team table gives each paused bot's
  state and what it holds, with "Held while paused" under it. The sidebar
  row, the bot header and the chat banner say it too. The row's context menu
  (Open, Pause or Resume) is built from the app's menu parts; no board shows
  it. The design's ⇧⌘P is the markdown preview's, so Pause all is ⌥⇧⌘P.
- **Resume.** Anyone, a bot included, may pause. A resume from the CLI waits
  for the owner in the app (PRO-468).

## GitHub and Linear as channels (PRO-480)

`src-tauri/src/bots/channels.rs`, with the commands in
`control_bot_channels.rs`. It builds on what main has (the owner's `gh`
login, the Linear key, the bots' chats), not on PRO-472's duty wakes: a
mention starts a conversation, not a duty run.

- **Posting.** `terminalx bots post github --pr|--issue …` and `terminalx
  bots post linear --issue …`, from a bot's session only (`Caller`). A
  review is a `COMMENT` or `REQUEST_CHANGES` review, never `APPROVE`: an
  approval with the owner's login would count as theirs. Every post ends
  with "Written by <bot>, a TerminalX bot, on behalf of <owner>"
  ([`channels::signature`]), added by the app. Posts are recorded in
  `bot-channels.json` and shown in the bot's settings; at most 20 an hour
  per bot.
- **The gate.** `bots post` and `bots reply` are reports
  (`access::report_command`): Full access posts, the two lower levels ask
  first, a paused bot is refused. At every level, Full access included, a
  bot's session is refused the `gh` commands that post a comment or a
  review unsigned (`access::unsigned_post`, PRO-502): `gh pr comment`,
  `gh issue comment`, `gh pr review`, and a `gh api` call that writes to a
  `comments` or `reviews` path or sends a GraphQL mutation that names a
  comment or a review. `-R`/`--repo` and its value are skipped wherever
  they stand, so `gh pr -R o/r comment 12` and `gh issue --repo=o/r comment`
  are refused too (PRO-505). A `gh api graphql` call whose query cannot be
  read, sent with `--input` or read from a file or stdin (`-F
  query=@add.graphql`, `-F query=@-`), is refused as if it were a comment
  mutation, whatever the file says: a bot reads with GraphQL by writing
  the query in the command (`-f query='query { … }'`), and `-f
  query=@x` is the text `@x`, not a file. The refusal names `bots post`
  and `bots reply`. It finds them anywhere in a command line (lists,
  pipes, `sh -c`, `env`, `sudo`), but it reads commands: a script, another
  program (`curl` to the API, a Linear client), a connected server's (MCP)
  tool, an alias, a `gh` extension, or a call spelt another way (an option
  `gh` reads that this check does not know of, set before the
  subcommand) still posts. The bot holds the owner's credentials, so this
  stops habit and a prompt that asks for it, not a bot set on getting
  around it. What stands behind it is the check below, which reads no
  command.
- **Reading.** The automation scheduler's tick calls `channels::tick`,
  which reads at most every two minutes, on a thread of its own: the
  conversation and review comments of the GitHub repositories of the
  owner's projects (20 at most), and Linear comments that contain any bot's
  `@slug`. Each source starts from the moment it is first read; each
  comment is looked at once, on its first read (`seen`), so a mention an
  edit adds later is never taken in. A comment edited before its first
  read is not accepted: the services do not say who edited it, and a
  maintainer can edit anyone's comment. A mention is `@slug` as a word of its
  own, outside a quoted line.
- **Who is accepted (`channels::judge`).** The owner (their `gh` login,
  their Linear user id), and the people in Who can ask who may ask, known by
  the GitHub login the owner gives them (`BotAsker.github`, set from the
  person's row) or on Linear by their email (`BotAsker.email`, kept when
  they are added from the organisation). Giving or changing a login needs
  the window's proof, as any new entry does (`gives_more`). A person
  listed for an organisation the bot does not work in now, and anyone not
  listed, is kept as "not accepted" with why, shown in the bot's settings,
  and starts nothing. A comment that carries the signature, or comes from a
  bot account, is not looked at (a signature only in quoted `>` lines is a
  person quoting a bot's post, and counts as theirs): a bot's signed post
  wakes no bot, and is never taken for the owner.
- **While a bot is at work (PRO-502).** A mention from the owner's account
  written while one of the owner's bots at Full access was in a turn is
  kept as "not accepted", with the bot's name and "mention @slug again in a
  new comment once it has finished", as an edited comment is. It reads no
  command. A spell (`Working` in `bot-channels.json`) opens on a bot tab's
  first sign of work in a turn (its prompt, turn start or a tool call,
  `SessionManager::publish_event`) while the bot is at Full access and not
  paused, and closes at the turn's end; one whose end was never seen closes
  on the next read when the tab has no turn open. Whether a bot is at Full
  access and not paused is read from `bots.json` at most once a second per
  bot (`channels::opens_spells`, PRO-505), so a bot below Full access does
  not have the file read on every tool call. An access or pause change the
  same process saves is seen on the next event; any other change to
  `bots.json` within a second. A comment counts as
  written in a spell from two minutes before it starts to two minutes after
  it ends (`WORK_MARGIN_SECONDS`: the services' clocks and posting delay).
  Spells are kept a day. Bots at the two lower levels open none: they ask
  before every command, and the card shows it. Comments from people in Who
  can ask are not affected: a bot posts with the owner's login, not theirs.
  The trade-off: the owner's mention made while any Full access bot is
  working is turned away and must be made again. A narrower rule (only
  turns that ran a command not known to read, or comments whose text a
  tool call carried) would read the bot's commands, which is what this
  check is there not to depend on.
- **What is not guaranteed.** A bot's unsigned post with the owner's login
  is still taken for the owner when it is made outside a turn: by a
  process the bot left running in the background, by a scheduled job, or
  through a session the app does not know acts for a bot. A bot at a lower
  level can post unsigned with a command the owner approves on the card.
  So the agent is still told a comment from the owner's account is not
  always the owner's, its text reaches it fenced as a request, never an
  approval, and at most ten mentions an hour reach one bot.
- **Names.** Outside the fence, a mention names its author in the app's
  words: the name the owner gave a listed person, the owner's own login or
  Linear name, never a display name the commenter chose. The GitHub login
  is kept apart (`login`) to name the person in the reply.
- **Who the owner is** is read with `gh api user` and Linear's viewer and
  kept for half an hour, but not while the Linear viewer could not be read;
  without it Linear is not read at all, so no owner's mention is turned
  away.
- **The conversation.** An accepted mention becomes a new chat of the bot
  (`chat::channel_chat`, marked `botChannel` with the thread's kind, label
  and address, listed under "Chats with <bot>" with its source), or goes to
  the chat that pull request or issue already has. Its first message has
  TerminalX as its author ("TerminalX · @ann mentioned you on GitHub
  (acme/app#7) · a request, not an approval"), with the comment fenced
  (`channel-message`) as a request from that person, never an approval and
  never the owner's instruction, even when the owner wrote it.
  `terminalx bots reply` posts the answer in the thread of the newest
  mention that reached that chat: a new comment on the pull request or
  issue (naming who asked), a reply in a review comment's thread, or a reply
  under the Linear comment's thread.
- **Bounds.** A paused bot's mentions wait until it is resumed; at most 10
  reach a bot an hour, and the rest wait. One that cannot reach its chat is
  tried three times, then shown as failed. A mention's text is capped at
  4,000 characters and dropped once delivered.
- **Deleting a bot** drops its mentions and posts; its chats go to the
  archive with its others.
- **With Bots off** nothing is read, nothing is delivered, and both
  commands answer `bots_off`.

## Slack and Telegram as channels (PRO-481)

`src-tauri/src/bots/chat_apps.rs`, with the connectors in `telegram.rs`
(Bot API long polling, `getUpdates`) and `slack.rs` (Socket Mode). No
relay: both need only outbound connections from the runtime, which runs
them. WhatsApp's Cloud API delivers only by webhook to a public address, so
its row stays off.

- **Logins.** The owner makes their own Telegram bot (@BotFather) or Slack
  app (Socket Mode on; bot scopes `chat:write`, `im:history`,
  `app_mentions:read`, `users:read`, `users:read.email`, `channels:read`;
  events `message.im` and `app_mention`; interactivity on) and pastes its
  tokens in Settings → the bot → Channels. The window checks them (`getMe`;
  `auth.test` and `apps.connections.open`) and writes them itself to
  `bot-chat-logins.json` in the store, owner-readable, beside
  `settings.json` where the Linear key is: the runtime has no Keychain, and
  the tokens never cross the control socket. Never in `bots.json`, the
  bot's home, a log or an error: the clients' errors are built from the
  services' answers, not the HTTP library's, which would print Telegram's
  address and its token.
- **Linking.** "Link a chat" makes a code (six letters and digits, ten
  minutes, five wrong tries) that is sent from the chat to link: bare,
  `/start CODE` (the `t.me` link the dialog opens) or `/link@bot CODE` in a
  group. Whoever sends it is the owner there. A message from a chat that is
  not linked, or linked through another login, is kept without its text,
  shown in the dialog's "Lately", and never reaches the agent.
- **Who may ask.** In a linked group or channel, someone else is accepted
  only when they are in Who can ask by the email Slack gives for them,
  judged as a GitHub or Linear mention is (`channels::judge`). Telegram
  gives no email, so only the person who linked a Telegram chat asks there.
  The text reaches the agent fenced (`chat-message`), with TerminalX as the
  transcript's author, as a request and never an approval.
- **Where it goes.** The owner's direct message goes to the home chat; a
  group's or channel's goes to a chat of its own per Telegram group or
  Slack thread, marked `botChannel` (`slack`, `telegram`). A paused bot's
  messages wait (the chat is told once); at most 30 reach one bot an hour.
- **Replies.** The turn that answers a message (found by its start after
  the sequence number it was sent at, so a queued message waits its turn)
  is sent back where it was asked: in its Slack thread, as a Telegram reply.
  A stopped turn says so; after six hours it is given up.
- **Reports and questions.** A duty's report to the owner goes to every
  direct chat the owner linked, with no sound in quiet hours (Telegram's
  `disable_notification`). A "Needs you" question goes with its answers as
  buttons (inline keyboard; Block Kit, the recommended one primary). A
  press is taken only from the person who linked that chat, once, as an
  answer from outside the window (`byPerson: false`), so one that would
  approve a run is refused; such a question goes with no buttons and says
  to answer in TerminalX.
- **Also sends to** (design 23.04): beside the home chat's send button, the
  linked direct chats the bot's replies to what the owner writes there also
  go to, each with a quote of what was written.
- **Workers.** The scheduler's tick (and the window's read) start one pump
  and one connector per saved login; each stops when its login changes or
  goes, the bot is deleted, or Bots is switched off. Deleting a bot forgets
  its links, messages and logins.

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
- **How a block reads (PRO-497).** A run that began and was stopped is
  "Stopped", never "Did not run", which is kept for a time that passed
  without a run. A block for one run is as tall as the run went on (to now
  while it runs; `blocks[].minutes`), cut at midnight, and one near midnight
  is drawn ending inside its day. The calendar ticks only while the window is
  shown, and reads the week again when it is shown. An older runtime that does
  not know `dutyWeek` is offered Restart runtime.
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
- **Which weeks.** Weeks whose first day is from 1 January 2000 to the end
  of 2199 can be shown; others are refused, and the arrows stop there. A day whose midnight does not
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

### Decisions after the follow-up (PRO-499)

Each was a default taken to start the work; the owner may change any of them.

| Item | Built |
|---|---|
| Many duties at one time | Side by side while each stays at least 48 pixels wide; past that, the last lane of the group is a "+N more" that opens a list of the rest, each opening its duty (`fitLanes`) |
| First day of the week | The system's region (`Intl.Locale` week info for the window's locale, `firstWeekday`); no new setting. `dutyWeek` takes `firstDay` (0 Monday … 6 Sunday, Monday when absent) and a block's `day` counts from it. Stored weekdays and cron days keep their meaning; the screen reads each column's weekday from its date, so an older runtime's Monday week still adds and moves on the right days |
| Keyboard | The hours are an ARIA grid under the blocks with one tab stop: the arrow keys move between hours and days, Home and End to the week's ends, Page Up and Down by six hours, Enter or Space adds a duty at the hour. On a block still to come, Alt (Option) and the arrows move it by 15 minutes or a day, shown where it would go; Enter saves it, Escape or leaving it puts it back |
| A deleted duty's past runs | `dutyDelete` keeps the run log, with the definition and when it was deleted beside it (`automations/<id>/deleted.json`); one that never ran leaves nothing. A run still going ends then, as stopped ("Its duty was deleted before this run finished."): recovery and a run's own ending read only the duties there are, so nothing would close it after, and a run the log gets after the delete is read as ended at it. Its past runs are drawn dimmed with a bin mark and "(deleted)", never moved, nothing of it is to come, and it is named from `deleted[]`. Clicking one opens its kept log (`dutyKeptLog`, a read), whose runs open their sessions on a bot's Duties tab. Deleting the bot takes its deleted duties' logs to its home in the trash |
| A run past midnight | Drawn again from each later midnight of the week it covers, as a block marked `continued` whose `minutes` run from there; one begun the week before is drawn from the week's first midnight and counted in the week it began |

## Look around, suggestions and the memory tidy (PRO-477)

Every bot has two built-in duties (`src-tauri/src/bots/builtins.rs`). They
are ordinary duties, so they are scheduled, paused, timed out and logged as
any duty is; the duty's owner record marks them (`bot.builtin`:
`lookAround` or `tidyMemory`), and that mark changes what a run may do, its
free check, its prompt and its report.

- **Look around** wakes at 08:00, 12:00, 16:00 and 20:00 in the owner's time
  zone (`0 8,12,16,20 * * *`), with an optional focus line the editor keeps
  (200 characters). It reads what changed and proposes work with
  `terminalx bots suggest --title … --why …`; it changes nothing.
- **Tidy memory** wakes at 02:00 (`0 2 * * *`). It reads the notes with
  `terminalx bots memory list` and sends one plan to
  `terminalx bots memory tidy --plan JSON`: notes to merge into one, and notes
  a newer one contradicts. The plan names each note by its line and its text;
  when a line no longer reads as named (memory changed since it was read), a
  line is named twice, a merge has fewer than two notes or its new note holds
  a secret, the whole plan is refused and nothing is written. A plan that
  passes is one change in the memory's history (`tidied`), so one Undo on the
  Changes list puts every note back. A tidy run tidies once; the owner may
  tidy too. A bot tidies only the places its conversations read.
- **Read-only by the hooks, not the prompt.** A built-in run's session is
  marked (`botDuty: {id, builtin}`), and its tab's runtime holds that mark
  (`TabRuntime::bot_builtin`). Every tool call passes
  `builtins::session_gate` in the PreToolUse and PermissionRequest hooks (and
  `approval_gate` for app-server Codex) before the bot's own access gate: a
  read (`access::reads`) or the built-in's own commands pass, and anything
  else is refused before it runs, with a message telling the agent to suggest
  it instead. So a Full access bot's look around cannot write, even in bypass
  mode. Asking a person (`AskUserQuestion`, `ExitPlanMode`) is refused too:
  nobody is there. Each refusal is counted against its run
  (`bot-suggestions/<bot id>.json`, `looks`). Native Codex has no hooks, so
  its built-in runs start in plan mode, whose read-only sandbox is the
  barrier (`builtins::run_mode`).
- **A free check before the model** (`builtins::nothing_to_do`, from
  `duties::may_wake` when a run is due). A look around is skipped while five
  of its suggestions wait on the owner, or when nothing it can see has changed
  since its last finished look: a SHA-256 over the projects' `.git` state
  files, its own prompt and focus line, the person's sessions (not any
  bot's) by what lasts in them (made, renamed, archived, tabs opened or
  closed; not their tabs' states), its open items and its open suggestions. A
  look is never skipped this way more than 24 hours after the last one that
  ran (`LOOK_QUIET_MAX`): what it reads beyond this computer, such as pull
  requests and CI, is not in the fingerprint. A tidy is skipped when memory is off, holds fewer than two
  notes, or is as the last tidy left it. A skipped run is logged as "Nothing
  new" (one folded row) and starts no session; the Home tab says why.
- **Suggestions** are kept at the store root, `bot-suggestions/<bot id>.json`,
  not in the home, which the bot writes with its own tools. A suggestion is a
  title (one line, 200 characters) and why (one line, 400), checked for secrets. At
  most 20 wait at once, at most 5 come from one look, and an open title is
  not suggested twice; the newest 50 closed ones are kept. Only a bot
  suggests, from its own sessions (`control_bot_suggestions.rs`, placed by
  `Caller`), never while paused. Records a newer build wrote are kept as
  they are and counted as not shown.
- **Start and Dismiss** are the window's (`suggestionStart`,
  `suggestionDismiss` in the runtime's `bots` call). Start needs the window's
  proof (`enforce::needs_person`, `consent::GUARDED_BOTS`): it is closed as
  started first, under the file's lock, so a second Start finds it closed; it
  makes an item the
  owner asked for, in progress, and sends it to the bot's home chat as the
  owner's message, which tells it to begin, and opens again if that fails.
  Dismiss only closes it.
- **The Home tab's right column** (23.01): who it reports to (PRO-475), Up
  next (the bot's duties that are on, soonest first), and Suggestions with a
  line saying when it last looked, how many it suggested, what was refused
  and why a look did no work, or that Look around is off, with a switch.
- **At hire** both are made switched on. A bot hired before this build gets
  them switched off the first time the window reads its Home tab
  (`suggestions` is the window's: a bot's own process may not read it). The
  Duties tab marks them Built in; they cannot be removed or copied, and their
  name and prompt stay TerminalX's. Their report goes in the bot's home chat
  and notifies no one unless it is urgent.
- **Deleting a bot** moves its suggestions file to `trash/bot-suggestions/`.

## Bots on the phone (PRO-479)

The phone (screen 23.08) reads and acts on the bots through the paired
phone's own calls, never a second set of bot rules.

- **Offered only with Bots on.** A Mac names `bots: 1` in
  `sync.capabilities` only while its runtime has the `bots` call and the
  Bots setting is on; switching it tells connected phones to ask again
  (`sync.capabilitiesChanged`). A phone shows its Bots tab only for a Mac
  that names it, and asks for bots' questions in its notification filter
  only then, so with Bots off nothing on the phone changes.
- **The calls** (`src-tauri/src/phone/rpc.rs`, wire names `bots.*`): `list`
  (every bot, Needs you across them, and each bot's current work and next
  duty run), `home` and `items` (one bot's record, list, chats, duties and
  role, read only: reading never makes a chat), and `answer`, `pause`,
  `resume`, `pauseAll`. The window passes them to the runtime's paired-phone
  call (`local_runtime/mobile.rs`, operation `bots`), which admits the phone
  by its device record, and the four that act only for a phone allowed to
  drive. `src-tauri/src/bots/phone.rs` then calls the bots' own routes:
  `answer` is `itemAnswer`, as the app's Needs you answers, so the answer is
  the owner's and reaches the bot's home chat the same way. A bot's session
  holds no device connection, so it cannot reach these.
- **A question** is answered by its index or in words, with the question's
  id it was shown, so an answer to a question that has since changed is
  refused ("no longer asks this") rather than given to the new one.
- **Notifications.** Each new Needs you question on a bot's item, asked
  while the phone is subscribed, is sent once as a `bot_question` notice with
  the bot, the item, the question's id and answers, and the bot's home chat
  as its session. It shows under the Questions choice and is not held back by
  "Sessions I started or follow", which is about sessions. Its buttons (up
  to four answers, the recommended one first) answer through `bots.answer`;
  a tap opens the question as a sheet over the home chat. An older phone
  that does not know the kind opens that chat. An agent's own question in a
  bot's session is already sent as an ordinary question.
- **Not on the phone.** Editing duties, the role or a bot's settings, and
  hiring, stay on the Mac; the design's organisation switcher and search wait
  for PRO-483.

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
| PRO-472 | Wake a duty on GitHub and Linear events, another bot, or a change | 23.05 | In review |
| PRO-473 | Week calendar of duties | 23.13 | In review |
| PRO-474 | Pause and Pause all that say what they stopped | 23.12 | In review |
| PRO-475 | Hand-offs, the reporting line and the team brief | 23.01, 23.04, 23.09 | In review |
| PRO-476 | A bot plans and starts orchestration runs | 23.01, 23.04, 23.09 | In review |
| PRO-477 | Look around, suggestions, nightly memory tidy | 23.01 | In review |
| PRO-479 | Bots on the phone: Bots tab, Needs you, answer from a notification | 23.08 | In review |
| PRO-480 | GitHub and Linear as channels | 23.07 | In review |
| PRO-481 | Slack and Telegram or WhatsApp as channels | 23.04, 23.07 | In review |
| PRO-482 | A bot that lives on a cloud workspace and stays on | n/a | Backlog (waits for the Cloud VM work) |
| PRO-483 | One bot across several organisations | 23.02, 23.06, 23.07 | Backlog |
| PRO-489 | Hardening left over from reviews | n/a | In review |

## Not in this epic

- The Cloud VM platform itself. PRO-482 only puts a bot on it.
- A public marketplace for bots.
