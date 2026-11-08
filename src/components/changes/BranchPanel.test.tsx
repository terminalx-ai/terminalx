import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchOverview } from "@/lib/api";
import { getDraft } from "@/lib/drafts";

// The panel reads the branch, then its pull request: two answers in turn, slow on a busy machine.
const WAIT = { timeout: 5000 };

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({
    sessions: [{ id: "s1", cwd: "/repo/wt", title: "Add login", archived: false, worktreeRemoved: false, activeTab: "tab-1", tabs: [] }],
  }),
}));

const { BranchPanel, FETCH_EVERY, avatarUrl, graphRows } = await import("./BranchPanel");
const { localStep } = await import("./NextStep");

const { refreshDataPrivacy } = await import("@/lib/dataPrivacy");
let policy = { enabled: false, managed: false };
beforeEach(async () => {
  policy = { enabled: false, managed: false };
  invoke.mockResolvedValueOnce(policy);
  await refreshDataPrivacy();
});

const commit = (sha: string, subject: string, author: string, email = `${author.toLowerCase()}@x.io`) => ({ sha, shortSha: sha.slice(0, 7), subject, body: "", author, email, date: "2026-10-01T00:00:00Z", parent: null, tree: "" });
const overview = (patch: Partial<BranchOverview> = {}): BranchOverview => ({
  branch: "dc/login",
  base: "origin/main",
  onBase: false,
  forkPoint: commit("aaaaaaa1", "Base", "Cy"),
  ahead: 2,
  behind: 3,
  commits: [commit("bbbbbbb2", "Add form", "Ann"), commit("ccccccc3", "Wire API", "Me", "me@x.io")],
  baseCommits: [],
  contributors: [],
  baseContributors: [{ name: "Cy", email: "cy@x.io", commits: 3, last: "2026-10-01T00:00:00Z" }],
  upstream: "origin/dc/login",
  unpushed: 1,
  unpulled: 1,
  incoming: [commit("ddddddd4", "Fix header", "Bo")],
  dirty: true,
  changed: 3,
  hasRemote: true,
  merge: { state: "conflicts", conflicted: ["src/app.ts"] },
  ...patch,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Answers the panel's questions; after a pull, the branch has nothing left to pull. */
function answer(next: BranchOverview, prs: unknown[] = []) {
  let pulled = false;
  invoke.mockImplementation(async (command: string) => {
    if (command === "data_privacy_status") return policy;
    if (command === "branch_overview") return pulled ? { ...next, unpulled: 0, incoming: [] } : next;
    if (command === "branch_fetch") return true;
    if (command === "gh_available") return true;
    if (command === "pr_list") return prs;
    if (command === "git_identity") return { name: "Me", email: "ME@x.io" };
    if (command === "github_identity") return { login: null, source: null, email: null, repo: null, remoteHost: null };
    if (command === "git_pull") {
      pulled = true;
      return "";
    }
    throw new Error(`Unexpected command: ${command}`);
  });
}

describe("the Branch tab", () => {
  it("says the one next step, then draws the branch against where it started", async () => {
    answer(overview({ baseCommits: [commit("eeeeeee5", "Bump deps", "Cy")], behind: 1 }));
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
    expect((await screen.findByTestId("branch-name", {}, WAIT)).textContent).toBe("dc/login");
    // Others pushed to this branch: that comes before the conflicts, the uncommitted change and the push.
    expect(screen.getAllByTestId("next-step")).toHaveLength(1);
    expect(screen.getByTestId("next-step").textContent).toContain("Pull 1 commit");

    // Read down from where the work started: the branch, what others pushed to it, then what main gained.
    expect(screen.getByTestId("branch-fork").textContent).toContain("Branched from main · ");
    expect(screen.getByTestId("branch-you").textContent).toBe("You · 2 commits");
    const rows = screen.getAllByTestId("branch-commit").map((row) => [row.dataset.lane, row.querySelector("span[title]")?.textContent]);
    expect(rows).toEqual([
      ["branch", "#ddddddd Fix header"],
      ["base", "#eeeeeee Bump deps"],
    ]);
    // Where main is now: its newest commit, named.
    expect(screen.getByTestId("branch-base-now").textContent).toBe("main now");
    // Who made each: their face at the end of the row, named on hover.
    expect(screen.getByRole("img", { name: "Bo" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Cy" })).toBeTruthy();
    expect(screen.getByTestId("branch-behind").textContent).toContain("main is 1 commit ahead");
  });

  it("lists the conflicting files under the step, and offers the agent to resolve them", async () => {
    answer(overview({ unpulled: 0, incoming: [] }));
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
    const step = await screen.findByTestId("next-step", {}, WAIT);
    expect(step.textContent).toContain("Conflicts with main in 1 file");
    expect(screen.getByTestId("branch-conflicts").textContent).toContain("src/app.ts");
    // Updating from main is the same ask: not offered twice.
    expect(screen.queryByTestId("branch-behind")).toBeNull();
    fireEvent.click(within(step).getByRole("button", { name: "Resolve: conflicts" }));
    expect(getDraft("tab-1")).toBe("Merge the latest origin/main into dc/login, and resolve the conflicts.");
  });

  it("reads the graph down from where the work started, and counts what it leaves out", () => {
    const many = Array.from({ length: 14 }, (_, i) => commit(`f${String(i).padStart(2, "0")}aaaaa`, `Main ${i}`, "Cy"));
    const rows = graphRows(overview({ baseCommits: many, behind: 20 }), "main");
    expect(rows.slice(0, 4).map((r) => r.kind)).toEqual(["base", "you", "commit", "more"]);
    expect(rows[3]).toEqual({ kind: "more", label: "8 earlier on main" });
    // The newest twelve of main's, oldest first, so the newest ends the line.
    const base = rows.filter((r) => r.kind === "commit" && r.lane === "base").map((r) => (r.kind === "commit" ? r.commit.subject : ""));
    expect(base).toEqual(Array.from({ length: 12 }, (_, i) => `Main ${11 - i}`));
    // On the base itself: the base and what is not pulled yet, on its one line.
    expect(graphRows(overview({ onBase: true }), "main").map((r) => [r.kind, r.kind === "commit" ? r.lane : null])).toEqual([["base", null], ["commit", "base"]]);
  });

  it("opens your own commits onto the branch's line from the You row, and folds them away", async () => {
    answer(overview());
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
    const you = await screen.findByTestId("branch-you-toggle", {}, WAIT);
    expect(you.textContent).toContain("You · 2 commits");
    const subjects = () => screen.queryAllByTestId("branch-commit").filter((row) => row.getAttribute("data-lane") === "branch").map((row) => row.textContent);
    // Closed, only what others pushed sits on the branch's line.
    expect(subjects()).toEqual([expect.stringContaining("Fix header")]);
    fireEvent.click(you);
    expect(you.getAttribute("aria-expanded")).toBe("true");
    // Oldest first, as the line reads down, then what others pushed since.
    expect(subjects()).toEqual([expect.stringContaining("Wire API"), expect.stringContaining("Add form"), expect.stringContaining("Fix header")]);
    fireEvent.click(you);
    expect(subjects()).toEqual([expect.stringContaining("Fix header")]);
    expect(graphRows(overview(), "main", true).slice(0, 4).map((r) => (r.kind === "commit" ? r.commit.subject : r.kind))).toEqual(["base", "you", "Wire API", "Add form"]);
  });

  it("pulls what others pushed, or writes the agent a message asking it to", async () => {
    answer(overview());
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
    const step = await screen.findByTestId("next-step", {}, WAIT);
    expect(step.textContent).toContain("Pull 1 commit");

    fireEvent.click(within(step).getByRole("button", { name: "Ask agent: pull" }));
    expect(getDraft("tab-1")).toBe("Pull the latest commits on dc/login from origin/dc/login, and resolve anything that conflicts with my work.");

    fireEvent.click(within(step).getByRole("button", { name: "Pull" }));
    expect(invoke).toHaveBeenCalledWith("git_pull", { cwd: "/repo/wt" });
    // Pulled: the next step is the one under it.
    await vi.waitFor(() => expect(screen.getByTestId("next-step").textContent).toContain("Conflicts with main"), WAIT);
  });

  it("leaves the next step to the pull request once the branch needs nothing, and on the base shows none", async () => {
    answer(overview({ merge: { state: "clean", conflicted: [] }, behind: 0, unpulled: 0, unpushed: 0, dirty: false, incoming: [] }), [
      { number: 7, title: "Login", url: "", state: "OPEN", isDraft: false, base: "main", head: "dc/login", additions: 1, deletions: 0, mergeable: "MERGEABLE", reviewDecision: "APPROVED", checks: [], body: "", author: "ann" },
    ]);
    const onStep = vi.fn();
    render(<BranchPanel cwd="/repo/wt" active onStep={onStep} from="origin/main"><p>the pull request</p></BranchPanel>);
    expect(await screen.findByText("the pull request", {}, WAIT)).toBeTruthy();
    await vi.waitFor(() => expect(onStep).toHaveBeenLastCalledWith(false), WAIT);
    expect(screen.queryByTestId("next-step")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("branch_overview", { cwd: "/repo/wt", base: "origin/main" });
    cleanup();
    invoke.mockClear();

    answer(overview({ branch: "main", onBase: true, ahead: 0, behind: 0, commits: [], unpulled: 0, incoming: [], baseContributors: [], merge: { state: "merged", conflicted: [] } }));
    render(<BranchPanel cwd="/repo/wt" active onStep={onStep}><p>the pull request</p></BranchPanel>);
    await screen.findByTestId("branch-name", {}, WAIT);
    expect(screen.queryByText("the pull request")).toBeNull();
    expect(screen.queryByTestId("branch-you")).toBeNull();
    expect(onStep).toHaveBeenLastCalledWith(true);
    expect(invoke).not.toHaveBeenCalledWith("pr_list", expect.anything());
  });

  it("names one step for every state of the branch, in order", () => {
    const clean = overview({ unpulled: 0, incoming: [], merge: { state: "clean", conflicted: [] }, dirty: false, unpushed: 0 });
    const pr = { number: 1 } as never;
    const cases: [string, BranchOverview, unknown, string | null][] = [
      ["others pushed, before all else", overview(), null, "pull"],
      ["on main, behind its upstream", overview({ onBase: true }), null, "pull"],
      ["on main, up to date", { ...clean, onBase: true }, null, null],
      ["detached", { ...clean, branch: null }, null, "detached"],
      ["conflicts", { ...clean, merge: { state: "conflicts", conflicted: ["a"] } }, null, "conflicts"],
      ["uncommitted", { ...clean, dirty: true }, null, "commit"],
      ["nothing of its own, no pull request", { ...clean, ahead: 0 }, null, "empty"],
      ["nothing of its own, a pull request speaks for it", { ...clean, ahead: 0 }, pr, null],
      ["nothing of its own, pull request still being read", { ...clean, ahead: 0 }, undefined, null],
      ["never pushed", { ...clean, upstream: null }, null, "push"],
      ["no remote: merged here, never pushed", { ...clean, upstream: null, hasRemote: false }, null, "local"],
      ["no remote, nothing yet", { ...clean, ahead: 0, hasRemote: false }, undefined, "empty"],
      ["no remote, uncommitted first", { ...clean, dirty: true, hasRemote: false }, null, "commit"],
      ["commits not pushed", { ...clean, unpushed: 2 }, pr, "push"],
      ["ready for its pull request", clean, null, null],
      ["ready, a pull request open", clean, pr, null],
    ];
    for (const [name, o, p, kind] of cases) expect([name, localStep(o, p as never, "main")?.kind ?? null]).toEqual([name, kind]);
    expect(localStep({ ...clean, upstream: null }, null, "main")?.text).toBe("Push 2 commits");
    expect(localStep({ ...clean, unpushed: 1 }, null, "main")?.text).toBe("Push 1 commit");
    // Every step a newcomer can act on says why, in plain words.
    for (const [, o, p, kind] of cases) if (kind && kind !== "empty") expect(localStep(o, p as never, "main")?.why).toBeTruthy();
    expect(localStep({ ...clean, dirty: true }, null, "main")?.why).toBe("3 files changed. A commit saves them on this branch as a checkpoint you can come back to.");
  });

  it("on a project with no remote: says so, asks GitHub nothing, and merges into main here", async () => {
    const local = overview({ base: "main", upstream: null, unpulled: 0, unpushed: 0, incoming: [], merge: { state: "clean", conflicted: [] }, behind: 0, hasRemote: false, dirty: false });
    answer({ ...local, dirty: true });
    const shown = vi.fn();
    const { onPanelTab } = await import("@/lib/panelTab");
    const off = onPanelTab(shown);
    const onStep = vi.fn();
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" onStep={onStep}><p>the pull request</p></BranchPanel>);
    expect(await screen.findByTestId("branch-local-only", {}, WAIT)).toBeTruthy();
    const step = screen.getByTestId("next-step");
    expect(step.textContent).toContain("Commit your changes");
    fireEvent.click(within(step).getByRole("button", { name: "Review & commit" }));
    expect(shown).toHaveBeenCalledWith("changes");
    off();
    expect(screen.queryByText("the pull request")).toBeNull();
    expect(onStep).toHaveBeenLastCalledWith(true);
    cleanup();

    answer(local);
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: unknown) => (command === "branch_merge_into" ? "Merged into main" : base(command, args)));
    render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
    const ready = await screen.findByTestId("next-step", {}, WAIT);
    expect(ready.textContent).toContain("2 commits ready for main");
    expect(screen.getByTestId("next-step-why").textContent).toContain("only on this computer");
    fireEvent.click(within(ready).getByRole("button", { name: "Merge into main" }));
    expect(invoke).toHaveBeenCalledWith("branch_merge_into", { cwd: "/repo/wt", into: "main" });
    expect(invoke).not.toHaveBeenCalledWith("pr_list", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("gh_available", expect.anything());
  });

  it("asks the remote what others pushed on opening and every five minutes, and reads the branch again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      answer(overview());
      render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("branch_fetch", { cwd: "/repo/wt" }));
      const reads = () => invoke.mock.calls.filter(([command]) => command === "branch_overview").length;
      await vi.waitFor(() => expect(reads()).toBe(2));
      await vi.advanceTimersByTimeAsync(FETCH_EVERY);
      expect(invoke.mock.calls.filter(([command]) => command === "branch_fetch")).toHaveLength(2);
      await vi.waitFor(() => expect(reads()).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("keeps local branch facts but stops automatic transfers under privacy (managed=%s)", async (managed) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      answer(overview());
      policy = { enabled: true, managed };
      await act(() => refreshDataPrivacy());
      render(<BranchPanel cwd="/repo/wt" active sessionId="s1" />);
      expect((await screen.findByTestId("branch-name", {}, WAIT)).textContent).toBe("dc/login");
      await vi.advanceTimersByTimeAsync(FETCH_EVERY);
      expect(invoke.mock.calls.filter(([c]) => c === "branch_fetch")).toHaveLength(0);
      policy = { enabled: false, managed: false };
      await act(() => refreshDataPrivacy());
      await vi.waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === "branch_fetch")).toHaveLength(1));
      policy = { enabled: true, managed };
      await act(() => refreshDataPrivacy());
      await vi.advanceTimersByTimeAsync(FETCH_EVERY * 2);
      expect(invoke.mock.calls.filter(([c]) => c === "branch_fetch")).toHaveLength(1);
      expect(screen.getByTestId("branch-name").textContent).toBe("dc/login");
    } finally { vi.useRealTimers(); }
  });

  it("finds a GitHub face from a GitHub address, and looks others up only on a GitHub project", () => {
    expect(avatarUrl("12345+ann@users.noreply.github.com", false)).toBe("https://avatars.githubusercontent.com/u/12345?s=48");
    expect(avatarUrl("ann@x.io", false)).toBeNull();
    expect(avatarUrl("ann@x.io", true)).toBe("https://avatars.githubusercontent.com/u/e?email=ann%40x.io&s=48");
  });
});
