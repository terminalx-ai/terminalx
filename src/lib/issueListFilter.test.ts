import { describe, expect, it } from "vitest";
import type { Issue } from "@/lib/api";
import { DEFAULT_ISSUE_FILTER, filterMiss, issueFilterFor, wireFilter, type IssueListFilter } from "@/lib/issueListFilter";

const issue = (patch: Partial<Issue> = {}): Issue => ({
  provider: "github",
  id: "1",
  identifier: "#1",
  number: 1,
  title: "A",
  url: "u",
  state: "Open",
  stateType: "open",
  labels: [{ name: "bug", color: "" }, { name: "ui", color: "" }],
  assignees: [{ id: "sam", name: "Sam" }],
  updatedAt: "",
  ...patch,
});
const filter = (patch: Partial<IssueListFilter>): IssueListFilter => ({ ...DEFAULT_ISSUE_FILTER, ...patch });

describe("the issue list's filter", () => {
  it("is read back safely for the tracker it is kept for", () => {
    expect(issueFilterFor(undefined, "github")).toEqual(DEFAULT_ISSUE_FILTER);
    // A Linear state type or sort has no meaning on GitHub, and a team none.
    expect(issueFilterFor({ state: "backlog", sort: "priority", teamId: "t" }, "github")).toEqual(DEFAULT_ISSUE_FILTER);
    expect(issueFilterFor({ state: "backlog", sort: "priority", teamId: "t" }, "linear")).toMatchObject({ state: "backlog", sort: "priority", teamId: "t" });
    expect(issueFilterFor({ state: "closed" }, "linear").state).toBe("open");
    // Something stored by hand or by an older build is dropped, not passed on.
    expect(issueFilterFor({ assignee: { kind: "person" } as never, labels: "bug" as never }, "github")).toMatchObject({ assignee: null, labels: [] });
    expect(issueFilterFor({ assignee: { kind: "person", id: "sam", name: "Sam" } }, "github").assignee).toEqual({ kind: "person", id: "sam", name: "Sam" });
  });

  it("asks the backend without the names kept for the menus", () => {
    expect(wireFilter(filter({ assignee: { kind: "person", id: "sam", name: "Sam" }, labels: ["bug"], state: "closed", sort: "created" }), "login")).toEqual({
      state: "closed", assignee: { kind: "person", id: "sam" }, labels: ["bug"], sort: "created", teamId: null, search: "login",
    });
    expect(wireFilter(DEFAULT_ISSUE_FILTER, "").assignee).toBeNull();
  });

  it("says why a changed issue no longer matches", () => {
    expect(filterMiss(issue(), DEFAULT_ISSUE_FILTER, "github", "kim")).toBeNull();
    expect(filterMiss(issue({ state: "Closed", stateType: "canceled" }), DEFAULT_ISSUE_FILTER, "github", null)).toBe("Now Closed");
    expect(filterMiss(issue(), filter({ state: "closed" }), "github", null)).toBe("Now Open");
    expect(filterMiss(issue({ state: "Closed", stateType: "completed" }), filter({ state: "all" }), "github", null)).toBeNull();

    // Linear's state types, by the type the issue's state has now.
    const linear = (workflowStateType: string, state: string, stateType: Issue["stateType"]) => issue({ provider: "linear", state, stateType, workflowStateType });
    expect(filterMiss(linear("unstarted", "Todo", "open"), filter({ state: "backlog" }), "linear", null)).toBe("Now Todo");
    expect(filterMiss(linear("backlog", "Backlog", "open"), filter({ state: "backlog" }), "linear", null)).toBeNull();
    expect(filterMiss(linear("completed", "Done", "completed"), DEFAULT_ISSUE_FILTER, "linear", null)).toBe("Now Done");
    // A row without the type: what its coarse kind can tell.
    expect(filterMiss(issue({ provider: "linear", state: "Done", stateType: "completed" }), filter({ state: "started" }), "linear", null)).toBe("Now Done");
    expect(filterMiss(issue({ provider: "linear", state: "Todo", stateType: "open" }), filter({ state: "backlog" }), "linear", null)).toBeNull();

    expect(filterMiss(issue(), filter({ assignee: { kind: "me" } }), "github", "kim")).toBe("No longer assigned to you");
    expect(filterMiss(issue(), filter({ assignee: { kind: "me" } }), "github", null)).toBeNull();
    expect(filterMiss(issue(), filter({ assignee: { kind: "unassigned" } }), "github", null)).toBe("Now assigned");
    expect(filterMiss(issue(), filter({ assignee: { kind: "person", id: "alex", name: "Alex" } }), "github", null)).toBe("No longer assigned to Alex");

    // GitHub wants every label chosen, Linear any of them.
    expect(filterMiss(issue(), filter({ labels: ["bug", "docs"] }), "github", null)).toBe("Labels changed");
    expect(filterMiss(issue(), filter({ labels: ["Bug", "UI"] }), "github", null)).toBeNull();
    expect(filterMiss(issue({ provider: "linear" }), filter({ labels: ["bug", "docs"] }), "linear", null)).toBeNull();
    expect(filterMiss(issue({ provider: "linear" }), filter({ labels: ["docs"] }), "linear", null)).toBe("Labels changed");

    // A row that claims no state (a pipeline's memory of it) is never judged.
    expect(filterMiss(issue({ state: "" }), filter({ state: "closed" }), "github", null)).toBeNull();
  });
});
