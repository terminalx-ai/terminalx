// `run`: one task under one arrangement, recorded with what it cost
// (docs/ORCHESTRATION-BENCH.md).
//
//   node scripts/orchestration-bench/cli.mjs run --task <id> --arrangement <name> [--repeat n]
//     [--budget-dollars n] [--cap-dollars n] [--out file] [--dry-run]
//   node scripts/orchestration-bench/cli.mjs run --all --budget-dollars n [...]
//
// Each run is a session of its own, started with the terminalx CLI in a new
// TerminalX worktree of the attached project, so no two runs share a
// conversation or a prompt cache. The steps, the same for all four
// arrangements:
//
//  1. `sessions create` with a one-word warm-up prompt, on the arrangement's
//     model, in bypassPermissions mode, recorded with no parent.
//  2. Wait for the warm-up turn; move the session's worktree (and branch) to
//     the task's startCommit; install dependencies; read usage as the
//     baseline. A new worktree starts at the default branch, and the CLI has
//     no flag for another base, so the move happens while the agent is idle.
//  3. `send` the task. Wait in short slices, reading usage after each: a run
//     whose cost since the baseline reaches its cap is stopped there. A lead
//     is done when its turn has ended and no run it leads is under way.
//  4. Stop the lead's runs and workers; read usage a last time.
//  5. Copy the task's check.files from the solution into the worktree, run
//     check.run there, and append the result line.
//  6. Delete every worktree the run used (workers' first, then the
//     session's), naming exactly the sessions the run started, and their
//     branches. Deleting the session's worktree is also what stops a single
//     session that hit its cap: the CLI stops a lead's workers, not a session.
//
// `--dry-run` prints those commands, with the real arguments, and starts nothing.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { ROUTING_FILE, WARM_UP_PROMPT, loadRouting, resolveArrangement, taskPrompt } from "./arrangements.mjs";
import { ARRANGEMENTS, formatResultLine } from "./schema.mjs";
import { TASKS_DIR, loadTasks } from "./tasks.mjs";
import { CliError, NO_USAGE, parseUsage, roundCents, unknownCost, unwrap, usageSince } from "./usage.mjs";
import { INSTALL_TIMEOUT_SECONDS, commitExists, copyCheckFiles, git, repoRoot, runCommand, solutionCommit } from "./worktree.mjs";

/** The cap on one run when the command names none, in dollars at API list prices. */
export const DEFAULT_CAP_DOLLARS = 10;
/** How long one `wait` slice lasts; usage is read, and the cap checked, after each. */
export const DEFAULT_POLL_SECONDS = 30;
/** How long a run may take before the runner stops it. */
export const DEFAULT_TIMEOUT_MINUTES = 120;
/** How long the warm-up turn may take. */
const WARM_UP_SECONDS = 600;
/** Readings of usage that may fail in a row before the cap counts as unheld and the run is stopped. */
const MAX_UNREAD_USAGE = 5;
/** Run states in which a run is still under way (`terminalx runs show`). */
export const ACTIVE_RUN_STATES = new Set(["planned", "awaitingApproval", "running", "needsYou", "verifying", "merging"]);

const SHORT = { "top-single": "top", "large-single": "large", "lead-mid-workers": "lead-mid", "lead-low-escalate": "lead-low" };

export const HELP = `Usage: node scripts/orchestration-bench/cli.mjs run --task <id> --arrangement <name> [options]
       node scripts/orchestration-bench/cli.mjs run --all --budget-dollars <n> [options]

Runs a task in a new TerminalX session and worktree of its own, runs the task's
check there, and appends one result line per run. Every run costs real money
(or subscription usage): look at --dry-run first.

  --task <id>             the task to run (with --arrangement)
  --arrangement <name>    ${ARRANGEMENTS.join(", ")}
  --all                   every task under every arrangement; needs --budget-dollars
  --repeat <n>            run each task and arrangement n times (default 1)
  --budget-dollars <n>    stop starting runs once this command has spent n dollars
  --cap-dollars <n>       stop any one run at n dollars (default ${DEFAULT_CAP_DOLLARS}, and never more
                          than what is left of the budget)
  --out <file>            results file to append to (default bench/orchestration/results.jsonl)
  --dry-run               print every command a run would run, and start nothing
  --project <path>        the attached TerminalX project to start sessions in
                          (default: the main checkout of this repository)
  --tasks <dir>           task folder (default ${TASKS_DIR})
  --repo <dir>            repository the tasks' commits are in (default: this one)
  --agent <name>          claude (default; the only agent the runner can start)
  --poll-seconds <n>      wait slice between cost readings (default ${DEFAULT_POLL_SECONDS})
  --timeout-minutes <n>   stop a run after this long (default ${DEFAULT_TIMEOUT_MINUTES})

Arrangements (tiers from ${ROUTING_FILE}):
  top-single          one session on the top tier
  large-single        one session on the large tier
  lead-mid-workers    a top-tier lead that runs its pieces on mid-tier workers
  lead-low-escalate   a top-tier lead whose workers run at low effort, failed
                      pieces run again at high effort

Costs are terminalx's estimates at API list prices. A run is stopped at the
first reading at or over its cap, so it can go over by what one wait slice
spends. A lead run waits for the person to approve its plan unless the
project's Settings → Orchestrator turns approval off. Run it from an ordinary
shell, not from inside a run's worker.`;

/** A mistake in the command line: printed with the usage, exit 2. */
export class UsageError extends Error {}

const positive = (flag, value, { whole = false } = {}) => {
  const number = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(number) || number <= 0 || (whole && !Number.isInteger(number))) {
    throw new UsageError(`${flag} needs ${whole ? "a whole number" : "a number"} above 0`);
  }
  return number;
};

/** The command line as options. Throws UsageError. */
export function parseArgs(argv) {
  const options = {
    task: null,
    arrangement: null,
    all: false,
    repeat: 1,
    budgetDollars: null,
    capDollars: DEFAULT_CAP_DOLLARS,
    capGiven: false,
    out: null,
    dryRun: false,
    project: null,
    tasks: null,
    repo: null,
    agent: "claude",
    pollSeconds: DEFAULT_POLL_SECONDS,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    help: false,
  };
  const valued = {
    "--task": (value) => (options.task = value),
    "--arrangement": (value) => (options.arrangement = value),
    "--repeat": (value) => (options.repeat = positive("--repeat", value, { whole: true })),
    "--budget-dollars": (value) => (options.budgetDollars = positive("--budget-dollars", value)),
    "--cap-dollars": (value) => {
      options.capDollars = positive("--cap-dollars", value);
      options.capGiven = true;
    },
    "--out": (value) => (options.out = value),
    "--project": (value) => (options.project = value),
    "--tasks": (value) => (options.tasks = value),
    "--repo": (value) => (options.repo = value),
    "--agent": (value) => (options.agent = value),
    "--poll-seconds": (value) => (options.pollSeconds = positive("--poll-seconds", value, { whole: true })),
    "--timeout-minutes": (value) => (options.timeoutMinutes = positive("--timeout-minutes", value)),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg in valued) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      valued[arg](value);
      index += 1;
    } else throw new UsageError(`unknown option ${arg}`);
  }
  if (options.help) return options;
  if (options.all) {
    if (options.task || options.arrangement) throw new UsageError("--all runs every task under every arrangement; leave out --task and --arrangement");
    if (options.budgetDollars === null) throw new UsageError("--all needs --budget-dollars: running every task costs real money, and the runner holds a total");
  } else {
    if (!options.task || !options.arrangement) throw new UsageError("name --task and --arrangement, or use --all");
    if (!ARRANGEMENTS.includes(options.arrangement)) throw new UsageError(`unknown arrangement ${options.arrangement}; one of ${ARRANGEMENTS.join(", ")}`);
  }
  return options;
}

/** Every run the options ask for, in order: each task under each arrangement, `repeat` times. */
export function planRuns(tasks, arrangements, repeat) {
  const runs = [];
  for (const task of tasks) {
    for (const arrangement of arrangements) {
      for (let round = 1; round <= repeat; round += 1) runs.push({ task, arrangement, round, of: repeat });
    }
  }
  return runs;
}

/**
 * The dollars a command may spend. `total` is the budget (null: none, a
 * single task); each run gets the cap or what is left, whichever is less.
 */
export class Budget {
  constructor(total, cap) {
    this.total = total;
    this.cap = cap;
    this.spent = 0;
  }

  /** Dollars left; Infinity without a total. */
  remaining() {
    return this.total === null ? Infinity : Math.max(0, roundCents(this.total - this.spent));
  }

  /** The cap for the next run, or 0 when nothing is left to start one with. */
  capForNext() {
    return Math.min(this.cap, this.remaining());
  }

  exhausted() {
    return this.capForNext() <= 0;
  }

  add(dollars) {
    if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`cannot count ${dollars} dollars`);
    this.spent = roundCents(this.spent + dollars);
  }
}

/** `text` quoted for a POSIX shell, so a printed command can be pasted as it is. */
export function shellQuote(text) {
  const value = String(text);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export const commandLine = (program, args) => [program, ...args].map(shellQuote).join(" ");

/** The terminalx arguments of each step. The dry run prints these; a real run passes them. */
export const cli = {
  create: ({ project, model, effort, title, name }) => [
    "sessions", "create", "--project", project, "--agent", "claude", "--prompt", WARM_UP_PROMPT, "--title", title, "--name", name,
    "--worktree", "--no-parent", "--model", model, ...(effort ? ["--effort", effort] : []), "--mode", "bypassPermissions", "--json",
  ],
  findCreated: ({ project, name }) => ["sessions", "list", "--worktree", name, "--project", project, "--json"],
  wait: (session, seconds) => ["wait", session, "--timeout", String(seconds), "--json"],
  send: (session, text) => ["send", session, text, "--json"],
  usage: (session, lead) => (lead ? ["sessions", "usage", "--children-of", session, "--json"] : ["sessions", "usage", session, "--json"]),
  runs: (session) => ["runs", "list", "--lead", session, "--all", "--json"],
  stopRun: (run) => ["runs", "stop", run, "--json"],
  stopWorkers: (session) => ["sessions", "stop", "--children-of", session, "--json"],
  workers: (session) => ["sessions", "list", "--children-of", session, "--json"],
  previewDelete: (path, project) => ["worktrees", "delete", path, "--project", project, "--dry-run", "--json"],
  delete: (path, project, sessions) => ["worktrees", "delete", path, "--project", project, "--yes", "--sessions", sessions.join(","), "--force", "--json"],
};

/** A worktree name for a run: the slug rules allow 40 characters. */
export function worktreeName(arrangement, random = randomBytes(3).toString("hex")) {
  return `bench-${SHORT[arrangement]}-${random}`;
}

export const sessionTitle = ({ task, arrangement, round, of }) => `Bench: ${task.id} under ${arrangement}${of > 1 ? ` (${round} of ${of})` : ""}`;

/**
 * Every command one run would run, as lines to print, in the order it runs
 * them. Values a real run only learns from an answer are shown as
 * `<session>`, `<worktree>`, `<run>` and `<sessions>`.
 */
export function describeRun(run, { project, cap, out, pollSeconds, timeoutMinutes, arrangement, name }) {
  const { task } = run;
  const T = (args) => commandLine("terminalx", args);
  const lead = arrangement.lead;
  const steps = [
    T(cli.create({ project, model: arrangement.model, effort: arrangement.effort, title: sessionTitle(run), name })),
    `${T(cli.wait("<session>", WARM_UP_SECONDS))}   # the warm-up turn`,
    `${commandLine("git", ["-C", "<worktree>", "reset", "--hard", "--quiet", task.startCommit])} && ${commandLine("git", ["-C", "<worktree>", "clean", "-fdq"])}`,
    task.check.install === false ? "# no dependency install: the task's check.install is false" : `(cd <worktree> && pnpm install --frozen-lockfile --prefer-offline)   # when the worktree has a pnpm-lock.yaml`,
    `${T(cli.usage("<session>", lead))}   # baseline, left out of the result`,
    T(cli.send("<session>", taskPrompt(task, arrangement))),
    `every ${pollSeconds} s, for up to ${timeoutMinutes} min, until ${lead ? "the lead's turn has ended and no run it leads is under way" : "the turn has ended"}, or $${cap.toFixed(2)} is spent:`,
    `  ${T(cli.wait("<session>", pollSeconds))}`,
    `  ${T(cli.usage("<session>", lead))}`,
  ];
  if (lead) {
    steps.push(`  ${T(cli.runs("<session>"))}`);
    steps.push(`${T(cli.stopRun("<run>"))}   # each run that has not ended`);
    steps.push(T(cli.stopWorkers("<session>")));
  }
  steps.push(`${T(cli.usage("<session>", lead))}   # final`);
  const files = task.check.files.length ? `copy ${task.check.files.join(", ")} from the solution (${task.solution}) into <worktree>` : "# no check files to copy";
  steps.push(files);
  steps.push(`(cd <worktree> && /bin/sh -c ${shellQuote(task.check.run)})   # the check, killed after ${task.check.timeoutSeconds} s`);
  if (lead) {
    steps.push(T(cli.workers("<session>")));
    steps.push(`for each worker's worktree: ${T(cli.previewDelete("<worker worktree>", project))}`);
    steps.push(`  ${T(cli.delete("<worker worktree>", project, ["<sessions>"]))}`);
  }
  steps.push(T(cli.previewDelete("<worktree>", project)));
  steps.push(T(cli.delete("<worktree>", project, ["<sessions>"])));
  steps.push(`${commandLine("git", ["branch", "-D", "<branch>"])}   # each branch the run's sessions were on`);
  steps.push(`append one result line to ${out}`);
  return steps;
}

/**
 * Which sessions a `worktrees delete --dry-run` answer would delete, when
 * every one of them is the run's own. Throws, naming the others, when the
 * worktree holds a session the run did not start: that worktree is left.
 */
export function sessionsToDelete(preview, own) {
  const listed = Array.isArray(preview?.sessions) ? preview.sessions : null;
  if (!listed) throw new Error("the deletion preview lists no sessions");
  const ids = listed.map((session) => session?.id).filter((id) => typeof id === "string" && id);
  const foreign = ids.filter((id) => !own.has(id));
  if (foreign.length) throw new Error(`it also holds sessions this run did not start (${foreign.join(", ")}), so it is left as it is`);
  return ids;
}

/** Moves a worktree, with its branch, to `commit`, leaving ignored files (node_modules); throws unless HEAD is then `commit`. */
export function moveToStart(dir, commit) {
  git(dir, ["reset", "--hard", "--quiet", commit]);
  git(dir, ["clean", "-fdq"]);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  if (head !== commit) throw new Error(`the worktree is at ${head}, not ${commit}`);
  const dirty = git(dir, ["status", "--porcelain"]).trim();
  if (dirty) throw new Error(`the worktree is not clean at ${commit.slice(0, 12)}:\n${dirty}`);
}

/**
 * The task's check on the work in `dir`: the check files written from the
 * solution (overwriting the agent's copies), then `check.run` with its
 * timeout. Returns `{ passed, exitCode, timedOut, seconds, output }`.
 */
export async function runCheck({ repo, dir, task, solution }) {
  copyCheckFiles({ repo, dir }, solution, task.check.files);
  const result = await runCommand(task.check.run, { cwd: dir, timeoutSeconds: task.check.timeoutSeconds });
  return { passed: result.exitCode === 0 && !result.timedOut, exitCode: result.exitCode, timedOut: result.timedOut, seconds: result.seconds, output: result.output };
}

/** The result line of one run, validated by formatResultLine when it is written. */
export function buildRecord({ task, arrangement, passed, usage, wallSeconds, startedAt, error }) {
  const record = {
    taskId: task.id,
    shape: task.shape,
    arrangement,
    passed: error ? false : passed,
    costUsd: roundCents(usage.costUsd, 6),
    tokens: { ...usage.tokens },
    wallSeconds: roundCents(wallSeconds, 3),
    attempts: 1,
    sessionIds: [...usage.sessionIds],
    startedAt,
  };
  if (error) record.error = error;
  return record;
}

/** Appends one result line to `file`, creating its folder. Throws, writing nothing, on an invalid record. */
export function appendRecord(file, record) {
  const line = formatResultLine(record);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line);
  return line;
}

/** The project a repository's sessions belong to: its main checkout, the folder of the common .git. */
export function mainCheckout(repo) {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return common.endsWith("/.git") ? dirname(common) : repoRoot(repo);
}

/** The terminalx executable, as the CLI guide picks it: on PATH, then tnx, then the app bundle. */
export function findTerminalx(env) {
  const folders = String(env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of ["terminalx", "tnx"]) {
    for (const folder of folders) if (existsSync(join(folder, name))) return join(folder, name);
  }
  const bundled = "/Applications/TerminalX.app/Contents/MacOS/terminalx";
  if (existsSync(bundled)) return bundled;
  throw new Error("no terminalx command: install it from TerminalX → Settings → General");
}

/** Runs one terminalx command and returns its result; throws CliError. */
function terminalx(bin, args, { env, timeoutSeconds = 120 }) {
  return new Promise((done, fail) => {
    execFile(bin, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutSeconds * 1000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (stdout && stdout.trim()) {
        try {
          done(unwrap(stdout));
        } catch (failure) {
          fail(failure);
        }
        return;
      }
      if (error) fail(new CliError(error.killed ? "timeout" : "failed", `terminalx ${args.slice(0, 2).join(" ")}: ${String(stderr || error.message).trim()}`));
      else fail(new CliError("unreadable", `terminalx ${args.slice(0, 2).join(" ")} printed nothing`));
    });
  });
}

const sleep = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000));
const money = (dollars) => `$${dollars.toFixed(2)}`;

/**
 * One run, for real: returns `{ record, spent, fatal }`. `record` is null when
 * nothing could be measured (the session never started); `spent` is every
 * dollar read, warm-up included; `fatal` stops a command that runs several.
 */
async function runOne(run, ctx) {
  const { io, bin, project, repo, cap, pollSeconds, timeoutMinutes, arrangement } = ctx;
  const say = (text) => io.stdout.write(`  ${text}\n`);
  const tx = (args, timeoutSeconds) => terminalx(bin, args, { env: io.env, timeoutSeconds });
  const lead = arrangement.lead;
  const name = worktreeName(arrangement.name);
  const solution = solutionCommit(repo, run.task);

  let session = null;
  let worktree = null;
  const branches = new Set();
  let baseline = NO_USAGE;
  let latest = null;
  let warmUpCost = 0;
  let error = null;
  let fatal = null;
  let passed = false;
  let startedAt = null;
  let sentAt = null;
  let checkEnd = null;
  const stopRequested = () => ctx.interrupted;

  const readUsage = async () => {
    const usage = parseUsage(await tx(cli.usage(session, lead)));
    const why = unknownCost(usage);
    if (why) {
      fatal = `the cost of ${session} cannot be read, so no cap can be held: ${why}`;
      throw new Error(fatal);
    }
    return usage;
  };

  try {
    try {
      const created = await tx(cli.create({ project, model: arrangement.model, effort: arrangement.effort, title: sessionTitle(run), name }), 180);
      session = created.sessionId;
      worktree = created.path;
      if (created.branch) branches.add(created.branch);
    } catch (failure) {
      // A create that timed out may have made the session all the same: find it to clean it up.
      if (failure instanceof CliError && failure.code === "timeout") {
        try {
          const found = await tx(cli.findCreated({ project, name }));
          const entry = (found.sessions ?? found ?? [])[0];
          if (entry?.id) {
            session = entry.id;
            worktree = entry.cwd ?? entry.path ?? null;
          }
        } catch {
          // Not found either: nothing to clean.
        }
      }
      throw new Error(`the session could not be started: ${failure.message}${session ? "" : ` (look for a worktree named ${name})`}`);
    }
    if (typeof session !== "string" || typeof worktree !== "string" || !existsSync(worktree)) throw new Error(`sessions create gave no session and worktree path (${JSON.stringify({ session, worktree })})`);
    say(`session ${session} in ${worktree}`);

    const warm = await tx(cli.wait(session, WARM_UP_SECONDS), WARM_UP_SECONDS + 60);
    if (warm.reason !== "stop" && warm.reason !== "stopped") throw new Error(`the warm-up turn did not end (${warm.reason}${warm.recovery ? `: ${warm.recovery}` : ""})`);
    moveToStart(worktree, run.task.startCommit);
    if (run.task.check.install !== false && existsSync(join(worktree, "pnpm-lock.yaml"))) {
      const install = await runCommand("pnpm install --frozen-lockfile --prefer-offline", { cwd: worktree, timeoutSeconds: INSTALL_TIMEOUT_SECONDS });
      if (install.exitCode !== 0 || install.timedOut) throw new Error(`pnpm install failed at the start commit:\n${install.output.slice(-2000)}`);
      say(`dependencies installed in ${install.seconds.toFixed(1)} s`);
    }
    baseline = await readUsage();
    warmUpCost = baseline.costUsd;
    latest = baseline;
    if (warmUpCost >= cap) throw new Error(`the warm-up alone cost ${money(warmUpCost)}, the run's whole cap`);

    startedAt = new Date().toISOString();
    sentAt = process.hrtime.bigint();
    await tx(cli.send(session, taskPrompt(run.task, arrangement)));
    say(`task sent to ${arrangement.model}; cap ${money(cap)}`);

    const deadline = Date.now() + timeoutMinutes * 60 * 1000;
    let unread = 0;
    let told = null;
    for (;;) {
      if (stopRequested()) throw new Error("interrupted");
      if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMinutes} min`);
      let waited = null;
      try {
        waited = await tx(cli.wait(session, pollSeconds), pollSeconds + 60);
      } catch (failure) {
        if (!(failure instanceof CliError) || failure.code !== "timeout") throw failure;
      }
      try {
        latest = await readUsage();
        unread = 0;
      } catch (failure) {
        if (fatal) throw failure;
        unread += 1;
        if (unread >= MAX_UNREAD_USAGE) {
          fatal = `usage could not be read ${unread} times in a row (${failure.message}), so the cap cannot be held`;
          throw new Error(fatal);
        }
      }
      const spent = usageSince(latest, baseline).costUsd;
      if (spent >= cap) throw new Error(`stopped at the cap: ${money(spent)} of ${money(cap)}`);
      const reason = waited?.reason;
      if (reason === "permission" || reason === "terminal") throw new Error(`the session waits on a person (${reason}); runs must need no one`);
      if (reason === "recovery") throw new Error(`the session stopped on an error (${waited.recovery ?? "unknown"})`);
      if (reason !== "stop" && reason !== "stopped") continue;
      if (!lead) break;
      const runs = (await tx(cli.runs(session))).runs ?? [];
      const active = runs.filter((entry) => ACTIVE_RUN_STATES.has(entry.state));
      if (!active.length) break;
      const state = active.map((entry) => `${entry.id} ${entry.state}`).join(", ");
      if (state !== told) {
        say(`the lead's turn ended while its run is under way (${state})${active.some((entry) => entry.state === "awaitingApproval") ? "; approve the plan in its Run view" : ""}`);
        told = state;
      }
      // The lead is settled, so a wait returns at once: sleep the slice instead.
      await sleep(pollSeconds);
    }
  } catch (failure) {
    error = failure.message;
  }

  // Stop everything the run started, then read what it all cost.
  if (session && lead) {
    try {
      const runs = (await tx(cli.runs(session))).runs ?? [];
      for (const entry of runs.filter((item) => ACTIVE_RUN_STATES.has(item.state))) await tx(cli.stopRun(entry.id));
      await tx(cli.stopWorkers(session));
    } catch (failure) {
      say(`could not stop the lead's runs and workers: ${failure.message}`);
    }
  }
  if (session && latest) {
    try {
      latest = await readUsage();
    } catch (failure) {
      say(`the last usage reading failed; the result counts the one before (${failure.message})`);
    }
  }

  if (session && worktree && !error) {
    try {
      const check = await runCheck({ repo, dir: worktree, task: run.task, solution });
      passed = check.passed;
      say(`check ${passed ? "passed" : `failed (${check.timedOut ? "timed out" : `exit ${check.exitCode}`})`} in ${check.seconds.toFixed(1)} s`);
    } catch (failure) {
      error = `the check could not be run: ${failure.message}`;
    }
  }
  checkEnd = process.hrtime.bigint();

  // Remove every worktree the run used, naming exactly its own sessions.
  if (session) {
    const own = new Set([session]);
    const worktrees = [];
    if (lead) {
      try {
        const listed = await tx(cli.workers(session));
        for (const worker of listed.workers ?? []) {
          own.add(worker.sessionId);
          if (worker.branch) branches.add(worker.branch);
          if (worker.worktree && worker.path && worker.path !== worktree && !worktrees.includes(worker.path)) worktrees.push(worker.path);
        }
      } catch (failure) {
        say(`could not list the lead's workers, so their worktrees are left: ${failure.message}`);
      }
    }
    if (worktree) worktrees.push(worktree);
    for (const path of worktrees) {
      try {
        const ids = sessionsToDelete(await tx(cli.previewDelete(path, project)), own);
        await tx(cli.delete(path, project, ids), 180);
      } catch (failure) {
        say(`worktree ${path} was not removed: ${failure.message}`);
      }
    }
    for (const branch of branches) {
      try {
        git(repo, ["branch", "-D", "--quiet", branch]);
      } catch (failure) {
        say(`branch ${branch} was kept: ${failure.message}`);
      }
    }
  }

  const spent = latest ? roundCents(latest.costUsd) : 0;
  if (!latest || !startedAt) return { record: null, spent, fatal, error: error ?? "nothing was measured" };
  const usage = usageSince(latest, baseline);
  // Wall time runs from the task being sent to the check's end: the warm-up
  // and the install before it are the harness's, the same for every arrangement.
  const wallSeconds = Number(checkEnd - sentAt) / 1e9;
  return { record: buildRecord({ task: run.task, arrangement: arrangement.name, passed, usage, wallSeconds, startedAt, error }), spent, fatal, error };
}

export async function main(argv, io) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr.write(`run: ${error.message}\n\n${HELP}\n`);
    return 2;
  }
  if (options.help) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  const at = (path) => (isAbsolute(path) ? path : resolve(io.cwd, path));
  let repo;
  try {
    repo = repoRoot(at(options.repo ?? "."));
  } catch (error) {
    io.stderr.write(`run: ${error.message}\n`);
    return 1;
  }
  const tasksDir = options.tasks ? at(options.tasks) : join(repo, TASKS_DIR);
  const out = options.out ? at(options.out) : join(repo, "bench/orchestration/results.jsonl");

  let routing;
  let arrangements;
  try {
    routing = loadRouting(repo);
    arrangements = Object.fromEntries((options.all ? ARRANGEMENTS : [options.arrangement]).map((name) => [name, resolveArrangement(name, routing, options.agent)]));
  } catch (error) {
    io.stderr.write(`run: ${error.message}\n`);
    return 1;
  }

  const { tasks, problems } = loadTasks(tasksDir);
  if (problems.length) {
    io.stderr.write(`run: the task files have problems; fix them first:\n${problems.map((problem) => `  ${problem}`).join("\n")}\n`);
    return 1;
  }
  const chosen = options.all ? tasks : tasks.filter((task) => task.id === options.task);
  if (!chosen.length) {
    io.stderr.write(options.all ? `run: no tasks in ${tasksDir}\n` : `run: no task ${options.task} in ${tasksDir}\n`);
    return 1;
  }
  const missing = chosen.filter((task) => !commitExists(repo, task.startCommit) || (!task.solutionPatch && !commitExists(repo, task.solution)));
  if (missing.length) {
    io.stderr.write(`run: commits missing from ${repo}: ${missing.map((task) => task.id).join(", ")}\n`);
    return 1;
  }

  let project;
  try {
    project = options.project ? at(options.project) : mainCheckout(repo);
  } catch (error) {
    io.stderr.write(`run: ${error.message}\n`);
    return 1;
  }

  const runs = planRuns(chosen, Object.keys(arrangements), options.repeat);
  const budget = new Budget(options.budgetDollars, options.capDollars);
  const header = [
    `${options.dryRun ? "Would run" : "Running"} ${runs.length} run${runs.length === 1 ? "" : "s"} in project ${project}.`,
    `Budget: ${budget.total === null ? "none (a single task)" : money(budget.total)}; each run stops at ${money(budget.capForNext())}.`,
    `Results go to ${out}.`,
    `Tiers from ${ROUTING_FILE}: ${Object.values(arrangements).map((item) => `${item.name} → ${item.model}${item.workers ? ` (workers ${item.workers.model ?? "by kind"}, effort ${item.workers.effort ?? "by kind"})` : ""}`).join("; ")}.`,
  ];
  io.stdout.write(`${header.join("\n")}\n`);

  if (options.dryRun) {
    runs.forEach((run, index) => {
      const arrangement = arrangements[run.arrangement];
      io.stdout.write(`\nrun ${index + 1} of ${runs.length}: ${run.task.id} under ${run.arrangement}${run.of > 1 ? ` (${run.round} of ${run.of})` : ""}\n`);
      const steps = describeRun(run, { project, cap: budget.capForNext(), out, pollSeconds: options.pollSeconds, timeoutMinutes: options.timeoutMinutes, arrangement, name: `bench-${SHORT[run.arrangement]}-<random>` });
      steps.forEach((step, number) => io.stdout.write(`  ${String(number + 1).padStart(2)}. ${step}\n`));
    });
    io.stdout.write(`\nDry run: nothing was started.\n`);
    return 0;
  }

  let bin;
  try {
    bin = findTerminalx(io.env);
  } catch (error) {
    io.stderr.write(`run: ${error.message}\n`);
    return 1;
  }
  const ctx = { io, bin, project, repo, pollSeconds: options.pollSeconds, timeoutMinutes: options.timeoutMinutes, interrupted: false };
  const interrupt = () => {
    ctx.interrupted = true;
    io.stderr.write("run: interrupted; stopping this run and cleaning up\n");
  };
  process.once("SIGINT", interrupt);
  let code = 0;
  let written = 0;
  try {
    for (const [index, run] of runs.entries()) {
      if (ctx.interrupted) break;
      if (budget.exhausted()) {
        io.stdout.write(`\nBudget reached: ${money(budget.spent)} of ${money(budget.total)} spent; ${runs.length - index} run(s) not started.\n`);
        break;
      }
      const cap = budget.capForNext();
      io.stdout.write(`\nrun ${index + 1} of ${runs.length}: ${run.task.id} under ${run.arrangement} (cap ${money(cap)})\n`);
      const outcome = await runOne(run, { ...ctx, cap, arrangement: arrangements[run.arrangement] });
      budget.add(outcome.spent);
      if (outcome.record) {
        appendRecord(out, outcome.record);
        written += 1;
        io.stdout.write(`  ${outcome.record.passed ? "passed" : "failed"}, ${money(outcome.record.costUsd)}${outcome.error ? ` (${outcome.error})` : ""}; ${money(budget.spent)} spent in all\n`);
      } else {
        code = 1;
        io.stderr.write(`  no result: ${outcome.error}\n`);
      }
      if (outcome.fatal) {
        code = 1;
        io.stderr.write(`run: stopping: ${outcome.fatal}\n`);
        break;
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
  io.stdout.write(`\n${written} result line(s) written to ${out}; ${money(budget.spent)} spent, warm-ups included.\n`);
  return ctx.interrupted ? 130 : code;
}
