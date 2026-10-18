import type { AssigneeFilter, Issue, IssueFilter } from "@/lib/api";

/**
 * What the Issues list is narrowed to and sorted by, for one project and
 * tracker, as the reader left it (`prefs.issueFilters`). Search text is not
 * kept: it is a moment's question, not a way of looking at the list.
 */
export interface IssueListFilter {
  /** GitHub: `open`, `closed`, `all`. Linear: `open` (neither completed nor canceled), `all`, or a workflow state type. */
  state: string;
  /** Nobody chosen is anyone. A person keeps their name, for the menu before the people are read. */
  assignee: (AssigneeFilter & { name?: string }) | null;
  /** By name. GitHub lists issues with all of them, Linear issues with any of them, as each website does. */
  labels: string[];
  sort: IssueSort;
  /** Linear's team; none is every team. */
  teamId: string | null;
}

export type IssueSort = "updated" | "created" | "created_asc" | "priority";
export type IssueListProvider = "github" | "linear";

export const DEFAULT_ISSUE_FILTER: IssueListFilter = { state: "open", assignee: null, labels: [], sort: "updated", teamId: null };

export const issueFilterKey = (projectPath: string, provider: IssueListProvider) => `${projectPath}\n${provider}`;

export interface Choice<T extends string = string> {
  value: T;
  label: string;
}

export const STATE_CHOICES: Record<IssueListProvider, Choice[]> = {
  github: [
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
    { value: "all", label: "All" },
  ],
  linear: [
    { value: "open", label: "Open" },
    { value: "triage", label: "Triage" },
    { value: "backlog", label: "Backlog" },
    { value: "unstarted", label: "Unstarted" },
    { value: "started", label: "Started" },
    { value: "completed", label: "Completed" },
    { value: "canceled", label: "Canceled" },
    { value: "all", label: "All" },
  ],
};

export const SORT_CHOICES: Record<IssueListProvider, Choice<IssueSort>[]> = {
  github: [
    { value: "updated", label: "Recently updated" },
    { value: "created", label: "Newest" },
    { value: "created_asc", label: "Oldest" },
  ],
  linear: [
    { value: "updated", label: "Recently updated" },
    { value: "created", label: "Newest" },
    { value: "created_asc", label: "Oldest" },
    { value: "priority", label: "Priority" },
  ],
};

function validAssignee(value: unknown): value is IssueListFilter["assignee"] & object {
  const assignee = value as { kind?: unknown; id?: unknown } | null;
  return !!assignee && typeof assignee === "object" && (assignee.kind === "me" || assignee.kind === "unassigned" || (assignee.kind === "person" && typeof assignee.id === "string" && !!assignee.id));
}

/**
 * The reader's filter as kept, made safe for this tracker: a state or sort
 * the other tracker has (a stored filter, a renamed choice) is the default.
 */
export function issueFilterFor(stored: Partial<IssueListFilter> | undefined, provider: IssueListProvider): IssueListFilter {
  const filter = { ...DEFAULT_ISSUE_FILTER, ...stored };
  return {
    state: STATE_CHOICES[provider].some((choice) => choice.value === filter.state) ? filter.state : DEFAULT_ISSUE_FILTER.state,
    assignee: validAssignee(filter.assignee) ? filter.assignee : null,
    labels: Array.isArray(filter.labels) ? filter.labels.filter((label) => typeof label === "string") : [],
    sort: SORT_CHOICES[provider].some((choice) => choice.value === filter.sort) ? filter.sort : DEFAULT_ISSUE_FILTER.sort,
    teamId: provider === "linear" ? filter.teamId ?? null : null,
  };
}

/** What `issues.list` is asked for. */
export function wireFilter(filter: IssueListFilter, search: string): IssueFilter {
  const assignee = filter.assignee ? (filter.assignee.kind === "person" ? { kind: "person" as const, id: filter.assignee.id } : { kind: filter.assignee.kind }) : null;
  return { state: filter.state, assignee, labels: filter.labels, sort: filter.sort, teamId: filter.teamId, search };
}

const closed = (issue: Issue) => issue.stateType === "completed" || issue.stateType === "canceled";

/**
 * Why `issue`, as it is now, would not be listed under `filter`; `null`
 * when it would be, or when that can't be told from the row. Used for an
 * issue changed here since the list was read: it stays in the list, dimmed,
 * with this reason, until the next refresh.
 */
export function filterMiss(issue: Issue, filter: IssueListFilter, provider: IssueListProvider, viewerId: string | null): string | null {
  if (!issue.state) return null;
  const state = filter.state;
  const stateMiss =
    state === "all" ? false
    : state === "open" ? closed(issue)
    : state === "closed" ? !closed(issue)
    // A Linear state type. A row read before its type was listed says only open, started or finished.
    : issue.workflowStateType ? issue.workflowStateType !== state
    : ["started", "completed", "canceled"].includes(state) ? issue.stateType !== state
    : issue.stateType !== "open";
  if (stateMiss) return `Now ${issue.state}`;

  const people = issue.assignees ?? null;
  const assignee = filter.assignee;
  if (assignee && people) {
    if (assignee.kind === "me" && viewerId && !people.some((person) => person.id === viewerId)) return "No longer assigned to you";
    if (assignee.kind === "unassigned" && people.length > 0) return "Now assigned";
    if (assignee.kind === "person" && !people.some((person) => person.id === assignee.id)) return `No longer assigned to ${assignee.name ?? assignee.id}`;
  }

  if (filter.labels.length) {
    const has = new Set(issue.labels.map((label) => label.name.toLowerCase()));
    const wanted = filter.labels.map((label) => label.toLowerCase());
    const matches = provider === "github" ? wanted.every((label) => has.has(label)) : wanted.some((label) => has.has(label));
    if (!matches) return "Labels changed";
  }
  return null;
}
