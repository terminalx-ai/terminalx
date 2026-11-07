import { assertions, scenarios } from "./scenarios.mjs";

export function evaluateRun({ runId, identity, attempts = [], prerequisites = [], cleanup = [], mode = "real" }) {
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
          add("break-is-discriminating", failures.length === 1 && failures[0] === scenario.breaks);
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
  return {
    v: 1, suite: "two-account", runId, mode,
    status: blockers.length || rows.some((row) => row.status === "incomplete") ? "incomplete" : failed ? "failed" : "passed",
    passed: checks.length - failed, failed, failures: checks.filter((check) => !check.ok).map((check) => `${check.section}: ${check.name}`),
    checks, scenarios: rows, prerequisites: blockers, identity: identity ?? null, attempts, cleanup,
  };
}

export const exitCode = (report) => report.status === "passed" ? 0 : report.status === "incomplete" ? 2 : 1;
