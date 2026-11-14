import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRun, redact, retainRuns, saveJson, verifyArtifacts } from "./artifacts.mjs";
import { command, terminalxResult } from "./process.mjs";
import { desktopEnvironment, nativeObserver } from "./native.mjs";
import { run } from "./run.mjs";
import { finalizeRun } from "./results.mjs";

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "team-harness-unit-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("preflight writes a non-green report for every required scenario without launching anything", async (t) => {
  const path = await temporary(t);
  const { report, code, directory } = await run(["--preflight", "--artifacts", path]);
  assert.equal(code, 2);
  assert.equal(report.scenarios.length, 11);
  assert.ok(report.scenarios.every((r) => r.status === "incomplete"));
  assert.deepEqual(report.execution.activePids, []);
  assert.equal(report.execution.started, false);
  assert.equal(JSON.parse(await readFile(join(directory, "result.json"))).status, "incomplete");
});
test("artifacts are immutable and credentials are redacted", async (t) => {
  const { directory } = await createRun(await temporary(t));
  const value = { accessToken: "sensitive", nested: { password: "another" }, text: "Bearer xyz https://local/callback?code=abc&state=def", database: "postgresql://user:pass@127.0.0.1/db" };
  await saveJson(directory, "result.json", value);
  const content = await readFile(join(directory, "result.json"), "utf8");
  for (const secret of ["sensitive", "another", "xyz", "abc", "def", "user:pass"]) assert.equal(content.includes(secret), false);
  await assert.rejects(saveJson(directory, "result.json", {}), { code: "EEXIST" });
  assert.equal(redact({ refreshToken: "x" }).refreshToken, "[redacted]");
});
test("retention removes only finished owned runs, leaves active, unrelated and symlinked paths", async (t) => {
  const root = await temporary(t);
  const old = await createRun(root);
  await saveJson(old.directory, "result.json", { runId: old.runId, finishedAt: "yesterday" });
  const active = await createRun(root);
  await mkdir(join(root, "unrelated"));
  await symlink(old.directory, join(root, "team-00000000-0000-0000-0000-000000000000"));
  const removed = await retainRuns(root, { now: Date.now() + 30 * 86_400_000 });
  assert.deepEqual(removed, [old.directory]);
  assert.ok((await readdir(root)).includes(active.runId));
  assert.ok((await readdir(root)).includes("unrelated"));
});
test("evidence hashes, containment and PNG identity are verified", async (t) => {
  const root = await temporary(t);
  const { directory } = await createRun(root);
  const bytes = Buffer.from("owned log");
  await writeFile(join(directory, "trace.log"), bytes);
  const entry = { path: "trace.log", kind: "log", sha256: createHash("sha256").update(bytes).digest("hex") };
  await verifyArtifacts(directory, [entry]);
  await assert.rejects(verifyArtifacts(directory, [{ ...entry, sha256: "0".repeat(64) }]), /hash/);
  await assert.rejects(verifyArtifacts(directory, [{ ...entry, kind: "screenshot" }]), /PNG/);
  await writeFile(join(root, "outside.log"), bytes);
  await symlink(join(root, "outside.log"), join(directory, "escape.log"));
  await assert.rejects(verifyArtifacts(directory, [{ ...entry, path: "escape.log" }]), /escapes/);
});
test("owned command deadline retains PID and exit; output limit is bounded", async () => {
  await assert.rejects(command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 80 }), (error) => {
    assert.equal(error.message, "command_timeout");
    assert.ok(error.result.pid > 1);
    assert.ok(error.result.signal);
    return true;
  });
  await assert.rejects(command(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { maxBytes: 100 }), /output_limit/);
});
test("TerminalX typed refusals are terminal, even with exit zero", () => {
  for (const code of ["own_app_protected", "internal", "busy", "confirmation_pending", "forbidden"]) {
    assert.throws(() => terminalxResult({ code: 0, stdout: JSON.stringify({ ok: false, error: { code } }) }), new RegExp(code));
  }
});
test("native observer cannot click before a snapshot or repeatedly reuse an index", async () => {
  const calls = [];
  const observer = nativeObserver({ pid: 555, run: async (...args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ ok: true, result: { snapshot: { app: { pid: 555 }, treeText: "42 button Test-only fixture" } } }) }; } });
  await assert.rejects(observer.click(42), /fresh/);
  await observer.snapshot();
  await assert.rejects(observer.click(1), /fresh/);
  await observer.click(42);
  await assert.rejects(observer.click(42), /fresh/);
  assert.equal(calls.length, 2);
});
test("desktop process environment fences credentials and Keychain per account", () => {
  const base = { runId: "team-12345678-1234-1234-1234-123456789abc", directory: "/tmp/owned", apiOrigin: "http://127.0.0.1:42220" };
  const env = desktopEnvironment({ ...base, account: "A" }, { PATH: "/bin", HOME: "/Users/test", TERMINALX_NEXT_TOKEN: "real", AWS_SECRET_ACCESS_KEY: "real" });
  assert.equal(env.TERMINALX_NEXT_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.notEqual(env.RACCOON_DEV_KEYCHAIN_SERVICE, desktopEnvironment({ ...base, account: "B" }).RACCOON_DEV_KEYCHAIN_SERVICE);
  assert.throws(() => desktopEnvironment({ ...base, account: "A", apiOrigin: "https://login.terminalx.ai" }), /loopback/);
});
test("a failed native refresh invalidates every previously selected element", async () => {
  for (const failure of ["own_app_protected", "busy", "timeout", "invalid-json"]) {
    let count = 0;
    const observer = nativeObserver({ pid: 555, run: async () => {
      count++;
      return { code: 0, stdout: count === 1 ? JSON.stringify({ ok: true, result: { snapshot: { app: { pid: 555 }, treeText: "42 button Fixture" } } }) : failure === "invalid-json" ? "broken" : JSON.stringify({ ok: false, error: { code: failure } }) };
    } });
    await observer.snapshot();
    await assert.rejects(observer.snapshot());
    await assert.rejects(observer.click(42), /fresh/);
    assert.equal(count, 2);
  }
});
test("finalization refuses fabricated labels, mismatched provenance, and missing evidence", async (t) => {
  const { directory, runId } = await createRun(await temporary(t));
  await assert.rejects(finalizeRun({ mode: "contract-test", runId }, directory), /real native/);
  await assert.rejects(finalizeRun({ mode: "real", runId }, directory), /provenance/);
  const identity = { runId, accountA: "alice", accountB: "bob", machineA: "mac-a", machineB: "mac-b", desktopHeadA: "a".repeat(40), desktopHeadB: "a".repeat(40), serverHead: "b".repeat(40) };
  const side = (name, pid) => ({ platform: "darwin", machineId: identity[`machine${name}`], pid, head: identity[`desktopHead${name}`], accountId: identity[`account${name}`], binarySha256: "c".repeat(64) });
  const provenance = { runId, source: "terminalx-native-capture-v1", serverHead: identity.serverHead, A: side("A", 55), B: side("B", 66) };
  const attempt = { id: "unit", provenance: { runId, ...provenance.B }, artifacts: [{ kind: "log", path: "missing.log", sha256: "d".repeat(64) }] };
  await assert.rejects(finalizeRun({ mode: "real", runId, identity, provenance, attempts: [attempt] }, directory), /ENOENT/);
  await assert.rejects(finalizeRun({ mode: "real", runId, identity, provenance, attempts: [{ ...attempt, provenance: { ...attempt.provenance, pid: 67 } }] }, directory), /Stale/);
  const observation = { runId, orgId: "org", observerId: "bob" };
  const captured = { runId, source: "terminalx-native-capture-v1", attemptId: attempt.id, observation, provenance: attempt.provenance };
  const bytes = Buffer.from(JSON.stringify(captured));
  await writeFile(join(directory, "observation.log"), bytes);
  const evidence = { ...attempt, observation, scenario: "share", phase: "baseline", status: "completed", source: "terminalx-native", artifacts: [{ kind: "log", path: "observation.log", sha256: createHash("sha256").update(bytes).digest("hex") }] };
  const result = await finalizeRun({ mode: "real", runId, identity, provenance, attempts: [evidence] }, directory);
  assert.equal(result.evidenceValidation.state, "files-and-provenance-validated");
  assert.equal(result.status, "incomplete");
  assert.equal(result.certification.state, "native-recorder-unavailable");
  await writeFile(join(directory, "observation.log"), "tampered");
  await assert.rejects(finalizeRun({ mode: "real", runId, identity, provenance, attempts: [evidence] }, directory), /hash mismatch/);
});

test("missing local server and second Mac produce actionable pending prerequisites", async (t) => {
  const { report, code } = await run(["--artifacts", await temporary(t)]);
  assert.equal(code, 2);
  assert.ok(report.prerequisites.some((s) => /Local server prerequisite.*127\.0\.0\.1/.test(s)));
  assert.ok(report.prerequisites.some((s) => /second Mac/.test(s)));
  assert.deepEqual(report.attempts, []);
  assert.deepEqual(report.coverage, { native: "pending", server: "pending", realDeliberateBreaks: "pending" });
  assert.equal(report.nightly.collectionOnly, true);
});

test("config cannot bypass recorder gate, certify or contact remote endpoints", async (t) => {
  const path = await temporary(t);
  const configPath = join(path, "config.json");
  for (const apiOrigin of ["https://production.example", "http://127.0.0.1:42220"]) {
    await writeFile(configPath, JSON.stringify({ apiOrigin, serverCheckout: "/not-started", machineA: "A", machineB: "B", debugBuilds: true, certified: true, observations: [{ ok: true }] }));
    const { report, code } = await run(["--config", configPath, "--artifacts", path]);
    assert.equal(code, 2);
    assert.equal(report.execution.started, false);
    assert.equal(report.certification.state, "unverified");
    assert.ok(report.scenarios.every((row) => row.status === "incomplete"));
    assert.ok(report.prerequisites.some((s) => /Native driver prerequisite/.test(s)));
    assert.equal(report.prerequisites.some((s) => /Production\/remote endpoints/.test(s)), apiOrigin.startsWith("https"));
  }
});

test("bad CLI and config fail before creating run artifacts", async (t) => {
  const root = await temporary(t);
  for (const args of [["--adapter", "anything"], ["--config"], ["--artifacts", "--preflight"]]) {
    await assert.rejects(run([...args]), /argument/i);
  }
  const config = join(root, "bad.json");
  for (const value of ["{broken", "null", "[]"]) {
    await writeFile(config, value);
    await assert.rejects(run(["--config", config, "--artifacts", join(root, "runs")]));
  }
  assert.deepEqual(await readdir(root), ["bad.json"]);
});

test("command spawn failure, nonzero exit and forced termination retain actual outcomes", async () => {
  await assert.rejects(command("/nonexistent/team-e2e-command", []), { code: "ENOENT" });
  const failed = await command(process.execPath, ["-e", "process.stderr.write('fixture failed'); process.exit(7)"]);
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /fixture failed/);
  await assert.rejects(command(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 300 }), (error) => {
    assert.equal(error.message, "command_timeout");
    assert.equal(error.result.signal, "SIGKILL");
    assert.throws(() => process.kill(error.result.pid, 0), { code: "ESRCH" });
    return true;
  });
});

test("retention does not trust symlinked completion markers", async (t) => {
  const root = await temporary(t);
  const run = await createRun(root);
  const outside = join(root, "foreign.json");
  await writeFile(outside, JSON.stringify({ runId: run.runId, finishedAt: "yesterday" }));
  await symlink(outside, join(run.directory, "result.json"));
  assert.deepEqual(await retainRuns(root, { now: Date.now() + 30 * 86_400_000 }), []);
});

test("artifact redaction catches API key names and credential values under ordinary keys", async (t) => {
  const { directory } = await createRun(await temporary(t));
  const value = { apiKey: "named-one", api_key: "named-two", secret: "named-three", password: "named-four", authorization: "named-five", nested: [{ text: "sk-proj-Abc_123 ghp_Abc123 gho_Abc123", harmless: "tool version 24.2" }] };
  await saveJson(directory, "secrets.json", value);
  const saved = await readFile(join(directory, "secrets.json"), "utf8");
  for (const secret of ["named-one", "named-two", "named-three", "named-four", "named-five", "sk-proj-Abc_123", "ghp_Abc123", "gho_Abc123"]) assert.equal(saved.includes(secret), false);
  assert.ok(saved.includes("tool version 24.2"));
});
test("nightly collector actions use immutable commit pins", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/team-e2e-nightly.yml", import.meta.url), "utf8");
  const uses = [...workflow.matchAll(/uses:\s+(actions\/[a-z-]+)@([^\s]+)/g)];
  assert.equal(uses.length, 3);
  for (const [, action, ref] of uses) assert.match(ref, /^[a-f0-9]{40}$/, action);
});
