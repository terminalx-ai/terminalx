import rules from "./sessionStatusRules.json";

export type AgentActivity = "needs_permission" | "needs_answer" | "review_plan" | "setting_up" | "setup_failed" | "stopping" | "background";
export interface StatusTab {
  status: "idle" | "in_progress" | "completed" | "waiting";
  activity?: AgentActivity | null;
}
export interface BranchStatus {
  /** The branch this observation belongs to. Never apply it to another branch. */
  branch: string;
  checked: boolean;
  /** True only when the observed local branch tip equals the associated PR head. */
  headMatches?: boolean | null;
  pr?: {
    number: number;
    state: string;
    draft: boolean;
    mergeable: string;
    mergeStateStatus: string;
    checks: string | null;
    inMergeQueue: boolean;
  } | null;
}
export interface SessionStatusInput {
  tabs: readonly StatusTab[];
  branch?: string | null;
  branchStatus?: BranchStatus | null;
}
export interface StatusDescription {
  id: string;
  label: string;
  icon: string;
  color: string;
  tooltip: string;
}

type Condition = { path: string; values: unknown[] };
function description({ id, label, icon, color, tooltip }: StatusDescription): StatusDescription {
  return { id, label, icon, color, tooltip };
}

function valuesAt(value: unknown, path: string[]): unknown[] {
  if (!path.length) return [value];
  const [key, ...rest] = path;
  if (key === "*") return Array.isArray(value) ? value.flatMap((item) => valuesAt(item, rest)) : [];
  return valuesAt(value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, rest);
}

function matches(value: unknown, pattern: unknown): boolean {
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    return !!value && typeof value === "object" && Object.entries(pattern).every(([key, expected]) => matches((value as Record<string, unknown>)[key] ?? null, expected));
  }
  return value === pattern;
}

/**
 * One presentation status, independent of lifecycle, unread state or ownership.
 * Rules are ordered: attention, active agent work, then the branch's PR.
 * The Rust CLI reads this same decision table; it has no separate precedence.
 */
export function sessionStatus(input: SessionStatusInput): StatusDescription {
  const branchStatus = input.branchStatus?.checked && input.branchStatus.branch === input.branch ? input.branchStatus : undefined;
  const facts = { ...input, branchStatus };
  return description(rules.find((rule) => (rule.when as Condition[][]).some((all) => all.every(({ path, values }) => valuesAt(facts, path.split(".")).some((value) => values.some((pattern) => matches(value, pattern))))))!);
}

/** A collapsed branch row represents all its sessions; attention in any one wins. */
export function combinedSessionStatus(sessions: readonly SessionStatusInput[]): StatusDescription {
  const selected = sessions.map(sessionStatus);
  return description(rules.find((rule) => selected.some((status) => status.id === rule.id)) ?? sessionStatus({ tabs: [] }));
}

export const SESSION_STATUSES: readonly StatusDescription[] = rules.map(description);
