import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchOverview } from "@/lib/api";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/sessions", () => ({
  selectSession: vi.fn(),
  useSessionStore: () => ({
    sessions: [
      { id: "s1", cwd: "/repo/wt", title: "Add login", archived: false, worktreeRemoved: false },
      { id: "s2", cwd: "/repo/wt", title: "Fix tests", archived: false, worktreeRemoved: false },
      { id: "s3", cwd: "/repo/other", title: "Elsewhere", archived: false, worktreeRemoved: false },
    ],
  }),
}));

const { BranchPanel } = await import("./BranchPanel");

const commit = (sha: string, subject: string, author: string) => ({ sha, shortSha: sha.slice(0, 7), subject, body: "", author, email: `${author.toLowerCase()}@x.io`, date: "2026-10-01T00:00:00Z", parent: null, tree: "" });
const overview = (patch: Partial<BranchOverview> = {}): BranchOverview => ({
  branch: "dc/login",
  base: "origin/main",
  onBase: false,
  forkPoint: commit("aaaaaaa1", "Base", "Cy"),
  ahead: 2,
  behind: 3,
  commits: [commit("bbbbbbb2", "Add form", "Ann"), commit("ccccccc3", "Wire API", "Bo")],
  baseCommits: [],
  contributors: [
    { name: "Ann Lee", email: "ann@x.io", commits: 1, last: "2026-10-01T00:00:00Z" },
    { name: "Bo", email: "bo@x.io", commits: 1, last: "2026-10-01T00:00:00Z" },
  ],
  baseContributors: [{ name: "Cy", email: "cy@x.io", commits: 3, last: "2026-10-01T00:00:00Z" }],
  upstream: "origin/dc/login",
  unpushed: 1,
  unpulled: 0,
  dirty: true,
  merge: { state: "conflicts", conflicted: ["src/app.ts"] },
  ...patch,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function answer(next: BranchOverview, prs: unknown[] = []) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "branch_overview") return next;
    if (command === "gh_available") return true;
    if (command === "pr_list") return prs;
    throw new Error(`Unexpected command: ${command}`);
  });
}

describe("the Branch tab", () => {
  it("says where the branch stands, who wrote it, the chats on it and its commits", async () => {
    answer(overview());
    const onOpenPr = vi.fn();
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" onOpenPr={onOpenPr} />);
    expect((await screen.findByTestId("branch-name")).textContent).toBe("dc/login");
    expect(screen.getByTestId("branch-status").textContent).toBe("Conflicts");
    expect(screen.getByTestId("branch-merge").textContent).toContain("Conflicts with main in 1 file");
    expect(screen.getByTestId("branch-merge").textContent).toContain("src/app.ts");
    expect(screen.getByTestId("branch-behind").textContent).toBe("main has 3 new commits since you branched");
    expect(screen.getByTestId("branch-remote").textContent).toBe("1 to push");
    expect(screen.getByTestId("branch-dirty")).toBeTruthy();
    expect(await screen.findByText("No pull request yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onOpenPr).toHaveBeenCalled();
    expect(screen.getByText("Ann Lee")).toBeTruthy();
    expect(screen.getByTestId("branch-base-people").textContent).toBe("Also on main since you branched: Cy");
    // The chats in this checkout, this one marked; one elsewhere is not listed.
    const chats = screen.getByRole("region", { name: "Chats on this branch" });
    expect(chats.textContent).toContain("Add login");
    expect(chats.textContent).toContain("this chat");
    expect(chats.textContent).not.toContain("Elsewhere");
    expect(screen.getByText("Wire API")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("pr_list", { cwd: "/repo/wt", branch: "dc/login" });
  });

  it("reads an open pull request's state, and on the base branch has nothing to merge", async () => {
    answer(overview({ merge: { state: "clean", conflicted: [] }, behind: 0 }), [
      { number: 7, title: "Login", url: "", state: "OPEN", isDraft: false, base: "main", head: "dc/login", additions: 1, deletions: 0, mergeable: "MERGEABLE", reviewDecision: "APPROVED", checks: [{ name: "ci", state: "success" }], body: "", author: "ann" },
    ]);
    render(<BranchPanel cwd="/repo/wt" active onOpenPr={() => undefined} />);
    expect((await screen.findByTestId("branch-pr")).textContent).toContain("#7 · Ready to merge · Approved");
    expect(screen.getByTestId("branch-status").textContent).toBe("Ready");
    expect(screen.getByTestId("branch-merge").textContent).toBe("Merges cleanly into main");
    cleanup();
    invoke.mockClear();

    answer(overview({ branch: "main", onBase: true, ahead: 0, behind: 0, commits: [], contributors: [], baseContributors: [], merge: { state: "merged", conflicted: [] } }));
    render(<BranchPanel cwd="/repo/wt" active onOpenPr={() => undefined} />);
    expect((await screen.findByTestId("branch-status")).textContent).toBe("Base");
    expect(screen.queryByTestId("branch-pr")).toBeNull();
    expect(screen.queryByTestId("branch-picture")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("pr_list", expect.anything());
  });
});
