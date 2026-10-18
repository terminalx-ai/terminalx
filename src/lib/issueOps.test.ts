import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssueOpsMock } from "@/test/issueOpsMock";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { errorMessage } from "@/lib/api";
import { isIssueOpError, issueOps } from "@/lib/issueOps";

afterEach(() => invoke.mockReset());

describe("issueOps", () => {
  it("calls each command with the argument names the backend takes", async () => {
    invoke.mockResolvedValue(null);
    await issueOps.details("/repo", "github", "41");
    await issueOps.comments("/repo", "linear", "ENG-42", "c2");
    await issueOps.options("/repo", "linear", { teamId: "team-eng" }, true);
    await issueOps.commentEdit("/repo", "github", "41", "c1", "Edited");
    await issueOps.setState("/repo", "github", "41", { kind: "close", reason: "not_planned" });
    await issueOps.setDescription("/repo", "linear", "ENG-42", { description: "New", expectedUpdatedAt: "t" });
    await issueOps.create("/repo", "linear", { teamId: "team-eng", title: "New issue" });
    expect(invoke.mock.calls).toEqual([
      ["issue_details", { projectPath: "/repo", provider: "github", id: "41" }],
      ["issue_comments", { projectPath: "/repo", provider: "linear", id: "ENG-42", cursor: "c2" }],
      ["issue_options", { projectPath: "/repo", provider: "linear", id: null, teamId: "team-eng", refresh: true }],
      ["issue_comment_edit", { projectPath: "/repo", provider: "github", id: "41", commentId: "c1", body: "Edited" }],
      ["issue_set_state", { projectPath: "/repo", provider: "github", id: "41", change: { kind: "close", reason: "not_planned" } }],
      ["issue_set_description", { projectPath: "/repo", provider: "linear", id: "ENG-42", edit: { description: "New", expectedUpdatedAt: "t" } }],
      ["issue_create", { projectPath: "/repo", provider: "linear", input: { teamId: "team-eng", title: "New issue" } }],
    ]);
  });
});

describe("the issue-operations mock", () => {
  it("answers reads and applies writes the way the provider re-reads them", async () => {
    const mock = createIssueOpsMock();
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => mock.handle(command, args) ?? Promise.reject(new Error(`unexpected ${command}`)));

    const github = await issueOps.details("/repo", "github", "41");
    expect(github.assignees.map((user) => user.login)).toEqual(["sam", "alex"]);
    const closed = await issueOps.setState("/repo", "github", "41", { kind: "close", reason: "not_planned" });
    expect([closed.state, closed.stateType, closed.closeReason]).toEqual(["Closed", "canceled", "not_planned"]);
    expect((await issueOps.setAssignees("/repo", "github", "41", ["kim"])).assignees.map((user) => user.id)).toEqual(["kim"]);

    const linear = await issueOps.setState("/repo", "linear", linearId(mock), { kind: "workflow_state", stateId: "state-review" });
    expect([linear.state, linear.stateId]).toEqual(["In Review", "state-review"]);
    await expect(issueOps.setAssignees("/repo", "linear", linear.id, ["user-sam", "user-kim"])).rejects.toMatchObject({ kind: "invalid" });
    await expect(issueOps.setPriority("/repo", "github", "41", 1)).rejects.toMatchObject({ kind: "unsupported" });

    // A description edit from a stale copy is a conflict.
    await expect(issueOps.setDescription("/repo", "linear", linear.id, { description: "x", expectedUpdatedAt: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ kind: "conflict" });
    const edited = await issueOps.setDescription("/repo", "linear", linear.id, { description: "x", expectedUpdatedAt: linear.updatedAt });
    expect(edited.description).toBe("x");
    // With the description it started from, only a changed description is a conflict.
    const kept = await issueOps.setDescription("/repo", "linear", linear.id, { description: "y", expectedUpdatedAt: "2026-01-01T00:00:00Z", expectedDescription: "x" });
    expect(kept.description).toBe("y");
    await expect(issueOps.setDescription("/repo", "linear", linear.id, { description: "z", expectedUpdatedAt: kept.updatedAt, expectedDescription: "x" })).rejects.toMatchObject({ kind: "conflict" });

    const added = await issueOps.commentAdd("/repo", "github", "41", "On it");
    const page = await issueOps.comments("/repo", "github", "41");
    expect(page.comments.at(-1)).toEqual(added);
    await issueOps.commentDelete("/repo", "github", "41", added.id);
    expect((await issueOps.comments("/repo", "github", "41")).comments).toHaveLength(2);

    const created = await issueOps.create("/repo", "linear", { teamId: "team-eng", title: "New", labels: ["label-frontend"], priority: 3 });
    expect([created.state, created.priority, created.labels[0].name]).toEqual(["Todo", 3, "Frontend"]);
    expect((await issueOps.details("/repo", "linear", created.id)).title).toBe("New");
  });

  it("fails the next call of a command with a typed error", async () => {
    const mock = createIssueOpsMock();
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => mock.handle(command, args));
    mock.fail("issue_comment_add", "not_signed_in");
    const error = await issueOps.commentAdd("/repo", "github", "41", "Hi").catch((caught: unknown) => caught);
    expect(isIssueOpError(error) && error.kind).toBe("not_signed_in");
    expect(errorMessage(error)).toContain("gh auth login");
    await expect(issueOps.commentAdd("/repo", "github", "41", "Hi")).resolves.toMatchObject({ body: "Hi" });
    expect(mock.handle("issues_list", {})).toBeUndefined();
    expect(mock.calls.map((call) => call.command)).toEqual(["issue_comment_add", "issue_comment_add"]);
  });
});

function linearId(mock: ReturnType<typeof createIssueOpsMock>) {
  return [...mock.issues.values()].find((entry) => entry.issue.provider === "linear")!.issue.id;
}
