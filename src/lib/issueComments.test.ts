import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIssueOpsMock, githubIssueFixture, linearIssueFixture } from "@/test/issueOpsMock";
import type { IssueComment } from "@/lib/issueOps";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { discussionForPrompt, readAllComments } = await import("@/lib/issueComments");
const { issuePrompt, issuePromptWithComments } = await import("@/lib/issueSession");

const comment = (index: number, body = `Comment ${index}`): IssueComment => ({
  id: `c${index}`,
  author: { id: `u${index}`, name: `User ${index}`, login: `user${index}` },
  body,
  createdAt: `2026-09-${String(index % 28 + 1).padStart(2, "0")}T00:00:00Z`,
  viewerCanEdit: false,
  viewerCanDelete: false,
});

beforeEach(() => {
  invoke.mockReset();
});

describe("readAllComments", () => {
  it("follows the cursor to the end, oldest first", async () => {
    const all = Array.from({ length: 120 }, (_, index) => comment(index));
    const issues = createIssueOpsMock({ issues: [githubIssueFixture()], comments: { "github:41": all } });
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args));
    expect(await readAllComments("/repo", "github", "41")).toEqual({ comments: all, omitted: 0 });
  });

  it("past what it keeps, lets the oldest go and counts them, never the newest", async () => {
    const all = Array.from({ length: 120 }, (_, index) => comment(index));
    const issues = createIssueOpsMock({ issues: [githubIssueFixture()], comments: { "github:41": all } });
    issues.pageSize = 7;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args));
    const thread = await readAllComments("/repo", "github", "41", 25);
    expect(thread.comments.map((each) => each.id)).toEqual(all.slice(-25).map((each) => each.id));
    expect(thread.omitted).toBe(95);
    // And the prompt says so.
    expect(issuePrompt(githubIssueFixture(), thread)).toContain("earlier comments omitted; read them at https://github.com/acme/widgets/issues/41");
  });

  it("stops at a cursor it has already followed", async () => {
    invoke.mockResolvedValue({ comments: [comment(1)], nextCursor: "again" });
    expect((await readAllComments("/repo", "linear", "ENG-1")).comments).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("discussionForPrompt", () => {
  it("lists every comment that fits", () => {
    expect(discussionForPrompt([comment(1), comment(2)], "https://x/1")).toBe("## Comments\n\n**user1** (2026-09-02):\nComment 1\n\n**user2** (2026-09-03):\nComment 2");
  });

  it("keeps the most recent comments under the cap and says how many were left out", () => {
    const all = Array.from({ length: 60 }, (_, index) => comment(index, "x".repeat(500)));
    const text = discussionForPrompt(all, "https://linear.app/acme/issue/ENG-1");
    expect(text.length).toBeLessThan(12_500);
    const kept = text.match(/\*\*user\d+\*\*/g)!.length;
    expect(text).toContain(`…${60 - kept} earlier comments omitted; read them at https://linear.app/acme/issue/ENG-1`);
    expect(text.trimEnd().endsWith("x")).toBe(true);
    expect(text).toContain("**user59**");
    expect(text).not.toContain("**user0**");
  });

  it("clips one huge comment rather than leaving it out", () => {
    const text = discussionForPrompt([comment(1, "y".repeat(50_000))], "https://x/1");
    expect(text.length).toBeLessThan(4_000);
    expect(text).toContain("…(cut)");
    expect(text).not.toContain("omitted");
  });
});

describe("issuePrompt", () => {
  it("adds the discussion after the description for both providers", () => {
    for (const issue of [githubIssueFixture(), linearIssueFixture()]) {
      const prompt = issuePrompt(issue, [comment(1)]);
      expect(prompt).toContain(`${issue.description}\n\n## Comments\n\n**user1**`);
      expect(prompt.endsWith(`Issue link: ${issue.url}\nWhen done, summarise what changed.`)).toBe(true);
    }
  });

  it("takes a Linear description alone, not the comments pasted under its body", () => {
    const issue = { ...linearIssueFixture(), body: "Users get logged out.\n\n---\n\n## Comments\n\n**Kim**: old paste" };
    expect(issuePrompt(issue, [comment(1)])).not.toContain("old paste");
    // Without the thread, the body is all there is.
    expect(issuePrompt(issue)).toContain("old paste");
  });

  it("reads the thread for the prompt, and starts without it when it cannot", async () => {
    const issues = createIssueOpsMock();
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args));
    const github = githubIssueFixture();
    expect(await issuePromptWithComments("/repo", github)).toContain("**alex** (2026-09-01):\nSeen it on staging too.");
    issues.fail("issue_comments", "not_signed_in");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await issuePromptWithComments("/repo", github)).toBe(issuePrompt(github));
    // A provider that never answers does not hold the session's start.
    invoke.mockImplementation(() => new Promise(() => undefined));
    expect(await issuePromptWithComments("/repo", github, 20)).toBe(issuePrompt(github));
    logged.mockRestore();
  });
});
