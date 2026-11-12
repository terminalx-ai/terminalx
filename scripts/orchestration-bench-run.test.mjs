// @vitest-environment node
// The orchestration benchmark's runner (docs/ORCHESTRATION-BENCH.md): the
// parts that need no agent, against real temporary git repositories, the
// real routing table and terminalx answers captured on this machine. Nothing
// here starts a session: every run of `main` below is a dry run or a refusal.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ARRANGEMENT_SPECS, ROUTING_FILE, WARM_UP_PROMPT, loadRouting, parseRouting, resolveArrangement, taskPrompt } from "./orchestration-bench/arrangements.mjs";
import {
  ACTIVE_RUN_STATES,
  Budget,
  DEFAULT_CAP_DOLLARS,
  UsageError,
  appendRecord,
  buildRecord,
  cli,
  findTerminalx,
  main,
  mainCheckout,
  moveToStart,
  parseArgs,
  planRuns,
  runCheck,
  sessionsToDelete,
  shellQuote,
  worktreeName,
} from "./orchestration-bench/run.mjs";
import { ARRANGEMENTS, parseResultLines } from "./orchestration-bench/schema.mjs";
import { CliError, NO_USAGE, parseUsage, unknownCost, unwrap, usageSince } from "./orchestration-bench/usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(HERE, "orchestration-bench/cli.mjs");
const FIXTURES = join(HERE, "orchestration-bench/fixtures");
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const ROUTING_SOURCE = readFileSync(join(ROOT, ROUTING_FILE), "utf8");

const scratch = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `orchestration-bench-run-test-${prefix}-`));
  scratch.push(dir);
  return dir;
}

function capture(cwd) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, cwd, env: process.env },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/**
 * A real repository with the real routing table: a buggy `add`, then a commit
 * that fixes it and adds its check, and a task file for it.
 */
function makeRepo() {
  const repo = tempDir("repo");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Bench Test");
  git(repo, "config", "user.email", "bench@invalid");
  git(repo, "config", "commit.gpgsign", "false");
  mkdirSync(dirname(join(repo, ROUTING_FILE)), { recursive: true });
  copyFileSync(join(ROOT, ROUTING_FILE), join(repo, ROUTING_FILE));
  write(repo, { "src/add.mjs": "export const add = (a, b) => a - b;\n", ".gitignore": "node_modules/\n" });
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "start");
  const start = git(repo, "rev-parse", "HEAD");
  write(repo, {
    "src/add.mjs": "export const add = (a, b) => a + b;\n",
    "test/add.check.mjs": 'import assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\nassert.equal(add(2, 3), 5);\nconsole.log("add works");\n',
  });
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "fix add");
  const fix = git(repo, "rev-parse", "HEAD");
  const task = {
    id: "fix-add",
    shape: "feature",
    title: "Make add add",
    prompt: "add() in src/add.mjs subtracts. Make it add.",
    startCommit: start,
    solution: fix,
    check: { run: "node test/add.check.mjs", timeoutSeconds: 30, files: ["test/add.check.mjs"], install: false },
    source: { commit: fix.slice(0, 12) },
  };
  const tasks = join(repo, "bench/orchestration/tasks");
  write(tasks, { [`feature/${task.id}.json`]: `${JSON.stringify(task, null, 2)}\n` });
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "task");
  return { repo, start, fix, task, tasks };
}

const worktrees = (repo) => git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

describe("command line", () => {
  it("refuses --all without a budget, and a run with nothing to run", () => {
    expect(() => parseArgs(["--all"])).toThrow(UsageError);
    expect(() => parseArgs(["--all"])).toThrow(/--budget-dollars/);
    expect(() => parseArgs([])).toThrow(/--task and --arrangement/);
    expect(() => parseArgs(["--task", "fix-add"])).toThrow(/--task and --arrangement/);
    expect(() => parseArgs(["--task", "fix-add", "--arrangement", "one-big-model"])).toThrow(/unknown arrangement/);
    expect(() => parseArgs(["--all", "--budget-dollars", "5", "--task", "fix-add"])).toThrow(/leave out --task/);
    expect(() => parseArgs(["--task", "x", "--arrangement", "top-single", "--repeat", "1.5"])).toThrow(/whole number/);
    expect(() => parseArgs(["--task", "x", "--arrangement", "top-single", "--budget-dollars", "0"])).toThrow(/above 0/);
    expect(() => parseArgs(["--task", "x", "--arrangement", "top-single", "--out"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--task", "x", "--arrangement", "top-single", "--verbose"])).toThrow(/unknown option/);
  });

  it("reads every option", () => {
    const options = parseArgs(["--all", "--budget-dollars", "12.5", "--cap-dollars", "3", "--repeat", "2", "--out", "r.jsonl", "--dry-run", "--poll-seconds", "10", "--timeout-minutes", "45"]);
    expect(options).toMatchObject({ all: true, budgetDollars: 12.5, capDollars: 3, capGiven: true, repeat: 2, out: "r.jsonl", dryRun: true, pollSeconds: 10, timeoutMinutes: 45 });
    expect(parseArgs(["--task", "a", "--arrangement", "large-single"])).toMatchObject({ task: "a", arrangement: "large-single", capDollars: DEFAULT_CAP_DOLLARS, budgetDollars: null, repeat: 1 });
  });

  it("answers --help with exit 0 through the benchmark's own command", () => {
    const result = spawnSync(process.execPath, [CLI, "run", "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--budget-dollars");
    for (const name of ARRANGEMENTS) expect(result.stdout).toContain(name);
  });

  it("exits 2 with the usage for --all without a budget, starting nothing", async () => {
    const { repo } = makeRepo();
    const out = capture(repo);
    expect(await main(["--all"], out.io)).toBe(2);
    expect(out.err()).toContain("--all needs --budget-dollars");
    expect(out.out()).toBe("");
  });
});

describe("arrangements from the routing table", () => {
  it("reads the tiers, efforts and families from routing.rs itself", () => {
    const routing = parseRouting(ROUTING_SOURCE);
    expect(routing.tiers).toEqual(["small", "mid", "large", "top"]);
    expect(routing.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(Object.keys(routing.families).sort()).toEqual(["claude", "codex"]);
    for (const agent of Object.keys(routing.families)) expect(Object.keys(routing.families[agent])).toEqual(routing.tiers);
  });

  it("resolves each arrangement to the routing table's family for its tiers", () => {
    const routing = loadRouting(ROOT);
    const family = routing.families.claude;
    const top = resolveArrangement("top-single", routing);
    expect(top).toMatchObject({ lead: false, tier: "top", model: family.top, effort: null, workers: null });
    expect(resolveArrangement("large-single", routing)).toMatchObject({ lead: false, tier: "large", model: family.large });
    expect(resolveArrangement("lead-mid-workers", routing)).toMatchObject({ lead: true, model: family.top, workers: { tier: "mid", model: family.mid, effort: null }, escalateEffort: null });
    expect(resolveArrangement("lead-low-escalate", routing)).toMatchObject({ lead: true, model: family.top, workers: { tier: null, model: null, effort: "low" }, escalateEffort: "high" });
    expect(Object.keys(ARRANGEMENT_SPECS)).toEqual(ARRANGEMENTS);
  });

  it("follows the routing table when a family changes, and refuses a table it cannot read", () => {
    const renamed = ROUTING_SOURCE.replace(/"claude" => Some\(\["(\w+)", "(\w+)", "(\w+)", "(\w+)"\]/, '"claude" => Some(["$1", "$2", "$3", "nextgen"]');
    expect(renamed).not.toBe(ROUTING_SOURCE);
    expect(resolveArrangement("top-single", parseRouting(renamed)).model).toBe("nextgen");
    expect(() => parseRouting(ROUTING_SOURCE.replace("pub const ALL", "const EVERY"))).toThrow(/Tier::ALL/);
    expect(() => parseRouting(ROUTING_SOURCE.replace(/pub fn family[\s\S]*?\n {4}\}/, ""))).toThrow(/Tier::family/);
    expect(() => resolveArrangement("top-single", parseRouting(ROUTING_SOURCE), "codex")).toThrow(/claude sessions only/);
    expect(() => resolveArrangement("solo", parseRouting(ROUTING_SOURCE))).toThrow(/unknown arrangement/);
  });

  it("tells a lead to use the orchestrator skill and which worker tier and effort to plan for", () => {
    const routing = loadRouting(ROOT);
    const task = { prompt: "Make add add." };
    const mid = taskPrompt(task, resolveArrangement("lead-mid-workers", routing));
    expect(mid).toContain("terminalx skills get terminalx-orchestrator");
    expect(mid).toContain(`"model": "${routing.families.claude.mid}"`);
    expect(mid).toContain("terminalx runs merge --json");
    expect(mid.endsWith("Make add add.")).toBe(true);
    const low = taskPrompt(task, resolveArrangement("lead-low-escalate", routing));
    expect(low).toContain('"effort": "low"');
    expect(low).toContain('"effort": "high"');
    expect(low).toContain("terminalx skills get terminalx-orchestrator");
    const single = taskPrompt(task, resolveArrangement("top-single", routing));
    expect(single.startsWith("Make add add.")).toBe(true);
    expect(single).not.toContain("orchestrator");
    expect(WARM_UP_PROMPT).toMatch(/ready/);
  });
});

describe("reading terminalx answers", () => {
  it("parses a captured `sessions usage <session>` answer", () => {
    const result = unwrap(fixture("sessions-usage.json"));
    const usage = parseUsage(result);
    expect(usage.sessionIds).toEqual([result.sessionId]);
    expect(usage.costUsd).toBe(result.total.costUsd);
    expect(usage.tokens).toEqual({ input: result.total.inputTokens, output: result.total.outputTokens, cacheRead: result.total.cacheReadTokens, cacheWrite: result.total.cacheWriteTokens });
    expect(unknownCost(usage)).toBeNull();
  });

  it("parses a captured `--children-of` answer: the lead first, then every worker, and the grand total", () => {
    const result = unwrap(fixture("sessions-usage-children-of.json"));
    const usage = parseUsage(result);
    expect(usage.sessionIds[0]).toBe(result.parent.sessionId);
    expect(usage.sessionIds.slice(1)).toEqual(result.workers.map((worker) => worker.sessionId));
    expect(usage.sessionIds.length).toBeGreaterThan(1);
    // The grand total is the lead's and the workers' totals added up.
    const parts = [result.lead, ...result.workers].map((report) => parseUsage(report));
    for (const kind of ["input", "output", "cacheRead", "cacheWrite"]) expect(usage.tokens[kind]).toBe(parts.reduce((sum, part) => sum + part.tokens[kind], 0));
    expect(usage.costUsd).toBeCloseTo(parts.reduce((sum, part) => sum + part.costUsd, 0), 6);
  });

  it("subtracts a baseline, and refuses readings that went down", () => {
    const children = parseUsage(unwrap(fixture("sessions-usage-children-of.json")));
    const lead = parseUsage(unwrap(fixture("sessions-usage.json")));
    expect(usageSince(children, NO_USAGE)).toEqual({ ...children, costUsd: Number(children.costUsd.toFixed(6)) });
    const since = usageSince(children, lead);
    expect(since.tokens.output).toBe(children.tokens.output - lead.tokens.output);
    expect(since.costUsd).toBeCloseTo(children.costUsd - lead.costUsd, 6);
    expect(since.sessionIds).toEqual(children.sessionIds);
    expect(() => usageSince(lead, children)).toThrow(/went down/);
  });

  it("never counts a cost that is null or leaves models out", () => {
    const usage = parseUsage(unwrap(fixture("sessions-usage.json")));
    expect(unknownCost({ ...usage, costUsd: null })).toMatch(/no cost/);
    expect(unknownCost({ ...usage, unpricedModels: ["claude-next"] })).toMatch(/leaves out claude-next/);
    expect(usageSince({ ...usage, costUsd: null }, NO_USAGE).costUsd).toBeNull();
  });

  it("turns a captured failure into a CliError with the CLI's code", () => {
    let thrown;
    try {
      unwrap(fixture("error-timeout.json"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect(thrown.code).toBe("timeout");
    expect(thrown.message).toMatch(/did not answer/);
    expect(() => unwrap("not json")).toThrow(/not JSON/);
    expect(() => unwrap('{"ok":true}')).toThrow(/neither/);
  });

  it("reads a captured wait answer's reason", () => {
    expect(unwrap(fixture("wait.json")).reason).toBe("stop");
  });

  it("deletes a worktree only when every session in it is the run's own", () => {
    const preview = unwrap(fixture("worktrees-delete-dry-run.json"));
    const [held] = preview.sessions.map((session) => session.id);
    expect(sessionsToDelete(preview, new Set([held, "another"]))).toEqual([held]);
    expect(() => sessionsToDelete(preview, new Set(["another"]))).toThrow(new RegExp(`did not start \\(${held}\\)`));
    expect(() => sessionsToDelete({}, new Set([held]))).toThrow(/lists no sessions/);
  });
});

describe("budget and plan", () => {
  it("gives each run the cap or what is left, and stops at the total", () => {
    const budget = new Budget(10, 4);
    expect(budget.capForNext()).toBe(4);
    budget.add(3.5);
    budget.add(4.25);
    expect(budget.spent).toBe(7.75);
    expect(budget.capForNext()).toBe(2.25);
    expect(budget.exhausted()).toBe(false);
    budget.add(2.3); // a run can go over by what one wait slice spends
    expect(budget.remaining()).toBe(0);
    expect(budget.exhausted()).toBe(true);
    expect(() => budget.add(-1)).toThrow();
    const single = new Budget(null, 5);
    single.add(100);
    expect(single.capForNext()).toBe(5);
  });

  it("plans each task under each arrangement, repeated", () => {
    const runs = planRuns([{ id: "a" }, { id: "b" }], ARRANGEMENTS, 2);
    expect(runs).toHaveLength(16);
    expect(runs.slice(0, 2).map((run) => [run.task.id, run.arrangement, run.round, run.of])).toEqual([["a", "top-single", 1, 2], ["a", "top-single", 2, 2]]);
    expect(new Set(runs.map((run) => `${run.task.id}/${run.arrangement}/${run.round}`)).size).toBe(16);
  });

  it("names worktrees within the slug limit, one per run", () => {
    for (const name of ARRANGEMENTS) {
      const slug = worktreeName(name);
      expect(slug).toMatch(/^bench-[a-z-]+-[0-9a-f]{6}$/);
      expect(slug.length).toBeLessThanOrEqual(40);
    }
    expect(worktreeName("top-single")).not.toBe(worktreeName("top-single"));
  });

  it("builds the CLI arguments each step passes", () => {
    expect(cli.create({ project: "/p", model: "opus", effort: null, title: "t", name: "bench-large-abc123" })).toEqual([
      "sessions", "create", "--project", "/p", "--agent", "claude", "--prompt", WARM_UP_PROMPT, "--title", "t", "--name", "bench-large-abc123", "--worktree", "--no-parent", "--model", "opus", "--mode", "bypassPermissions", "--json",
    ]);
    expect(cli.create({ project: "/p", model: "opus", effort: "high", title: "t", name: "n" })).toContain("high");
    expect(cli.usage("s", true)).toEqual(["sessions", "usage", "--children-of", "s", "--json"]);
    expect(cli.usage("s", false)).toEqual(["sessions", "usage", "s", "--json"]);
    expect(cli.delete("/w", "/p", ["a", "b"])).toEqual(["worktrees", "delete", "/w", "--project", "/p", "--yes", "--sessions", "a,b", "--force", "--json"]);
    expect(ACTIVE_RUN_STATES.has("done")).toBe(false);
    expect(ACTIVE_RUN_STATES.has("awaitingApproval")).toBe(true);
  });

  it("quotes commands so a shell reads them back exactly", () => {
    for (const text of ["plain", "it's here", 'say "hi"\nnext line', "$HOME `x` \\ !", ""]) {
      expect(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(text)}`], { encoding: "utf8" })).toBe(text);
    }
  });
});

describe("dry run", () => {
  it("prints every command of a lead run, with the real arguments, and starts nothing", async () => {
    const { repo, start, task } = makeRepo();
    const before = git(repo, "for-each-ref");
    const out = capture(repo);
    const results = join(repo, "results.jsonl");
    expect(await main(["--task", "fix-add", "--arrangement", "lead-mid-workers", "--dry-run", "--out", results, "--cap-dollars", "4"], out.io)).toBe(0);
    const text = out.out();
    const family = loadRouting(ROOT).families.claude;
    expect(text).toContain("Would run 1 run in project");
    expect(text).toContain(realpathSync(repo));
    expect(text).toContain("each run stops at $4.00");
    expect(text).toMatch(/terminalx sessions create --project \S+ --agent claude --prompt '[^']+' --title 'Bench: fix-add under lead-mid-workers' --name 'bench-lead-mid-<random>' --worktree --no-parent --model /);
    expect(text).toContain(`--model ${family.top}`);
    expect(text).toContain(`"model": "${family.mid}"`);
    expect(text).toContain(`reset --hard --quiet ${start}`);
    expect(text).toContain("terminalx sessions usage --children-of '<session>' --json");
    expect(text).toContain("terminalx runs list --lead '<session>' --all --json");
    expect(text).toContain("terminalx sessions stop --children-of '<session>' --json");
    expect(text).toContain("copy test/add.check.mjs from the solution");
    expect(text).toContain("/bin/sh -c 'node test/add.check.mjs'");
    expect(text).toContain("--yes --sessions '<sessions>' --force --json");
    expect(text).toContain(task.prompt);
    expect(text).toContain("Dry run: nothing was started.");
    expect(existsSync(results)).toBe(false);
    expect(worktrees(repo)).toBe(1);
    expect(git(repo, "for-each-ref")).toBe(before);
  });

  it("lists every task under every arrangement for --all, inside the budget", async () => {
    const { repo } = makeRepo();
    const out = capture(repo);
    expect(await main(["--all", "--budget-dollars", "3", "--dry-run"], out.io)).toBe(0);
    const text = out.out();
    expect(text).toContain("Would run 4 runs");
    expect(text).toContain("Budget: $3.00; each run stops at $3.00.");
    for (const [index, name] of ARRANGEMENTS.entries()) expect(text).toContain(`run ${index + 1} of 4: fix-add under ${name}`);
    expect(text).toContain("terminalx sessions usage '<session>' --json");
    expect(text).toContain(join(realpathSync(repo), "bench/orchestration/results.jsonl"));
  });

  it("names the project as the main checkout when run from another worktree", async () => {
    const { repo, start, tasks } = makeRepo();
    const other = join(tempDir("linked"), "wt");
    git(repo, "worktree", "add", "--quiet", "--detach", other, start);
    expect(mainCheckout(other)).toBe(realpathSync(repo));
    const out = capture(other);
    expect(await main(["--task", "fix-add", "--arrangement", "top-single", "--dry-run", "--tasks", tasks], out.io)).toBe(0);
    expect(out.out()).toContain(`--project ${realpathSync(repo)} `);
  });

  it("refuses a task that does not exist and task files with problems", async () => {
    const { repo, tasks } = makeRepo();
    const out = capture(repo);
    expect(await main(["--task", "no-such-task", "--arrangement", "top-single", "--dry-run"], out.io)).toBe(1);
    expect(out.err()).toContain("no task no-such-task");
    write(tasks, { "feature/broken.json": "{" });
    const again = capture(repo);
    expect(await main(["--task", "fix-add", "--arrangement", "top-single", "--dry-run"], again.io)).toBe(1);
    expect(again.err()).toContain("broken.json: not JSON");
  });
});

describe("the worktree and the check", () => {
  it("moves a session's worktree and branch to the start commit, keeping ignored files", () => {
    const { repo, start, fix } = makeRepo();
    const dir = join(tempDir("session"), "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "raccoon/bench-top-abc123", dir, "main");
    write(dir, { "notes.txt": "left by someone\n", "node_modules/kept/index.js": "1\n", "src/add.mjs": "edited\n" });
    moveToStart(dir, start);
    expect(git(dir, "rev-parse", "HEAD")).toBe(start);
    expect(git(dir, "rev-parse", "raccoon/bench-top-abc123")).toBe(start);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(existsSync(join(dir, "notes.txt"))).toBe(false);
    expect(existsSync(join(dir, "node_modules/kept/index.js"))).toBe(true);
    expect(readFileSync(join(dir, "src/add.mjs"), "utf8")).toBe("export const add = (a, b) => a - b;\n");
    expect(() => moveToStart(dir, "f".repeat(40))).toThrow();
    expect(git(repo, "rev-parse", "main")).not.toBe(fix);
  });

  it("runs the check on the agent's work with the solution's check files, never the agent's", async () => {
    const { repo, start, fix, task } = makeRepo();
    const dir = join(tempDir("session"), "wt");
    git(repo, "worktree", "add", "--quiet", "--detach", dir, start);

    // Nothing done yet: the check fails.
    expect((await runCheck({ repo, dir, task, solution: fix })).passed).toBe(false);

    // An agent that wrote its own passing "check" instead of fixing add still fails.
    write(dir, { "test/add.check.mjs": 'console.log("looks fine");\n' });
    const cheat = await runCheck({ repo, dir, task, solution: fix });
    expect(cheat.passed).toBe(false);
    expect(readFileSync(join(dir, "test/add.check.mjs"), "utf8")).toContain("assert.equal(add(2, 3), 5)");

    // The real fix passes.
    write(dir, { "src/add.mjs": "export const add = (a, b) => a + b;\n" });
    const fixed = await runCheck({ repo, dir, task, solution: fix });
    expect(fixed).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
    expect(fixed.output).toContain("add works");

    // A check that runs past its timeout fails.
    const slow = await runCheck({ repo, dir, task: { ...task, check: { ...task.check, run: "sleep 5", timeoutSeconds: 1 } }, solution: fix });
    expect(slow).toMatchObject({ passed: false, timedOut: true });
  });
});

describe("result lines", () => {
  const usage = parseUsage(unwrap(fixture("sessions-usage-children-of.json")));
  const task = { id: "fix-add", shape: "feature" };

  it("appends one valid line per run, which the format reads back", () => {
    const file = join(tempDir("results"), "nested/results.jsonl");
    const passed = buildRecord({ task, arrangement: "lead-mid-workers", passed: true, usage, wallSeconds: 412.12345, startedAt: "2026-11-12T09:30:00.000Z" });
    const capped = buildRecord({ task, arrangement: "top-single", passed: true, usage: usageSince(usage, NO_USAGE), wallSeconds: 3, startedAt: "2026-11-12T10:00:00Z", error: "stopped at the cap: $12.21 of $10.00" });
    appendRecord(file, passed);
    appendRecord(file, capped);
    const { results, problems } = parseResultLines(readFileSync(file, "utf8"));
    expect(problems).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ taskId: "fix-add", shape: "feature", arrangement: "lead-mid-workers", passed: true, attempts: 1, wallSeconds: 412.123, sessionIds: usage.sessionIds });
    expect(results[0].tokens).toEqual(usage.tokens);
    expect(results[0].costUsd).toBeCloseTo(usage.costUsd, 6);
    expect(results[1]).toMatchObject({ passed: false, error: "stopped at the cap: $12.21 of $10.00" });
  });

  it("writes nothing for an invalid record", () => {
    const file = join(tempDir("results"), "results.jsonl");
    const bad = buildRecord({ task, arrangement: "top-single", passed: true, usage, wallSeconds: 1, startedAt: "yesterday" });
    expect(() => appendRecord(file, bad)).toThrow(/startedAt/);
    expect(existsSync(file)).toBe(false);
  });
});

describe("finding terminalx", () => {
  it("takes terminalx from PATH before tnx", () => {
    const bin = tempDir("bin");
    for (const name of ["tnx", "terminalx"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
    }
    expect(findTerminalx({ PATH: bin })).toBe(join(bin, "terminalx"));
    rmSync(join(bin, "terminalx"));
    expect(findTerminalx({ PATH: bin })).toBe(join(bin, "tnx"));
  });
});
