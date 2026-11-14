// @vitest-environment node
// The orchestration benchmark's contract (docs/ORCHESTRATION-BENCH.md): the
// formats, the task loader, the dispatcher and check-task, driven against real
// temporary git repositories.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "./orchestration-bench/cli.mjs";
import { main as checkTask } from "./orchestration-bench/check-task.mjs";
import { ARRANGEMENTS, SHAPES, formatResultLine, parseResultLines, validateResult, validateTask } from "./orchestration-bench/schema.mjs";
import { loadTasks } from "./orchestration-bench/tasks.mjs";
import { closeWorktree, openWorktree, runCommand, solutionCommit } from "./orchestration-bench/worktree.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "orchestration-bench/cli.mjs");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const scratch = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `orchestration-bench-test-${prefix}-`));
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

/** A real repository: a buggy `add`, then a commit that fixes it and adds its test. */
function makeRepo({ extra = {} } = {}) {
  const repo = tempDir("repo");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Bench Test");
  git(repo, "config", "user.email", "bench@invalid");
  git(repo, "config", "commit.gpgsign", "false");
  write(repo, { "src/add.mjs": "export const add = (a, b) => a - b;\n", ...extra });
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
  return { repo, start, fix };
}

function task(overrides = {}) {
  return {
    id: "fix-add",
    shape: "feature",
    title: "Make add add",
    prompt: "add() in src/add.mjs subtracts. Make it add.",
    startCommit: SHA_A,
    solution: SHA_B,
    check: { run: "node test/add.check.mjs", timeoutSeconds: 30, files: ["test/add.check.mjs"] },
    source: { commit: SHA_B.slice(0, 12), pr: 812 },
    ...overrides,
  };
}

function writeTask(tasksDir, value, { shape = value.shape, name = `${value.id}.json` } = {}) {
  const file = join(tasksDir, shape, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function result(overrides = {}) {
  return {
    taskId: "fix-add",
    shape: "feature",
    arrangement: "lead-mid-workers",
    passed: true,
    costUsd: 1.25,
    tokens: { input: 1200, output: 340, cacheRead: 50000, cacheWrite: 2000 },
    wallSeconds: 412.5,
    attempts: 1,
    sessionIds: ["4f0c2a", "9b1d77"],
    startedAt: "2026-11-12T09:30:00Z",
    ...overrides,
  };
}

const worktreesOf = (repo) => git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

describe("task format", () => {
  it("accepts a complete task with a commit or a patch solution", () => {
    expect(validateTask(task())).toEqual([]);
    expect(validateTask(task({ solution: "fix-add.patch", notes: "from the add fix" }))).toEqual([]);
    expect(validateTask(task({ check: { run: "true", timeoutSeconds: 5, files: [], install: false } }))).toEqual([]);
  });

  it("names every problem in a bad task", () => {
    const problems = validateTask({
      id: "Fix Add",
      shape: "bugfix",
      title: "",
      prompt: "see /Users/someone/notes",
      startCommit: "abc123",
      solution: "../outside.patch",
      check: { run: "", timeoutSeconds: 0, files: ["/etc/passwd", "a/../b"], extra: 1 },
      source: {},
      colour: "red",
    });
    for (const expected of [
      "colour is not a field",
      "id must be",
      "shape must be one of search, feature, chain",
      "title must be",
      "prompt contains a home folder path",
      "startCommit must be a full",
      "solution is neither",
      "check.extra is not a field",
      "check.run must be",
      "check.timeoutSeconds must be",
      "check.files[0] must be relative",
      "check.files[1] must not contain",
      "source must name",
    ]) {
      expect(problems.some((problem) => problem.includes(expected)), `${expected} in ${problems.join(" | ")}`).toBe(true);
    }
    expect(validateTask(task({ solution: SHA_A, startCommit: SHA_A }))).toContain("solution must differ from startCommit");
    expect(validateTask(task({ solution: "fix.txt" }))).toContain("solution patch file must end in .patch or .diff");
    expect(validateTask(task({ check: { run: "x", timeoutSeconds: 5 } }))).toContain("check.files must be a list of paths (it may be empty)");
    expect(validateTask(task({ source: { pr: 0 } }))).toContain("source.pr must be a pull request number");
  });
});

describe("result record", () => {
  it("keeps the shapes and arrangements fixed", () => {
    expect(SHAPES).toEqual(["search", "feature", "chain"]);
    expect(ARRANGEMENTS).toEqual(["top-single", "large-single", "lead-mid-workers", "lead-low-escalate"]);
  });

  it("round-trips through a results file and reports bad lines by number", () => {
    const good = result();
    const failed = result({ arrangement: "top-single", passed: false, error: "the check timed out" });
    const text = formatResultLine(good) + "\n" + formatResultLine(failed) + "{not json\n" + `${JSON.stringify(result({ arrangement: "solo" }))}\n`;
    const { results, problems } = parseResultLines(text);
    expect(results).toEqual([good, failed]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^line 4: not JSON/);
    expect(problems[1]).toMatch(/^line 5: arrangement must be one of top-single/);
  });

  it("rejects incomplete records", () => {
    const problems = validateResult({ ...result({ costUsd: -1, attempts: 0, startedAt: "yesterday", tokens: { input: 1, output: 1.5 } }), extra: true });
    for (const expected of ["extra is not a field", "costUsd", "attempts", "startedAt", "tokens.output", "tokens.cacheRead"]) {
      expect(problems.some((problem) => problem.includes(expected)), expected).toBe(true);
    }
    expect(() => formatResultLine(result({ passed: "yes" }))).toThrow(/passed must be true or false/);
  });
});

describe("task loader", () => {
  it("loads tasks by shape and resolves patch solutions next to the task", () => {
    const dir = tempDir("tasks");
    const file = writeTask(dir, task());
    writeTask(dir, task({ id: "find-caller", shape: "search", solution: "find-caller.patch" }));
    writeFileSync(join(dir, "search", "find-caller.patch"), "");
    const all = loadTasks(dir);
    expect(all.problems).toEqual([]);
    expect(all.tasks.map((t) => t.id)).toEqual(["fix-add", "find-caller"]);
    expect(all.tasks[0].file).toBe(file);
    expect(all.tasks[1].solutionPatch).toBe(join(dir, "search", "find-caller.patch"));
    expect(loadTasks(dir, { shape: "search" }).tasks.map((t) => t.id)).toEqual(["find-caller"]);
    expect(loadTasks(join(dir, "missing")).tasks).toEqual([]);
  });

  it("catches what one file cannot: folder, file name, duplicate ids, missing patches", () => {
    const dir = tempDir("tasks");
    writeTask(dir, task(), { shape: "chain" });
    writeTask(dir, task({ id: "other" }), { name: "renamed.json" });
    writeTask(dir, task({ id: "fix-add", shape: "search" }));
    writeTask(dir, task({ id: "patched", solution: "patched.patch" }));
    mkdirSync(join(dir, "misc"));
    writeFileSync(join(dir, "feature", "broken.json"), "{");
    const { tasks, problems } = loadTasks(dir);
    expect(tasks).toEqual([]);
    const text = problems.join("\n");
    expect(text).toContain("chain/fix-add.json: shape is feature but the file is in chain/");
    expect(text).toContain("feature/renamed.json: file name must be other.json");
    expect(text).toContain("search/fix-add.json: id fix-add is already used by chain/fix-add.json");
    expect(text).toContain("feature/patched.json: solution patch patched.patch does not exist");
    expect(text).toContain("feature/broken.json: not JSON");
    expect(text).toContain("misc/: not a shape");
  });
});

describe("dispatcher", () => {
  it("prints usage for --help and exits 0", () => {
    const shown = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("check-task");
    expect(shown.stdout).toContain("lead-low-escalate");
  });

  it("says plainly when a subcommand's module is not there yet", async () => {
    const empty = tempDir("modules");
    const seen = capture(empty);
    expect(await dispatch(["report"], seen.io, { moduleDir: empty })).toBe(1);
    expect(seen.err()).toContain("'report' is not built yet: report.mjs does not exist");
    expect(await dispatch(["launch"], seen.io, { moduleDir: empty })).toBe(2);
    expect(seen.err()).toContain("unknown subcommand launch");
  });

  it("loads run.mjs lazily and passes its arguments and exit code through", async () => {
    const dir = tempDir("modules");
    writeFileSync(join(dir, "run.mjs"), "export async function main(argv, io) { io.stdout.write(argv.join('|')); return 3; }\n");
    const seen = capture(dir);
    expect(await dispatch(["run", "--task", "fix-add"], seen.io, { moduleDir: dir })).toBe(3);
    expect(seen.out()).toBe("--task|fix-add");
    writeFileSync(join(dir, "report.mjs"), "export const nothing = 1;\n");
    expect(await dispatch(["report"], seen.io, { moduleDir: dir })).toBe(1);
    expect(seen.err()).toContain("report.mjs does not export main(argv, io)");
  });
});

describe("check-task", () => {
  it("passes a task whose check fails at start and passes at the solution, with a commit or a patch", async () => {
    const { repo, start, fix } = makeRepo();
    const tasksDir = tempDir("tasks");
    writeTask(tasksDir, task({ startCommit: start, solution: fix }));
    writeTask(tasksDir, task({ id: "fix-add-patch", startCommit: start, solution: "fix-add-patch.patch" }));
    writeFileSync(join(tasksDir, "feature", "fix-add-patch.patch"), git(repo, "diff", "--binary", start, fix) + "\n");
    const seen = capture(repo);
    const code = await checkTask(["--tasks", tasksDir, "--work-dir", tempDir("work"), "--min", "2"], seen.io);
    expect(seen.err()).toBe("");
    expect(code).toBe(0);
    expect(seen.out()).toMatch(/feature\/fix-add: Make add add\n {4}at startCommit: failed as required \(exit 1\) in \d+\.\d s\n {4}at the solution: passed as required in \d+\.\d s/);
    expect(seen.out()).toContain("all 2 tasks fail at startCommit and pass at the solution");
    expect(worktreesOf(repo)).toBe(1);
  });

  it("fails a task whose check already passes, never passes, or hangs, and still removes every worktree", async () => {
    const { repo, start, fix } = makeRepo();
    const tasksDir = tempDir("tasks");
    // The test is copied in, but the fix is already there: the check passes at start.
    writeTask(tasksDir, task({ id: "already-done", startCommit: fix, solution: start, check: { run: "true", timeoutSeconds: 10, files: [] } }));
    writeTask(tasksDir, task({ id: "never-passes", startCommit: start, solution: fix, check: { run: "node test/add.check.mjs && exit 4", timeoutSeconds: 10, files: ["test/add.check.mjs"] } }));
    writeTask(tasksDir, task({ id: "hangs", startCommit: start, solution: fix, check: { run: "sleep 60", timeoutSeconds: 1, files: [] } }));
    writeTask(tasksDir, task({ id: "missing-file", startCommit: start, solution: fix, check: { run: "true", timeoutSeconds: 5, files: ["test/none.mjs"] } }));
    const seen = capture(repo);
    const began = Date.now();
    const code = await checkTask(["--tasks", tasksDir, "--work-dir", tempDir("work")], seen.io);
    expect(code).toBe(1);
    expect(Date.now() - began).toBeLessThan(20_000);
    const out = seen.out();
    expect(out).toContain("PROBLEM: at startCommit the check passed; it must fail before the task is done");
    expect(out).toContain("PROBLEM: at the solution the check failed (exit 4)");
    expect(out).toContain("PROBLEM: at startCommit the check timed out after 1 s");
    expect(out).toContain("PROBLEM: check file test/none.mjs is not a file in the solution");
    expect(seen.err()).toContain("4 of 4 tasks failed");
    expect(worktreesOf(repo)).toBe(1);
  });

  it("selects by shape and task, and enforces --min", async () => {
    const { repo, start, fix } = makeRepo();
    const tasksDir = tempDir("tasks");
    writeTask(tasksDir, task({ startCommit: start, solution: fix }));
    const work = tempDir("work");
    const few = capture(repo);
    expect(await checkTask(["--tasks", tasksDir, "--work-dir", work, "--shape", "search"], few.io)).toBe(1);
    expect(few.err()).toContain("0 search tasks");
    const short = capture(repo);
    expect(await checkTask(["--tasks", tasksDir, "--work-dir", work, "--min", "7"], short.io)).toBe(1);
    expect(short.err()).toContain("fewer than --min 7");
    const unknown = capture(repo);
    expect(await checkTask(["--tasks", tasksDir, "--task", "nope"], unknown.io)).toBe(1);
    expect(unknown.err()).toContain("no task nope");
    const one = capture(repo);
    expect(await checkTask(["--tasks", tasksDir, "--work-dir", work, "--task", "fix-add", "--shape", "feature"], one.io)).toBe(0);
    const invalid = capture(repo);
    writeTask(tasksDir, { id: "bad" }, { shape: "feature" });
    expect(await checkTask(["--tasks", tasksDir, "--work-dir", work], invalid.io)).toBe(1);
    expect(invalid.err()).toContain("feature/bad.json: shape must be one of");
    expect(await checkTask(["--min", "x"], capture(repo).io)).toBe(2);
  });
});

describe("worktree helper", () => {
  it("installs once per lockfile and reuses the tree in the next worktree", async () => {
    // A local package as the one dependency: a real install, with no network.
    const { repo, start } = makeRepo({
      extra: {
        "package.json": '{ "name": "bench-fixture", "private": true, "version": "0.0.0", "dependencies": { "bench-dep": "file:./vendor/bench-dep" } }\n',
        "vendor/bench-dep/package.json": '{ "name": "bench-dep", "version": "1.0.0", "type": "module", "main": "index.mjs" }\n',
        "vendor/bench-dep/index.mjs": "export const answer = 42;\n",
      },
    });
    execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-workspace"], { cwd: repo, stdio: "ignore", timeout: 120_000 });
    git(repo, "add", "pnpm-lock.yaml");
    git(repo, "commit", "--quiet", "-m", "lockfile");
    const head = git(repo, "rev-parse", "HEAD");
    const workRoot = tempDir("work");

    const first = await openWorktree({ repo, commit: head, label: "first", workRoot, installTimeoutSeconds: 120 });
    expect(first.install).toBe("fresh");
    expect(existsSync(join(first.dir, "node_modules", ".modules.yaml"))).toBe(true);
    closeWorktree(first);
    expect(existsSync(first.dir)).toBe(false);
    expect(readdirSync(join(workRoot, "node-modules")).filter((name) => !name.startsWith("."))).toHaveLength(1);

    const second = await openWorktree({ repo, commit: head, label: "second", workRoot, installTimeoutSeconds: 120 });
    expect(second.install).toBe("reused");
    expect(existsSync(join(second.dir, "node_modules", ".modules.yaml"))).toBe(true);
    const used = await runCommand(`node --input-type=module -e "import { answer } from 'bench-dep'; console.log(answer)"`, { cwd: second.dir, timeoutSeconds: 30 });
    expect(used.exitCode).toBe(0);
    expect(used.output.trim()).toBe("42");
    closeWorktree(second);

    // A commit with no lockfile installs nothing.
    const bare = await openWorktree({ repo, commit: start, label: "bare", workRoot });
    expect(bare.install).toBe("none");
    closeWorktree(bare);
    expect(worktreesOf(repo)).toBe(1);
  }, 120_000);

  it("turns a patch into a commit without touching the checkout, and refuses one that does not apply", () => {
    const { repo, start, fix } = makeRepo();
    const dir = tempDir("tasks");
    const patch = join(dir, "fix.patch");
    writeFileSync(patch, git(repo, "diff", "--binary", start, fix) + "\n");
    const commit = solutionCommit(repo, { id: "fix", startCommit: start, solution: "fix.patch", solutionPatch: patch });
    expect(git(repo, "rev-parse", `${commit}^{tree}`)).toBe(git(repo, "rev-parse", `${fix}^{tree}`));
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(() => solutionCommit(repo, { id: "fix", startCommit: fix, solution: "fix.patch", solutionPatch: patch })).toThrow(/does not apply/);
  });

  it("kills a command and everything it started when its time runs out", async () => {
    const dir = tempDir("cmd");
    const done = await runCommand("sleep 30 & sleep 30; echo never", { cwd: dir, timeoutSeconds: 1 });
    expect(done.timedOut).toBe(true);
    expect(done.seconds).toBeLessThan(5);
    expect(done.output).not.toContain("never");
    expect(() => runCommand("true", { cwd: dir })).toThrow(/explicit timeoutSeconds/);
  });
});
