import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { forgetIssueViewers, issueViewer } = await import("./issueViewer");

const asked = () => invoke.mock.calls.filter(([command]) => command === "issue_viewer").length;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (_command: string, args: { provider: string }) => ({ id: `${args.provider}-me`, name: "me" }));
});
afterEach(() => forgetIssueViewers());

describe("issueViewer", () => {
  it("reads the reader once per project, provider and revision", async () => {
    await issueViewer("/repo", "github");
    await issueViewer("/repo", "github");
    expect(asked()).toBe(1);
    await issueViewer("/repo", "linear");
    await issueViewer("/other", "github");
    expect(asked()).toBe(3);
    // A new Linear key, or a refresh, is a new revision.
    expect((await issueViewer("/repo", "linear", "true:paresh")).id).toBe("linear-me");
    expect(asked()).toBe(4);
  });

  it("tries again after a failed read", async () => {
    invoke.mockRejectedValueOnce({ kind: "not_signed_in", message: "Linear is not connected." });
    await expect(issueViewer("/repo", "linear")).rejects.toMatchObject({ kind: "not_signed_in" });
    await expect(issueViewer("/repo", "linear")).resolves.toMatchObject({ id: "linear-me" });
    expect(asked()).toBe(2);
  });

  it("forgets one provider's readers when asked", async () => {
    await issueViewer("/repo", "github");
    await issueViewer("/repo", "linear");
    forgetIssueViewers("linear");
    await issueViewer("/repo", "github");
    await issueViewer("/repo", "linear");
    expect(asked()).toBe(3);
  });
});
