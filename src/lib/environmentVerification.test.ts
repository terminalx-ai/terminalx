import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseProposal } from "./environmentProposal";
import { SCRATCH_DIRECTORY, commandScript, outcomeOf, verifyProposal, type RunScript, type ScriptRun } from "./environmentVerification";

const expected = [{ owner: "acme", name: "widgets", defaultBranch: "main" }];
const proposal = (commands: Record<string, string>, setup = [{ workingDirectory: ".", script: "echo setup" }], installScript = "") =>
  parseProposal(JSON.stringify({ installScript, repositories: [{ owner: "acme", name: "widgets", setup, commands }] }), expected);
const far = () => Date.now() + 60 * 60 * 1000;

describe("outcomeOf", () => {
  it("never calls a non-zero exit, a timeout or an unseen ending a pass", () => {
    expect(outcomeOf({ exitCode: 0, timedOut: false, durationMs: 12.4 })).toEqual({ status: "passed", exitCode: 0, durationMs: 12 });
    expect(outcomeOf({ exitCode: 2, timedOut: false, durationMs: 5 })).toMatchObject({ status: "failed", exitCode: 2 });
    expect(outcomeOf({ exitCode: null, timedOut: true, durationMs: 5 })).toMatchObject({ status: "timed-out", exitCode: null });
    expect(outcomeOf({ exitCode: null, timedOut: false, durationMs: 5 })).toEqual({ status: "not-run", exitCode: null, durationMs: null });
    expect(outcomeOf({ exitCode: 300, timedOut: false, durationMs: 5 })).toMatchObject({ status: "failed", exitCode: 255 });
  });
});

describe("verifyProposal, with a scripted runner", () => {
  const scripted = (decide: (script: string) => Partial<ScriptRun>) => {
    const scripts: string[] = [];
    const run: RunScript = async (script) => {
      scripts.push(script);
      return { exitCode: 0, timedOut: false, durationMs: 10, ...decide(script) };
    };
    return { run, scripts };
  };
  const failing = (needle: string, where?: string) => (script: string) => (script.includes(needle) && (!where || script.includes(where)) ? { exitCode: 1 } : {});

  it("reruns a failure without the recipe and marks it pre-existing only when it fails there too", async () => {
    const both = scripted(failing("run-tests"));
    const observed = await verifyProposal(proposal({ lint: "run-lint", test: "run-tests", build: "run-build" }), both.run, { directories: { "acme/widgets": "widgets" }, deadline: far() });
    expect(observed.observedBy).toBe("verification");
    expect(observed.repositories[0].checks.map((check) => [check.kind, check.status, check.preexisting])).toEqual([
      ["install", "passed", false],
      ["lint", "passed", false],
      ["test", "failed", true],
      ["build", "passed", false],
      ["start", "skipped", false],
    ]);
    // The rerun happens in a second clone, and only for what failed.
    expect(both.scripts.filter((script) => script.includes("before-acme-widgets")).length).toBe(2);

    const onlyAfter = scripted(failing("run-tests", "after-acme-widgets"));
    const caused = await verifyProposal(proposal({ test: "run-tests" }), onlyAfter.run, { directories: { "acme/widgets": "widgets" }, deadline: far() });
    expect(caused.repositories[0].checks[2]).toMatchObject({ status: "failed", exitCode: 1, preexisting: false });
  });

  it("reports what the deadline cut off as not run, never as passed", async () => {
    let now = 1000;
    const { run } = scripted(() => {
      now += 400;
      return {};
    });
    const observed = await verifyProposal(proposal({ lint: "run-lint", test: "run-tests", build: "run-build" }), run, { directories: { "acme/widgets": "widgets" }, deadline: 2000, now: () => now });
    const statuses = observed.repositories[0].checks.map((check) => check.status);
    expect(statuses).not.toContain("failed");
    expect(statuses.filter((status) => status === "not-run").length).toBeGreaterThan(0);
    expect(statuses.slice(statuses.indexOf("not-run"))).toEqual(statuses.slice(statuses.indexOf("not-run")).map((status) => (status === "skipped" ? "skipped" : "not-run")));
  });

  it("stops at the first failing setup step and records it as the install result", async () => {
    const { run, scripts } = scripted(failing("step-one"));
    const observed = await verifyProposal(
      proposal({}, [
        { workingDirectory: ".", script: "step-one" },
        { workingDirectory: "web", script: "step-two" },
      ]),
      run,
      { directories: { "acme/widgets": "widgets" }, deadline: far() },
    );
    expect(observed.repositories[0].checks[0]).toMatchObject({ kind: "install", status: "failed", exitCode: 1, command: "step-one && step-two" });
    expect(scripts.some((script) => script.includes("step-two"))).toBe(false);
  });

  it("reports every check not run when the checkout cannot be found", async () => {
    const { run } = scripted(() => ({}));
    const observed = await verifyProposal(proposal({ test: "run-tests" }), run, { directories: {}, deadline: far() });
    expect(observed.repositories[0].checks.map((check) => check.status)).toEqual(["not-run", "skipped", "not-run", "skipped", "skipped"]);
  });

  it("keeps a command's text from ending or altering the script around it", () => {
    const script = commandScript("after-x", ".", "echo 'TERMINALX_EOF_1'\nTERMINALX_EOF_1\n$(rm -rf /)");
    const delimiter = script.match(/<<'(\S+)'/)![1];
    expect(script.split("\n").filter((line) => line === delimiter)).toHaveLength(1);
  });
});

// The scripts themselves, in a real shell: the ticket's validation of one
// healthy repository and one failing check, with nothing mocked but the
// terminal (each script runs with bash from the "workspace root").
const bash = spawnSync("bash", ["-c", "git --version"]).status === 0;
describe.skipIf(!bash)("verifyProposal, in a real shell", () => {
  const root = mkdtempSync(join(tmpdir(), "tx-verify-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  const repository = (name: string, files: Record<string, string>) => {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    git(directory, "init", "-q", "-b", "main");
    for (const [path, content] of Object.entries(files)) writeFileSync(join(directory, path), content, { mode: 0o755 });
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "init");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory }).toString().trim();
  };
  const run: RunScript = (script, timeoutMs) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn("bash", ["-c", script], { cwd: root, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ exitCode: null, timedOut: true, durationMs: Date.now() - started });
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut: false, durationMs: Date.now() - started });
      });
    });
  const readScratch = async (name: string) => {
    try {
      return readFileSync(join(root, SCRATCH_DIRECTORY, name), "utf8");
    } catch {
      return null;
    }
  };

  it("keeps a healthy repository, a failure the recipe causes and a failure that was already there distinct", async () => {
    // `lint` passes only once setup has made `deps/`; `test` fails whatever is set up; `build` passes.
    const head = repository("widgets", {
      "lint.sh": "#!/bin/bash\ntest -d deps\n",
      "test.sh": "#!/bin/bash\necho 'one test is red'\nexit 3\n",
      "build.sh": "#!/bin/bash\ntest -f deps/installed && echo built > out.txt\n",
    });
    // An uncommitted file in the agent's checkout must not reach the fresh clone.
    writeFileSync(join(root, "widgets", "untracked-by-agent.txt"), "x");
    const healthyHead = repository("api", { "check.sh": "#!/bin/bash\nexit 0\n" });
    const both = [
      { owner: "acme", name: "widgets", defaultBranch: "main" },
      { owner: "acme", name: "api", defaultBranch: "main" },
    ];
    const parsed = parseProposal(
      JSON.stringify({
        installScript: 'echo "machine ok" > "$HOME/.tx-verify-machine-$$" && rm -f "$HOME/.tx-verify-machine-$$"',
        repositories: [
          {
            owner: "acme",
            name: "widgets",
            setup: [{ workingDirectory: ".", script: "mkdir deps && touch deps/installed && test ! -e untracked-by-agent.txt" }],
            commands: { install: "", lint: "./lint.sh", test: "./test.sh", build: "./build.sh", start: "" },
          },
          { owner: "acme", name: "api", setup: [], commands: { install: "", lint: "./check.sh", test: "./check.sh", build: "./check.sh", start: "" } },
        ],
      }),
      both,
    );
    const steps: string[] = [];
    const observed = await verifyProposal(parsed, run, { directories: { "acme/widgets": "widgets", "acme/api": "api" }, deadline: far(), readScratch, onProgress: (step) => steps.push(step) });

    expect(observed.observedBy).toBe("verification");
    expect(observed.machine).toMatchObject({ status: "passed", exitCode: 0 });
    const [widgets, api] = observed.repositories;
    expect(widgets.commit).toBe(head);
    expect(api.commit).toBe(healthyHead);
    expect(widgets.checks.map((check) => [check.kind, check.status, check.exitCode, check.preexisting])).toEqual([
      ["install", "passed", 0, false],
      ["lint", "passed", 0, false],
      // Red before the recipe and after it: shown as failed, and as already failing.
      ["test", "failed", 3, true],
      ["build", "passed", 0, false],
      ["start", "skipped", null, false],
    ]);
    expect(api.checks.map((check) => check.status)).toEqual(["skipped", "passed", "passed", "passed", "skipped"]);
    // The agent's own checkout is untouched: no deps, no build output.
    expect(spawnSync("bash", ["-c", "test ! -e widgets/deps && test ! -e widgets/out.txt"], { cwd: root }).status).toBe(0);
    expect(steps).toContain("acme/widgets: checking failures without the recipe");
  }, 60_000);

  it("shows a failure the recipe itself causes as failed and not as pre-existing", async () => {
    repository("solo", { "lint.sh": "#!/bin/bash\ntest ! -e broken-by-setup\n" });
    const parsed = parseProposal(
      JSON.stringify({ installScript: "", repositories: [{ owner: "acme", name: "solo", setup: [{ workingDirectory: ".", script: "touch broken-by-setup" }], commands: { lint: "./lint.sh" } }] }),
      [{ owner: "acme", name: "solo", defaultBranch: "main" }],
    );
    const observed = await verifyProposal(parsed, run, { directories: { "acme/solo": "solo" }, deadline: far(), readScratch });
    expect(observed.machine).toBeNull();
    expect(observed.repositories[0].checks[1]).toMatchObject({ kind: "lint", status: "failed", exitCode: 1, preexisting: false });
  }, 60_000);

  it("times a command out instead of waiting on it, and says so", async () => {
    repository("slow", { "test.sh": "#!/bin/bash\nsleep 30\n" });
    const parsed = parseProposal(JSON.stringify({ installScript: "", repositories: [{ owner: "acme", name: "slow", setup: [], commands: { test: "./test.sh" } }] }), [{ owner: "acme", name: "slow", defaultBranch: "main" }]);
    const quick: RunScript = (script, timeoutMs) => run(script, script.includes("./test.sh") ? 300 : timeoutMs);
    const observed = await verifyProposal(parsed, quick, { directories: { "acme/slow": "slow" }, deadline: far() });
    expect(observed.repositories[0].checks[2]).toMatchObject({ kind: "test", status: "timed-out", exitCode: null, preexisting: true });
  }, 60_000);
});
