import type { IssueProvider, IssueUser } from "@/lib/issueOps";

/**
 * The new-issue form's unsent issue, per project and provider. Kept in the
 * module and in local storage, so closing the form by accident, leaving the
 * Issues view or restarting the app loses nothing; cleared once the issue
 * is created.
 */
export interface IssueDraft {
  /** Linear: the team it goes in. */
  teamId: string | null;
  title: string;
  description: string;
  /** The template the description was filled from, by file name. */
  template: string | null;
  assignees: IssueUser[];
  /** Ids as `setLabels` takes them. */
  labels: string[];
  /** Linear: the state to start in; none is the team's default. */
  stateId: string | null;
  /** Linear: 0 to 4; none is no priority. */
  priority: number | null;
}

export const emptyIssueDraft = (teamId: string | null = null): IssueDraft => ({
  teamId,
  title: "",
  description: "",
  template: null,
  assignees: [],
  labels: [],
  stateId: null,
  priority: null,
});

/** Whether anything was typed or picked; the team alone is not. */
export const draftHasContent = (draft: IssueDraft) =>
  !!(draft.title.trim() || draft.description.trim() || draft.assignees.length || draft.labels.length || draft.stateId || draft.priority);

const PREFIX = "terminalx.issueDraft:";
const drafts = new Map<string, IssueDraft>();
const keyOf = (projectPath: string, provider: IssueProvider) => `${PREFIX}${provider}:${projectPath}`;

export function getIssueDraft(projectPath: string, provider: IssueProvider): IssueDraft | null {
  const key = keyOf(projectPath, provider);
  const held = drafts.get(key);
  if (held) return held;
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<IssueDraft> | null;
    if (stored && typeof stored === "object") {
      const draft = { ...emptyIssueDraft(), ...stored };
      drafts.set(key, draft);
      return draft;
    }
  } catch {
    // Storage that can't be read holds no draft.
  }
  return null;
}

export function setIssueDraft(projectPath: string, provider: IssueProvider, draft: IssueDraft) {
  const key = keyOf(projectPath, provider);
  drafts.set(key, draft);
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // The module still holds it for this run.
  }
}

export function clearIssueDraft(projectPath: string, provider: IssueProvider) {
  const key = keyOf(projectPath, provider);
  drafts.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing more to do.
  }
}
