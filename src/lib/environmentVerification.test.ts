import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseProposal } from "./environmentProposal";
import { SCRATCH_DIRECTORY, commandScript, fetchScript, outcomeOf, verifyProposal, type RunScript, type ScriptRun } from "./environmentVerification";

const TOKEN = "token-1";
const COMMIT = "c".repeat(40);
const expected = [{ owner: "acme", name: "widgets", defaultBranch: "main" }];
const proposal = (commands: Record<string, string>, setup = [{ workingDirectory: ".", script: "echo setup" }], installScript = "") =>
  parseProposal(JSON.stringify({ token: TOKEN, installScript, repositories: [{ owner: "acme", name: "widgets", setup, commands }] }), expected, TOKEN);
const far = () => Date.now() + 60 * 60 * 1000;
// What a scripted run "wrote": the fetched commit, and an agent checkout at that commit with nothing changed.
const scratch = async (name: string) => (name.endsWith(".commit") ? `${COMMIT}\n` : name.endsWith(".agent") ? `${COMMIT}\n0\n` : null);

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
  const options = { directories: { "acme/widgets": "widgets" }, deadline: far(), readScratch: scratch };

  it("fetches the branch from GitHub by its canonical address, never from the agent's checkout", async () => {
    const { run, scripts } = scripted(() => ({}));
    const { observations, sources } = await verifyProposal(proposal({ test: "run-tests" }), run, options);
    const fetch = scripts.find((script) => script.includes("git fetch"))!;
    expect(fetch).toContain("'https://github.com/acme/widgets.git' 'refs/heads/main'");
    // The only script that names the agent's checkout is the one that compares it; nothing is cloned or copied from it.
    const touching = scripts.filter((script) => script.includes(`"$ROOT"/'widgets'`));
    expect(touching).toHaveLength(1);
    expect(touching[0]).toContain("git status --porcelain");
    expect(scripts.some((script) => /git clone/.test(script))).toBe(false);
    expect(observations.repositories[0].commit).toBe(COMMIT);
    expect(sources).toEqual([{ owner: "acme", name: "widgets", branch: "main", commit: COMMIT, agentCheckout: "same" }]);
  });

  it("says when the agent's checkout is not what GitHub has, and runs nothing when the fetch fails", async () => {
    const drifted = scripted(() => ({}));
    const ahead = await verifyProposal(proposal({ test: "run-tests" }), drifted.run, { ...options, readScratch: async (name) => (name.endsWith(".commit") ? COMMIT : `${"d".repeat(40)}\n0\n`) });
    expect(ahead.sources[0].agentCheckout).toBe("differs");
    const dirty = await verifyProposal(proposal({ test: "run-tests" }), scripted(() => ({})).run, { ...options, readScratch: async (name) => (name.endsWith(".commit") ? COMMIT : `${COMMIT}\n2\n`) });
    expect(dirty.sources[0].agentCheckout).toBe("differs");

    const offline = scripted((script) => (script.includes("git fetch") ? { exitCode: 95 } : {}));
    const none = await verifyProposal(proposal({ test: "run-tests" }), offline.run, options);
    expect(none.observations.repositories[0].checks.map((check) => check.status)).toEqual(["not-run", "skipped", "not-run", "skipped", "skipped"]);
    expect(none.observations.repositories[0].commit).toBeNull();
    expect(none.sources[0]).toMatchObject({ commit: null, agentCheckout: "unknown" });
    expect(offline.scripts.some((script) => script.includes("run-tests"))).toBe(false);
  });

  it("reruns a failure without the recipe's setup and records whether it fails there too", async () => {
    const both = scripted(failing("run-tests"));
    const { observations } = await verifyProposal(proposal({ lint: "run-lint", test: "run-tests", build: "run-build" }), both.run, options);
    expect(observations.observedBy).toBe("verification");
    expect(observations.repositories[0].checks.map((check) => [check.kind, check.status, check.preexisting])).toEqual([
      ["install", "passed", false],
      ["lint", "passed", false],
      ["test", "failed", true],
      ["build", "passed", false],
      ["start", "skipped", false],
    ]);
    // The rerun happens in a second copy, and only for what failed.
    expect(both.scripts.filter((script) => script.includes("before-acme-widgets")).length).toBe(2);

    const onlyAfter = scripted(failing("run-tests", "after-acme-widgets"));
    const caused = await verifyProposal(proposal({ test: "run-tests" }), onlyAfter.run, options);
    expect(caused.observations.repositories[0].checks[2]).toMatchObject({ status: "failed", exitCode: 1, preexisting: false });
  });

  it("reports what the deadline cut off as not run, never as passed", async () => {
    let now = 1000;
    const { run } = scripted(() => {
      now += 300;
      return {};
    });
    const { observations } = await verifyProposal(proposal({ lint: "run-lint", test: "run-tests", build: "run-build" }), run, { ...options, deadline: 2500, now: () => now });
    const statuses = observations.repositories[0].checks.map((check) => check.status);
    expect(statuses).not.toContain("failed");
    expect(statuses.filter((status) => status === "not-run").length).toBeGreaterThan(0);
    const cut = statuses.indexOf("not-run");
    expect(statuses.slice(cut).every((status) => status === "not-run" || status === "skipped")).toBe(true);
  });

  it("stops at the first failing setup step and records it as the install result", async () => {
    const { run, scripts } = scripted(failing("step-one"));
    const { observations } = await verifyProposal(
      proposal({}, [
        { workingDirectory: ".", script: "step-one" },
        { workingDirectory: "web", script: "step-two" },
      ]),
      run,
      options,
    );
    expect(observations.repositories[0].checks[0]).toMatchObject({ kind: "install", status: "failed", exitCode: 1, command: "step-one && step-two" });
    expect(scripts.some((script) => script.includes("step-two"))).toBe(false);
  });

  it("keeps a command's text, an address and a branch from ending or altering the script around them", () => {
    const script = commandScript("after-x", ".", "echo 'TERMINALX_EOF_1'\nTERMINALX_EOF_1\n$(rm -rf /)");
    const delimiter = script.match(/<<'(\S+)'/)![1];
    expect(script.split("\n").filter((line) => line === delimiter)).toHaveLength(1);
    expect(fetchScript("https://github.com/a/b'; rm -rf /; '.git", "main", "source-x")).toContain(`'https://github.com/a/b'\\''; rm -rf /; '\\''.git'`);
  });

  it("does not fetch a branch whose name is not a plain branch name", async () => {
    const { run, scripts } = scripted(() => ({}));
    const odd = parseProposal(JSON.stringify({ token: TOKEN, installScript: "", repositories: [{ owner: "acme", name: "widgets", setup: [], commands: { test: "t" } }] }), [{ owner: "acme", name: "widgets", defaultBranch: "main;x" }], TOKEN);
    const { observations } = await verifyProposal(odd, run, options);
    expect(scripts.some((script) => script.includes("git fetch"))).toBe(false);
    expect(observations.repositories[0].checks[2].status).toBe("not-run");
  });
});

// The scripts themselves, in a real shell and with real git: the ticket's
// validation of one healthy repository and one failing check. Each "GitHub"
// repository is a directory served as a file:// address; the agent's
// checkout is a clone of it. Nothing is mocked but the terminal: each script
// runs with a non-interactive bash from the "workspace root".
const bash = spawnSync("bash", ["-c", "git --version"]).status === 0;
describe.skipIf(!bash)("verifyProposal, in a real shell", () => {
  const base = mkdtempSync(join(tmpdir(), "tx-verify-"));
  const github = join(base, "github");
  const root = join(base, "workspace");
  mkdirSync(github);
  mkdirSync(root);
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
  /** A repository on "GitHub" and the agent's clone of it in the workspace; returns the remote's commit. */
  const repository = (name: string, files: Record<string, string>) => {
    const remote = join(github, name);
    mkdirSync(remote, { recursive: true });
    git(remote, "init", "-q", "-b", "main");
    for (const [path, content] of Object.entries(files)) writeFileSync(join(remote, path), content, { mode: 0o755 });
    git(remote, "add", "-A");
    git(remote, "commit", "-q", "-m", "init");
    git(root, "clone", "-q", remote, name);
    return git(remote, "rev-parse", "HEAD");
  };
  const run: RunScript = (script, timeoutMs) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn("bash", ["--noprofile", "--norc", "-c", script], { cwd: root, stdio: "ignore" });
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
  const real = (directories: Record<string, string>) => ({ directories, deadline: far(), readScratch, remoteUrl: (_owner: string, name: string) => `file://${join(github, name)}` });
  const one = (name: string, entry: Record<string, unknown>) =>
    parseProposal(JSON.stringify({ token: TOKEN, installScript: "", repositories: [{ owner: "acme", name, ...entry }] }), [{ owner: "acme", name, defaultBranch: "main" }], TOKEN);

  it("keeps a healthy repository and a failing check distinct, at the commit GitHub has", async () => {
    // `lint` passes only once setup has made `deps/`; `test` fails whatever is set up; `build` passes.
    const head = repository("widgets", {
      "lint.sh": "#!/bin/bash\ntest -d deps\n",
      "test.sh": "#!/bin/bash\necho 'one test is red'\nexit 3\n",
      "build.sh": "#!/bin/bash\ntest -f deps/installed && echo built > out.txt\n",
    });
    const healthyHead = repository("api", { "check.sh": "#!/bin/bash\nexit 0\n" });
    const parsed = parseProposal(
      JSON.stringify({
        token: TOKEN,
        installScript: "true",
        repositories: [
          { owner: "acme", name: "widgets", setup: [{ workingDirectory: ".", script: "mkdir deps && touch deps/installed" }], commands: { install: "", lint: "./lint.sh", test: "./test.sh", build: "./build.sh", start: "" } },
          { owner: "acme", name: "api", setup: [], commands: { install: "", lint: "./check.sh", test: "./check.sh", build: "./check.sh", start: "" } },
        ],
      }),
      [
        { owner: "acme", name: "widgets", defaultBranch: "main" },
        { owner: "acme", name: "api", defaultBranch: "main" },
      ],
      TOKEN,
    );
    const steps: string[] = [];
    const { observations, sources } = await verifyProposal(parsed, run, { ...real({ "acme/widgets": "widgets", "acme/api": "api" }), onProgress: (step) => steps.push(step) });

    expect(observations.observedBy).toBe("verification");
    expect(observations.machine).toMatchObject({ status: "passed", exitCode: 0 });
    const [widgets, api] = observations.repositories;
    expect(widgets.commit).toBe(head);
    expect(api.commit).toBe(healthyHead);
    expect(sources.map((source) => source.agentCheckout)).toEqual(["same", "same"]);
    expect(widgets.checks.map((check) => [check.kind, check.status, check.exitCode, check.preexisting])).toEqual([
      ["install", "passed", 0, false],
      ["lint", "passed", 0, false],
      // Red with the recipe's setup and without it: shown as failed, and as also failing without it.
      ["test", "failed", 3, true],
      ["build", "passed", 0, false],
      ["start", "skipped", null, false],
    ]);
    expect(api.checks.map((check) => check.status)).toEqual(["skipped", "passed", "passed", "passed", "skipped"]);
    // The agent's own checkout is untouched: no deps, no build output.
    expect(spawnSync("bash", ["-c", "test ! -e widgets/deps && test ! -e widgets/out.txt"], { cwd: root }).status).toBe(0);
    expect(steps).toContain("acme/widgets: checking failures without the recipe");
  }, 60_000);

  it("is not turned green by an agent that edits a failing test and commits without pushing", async () => {
    const head = repository("gamed", { "test.sh": "#!/bin/bash\nexit 4\n" });
    // The agent "fixes" the test in its own checkout, commits, and does not push.
    writeFileSync(join(root, "gamed", "test.sh"), "#!/bin/bash\nexit 0\n");
    git(join(root, "gamed"), "commit", "-q", "-am", "make the test pass");
    const agentHead = git(join(root, "gamed"), "rev-parse", "HEAD");
    expect(agentHead).not.toBe(head);
    // It also rewrites where "origin" points and its remote-tracking ref, to pass itself off as the remote.
    git(join(root, "gamed"), "remote", "set-url", "origin", join(root, "gamed"));
    git(join(root, "gamed"), "update-ref", "refs/remotes/origin/main", agentHead);

    const { observations, sources } = await verifyProposal(one("gamed", { setup: [], commands: { test: "./test.sh" } }), run, real({ "acme/gamed": "gamed" }));
    expect(observations.repositories[0].commit).toBe(head);
    expect(observations.repositories[0].checks[2]).toMatchObject({ kind: "test", status: "failed", exitCode: 4, preexisting: true });
    expect(sources[0]).toMatchObject({ commit: head, agentCheckout: "differs" });
  }, 60_000);

  it("notices files the agent changed without committing, but not its own proposal file", async () => {
    repository("dirty", { "test.sh": "#!/bin/bash\nexit 0\n" });
    mkdirSync(join(root, "dirty", ".terminalx"));
    writeFileSync(join(root, "dirty", ".terminalx", "environment-recipe.json"), "{}");
    const clean = await verifyProposal(one("dirty", { setup: [], commands: { test: "./test.sh" } }), run, real({ "acme/dirty": "dirty" }));
    expect(clean.sources[0].agentCheckout).toBe("same");
    writeFileSync(join(root, "dirty", "test.sh"), "#!/bin/bash\nexit 0\n# edited\n");
    const edited = await verifyProposal(one("dirty", { setup: [], commands: { test: "./test.sh" } }), run, real({ "acme/dirty": "dirty" }));
    expect(edited.sources[0].agentCheckout).toBe("differs");
    expect(edited.observations.repositories[0].checks[2].status).toBe("passed");
  }, 60_000);

  it("shows a failure the recipe itself causes as failed, not as also failing without it", async () => {
    repository("solo", { "lint.sh": "#!/bin/bash\ntest ! -e broken-by-setup\n" });
    const { observations } = await verifyProposal(one("solo", { setup: [{ workingDirectory: ".", script: "touch broken-by-setup" }], commands: { lint: "./lint.sh" } }), run, real({ "acme/solo": "solo" }));
    expect(observations.machine).toBeNull();
    expect(observations.repositories[0].checks[1]).toMatchObject({ kind: "lint", status: "failed", exitCode: 1, preexisting: false });
  }, 60_000);

  it("runs nothing for a repository it cannot fetch", async () => {
    const { observations, sources } = await verifyProposal(one("missing", { setup: [], commands: { test: "true" } }), run, real({}));
    expect(observations.repositories[0].checks[2].status).toBe("not-run");
    expect(sources[0]).toMatchObject({ commit: null, agentCheckout: "unknown" });
  }, 60_000);

  it("times a command out instead of waiting on it, and says so", async () => {
    repository("slow", { "test.sh": "#!/bin/bash\nsleep 30\n" });
    const quick: RunScript = (script, timeoutMs) => run(script, script.includes("./test.sh") ? 300 : timeoutMs);
    const { observations } = await verifyProposal(one("slow", { setup: [], commands: { test: "./test.sh" } }), quick, real({ "acme/slow": "slow" }));
    expect(observations.repositories[0].checks[2]).toMatchObject({ kind: "test", status: "timed-out", exitCode: null, preexisting: true });
  }, 60_000);
});
