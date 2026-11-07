import { assertions, scenarios } from "./scenarios.mjs";
import { verifyArtifacts } from "./artifacts.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function evaluateRun({ runId, identity, attempts = [], prerequisites = [], cleanup = [], mode = "contract-test" }) {
  const checks = [];
  const rows = [];
  const blockers = [...prerequisites];
  if (mode !== "real") blockers.push("Contract-test observations are not two-desktop E2E evidence.");
  if (!identity || identity.runId !== runId) blockers.push("Missing or mismatched run identity.");
  if (identity) {
    if (!identity.machineA || !identity.machineB || identity.machineA === identity.machineB) blockers.push("Two distinct machines are required.");
    if (identity.platformA !== "darwin" || identity.platformB !== "darwin") blockers.push("Both desktops must run the macOS product runtime.");
    for (const field of ["desktopHeadA", "desktopHeadB", "serverHead"]) {
      if (!/^[a-f0-9]{40}$/.test(identity[field] ?? "")) blockers.push(`Missing exact ${field}.`);
    }
  }
  const seen = new Set();
  for (const attempt of attempts) {
    if (!scenarios.some((scenario) => scenario.id === attempt.scenario)) blockers.push(`Unknown scenario ${attempt.scenario}.`);
    if (!attempt.id || seen.has(attempt.id)) blockers.push("Missing or duplicate attempt ID.");
    seen.add(attempt.id);
    if (!["baseline", "deliberate-break"].includes(attempt.phase)) blockers.push(`Unknown phase ${attempt.phase}.`);
  }
  for (const scenario of scenarios) {
    const history = attempts.filter((attempt) => attempt.scenario === scenario.id);
    const rowChecks = [];
    let incomplete = false;
    for (const phase of ["baseline", "deliberate-break"]) {
      const phases = history.filter((attempt) => attempt.phase === phase);
      if (!phases.length) { incomplete = true; continue; }
      for (const attempt of phases) {
        const prefix = `${attempt.id}/${phase}`;
        const add = (name, ok) => rowChecks.push({ section: scenario.id, name: `${prefix}/${name}`, ok: ok === true });
        if (attempt.status !== "completed" || !attempt.observation) {
          incomplete ||= ["not-run", "skipped", "incomplete"].includes(attempt.status);
          add(attempt.reason || "execution-incomplete", false);
          continue;
        }
        add("real-runtime-observation", attempt.source === "terminalx-native" && mode === "real");
        add("evidence-recorded", Array.isArray(attempt.artifacts) && attempt.artifacts.some((a) => a.kind === "screenshot") && attempt.artifacts.some((a) => a.kind === "log") && attempt.artifacts.every((a) => /^[a-f0-9]{64}$/.test(a.sha256 ?? "") && typeof a.path === "string"));
        const observed = assertions(scenario.id, attempt.observation, identity ?? {});
        if (phase === "baseline") {
          for (const check of observed) add(check.name, check.ok);
        } else {
          const failures = observed.filter((check) => !check.ok).map((check) => check.name);
          add("controlled-break-installed", attempt.break?.installed === true && attempt.break?.restored === true && attempt.break?.target === scenario.breaks && attempt.break?.runId === runId);
          add("expected-regression-detected", failures.includes(scenario.breaks));
          // An identity/setup fault is not a successful regression demonstration.
          const expectedFailures = new Set([scenario.breaks, ...(scenario.consequences ?? [])]);
          add("break-is-discriminating", failures.length > 0 && failures.every((name) => expectedFailures.has(name)));
        }
      }
    }
    if (!history.some((a) => a.phase === "baseline") || !history.some((a) => a.phase === "deliberate-break")) rowChecks.push({ section: scenario.id, name: "both-real-phases-required", ok: false });
    checks.push(...rowChecks);
    rows.push({ scenario: scenario.id, status: incomplete ? "incomplete" : rowChecks.every((c) => c.ok) ? "passed" : "failed", attempts: history.map((a) => a.id) });
  }
  for (const item of cleanup) checks.push({ section: "cleanup", name: item.name, ok: item.ok === true });
  if (!cleanup.length) blockers.push("Owned-resource cleanup has not been verified.");
  for (const blocker of blockers) checks.push({ section: "prerequisites", name: blocker, ok: false });
  const failed = checks.filter((check) => !check.ok).length;
  const assertionStatus = blockers.length || rows.some((row) => row.status === "incomplete") ? "incomplete" : failed ? "failed" : "passed";
  return {
    v: 1, suite: "two-account", runId, mode,
    status: assertionStatus === "passed" ? "incomplete" : assertionStatus,
    assertionStatus, certification: { state: "unverified" },
    passed: checks.length - failed, failed, failures: checks.filter((check) => !check.ok).map((check) => `${check.section}: ${check.name}`),
    checks, scenarios: rows, prerequisites: blockers, identity: identity ?? null, attempts, cleanup,
  };
}

/** Disk evidence and capture provenance must be checked again when a report is posted. */
export async function finalizeRun(input, directory) {
  if (input.mode !== "real") throw new Error("Only real native execution can be certified");
  const marker = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
  if (marker.owner !== "terminalx-two-account-v1" || marker.runId !== input.runId) throw new Error("Evidence directory is not owned by this run");
  const provenance = input.provenance;
  const identity = input.identity;
  if (!provenance || provenance.runId !== input.runId || provenance.source !== "terminalx-native-capture-v1" || !identity) throw new Error("Native capture provenance is required");
  for (const side of ["A", "B"]) {
    const machine = provenance[side];
    if (!machine || machine.platform !== "darwin" || machine.machineId !== identity[`machine${side}`] || !Number.isSafeInteger(machine.pid) || machine.pid <= 1 || !/^[a-f0-9]{64}$/.test(machine.binarySha256 ?? "") || machine.head !== identity[`desktopHead${side}`] || machine.accountId !== identity[`account${side}`]) throw new Error(`Invalid native provenance for desktop ${side}`);
  }
  if (provenance.A.machineId === provenance.B.machineId || provenance.serverHead !== identity.serverHead) throw new Error("Machine or server provenance mismatch");
  for (const attempt of input.attempts ?? []) {
    if (!attempt.provenance || attempt.provenance.runId !== input.runId || attempt.provenance.machineId !== provenance.B.machineId || attempt.provenance.pid !== provenance.B.pid || attempt.provenance.binarySha256 !== provenance.B.binarySha256 || attempt.provenance.accountId !== identity.accountB || attempt.provenance.head !== identity.desktopHeadB) throw new Error("Stale attempt provenance");
    const verified = await verifyArtifacts(directory, attempt.artifacts ?? []);
    const log = attempt.artifacts.find((a) => a.kind === "log");
    if (!log) throw new Error("Observation log missing");
    // Logs carry the observed values, so a report cannot silently replace its evidence.
    const captured = JSON.parse(verified.get(log.path).toString());
    if (captured.runId !== input.runId || captured.attemptId !== attempt.id || captured.source !== "terminalx-native-capture-v1" || JSON.stringify(captured.observation) !== JSON.stringify(attempt.observation) || JSON.stringify(captured.provenance) !== JSON.stringify(attempt.provenance)) throw new Error("Observation does not match captured log");
  }
  // There is no native recorder in this checkpoint. Files plus caller-supplied
  // provenance are useful evidence to inspect, but cannot prove actual execution.
  // Keep certification closed until the real two-Mac recorder is implemented/reviewed.
  return { ...evaluateRun(input), provenance, evidenceValidation: { state: "files-and-provenance-validated" }, certification: { state: "native-recorder-unavailable" } };
}

export const exitCode = (report) => report.status === "passed" ? 0 : report.status === "incomplete" ? 2 : 1;
