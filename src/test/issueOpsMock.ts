/**
 * A stand-in for the issue-operations backend (`src/lib/issueOps.ts`), for
 * component tests. It holds one GitHub and one Linear issue with comments
 * and picker options, answers every `issue_*` command from them, and applies
 * writes the way the provider would, so a test sees the re-read issue a
 * real write answers with.
 *
 *   const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
 *   vi.mock("@tauri-apps/api/core", () => ({ invoke }));
 *   const issues = createIssueOpsMock();
 *   invoke.mockImplementation((command, args) => issues.handle(command, args) ?? otherCommands(command, args));
 *
 * `handle` answers `undefined` for commands that are not issue operations,
 * so a test's own handlers compose with it. `fail` makes the next call of a
 * command reject with an `IssueOpError` of the given kind; `calls` records
 * every issue command answered.
 */
import type {
  CommentsPage,
  IssueComment,
  IssueCreate,
  IssueDetails,
  IssueOpError,
  IssueOpErrorKind,
  IssueOptions,
  IssueProvider,
  IssueUser,
  StateChange,
} from "@/lib/issueOps";

const sam: IssueUser = { id: "sam", name: "sam", login: "sam", avatarUrl: "https://avatars.githubusercontent.com/u/12?v=4" };
const alex: IssueUser = { id: "alex", name: "alex", login: "alex", avatarUrl: "https://avatars.githubusercontent.com/u/13?v=4" };
const kim: IssueUser = { id: "kim", name: "kim", login: "kim", avatarUrl: "https://avatars.githubusercontent.com/u/11?v=4" };
const linearSam: IssueUser = { id: "user-sam", name: "Sam", avatarUrl: "https://example.com/sam.png" };
const linearKim: IssueUser = { id: "user-kim", name: "Kim" };

export const githubIssueFixture = (): IssueDetails => ({
  provider: "github",
  id: "41",
  nodeId: "I_kwDOExample41",
  identifier: "#41",
  number: 41,
  title: "Repair the login timeout",
  url: "https://github.com/acme/widgets/issues/41",
  state: "Open",
  stateType: "open",
  labels: [{ id: "bug", name: "bug", color: "d73a4a" }],
  assignee: { name: sam.name, avatarUrl: sam.avatarUrl },
  updatedAt: "2026-09-02T10:00:00Z",
  body: "The session expires while a command is running.",
  description: "The session expires while a command is running.",
  closeReason: null,
  assignees: [sam, alex],
  author: kim,
  createdAt: "2026-09-01T09:00:00Z",
  repo: "acme/widgets",
  capabilities: { workflowStates: false, closeReasons: true, priority: false, multiAssignee: true, maxAssignees: 10 },
});

export const linearIssueFixture = (): IssueDetails => ({
  provider: "linear",
  id: "8a1c2e9e-0000-4000-8000-000000000042",
  identifier: "ENG-42",
  number: 42,
  title: "Fix login timeout",
  url: "https://linear.app/acme/issue/ENG-42/fix-login-timeout",
  state: "In Progress",
  stateType: "started",
  workflowStateType: "started",
  labels: [{ id: "label-bug", name: "Bug", color: "eb5757" }],
  assignee: { name: linearSam.name, avatarUrl: linearSam.avatarUrl },
  updatedAt: "2026-09-02T10:00:00.000Z",
  body: "Users get logged out.",
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  description: "Users get logged out.",
  stateId: "state-started",
  stateColor: "f2c94c",
  assignees: [linearSam],
  priority: 2,
  author: linearKim,
  createdAt: "2026-09-01T09:00:00.000Z",
  capabilities: { workflowStates: true, closeReasons: false, priority: true, multiAssignee: false, maxAssignees: 1 },
});

export const githubOptionsFixture = (): IssueOptions => ({
  provider: "github",
  states: [],
  closeReasons: ["completed", "not_planned"],
  members: [sam, alex, kim],
  labels: [
    { id: "bug", name: "bug", color: "d73a4a", description: "Something isn't working", isGroup: false },
    { id: "enhancement", name: "enhancement", color: "a2eeef", isGroup: false },
  ],
  priorities: [],
  capabilities: githubIssueFixture().capabilities,
});

export const linearOptionsFixture = (): IssueOptions => ({
  provider: "linear",
  states: [
    { id: "state-backlog", name: "Backlog", type: "backlog", color: "bec2c8", position: 0 },
    { id: "state-todo", name: "Todo", type: "unstarted", color: "e2e2e2", position: 1 },
    { id: "state-started", name: "In Progress", type: "started", color: "f2c94c", position: 2 },
    { id: "state-review", name: "In Review", type: "started", color: "5e6ad2", position: 3 },
    { id: "state-done", name: "Done", type: "completed", color: "5e6ad2", position: 4 },
    { id: "state-canceled", name: "Canceled", type: "canceled", color: "95a2b3", position: 5 },
  ],
  closeReasons: [],
  members: [linearSam, linearKim],
  labels: [
    { id: "label-bug", name: "Bug", color: "eb5757", isGroup: false },
    { id: "label-area", name: "Area", color: "", isGroup: true },
    { id: "label-frontend", name: "Frontend", color: "5e6ad2", group: "Area", groupId: "label-area", isGroup: false },
  ],
  priorities: [
    { value: 0, label: "No priority" },
    { value: 1, label: "Urgent" },
    { value: 2, label: "High" },
    { value: 3, label: "Medium" },
    { value: 4, label: "Low" },
  ],
  capabilities: linearIssueFixture().capabilities,
});

export const commentsFixture = (provider: IssueProvider): IssueComment[] => {
  const [first, second] = provider === "github" ? [alex, sam] : [linearKim, linearSam];
  return [
    { id: `${provider}-c1`, author: first, body: "Seen it on staging too.", createdAt: "2026-09-01T12:00:00Z", viewerCanEdit: false, viewerCanDelete: false },
    { id: `${provider}-c2`, author: second, body: "I'll take it.", createdAt: "2026-09-01T13:00:00Z", editedAt: "2026-09-01T13:05:00Z", viewerCanEdit: true, viewerCanDelete: true },
  ];
};

const MESSAGES: Record<IssueOpErrorKind, string> = {
  not_signed_in: "The GitHub CLI (gh) is not signed in. Run gh auth login, then try again.",
  missing_scope: "Your gh login can't change issues here. Run gh auth refresh -s repo, then try again.",
  forbidden: "Your account doesn't have permission to do that.",
  not_found: "Couldn't find that issue, or your account can't see it.",
  conflict: "Someone else changed this issue since you started editing. Refresh it, then make your change again.",
  rate_limited: "The provider is limiting requests right now. Wait a minute, then try again.",
  network: "Couldn't reach the provider. Check your connection, then try again.",
  unsupported: "This provider's issues don't have that.",
  invalid: "That change isn't one the issue can take.",
  not_implemented: "TerminalX can't do this yet. Open the issue in your browser to make this change.",
  other: "The provider couldn't do that. Try again, or open the issue in your browser.",
};

export const issueOpError = (kind: IssueOpErrorKind, message = MESSAGES[kind]): IssueOpError => ({ kind, message });

interface Stored {
  issue: IssueDetails;
  comments: IssueComment[];
}

export interface IssueOpsMock {
  /** The issues by `${provider}:${id}`; edit them freely between steps. */
  issues: Map<string, Stored>;
  options: Record<IssueProvider, IssueOptions>;
  /** Who `issue_viewer` says the reader is. */
  viewer: Record<IssueProvider, IssueUser>;
  /** Comments per page of `issue_comments`. */
  pageSize: number;
  calls: { command: string; args: Record<string, unknown> }[];
  /** The next call of `command` rejects with this kind. */
  fail(command: string, kind: IssueOpErrorKind, message?: string): void;
  handle(command: string, args?: Record<string, unknown>): Promise<unknown> | undefined;
  issue(provider: IssueProvider, id: string): IssueDetails;
}

const clone = <T>(value: T): T => structuredClone(value);

export function createIssueOpsMock(seed: { issues?: IssueDetails[]; comments?: Record<string, IssueComment[]> } = {}): IssueOpsMock {
  const issues = new Map<string, Stored>();
  for (const issue of seed.issues ?? [githubIssueFixture(), linearIssueFixture()]) {
    const key = `${issue.provider}:${issue.id}`;
    issues.set(key, { issue: clone(issue), comments: clone(seed.comments?.[key] ?? commentsFixture(issue.provider)) });
  }
  const failures = new Map<string, IssueOpError>();
  let clock = Date.parse("2026-10-01T00:00:00Z");
  let made = 0;
  const now = () => new Date((clock += 60_000)).toISOString();

  const mock: IssueOpsMock = {
    issues,
    options: { github: githubOptionsFixture(), linear: linearOptionsFixture() },
    viewer: { github: kim, linear: linearKim },
    pageSize: 50,
    calls: [],
    fail(command, kind, message) {
      failures.set(command, issueOpError(kind, message));
    },
    issue(provider, id) {
      const stored = issues.get(`${provider}:${id}`);
      if (!stored) throw new Error(`no ${provider} issue ${id} in the mock`);
      return stored.issue;
    },
    handle(command, args = {}) {
      if (!command.startsWith("issue_") || command.startsWith("issue_pipeline")) return undefined;
      mock.calls.push({ command, args });
      const failure = failures.get(command);
      if (failure) {
        failures.delete(command);
        return Promise.reject(failure);
      }
      try {
        return Promise.resolve(answer(command, args));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };

  const stored = (args: Record<string, unknown>): Stored => {
    const found = issues.get(`${args.provider}:${args.id}`);
    if (!found) throw issueOpError("not_found");
    return found;
  };
  const touched = (entry: Stored): IssueDetails => {
    entry.issue.updatedAt = now();
    return clone(entry.issue);
  };
  const setAssignees = (issue: IssueDetails, ids: string[]) => {
    if (ids.length > issue.capabilities.maxAssignees) throw issueOpError("invalid");
    const members = mock.options[issue.provider].members;
    issue.assignees = ids.map((id) => members.find((member) => member.id === id) ?? { id, name: id });
    issue.assignee = issue.assignees[0] ? { name: issue.assignees[0].name, avatarUrl: issue.assignees[0].avatarUrl } : null;
  };
  const setLabels = (issue: IssueDetails, ids: string[]) => {
    const labels = mock.options[issue.provider].labels;
    issue.labels = ids.map((id) => {
      const label = labels.find((option) => option.id === id);
      return { id, name: label?.name ?? id, color: label?.color ?? "" };
    });
  };
  const setState = (issue: IssueDetails, change: StateChange) => {
    if (change.kind === "workflow_state") {
      const state = mock.options.linear.states.find((option) => option.id === change.stateId);
      if (issue.provider !== "linear" || !state) throw issueOpError(issue.provider === "linear" ? "invalid" : "unsupported");
      Object.assign(issue, { stateId: state.id, state: state.name, stateColor: state.color, stateType: ["completed", "canceled", "started"].includes(state.type) ? state.type : "open", workflowStateType: state.type });
    } else if (issue.provider !== "github") {
      throw issueOpError("unsupported");
    } else if (change.kind === "close") {
      Object.assign(issue, { state: "Closed", stateType: change.reason === "not_planned" ? "canceled" : "completed", closeReason: change.reason });
    } else {
      Object.assign(issue, { state: "Open", stateType: "open", closeReason: null });
    }
  };

  function answer(command: string, args: Record<string, unknown>): unknown {
    switch (command) {
      case "issue_details":
        return clone(stored(args).issue);
      case "issue_comments": {
        const all = stored(args).comments;
        const start = Number(args.cursor ?? 0);
        const end = start + mock.pageSize;
        return clone({ comments: all.slice(start, end), nextCursor: end < all.length ? String(end) : null } satisfies CommentsPage);
      }
      case "issue_options":
        return clone(mock.options[args.provider as IssueProvider]);
      case "issue_viewer":
        return clone(mock.viewer[args.provider as IssueProvider]);
      case "issue_comment_add": {
        const entry = stored(args);
        const comment: IssueComment = { id: `${args.provider}-c${entry.comments.length + 1}-${now()}`, author: mock.options[args.provider as IssueProvider].members[0], body: String(args.body), createdAt: now(), viewerCanEdit: true, viewerCanDelete: true };
        entry.comments.push(comment);
        return clone(comment);
      }
      case "issue_comment_edit": {
        const comment = stored(args).comments.find((each) => each.id === args.commentId);
        if (!comment) throw issueOpError("not_found");
        if (!comment.viewerCanEdit) throw issueOpError("forbidden");
        Object.assign(comment, { body: String(args.body), editedAt: now() });
        return clone(comment);
      }
      case "issue_comment_delete": {
        const entry = stored(args);
        const comment = entry.comments.find((each) => each.id === args.commentId);
        if (!comment) throw issueOpError("not_found");
        if (!comment.viewerCanDelete) throw issueOpError("forbidden");
        entry.comments = entry.comments.filter((each) => each !== comment);
        return null;
      }
      case "issue_set_state": {
        const entry = stored(args);
        setState(entry.issue, args.change as StateChange);
        return touched(entry);
      }
      case "issue_set_assignees": {
        const entry = stored(args);
        setAssignees(entry.issue, args.assignees as string[]);
        return touched(entry);
      }
      case "issue_set_labels": {
        const entry = stored(args);
        setLabels(entry.issue, args.labels as string[]);
        return touched(entry);
      }
      case "issue_set_priority": {
        const entry = stored(args);
        if (!entry.issue.capabilities.priority) throw issueOpError("unsupported");
        entry.issue.priority = Number(args.priority);
        return touched(entry);
      }
      case "issue_set_title": {
        const entry = stored(args);
        if (!String(args.title).trim()) throw issueOpError("invalid");
        entry.issue.title = String(args.title);
        return touched(entry);
      }
      case "issue_set_description": {
        const entry = stored(args);
        const edit = args.edit as { description: string; expectedUpdatedAt?: string | null; expectedDescription?: string | null };
        const stale =
          edit.expectedDescription != null
            ? edit.expectedDescription !== entry.issue.description
            : !!edit.expectedUpdatedAt && edit.expectedUpdatedAt !== entry.issue.updatedAt;
        if (stale) throw issueOpError("conflict");
        entry.issue.description = edit.description;
        entry.issue.body = edit.description;
        return touched(entry);
      }
      case "issue_create": {
        const provider = args.provider as IssueProvider;
        const input = args.input as IssueCreate;
        if (!input.title.trim()) throw issueOpError("invalid");
        const number = 100 + ++made;
        const base = provider === "github" ? githubIssueFixture() : linearIssueFixture();
        const issue: IssueDetails = {
          ...base,
          id: provider === "github" ? String(number) : `linear-new-${number}`,
          nodeId: null,
          number,
          identifier: provider === "github" ? `#${number}` : `ENG-${number}`,
          title: input.title,
          description: input.description ?? "",
          body: input.description ?? "",
          url: provider === "github" ? `https://github.com/acme/widgets/issues/${number}` : `https://linear.app/acme/issue/ENG-${number}`,
          createdAt: now(),
          closeReason: null,
          priority: provider === "linear" ? (input.priority ?? 0) : null,
        };
        if (provider === "github") Object.assign(issue, { state: "Open", stateType: "open" });
        if (provider === "linear") setState(issue, { kind: "workflow_state", stateId: input.stateId ?? "state-todo" });
        setAssignees(issue, input.assignees ?? []);
        setLabels(issue, input.labels ?? []);
        const entry = { issue, comments: [] };
        issues.set(`${provider}:${issue.id}`, entry);
        return touched(entry);
      }
      default:
        throw issueOpError("not_implemented");
    }
  }

  return mock;
}
