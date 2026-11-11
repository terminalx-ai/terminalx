# TerminalX orchestrator

This guide is served by `terminalx skills get terminalx-orchestrator`.

How a lead session decides whether to split a task, cuts it, briefs workers, and checks what
comes back. The commands are in `terminalx skills get terminalx-cli` (sections "Worker reports"
and "Orchestration runs"); this guide says when and how to use them. It names no models: read the
model routing table and the escalation ladder where the person keeps them (for example
`~/.claude/reference/claude-model-selection.md`), and where there are none leave `model` and
`effort` out so each agent uses its own defaults.

Without this discipline a lead splits work that should stay in one session, writes briefs so
vague that workers duplicate each other, and trusts reports it should check.

## 1. The gate

Split only when all three hold:

1. At least two pieces do not need each other's output.
2. Each piece has its own done-check: a command, or a condition someone can look at.
3. The work would not fit in your context.

If any fails, work in one session, and say which one failed in a line to the person ("each step
needs the previous one's result, so I am doing it here"). A split of one or two small pieces
costs more than doing the work. A chain where each step needs the one before it is not a split:
the workers would only wait.

## 2. How many pieces

- A simple fact or one lookup: one piece, or no worker at all.
- A comparison, or two or three angles on one question: two to four pieces.
- Wide work, such as the same change across many modules: more, in slices that do not share files.
- Three to five workers at once is the usual ceiling. Past it, your reading of the reports
  becomes the bottleneck. The person's piece limit is a hard cap, set in Settings →
  Orchestrator; merge pieces rather than splitting into two runs.

Stages count: pieces that `dependsOn` another do not run together, so a plan of eight pieces in
three stages holds at most three workers at a time.

## 3. How to cut

- One owner per file. List what a piece changes in `owns`; two pieces that own the same path are
  refused (`shared_file`). A change that touches a shared file is either its own piece that the
  others depend on, or it stays with you (section 8).
- Each piece is self-contained: a worker knows nothing of your conversation. It has a clear
  deliverable it can finish and check by itself.
- Cut along the seams that already exist: modules, packages, commands, test files. Do not cut
  through a function.
- An unclear bug is not cut by area. Give each worker a competing hypothesis and the same
  evidence, and ask each to find the one fact that would prove or kill it.
- A piece that changes nothing (a search, a review, a measurement) owns no files and reports
  what it found.

## 4. The brief

A worker starts cold. The plan's piece fields become its brief, so write each one for a stranger:

- `goal`: what is true when it is done.
- `why`: what the result is for; it lets the worker make small decisions without asking.
- `scope` and `outOfScope`: where to work and what to leave alone.
- `known`: facts you have, and what has already been ruled out, so it does not walk the same
  path again.
- `readFirst`: the files to read first. Name paths; do not paste their contents.
- `doneChecks`: below.
- `limits`: what it must not do or change.
- The report format is added for you; workers end with a `terminalx-report` block.

Keep a brief short: a few lines a field, and no field restating another. A long brief is read
once and half-forgotten.

**Write a `command` done-check wherever a test, build, linter, type check or search exists**
(`{"type": "command", "run": "cd src-tauri && cargo t store::settings"}`). TerminalX runs it
itself from the root of the worker's worktree and passes on exit code 0, so it costs no model
call. Every piece needs one, or `"reviewOnly": true` with a `reviewOnlyReason` saying why no
command can prove it (a search, a review). Add a `review` check only for what no command shows,
such as a property of the diff; the reviewer sees the diff and your words, not the worker's
reasoning. A `vote` check (several reviewers judging separately) is for a high-cost claim only.

**A verifier gets the material, not your conclusion.** To check a claim, hand the verifier the
claim's inputs (the files, the logs, the commands) and ask what is true. A verifier told "confirm
that X is the cause" tends to confirm it.

## 5. The plan file

The plan is the JSON `runs create` reads; the field-by-field description is in the CLI guide.
One worked example: moving settings reads onto a typed store, where three call-site pieces wait on
the store.

```json
{
  "goal": "Move settings reads to the typed store",
  "pieces": [
    {
      "id": "store",
      "title": "Typed store module",
      "goal": "A typed settings store every reader can use, with the existing keys.",
      "why": "The call-site pieces need its API.",
      "scope": "The store module and its tests.",
      "outOfScope": "Call sites outside the store.",
      "known": ["41 call sites read settings directly today.", "Unknown keys must survive a save."],
      "readFirst": ["docs/SETTINGS.md"],
      "limits": ["Do not change the settings file format."],
      "owns": ["src-tauri/src/store/settings/"],
      "dependsOn": [],
      "doneChecks": [{"type": "command", "run": "cd src-tauri && cargo t store::settings"}],
      "kind": "code"
    },
    {
      "id": "sessions-reads",
      "title": "Session code reads settings through the store",
      "goal": "No direct settings reads left in the session module.",
      "why": "Part of the move; the store is done first.",
      "scope": "src-tauri/src/session/ only.",
      "known": ["The store exposes typed getters; read its public items first."],
      "readFirst": ["src-tauri/src/store/settings/mod.rs"],
      "owns": ["src-tauri/src/session/"],
      "dependsOn": ["store"],
      "doneChecks": [
        {"type": "command", "run": "cd src-tauri && cargo t session::"},
        {"type": "command", "run": "! grep -rq read_settings src-tauri/src/session"}
      ],
      "kind": "code"
    },
    {
      "id": "ui-reads",
      "title": "UI code reads settings through the store",
      "goal": "No direct settings reads left under src/lib.",
      "why": "Part of the move; the store is done first.",
      "scope": "src/lib/ only.",
      "readFirst": ["src-tauri/src/store/settings/mod.rs"],
      "owns": ["src/lib/"],
      "dependsOn": ["store"],
      "doneChecks": [{"type": "command", "run": "pnpm vitest run src/lib"}],
      "kind": "code"
    },
    {
      "id": "survey",
      "title": "Find readers outside both areas",
      "goal": "A list of every remaining direct settings read outside src-tauri/src/session and src/lib, as file:line.",
      "why": "Decides whether a second run is needed.",
      "scope": "Read-only search of the repository.",
      "dependsOn": [],
      "doneChecks": [{"type": "review", "text": "The report lists each read as file:line and says which directories it searched."}],
      "reviewOnly": true,
      "reviewOnlyReason": "A read-only search: no command proves it found everything.",
      "kind": "search"
    }
  ]
}
```

Notes on the example: only the two call-site pieces depend on `store`; the survey owns nothing
and starts with it; `model`, `effort` and `permissionMode` are left out, so the agents' defaults
and the project's mode apply. Add them only on a reason, taken from the routing table and the
escalation ladder. A piece that reads text from outside the repository (issues, web pages, logs
from elsewhere) sets `readsUntrusted`.

Then:

```text
terminalx runs create --from plan.json --json
terminalx runs start --json
```

By default the person approves the plan first. `runs start` is then refused with
`awaiting_approval`: tell the person the plan is ready and end your turn. You are sent a message
when they decide. Do not edit Settings → Orchestrator to get a plan accepted.

## 6. Waiting, and reading reports

Never poll. Start the workers, then wait on them with one command and read what comes back:

```text
terminalx wait --children-of <your session> --any --json
terminalx sessions report --children-of <your session> --json
terminalx runs start --json
```

Work that needs no worker's output may go on between the commands. Nothing needs you to look at a
worker's tab or transcript to find out whether it finished.

Read each report in this order, and stop at the first step that settles it:

1. **Route on the `status` line.** `done` goes to step 2. `partial` or `blocked`: read `notDone`
   and `result`, then `send` the worker what it lacks, or take the rest into your own work.
   `failed`: read `result` and `evidence`; send a correction or stop the piece. `missing`: read
   its `reason` and `tail`, do not treat it as done and do not treat it as failed.
2. **Check the evidence.** A `done` report is a claim. Re-run the piece's done-check command
   yourself, or read the `file:line` it cites. Prefer a command or a value TerminalX computes
   (`runs show`, a test's exit code) over asking a model for its opinion. `noEvidence: true`
   means nothing was shown at all.
3. **Read `couldNotRead` as a gap.** A source the worker could not read is not "nothing found". The
   conclusion is unsupported until someone reads it: do so, or send the piece to another worker.
4. **Read `uncertain` and `notDone`.** These are the places the work is weakest. A cheap check
   there pays more than a thorough one elsewhere.

## 7. When reports disagree

Do not pick the more confident one, the longer one, or the one that arrived first. Find the one
observable fact the two reports predict differently (a value, a line, an exit code, whether a
file exists) and check it yourself or hand it to a single worker as a question with no
conclusion attached. Say which fact decided it when you report to the person.

## 8. What stays with you

- Edits that span pieces: anything that touches files two pieces own.
- Judgment calls: which approach, what to drop, what the person should decide.
- Merging. A worker's branch is collected by you (`git merge <its branch>` in your worktree),
  after you have read its report. Workers never push, merge, deploy or open a pull request.
- Anything pushed or shared with other people. A worker's output is a draft until you have
  checked it.

## 9. Keeping your context lean

Workers read the long material; you read their reports. Ask for references, not content: a
worker returns `file:line` and a path to a file it wrote, not a pasted log or a copied function.
Read the transcript of a worker (`terminalx read <tab> --since <seq>`) only when a report is
`missing` or does not add up. If you need a worker's long result, have it write that to a file in
its worktree and name the file in `evidence`.

## Checklist

Before `runs create`: the gate holds and is said in a line; no two pieces own a path; every piece
has a `command` done-check, or `reviewOnly` with a reason; briefs are short and name files to
read; the piece count is within the usual ceiling.

After the workers report: every `done` was checked; every `couldNotRead` was followed up;
disagreements were settled by a fact; you hold every edit that spans pieces; you merged and
nothing was pushed except by you.
