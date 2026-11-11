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
/**
 * What the session's workspace holds, as the runtime last read it: changes not
 * committed, commits its default branch does not have, or neither. Absent or
 * null while unknown, and for a session that does not carry its branch.
 */
export type WorkState = "uncommitted" | "committed" | "none";
export interface SessionStatusInput {
  tabs: readonly StatusTab[];
  branch?: string | null;
  branchStatus?: BranchStatus | null;
  work?: WorkState | null;
  /** False only when nothing has been sent to the agent yet. Absent is unknown. */
  started?: boolean | null;
  /** Another session on this branch carries its PR and workspace state (see `sharedBranchSessions`). */
  sharedBranch?: boolean | null;
}
export interface StatusDescription {
  id: string;
  /** The row label: one of the screens' set (Working, Needs approval, …). */
  label: string;
  /** The model's own state behind the label, for tooltips and the detail pane. */
  detail: string;
  icon: string;
  color: string;
  tooltip: string;
  /** The open pull request the label is about, appended where the full label shows. */
  pr?: number | null;
}

type Rule = (typeof rules)[number];
type Condition = { path: string; values: unknown[] };
function description({ id, label, detail, icon, color, tooltip }: Rule, pr: number | null = null): StatusDescription {
  return { id, label, detail, icon, color, tooltip, pr };
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

function facts(input: SessionStatusInput) {
  const branchStatus = input.branchStatus?.checked && input.branchStatus.branch === input.branch ? input.branchStatus : undefined;
  return { ...input, branchStatus };
}

function select(input: SessionStatusInput): StatusDescription {
  const known = facts(input);
  const rule = rules.find((rule) => (rule.when as Condition[][]).some((all) => all.every(({ path, values }) => valuesAt(known, path.split(".")).some((value) => values.some((pattern) => matches(value, pattern))))))!;
  return description(rule, "showsPr" in rule && rule.showsPr ? known.branchStatus?.pr?.number ?? null : null);
}

/**
 * One presentation status, independent of lifecycle, unread state or ownership.
 * Rules are ordered: attention, active agent work, the branch's PR, then the
 * workspace. The Rust CLI reads this same decision table; it has no separate precedence.
 */
export function sessionStatus(input: SessionStatusInput): StatusDescription {
  return select(input);
}

/** A collapsed branch row represents all its sessions; attention in any one wins. */
export function combinedSessionStatus(sessions: readonly SessionStatusInput[]): StatusDescription {
  const selected = sessions.map(select);
  for (const rule of rules) {
    const found = selected.find((status) => status.id === rule.id);
    if (found) return found;
  }
  return select({ tabs: [] });
}

/** The full label, as the overview shows it: 'Checks failing · PR #781'. */
export function statusText(status: Pick<StatusDescription, "label" | "pr">): string {
  return status.pr ? `${status.label} · PR #${status.pr}` : status.label;
}

/** Tooltip text naming the model state behind the label, with the PR it is about. */
export function statusTooltip(status: Pick<StatusDescription, "tooltip" | "pr">): string {
  return status.pr ? `${status.tooltip} PR #${status.pr}.` : status.tooltip;
}

export const SESSION_STATUSES: readonly StatusDescription[] = rules.map((rule) => description(rule));

export interface BranchMember {
  id: string;
  /** The project the branch is in; branches of the same name in two projects are not shared. */
  project: string;
  branch?: string | null;
  /** When the session was last active: its latest message, else when it was made (RFC 3339). */
  activeAt: string;
}

/** RFC 3339 only, as the runtime's chrono parser reads it; anything else counts as the epoch. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const activeTime = (time: string) => (RFC3339.test(time) && Date.parse(time.replace(" ", "T"))) || 0;

/**
 * The reference statement of the shared-branch rule. The runtime applies its
 * Rust twin (`shared_branch_sessions`); both are checked against
 * `sharedBranchCases.json`, so the two cannot drift.
 *
 * Sessions on one branch share its PR and workspace: the most recently active
 * one carries them, the others show only their agent state. Ties go to the
 * smaller id so every reader picks the same session. Returns the ids that do
 * not carry their branch.
 */
export function sharedBranchSessions(members: readonly BranchMember[]): Set<string> {
  const carriers = new Map<string, BranchMember>();
  for (const member of members) {
    if (!member.branch) continue;
    const key = `${member.project}\u0000${member.branch}`;
    const held = carriers.get(key);
    const time = activeTime(member.activeAt);
    const heldTime = held ? activeTime(held.activeAt) : -Infinity;
    if (!held || time > heldTime || (time === heldTime && member.id < held.id)) carriers.set(key, member);
  }
  const carrying = new Set([...carriers.values()].map((member) => member.id));
  return new Set(members.filter((member) => member.branch && !carrying.has(member.id)).map((member) => member.id));
}
