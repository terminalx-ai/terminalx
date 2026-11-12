// The four ways of running a task (docs/ORCHESTRATION-BENCH.md, "Shapes and
// arrangements"), as sessions the runner starts.
//
// An arrangement names tiers, never models. The tier → model family table is
// read from the routing table itself (src-tauri/src/orchestration/routing.rs,
// `Tier::ALL`, `Tier::name` and `Tier::family`) each time the runner starts,
// so the benchmark follows the app when a vendor ships a new model.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARRANGEMENTS } from "./schema.mjs";

/** Where the routing table lives, relative to the repository root. */
export const ROUTING_FILE = "src-tauri/src/orchestration/routing.rs";

/** The agents the runner can start. Claude Code takes a tier's family alias as its model id. */
export const RUNNER_AGENTS = ["claude"];

/**
 * What each arrangement is, in tiers and efforts. `effort: null` leaves the
 * model's own default; a worker field left null leaves it to the piece's kind
 * in the routing table, as the orchestrator guide asks.
 */
export const ARRANGEMENT_SPECS = {
  "top-single": { lead: false, tier: "top", effort: null },
  "large-single": { lead: false, tier: "large", effort: null },
  "lead-mid-workers": { lead: true, tier: "top", effort: null, workers: { tier: "mid", effort: null }, escalateEffort: null },
  "lead-low-escalate": { lead: true, tier: "top", effort: null, workers: { tier: null, effort: "low" }, escalateEffort: "high" },
};

const quoted = (text) => [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]);

/**
 * The tier table in routing.rs's source: `{ tiers, efforts, families }`, with
 * `tiers` lowest first (`small`, `mid`, `large`, `top`), `efforts` lowest
 * first and `families[agent][tier]` the model family. Throws, naming what is
 * missing, when the file no longer has the shape this reads.
 */
export function parseRouting(source) {
  const all = /pub const ALL: \[Tier; \d+\] = \[([^\]]*)\];/.exec(source);
  if (!all) throw new Error(`${ROUTING_FILE}: no Tier::ALL`);
  const variants = all[1].split(",").map((part) => part.trim().replace(/^Tier::/, "")).filter(Boolean);
  const names = new Map([...source.matchAll(/Tier::(\w+) => "([a-z]+)",/g)].map((match) => [match[1], match[2]]));
  const tiers = variants.map((variant) => {
    if (!names.has(variant)) throw new Error(`${ROUTING_FILE}: Tier::name has no name for Tier::${variant}`);
    return names.get(variant);
  });

  const efforts = /pub const EFFORTS: \[&str; \d+\] = \[([^\]]*)\];/.exec(source);
  if (!efforts) throw new Error(`${ROUTING_FILE}: no EFFORTS`);

  const family = /pub fn family\(self, agent: &str\)[\s\S]*?\n {4}\}/.exec(source);
  if (!family) throw new Error(`${ROUTING_FILE}: no Tier::family`);
  const families = {};
  for (const match of family[0].matchAll(/"(\w+)" => Some\(\[([^\]]*)\]\[index\]\)/g)) {
    const list = quoted(match[2]);
    if (list.length !== tiers.length) throw new Error(`${ROUTING_FILE}: Tier::family gives ${match[1]} ${list.length} families for ${tiers.length} tiers`);
    families[match[1]] = Object.fromEntries(tiers.map((tier, index) => [tier, list[index]]));
  }
  if (!Object.keys(families).length) throw new Error(`${ROUTING_FILE}: Tier::family names no agent`);
  return { tiers, efforts: quoted(efforts[1]), families };
}

/** The routing table of the repository at `repoRoot`. */
export function loadRouting(repoRoot) {
  return parseRouting(readFileSync(join(repoRoot, ROUTING_FILE), "utf8"));
}

/**
 * One arrangement made concrete for `agent`: the session's model and effort
 * and, for a lead, what its workers are told to use.
 *
 * Returns `{ name, lead, tier, model, effort, workers, escalateEffort }`;
 * `workers` is `{ tier, model, effort }` (null fields: left to the kind) or
 * null for a single session.
 */
export function resolveArrangement(name, routing, agent = "claude") {
  const spec = ARRANGEMENT_SPECS[name];
  if (!spec || !ARRANGEMENTS.includes(name)) throw new Error(`unknown arrangement ${name}; one of ${ARRANGEMENTS.join(", ")}`);
  if (!RUNNER_AGENTS.includes(agent)) {
    throw new Error(`the runner starts ${RUNNER_AGENTS.join(", ")} sessions only: a ${agent} tier names a model family, and the CLI does not list the installed model ids it would resolve to`);
  }
  const families = routing.families[agent];
  if (!families) throw new Error(`${ROUTING_FILE} has no column for ${agent}`);
  const model = (tier) => {
    if (!routing.tiers.includes(tier)) throw new Error(`${ROUTING_FILE} has no tier ${tier}`);
    return families[tier];
  };
  const effort = (level) => {
    if (level !== null && !routing.efforts.includes(level)) throw new Error(`${ROUTING_FILE} has no effort ${level}`);
    return level;
  };
  return {
    name,
    lead: spec.lead,
    tier: spec.tier,
    model: model(spec.tier),
    effort: effort(spec.effort),
    workers: spec.workers ? { tier: spec.workers.tier, model: spec.workers.tier ? model(spec.workers.tier) : null, effort: effort(spec.workers.effort) } : null,
    escalateEffort: spec.lead ? effort(spec.escalateEffort) : null,
  };
}

/**
 * The first message of every session: one short turn the runner waits for
 * before it moves the session's worktree to the task's start commit and
 * installs dependencies. Its tokens are read before the task is sent and left
 * out of the result, the same way for all four arrangements.
 */
export const WARM_UP_PROMPT = "Reply with the single word ready. Do not read any file and do not run any tool: your task follows in the next message.";

const UNATTENDED = "Nobody is watching this session: do not stop to ask questions. Do not push, open a pull request, deploy or publish.";

/**
 * What the session is sent as its task, after the warm-up. `capDollars`, for
 * a lead, goes into its plan's `budget`, so the run itself also stops starting
 * workers at the run's cap (for workers on an API key; the runner's own
 * readings hold it for every login).
 */
export function taskPrompt(task, arrangement, { capDollars = null } = {}) {
  if (!arrangement.lead) {
    return `${task.prompt}\n\n${UNATTENDED} When you are done, your work is judged by a check run on this checkout.`;
  }
  const workers = [];
  if (arrangement.workers.model) workers.push(`give every piece "model": "${arrangement.workers.model}" (the ${arrangement.workers.tier} tier of the routing table)`);
  else workers.push("leave each piece's model to its kind");
  if (arrangement.workers.effort) workers.push(`give every piece "effort": "${arrangement.workers.effort}"`);
  else workers.push("leave each piece's effort to its kind");
  const lines = [
    "You lead an orchestration run for the task below. Read `terminalx skills get terminalx-orchestrator` first and follow it; the commands are in `terminalx skills get terminalx-cli`.",
    "Hand the task's work to workers through a run: plan it (`terminalx runs create`), start it, check what comes back, and bring the accepted pieces into your branch with `terminalx runs merge --json`. Keep for yourself only the planning, the checking, the merge, and edits that span pieces.",
    `Workers: ${workers.join(", and ")}.`,
  ];
  if (Number.isFinite(capDollars) && capDollars > 0) {
    lines.push(`Put "budget": {"dollars": ${Number(capDollars.toFixed(2))}} in the plan: the benchmark stops the whole run, you included, at that many dollars.`);
  }
  if (arrangement.escalateEffort) {
    lines.push(
      "A piece whose try falls short is tried again by the run without you: first on the same model one effort level up, then one model tier up. Do not stop the run, re-plan or message a worker while such a try is queued or running.",
      `When a piece is still blocked after those tries, run it again at ${arrangement.escalateEffort} effort: once nothing else in the run is under way, stop the run (\`terminalx runs stop --json\`) and create a new run for the pieces still missing, each with "effort": "${arrangement.escalateEffort}".`,
    );
  }
  lines.push(`${UNATTENDED} When your run has ended, your work is judged by a check run on your checkout.`, "", "The task:", "", task.prompt);
  return lines.join("\n");
}
