// `check-task`: proves every benchmark task can tell a solved task from an
// unsolved one (docs/ORCHESTRATION-BENCH.md).
//
// For each task: a clean worktree at startCommit, the check files copied in
// from the solution, the check run and required to FAIL; then the worktree
// moved to the solution, the check files copied in again, the check run and
// required to PASS. A check that runs out of time counts as neither: a task
// whose check hangs is broken.
//
//   node scripts/orchestration-bench/cli.mjs check-task [--shape s] [--min n] [--task id,...]
//     [--tasks dir] [--repo dir] [--work-dir dir] [--install-timeout seconds]

import { resolve } from "node:path";
import { SHAPES } from "./schema.mjs";
import { TASKS_DIR, loadTasks } from "./tasks.mjs";
import { INSTALL_TIMEOUT_SECONDS, commitExists, copyCheckFiles, defaultWorkRoot, moveWorktree, repoRoot, runCommand, solutionCommit, withWorktree } from "./worktree.mjs";

export const USAGE = `check-task [--shape ${SHAPES.join("|")}] [--min n] [--task id,...] [--tasks dir] [--repo dir] [--work-dir dir] [--install-timeout seconds]

  Loads every task and, for each one selected, runs its check in a clean
  worktree at startCommit (it must fail) and at the solution (it must pass).
  Exits 1 when a task file is invalid, a check gives the wrong answer or
  times out, or fewer than --min tasks are selected (default 1).

  --shape s             only tasks of this shape
  --min n               require at least n selected tasks
  --task id,...         only these tasks
  --tasks dir           task folder (default <repo>/${TASKS_DIR})
  --repo dir            repository the commits are in (default: the one around the current folder)
  --work-dir dir        where worktrees and the dependency cache go (default ${"$"}TMPDIR/terminalx-orchestration-bench)
  --install-timeout s   longest a pnpm install may take (default ${INSTALL_TIMEOUT_SECONDS})`;

function parseArgs(argv) {
  const options = { min: 1, installTimeoutSeconds: INSTALL_TIMEOUT_SECONDS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    const count = (text) => {
      if (!/^\d+$/.test(text)) throw new Error(`${flag} needs a whole number, not ${text}`);
      return Number(text);
    };
    switch (flag) {
      case "--shape": options.shape = value(); break;
      case "--min": options.min = count(value()); break;
      case "--task": options.ids = value().split(",").filter(Boolean); break;
      case "--tasks": options.tasks = value(); break;
      case "--repo": options.repo = value(); break;
      case "--work-dir": options.workRoot = value(); break;
      case "--install-timeout": options.installTimeoutSeconds = count(value()); break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  if (options.shape !== undefined && !SHAPES.includes(options.shape)) throw new Error(`--shape must be one of ${SHAPES.join(", ")}`);
  if (options.installTimeoutSeconds < 1) throw new Error("--install-timeout must be at least 1");
  return options;
}

const seconds = (value) => `${value.toFixed(1)} s`;
const exitText = (result) => (result.exitCode === null ? `signal ${result.signal ?? "?"}` : `exit ${result.exitCode}`);
const indent = (text) => text.trimEnd().split("\n").slice(-40).map((line) => `      ${line}`).join("\n");

/** Checks one task. Returns the problems found; empty when the task is good. */
async function checkOne(task, { repo, workRoot, installTimeoutSeconds }, say) {
  if (!commitExists(repo, task.startCommit)) return [`startCommit ${task.startCommit} is not in this repository`];
  let solution;
  try {
    solution = solutionCommit(repo, task);
  } catch (error) {
    return [error.message];
  }
  const install = task.check.install !== false;
  const problems = [];
  const started = Date.now();
  await withWorktree({ repo, commit: task.startCommit, label: task.id, workRoot, install, installTimeoutSeconds }, async (worktree) => {
    if (worktree.install !== "none") say(`    dependencies: ${worktree.install === "reused" ? "reused the cached tree" : "installed"} in ${seconds(worktree.installSeconds)}`);

    copyCheckFiles(worktree, solution, task.check.files);
    const before = await runCommand(task.check.run, { cwd: worktree.dir, timeoutSeconds: task.check.timeoutSeconds });
    if (before.timedOut) problems.push(`at startCommit the check timed out after ${task.check.timeoutSeconds} s; it must fail on its own, not hang`);
    else if (before.exitCode === 0) problems.push("at startCommit the check passed; it must fail before the task is done");
    say(`    at startCommit: ${before.timedOut ? "timed out" : before.exitCode === 0 ? "passed (wrong)" : `failed as required (${exitText(before)})`} in ${seconds(before.seconds)}`);
    if (problems.length && before.output.trim()) say(indent(before.output));

    const reinstall = await moveWorktree(worktree, solution, { install });
    if (reinstall) say(`    dependencies: the solution changes the lockfile; reinstalled in ${seconds(reinstall)}`);
    copyCheckFiles(worktree, solution, task.check.files);
    const after = await runCommand(task.check.run, { cwd: worktree.dir, timeoutSeconds: task.check.timeoutSeconds });
    if (after.timedOut) problems.push(`at the solution the check timed out after ${task.check.timeoutSeconds} s`);
    else if (after.exitCode !== 0) problems.push(`at the solution the check failed (${exitText(after)}); it must pass once the task is done`);
    say(`    at the solution: ${after.timedOut ? "timed out" : after.exitCode === 0 ? "passed as required" : `failed (wrong, ${exitText(after)})`} in ${seconds(after.seconds)}`);
    if ((after.timedOut || after.exitCode !== 0) && after.output.trim()) say(indent(after.output));
  });
  say(`    took ${seconds((Date.now() - started) / 1000)} in all`);
  return problems;
}

/** Entry point; returns the exit code. */
export async function main(argv, io) {
  const say = (line) => io.stdout.write(`${line}\n`);
  const complain = (line) => io.stderr.write(`${line}\n`);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    complain(`check-task: ${error.message}`);
    complain(USAGE);
    return 2;
  }
  if (options.help) {
    say(USAGE);
    return 0;
  }

  let repo;
  try {
    repo = repoRoot(resolve(io.cwd, options.repo ?? "."));
  } catch (error) {
    complain(`check-task: not in a git repository (${error.message})`);
    return 1;
  }
  const tasksDir = resolve(io.cwd, options.tasks ?? resolve(repo, TASKS_DIR));
  const { tasks: loaded, problems } = loadTasks(tasksDir, { shape: options.shape });
  if (problems.length) {
    complain(`check-task: ${problems.length} problem${problems.length === 1 ? "" : "s"} in the task files:`);
    for (const problem of problems) complain(`  ${problem}`);
    return 1;
  }
  let tasks = loaded;
  if (options.ids) {
    const missing = options.ids.filter((id) => !loaded.some((task) => task.id === id));
    if (missing.length) {
      complain(`check-task: no task ${missing.join(", ")}${options.shape ? ` of shape ${options.shape}` : ""}`);
      return 1;
    }
    tasks = loaded.filter((task) => options.ids.includes(task.id));
  }
  const selection = options.shape ? `${options.shape} task` : "task";
  if (tasks.length < options.min) {
    complain(`check-task: ${tasks.length} ${selection}${tasks.length === 1 ? "" : "s"} in ${tasksDir}, fewer than --min ${options.min}`);
    return 1;
  }

  const settings = { repo, workRoot: resolve(io.cwd, options.workRoot ?? defaultWorkRoot()), installTimeoutSeconds: options.installTimeoutSeconds };
  const failed = [];
  for (const task of tasks) {
    say(`${task.shape}/${task.id}: ${task.title}`);
    let found;
    try {
      found = await checkOne(task, settings, say);
    } catch (error) {
      found = [error.message];
    }
    for (const problem of found) say(`    PROBLEM: ${problem}`);
    say(`    ${found.length ? "FAIL" : "ok"}`);
    if (found.length) failed.push(task.id);
  }
  if (failed.length) {
    complain(`check-task: ${failed.length} of ${tasks.length} ${selection}s failed: ${failed.join(", ")}`);
    return 1;
  }
  say(`check-task: all ${tasks.length} ${selection}${tasks.length === 1 ? "" : "s"} fail at startCommit and pass at the solution`);
  return 0;
}
