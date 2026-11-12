// Reading the terminalx CLI's answers for the benchmark runner
// (docs/ORCHESTRATION-BENCH.md, `terminalx skills get terminalx-cli`).
//
// Every `--json` answer is an envelope: `{"id", "ok": true, "result": {...}}`
// or `{"id", "ok": false, "error": {"code", "message", "recovery"}}`. Usage
// comes from `terminalx sessions usage <session> --json` (one session) or
// `--children-of <lead>` (a lead and every session it started). Costs are
// estimates at API list prices; a total's `costUsd` is null when there are
// tokens and none of them is priced, and `unpricedModels` names the models a
// cost leaves out. The runner refuses to count either as a known cost.
//
// The fixtures beside this file are real answers captured on this machine.

/** A failed CLI answer, with the CLI's error code. */
export class CliError extends Error {
  constructor(code, message, recovery) {
    super(recovery ? `${message} (${recovery})` : message);
    this.name = "CliError";
    this.code = code;
    this.recovery = recovery ?? null;
  }
}

/** The `result` of one `--json` answer; throws a CliError for a failed or unreadable one. */
export function unwrap(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    throw new CliError("unreadable", `the CLI's answer is not JSON (${error.message}): ${String(text).slice(0, 200)}`);
  }
  if (answer === null || typeof answer !== "object") throw new CliError("unreadable", "the CLI's answer is not a JSON object");
  if (answer.ok === false) {
    const error = answer.error ?? {};
    throw new CliError(typeof error.code === "string" ? error.code : "failed", typeof error.message === "string" ? error.message : "the CLI reported a failure", error.recovery);
  }
  if (answer.ok !== true || !("result" in answer)) throw new CliError("unreadable", "the CLI's answer has neither ok:true with a result nor ok:false with an error");
  return answer.result;
}

const KINDS = [
  ["input", "inputTokens"],
  ["output", "outputTokens"],
  ["cacheRead", "cacheReadTokens"],
  ["cacheWrite", "cacheWriteTokens"],
];

function readTotal(total, where) {
  if (total === null || typeof total !== "object") throw new Error(`${where} has no total`);
  const tokens = {};
  for (const [kind, field] of KINDS) {
    const value = total[field];
    if (!Number.isInteger(value) || value < 0) throw new Error(`${where}: total.${field} is not a token count`);
    tokens[kind] = value;
  }
  const { costUsd } = total;
  if (costUsd !== null && (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)) throw new Error(`${where}: total.costUsd is neither a number nor null`);
  const unpricedModels = Array.isArray(total.unpricedModels) ? total.unpricedModels.filter((model) => typeof model === "string") : [];
  return { costUsd, unpricedModels, tokens };
}

/**
 * The usage in one `sessions usage` result, either form.
 *
 * Returns `{ costUsd, unpricedModels, tokens: { input, output, cacheRead,
 * cacheWrite }, sessionIds }`, with `sessionIds` lead first. `costUsd` is
 * null as the CLI gives it.
 */
export function parseUsage(result) {
  if (result === null || typeof result !== "object") throw new Error("a sessions usage result must be an object");
  if (Array.isArray(result.workers)) {
    // --children-of: `lead` is null once the lead was deleted; `total` covers the lead and every worker.
    const lead = result.lead ?? null;
    const leadId = lead?.sessionId ?? result.parent?.sessionId;
    if (typeof leadId !== "string" || !leadId) throw new Error("a --children-of usage result names no lead");
    const workers = result.workers.map((worker, index) => {
      if (typeof worker?.sessionId !== "string" || !worker.sessionId) throw new Error(`usage workers[${index}] has no sessionId`);
      return worker.sessionId;
    });
    return { ...readTotal(result.total, "usage of the lead and its workers"), sessionIds: [leadId, ...workers] };
  }
  if (typeof result.sessionId !== "string" || !result.sessionId) throw new Error("a sessions usage result names no session");
  return { ...readTotal(result.total, `usage of ${result.sessionId}`), sessionIds: [result.sessionId] };
}

/**
 * Why a usage reading cannot be counted as dollars, or null when it can. A
 * cost that leaves models out would let a run spend past its cap unseen.
 */
export function unknownCost(usage) {
  if (usage.costUsd === null) return "no cost could be read: none of the models used has a price";
  if (usage.unpricedModels.length) return `the cost leaves out ${usage.unpricedModels.join(", ")}, which have no price`;
  return null;
}

/** The empty reading: what a session has used before anything was read. */
export const NO_USAGE = Object.freeze({ costUsd: 0, unpricedModels: [], tokens: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), sessionIds: [] });

/**
 * `after` less `before`: what was used between two readings of the same
 * sessions. Totals only grow, so a kind that went down means the readings
 * are not of the same thing, and that throws.
 */
export function usageSince(after, before) {
  const tokens = {};
  for (const [kind] of KINDS) {
    const used = after.tokens[kind] - before.tokens[kind];
    if (used < 0) throw new Error(`${kind} tokens went down from ${before.tokens[kind]} to ${after.tokens[kind]} between two readings`);
    tokens[kind] = used;
  }
  const costUsd = after.costUsd === null || before.costUsd === null ? null : roundCents(Math.max(0, after.costUsd - before.costUsd), 6);
  const unpricedModels = [...new Set([...after.unpricedModels, ...before.unpricedModels])];
  const sessionIds = [...after.sessionIds, ...before.sessionIds.filter((id) => !after.sessionIds.includes(id))];
  return { costUsd, unpricedModels, tokens, sessionIds };
}

/** `value` rounded to `places` decimal places, so float sums do not print as 1.0703666999999997. */
export function roundCents(value, places = 6) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
