# Orchestration benchmark

PRO-283. A harness that compares four ways of running a task on score and
cost, over about 20 real tasks from this repository's history. Each task has
an automatic outcome check. The runner records one result per task and
arrangement. The report names a winner for each task shape.

This page fixes the formats every part of the benchmark builds to. Read it
before you write a task, the runner or the report. The code that enforces it
is `scripts/orchestration-bench/schema.mjs` (formats) and
`scripts/orchestration-bench/tasks.mjs` (loading).

## The command

```sh
node scripts/orchestration-bench/cli.mjs <subcommand> [options]
pnpm bench:orchestration <subcommand> [options]
```

| Subcommand   | Module          | What it does                                                        |
| ------------ | --------------- | ------------------------------------------------------------------- |
| `check-task` | `check-task.mjs` | Proves each task's check fails at `startCommit` and passes at the solution. |
| `run`        | `run.mjs`        | Runs tasks under arrangements and appends one result line per run.  |
| `report`     | `report.mjs`     | Reads results and names a winner per task shape.                    |

`--help` lists them; `<subcommand> --help` shows a subcommand's options.

Each subcommand is a module in `scripts/orchestration-bench/` that exports:

```js
export async function main(argv, io) { /* ... */ return 0; }
```

- `argv` is the arguments after the subcommand name.
- `io` is `{ stdout, stderr, cwd, env }`. Write with `io.stdout.write(text)`;
  resolve relative paths against `io.cwd`, not `process.cwd()`.
- The return value is the exit code, a whole number. Do not call
  `process.exit`.

`cli.mjs` loads `run.mjs` and `report.mjs` only when they are asked for. Until
a module exists, the command says `'run' is not built yet` and exits 1.

## Shapes and arrangements

Shapes, the kinds of task:

- `search`: find and report something in the code; little or no editing.
- `feature`: a bounded change with tests.
- `chain`: several dependent steps, where one step's output feeds the next.

Arrangements, the ways of running a task:

| Name                | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `top-single`        | One session on the top-tier model.                        |
| `large-single`      | One session on the large-tier model.                      |
| `lead-mid-workers`  | A lead session that hands pieces to mid-tier workers.     |
| `lead-low-escalate` | A lead with low-effort workers that escalate when stuck.  |

Tiers are the ones in `src-tauri/src/orchestration/routing.rs` (`small`,
`mid`, `large`, `top`). Use these exact strings; the validators reject any
other.

## Task file

One JSON file per task at `bench/orchestration/tasks/<shape>/<id>.json`. The
folder must match `shape` and the file name must be the `id`. Ids are unique
across all shapes.

```json
{
  "id": "session-cost-total",
  "shape": "feature",
  "title": "Show a session's total cost",
  "prompt": "The session header shows tokens but no cost. ...",
  "startCommit": "0123456789abcdef0123456789abcdef01234567",
  "solution": "89abcdef0123456789abcdef0123456789abcdef",
  "check": {
    "run": "pnpm exec vitest run src/lib/sessionCost.test.ts",
    "timeoutSeconds": 300,
    "files": ["src/lib/sessionCost.test.ts"]
  },
  "source": { "pr": 812, "commit": "89abcdef0123" }
}
```

| Field                  | Required | Meaning |
| ---------------------- | -------- | ------- |
| `id`                   | yes      | Lowercase letters, digits and dashes, up to 80 long. |
| `shape`                | yes      | `search`, `feature` or `chain`. |
| `title`                | yes      | One line for the report. |
| `prompt`               | yes      | What the agent is told. Everything it gets about the task. |
| `startCommit`          | yes      | Full 40-character sha the agent starts from. |
| `solution`             | yes      | A full commit sha whose tree is a correct answer, or a patch file path (`.patch` or `.diff`) relative to the task's folder, which applies to `startCommit` with `git apply`. |
| `check.run`            | yes      | A shell command run with `/bin/sh -c` at the worktree root. Exit 0 means solved. |
| `check.timeoutSeconds` | yes      | Whole seconds, 1 to 7200. On timeout the command's whole process group is killed and the check fails. |
| `check.files`          | yes      | Paths (relative, forward slashes) copied from the solution into the worktree right before the check runs. This is how the agent never sees the tests. May be empty. |
| `check.install`        | no       | `false` skips `pnpm install` for checks that need no dependencies, such as a `grep`. Default `true`. |
| `source`               | yes      | Where the task came from: `{ "commit": "<sha, 7 to 40>" }`, `{ "pr": <number> }` or both. |
| `notes`                | no       | Free text for people reading the task. |

No other fields are allowed.

Rules for task authors:

- The repository is public. No secrets, no home folder paths (the validator
  rejects `/Users/<name>` and `/home/<name>` in `title`, `prompt`, `notes` and
  `check.run`) and no one's private details.
- The check must fail at `startCommit` with the check files copied in, and pass
  at the solution. A check that times out at `startCommit` is rejected: it
  must fail on its own, not hang.
- Keep checks narrow and fast. A check that builds Rust pays for a fresh build
  in a clean worktree (minutes) and must say so in its timeout. Nothing in the
  harness builds Rust for you.
- `check.files` must not be files the agent is expected to write. They are
  overwritten with the solution's copy before the check runs.

## Result record

The runner appends one JSON object per line, one line per run of a task under
an arrangement. Use `formatResultLine(record)` from `schema.mjs` to write a
line (it throws on an invalid record) and `parseResultLines(text)` to read a
file (it returns `{ results, problems }`, with problems by line number).

```json
{"taskId":"session-cost-total","shape":"feature","arrangement":"lead-mid-workers","passed":true,"costUsd":1.25,"tokens":{"input":1200,"output":340,"cacheRead":50000,"cacheWrite":2000},"wallSeconds":412.5,"attempts":1,"sessionIds":["4f0c2a","9b1d77"],"startedAt":"2026-11-12T09:30:00Z"}
```

| Field         | Type | Meaning |
| ------------- | ---- | ------- |
| `taskId`      | string | The task's `id`. |
| `shape`       | string | The task's `shape`, copied so the report needs no task files. |
| `arrangement` | string | One of the four arrangement names. |
| `passed`      | boolean | The task's check exited 0 after the run. |
| `costUsd`     | number ≥ 0 | Dollars across every session in the run. |
| `tokens`      | object | `input`, `output`, `cacheRead`, `cacheWrite`: whole numbers summed over every session. Write 0 for a kind the agent does not report. |
| `wallSeconds` | number ≥ 0 | From the first session's start to the check's end. |
| `attempts`    | whole number ≥ 1 | How many times the run was started for this record (1 unless the runner retried). |
| `sessionIds`  | string[] | Every session the run used, lead first. |
| `startedAt`   | string | ISO 8601 time with a zone, such as `2026-11-12T09:30:00Z`. |
| `error`       | string, optional | Why a run did not finish normally (a timeout, a session that crashed). `passed` is then `false`. |

No other fields are allowed.

## check-task

```sh
node scripts/orchestration-bench/cli.mjs check-task [--shape s] [--min n] [--task id,...]
  [--tasks dir] [--repo dir] [--work-dir dir] [--install-timeout seconds]
```

It reads every task file and stops with exit 1 when any is invalid, listing
every problem. Then, for each selected task:

1. `git worktree add --detach` at `startCommit`, in a new folder under the
   work folder.
2. `pnpm install --frozen-lockfile --prefer-offline`, unless `check.install`
   is `false` or the commit has no `pnpm-lock.yaml`.
3. Copy `check.files` from the solution; run `check.run`. It must fail.
4. Reset the worktree, check out the solution (reinstall only when the
   lockfile changed), copy `check.files` again, run `check.run`. It must pass.
5. Remove the worktree, whatever happened.

It prints how long the install and each check took. It exits 1 when any task
fails or when fewer than `--min` tasks (default 1) are selected.

To check only the task you are writing:

```sh
pnpm bench:orchestration check-task --task session-cost-total
```

## Worktrees and dependencies

`scripts/orchestration-bench/worktree.mjs` is shared by `check-task` and the
runner:

- `withWorktree({ repo, commit, label, workRoot, install, installTimeoutSeconds }, fn)`
  opens a clean worktree, passes it to `fn` and always removes it.
- `moveWorktree(worktree, commit)` moves it to another commit.
- `copyCheckFiles(worktree, commit, files)` writes the check files from a
  commit, with their file modes.
- `runCommand(command, { cwd, timeoutSeconds })` runs a shell command with a
  hard timeout and returns `{ exitCode, signal, timedOut, seconds, output }`.
- `solutionCommit(repo, task)` turns a task's solution, sha or patch, into a
  commit; a patch becomes a commit object made in a private index, without
  touching any checkout.

The work folder defaults to `$TMPDIR/terminalx-orchestration-bench`
(`worktrees/` and `node-modules/` inside it). When a worktree closes, its
`node_modules` folders are moved into `node-modules/<sha256 of pnpm-lock.yaml>`.
The next worktree with the same lockfile moves them back and runs the same
install, which then finishes in about a second instead of a full install.
Two cached lockfiles are kept; older ones are deleted.
