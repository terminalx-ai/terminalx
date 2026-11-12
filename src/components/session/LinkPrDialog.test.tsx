import "@testing-library/dom";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), message: vi.fn(async () => undefined) }));
vi.mock("@/components/ui/tooltip", () => ({
  WithTooltip: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

const session: SessionEntry = {
  id: "s1",
  projectPath: "/repos/terminalx",
  cwd: "/repos/terminalx/.raccoon/worktrees/approval-diff",
  branch: "raccoon/approval-diff",
  worktreeRemoved: false,
  title: "Approval diff",
  created: "x",
  modified: "x",
  archived: false,
  pinned: false,
  tabs: [],
};

const check = (state: string) => ({ name: `check-${state}-${Math.random()}`, state });
const pr = (number: number, title: string, head: string, more: Record<string, unknown> = {}) => ({
  number,
  title,
  url: `https://github.com/terminalx-ai/terminalx/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  base: "main",
  head,
  headLabel: head,
  additions: 1,
  deletions: 1,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  checks: [],
  body: "",
  author: "aisha-k",
  ...more,
});

// The 05.19 screen's four rows.
const candidates = () => ({
  repository: "terminalx-ai/terminalx",
  total: 5,
  prs: [
    pr(788, "Render apply_patch as a diff in approval cards", "raccoon/approval-cards-diff", { checks: Array.from({ length: 7 }, () => check("success")) }),
    pr(786, "Teams invite emails", "teams-invite", { headLabel: "aisha-k:teams-invite", checks: Array.from({ length: 5 }, () => check("success")) }),
    pr(785, "Publish notarized builds to the feed", "raccoon/publish-feed", { base: "raccoon/staple-dmg", author: "paresh", checks: [check("success"), check("in_progress"), check("queued")] }),
    pr(783, "Session overview table", "raccoon/session-overview", { isDraft: true, author: "sara-r" }),
    pr(790, "Approval diff for this session", "raccoon/approval-diff"),
  ],
  here: [] as string[],
  elsewhere: ["https://github.com/terminalx-ai/terminalx/pull/783"],
});

let answer: () => unknown;

beforeEach(() => {
  answer = candidates;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        return { projects: [{ path: "/repos/terminalx", name: "TerminalX", kind: "git" }], lastSelected: null };
      case "list_sessions":
        return [session];
      case "list_harnesses":
      case "list_workspaces":
        return [];
      case "pr_link_candidates":
        return answer();
      case "pr_link":
        return [{ ...(args.association as object), linked: true }];
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(cleanup);

const called = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
const option = (number: number) => screen.getAllByRole("option").find((row) => row.getAttribute("data-pr") === String(number))!;
const search = () => screen.getByRole("textbox", { name: "Search open PRs" });

async function mount() {
  vi.resetModules();
  const sessions = await import("@/lib/sessions");
  const dialogs = await import("@/lib/dialogs");
  const panelTab = await import("@/lib/panelTab");
  const prLinks = await import("@/lib/prLinks");
  const { SessionDialogs } = await import("./SessionDialogs");
  await sessions.bootSessions();
  render(<SessionDialogs />);
  dialogs.openLinkPr("s1");
  await screen.findByText("Link a pull request");
  return { panelTab, prLinks };
}

describe("Link a pull request", () => {
  it("lists the repository's open pull requests with their branches, checks and authors", async () => {
    await mount();
    expect(await screen.findByText(/5 open PRs in terminalx-ai\/terminalx\./)).toBeTruthy();
    expect(search().getAttribute("placeholder")).toBe("Search open PRs by number, title or branch");
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(within(option(788)).getByText("raccoon/approval-cards-diff → main")).toBeTruthy();
    expect(within(option(788)).getByText("✓ 7 of 7")).toBeTruthy();
    expect(within(option(786)).getByText("aisha-k:teams-invite → main")).toBeTruthy();
    expect(within(option(785)).getByText("raccoon/publish-feed → raccoon/staple-dmg")).toBeTruthy();
    expect(within(option(785)).getByText("● 2 running")).toBeTruthy();
    expect(within(option(785)).getByText("PA")).toBeTruthy();
    expect(within(option(783)).getByText("Draft")).toBeTruthy();
    expect(within(option(788)).getByText("AK")).toBeTruthy();
    expect(called("pr_link_candidates")).toEqual([{ cwd: session.cwd, sessionKey: "s1" }]);
  });

  it("filters by number, title or branch as the reader types", async () => {
    await mount();
    await screen.findByText("Teams invite emails");
    const shown = () => screen.queryAllByRole("option").map((row) => Number(row.getAttribute("data-pr")));
    fireEvent.change(search(), { target: { value: "#78" } });
    expect(shown()).toEqual([788, 786, 785, 783]);
    fireEvent.change(search(), { target: { value: "786" } });
    expect(shown()).toEqual([786]);
    fireEvent.change(search(), { target: { value: "Notarized" } });
    expect(shown()).toEqual([785]);
    fireEvent.change(search(), { target: { value: "aisha-k:teams" } });
    expect(shown()).toEqual([786]);
    fireEvent.change(search(), { target: { value: "staple-dmg" } });
    expect(shown()).toEqual([785]);
    fireEvent.change(search(), { target: { value: "approval diff" } });
    expect(shown()).toEqual([788, 790]);
    fireEvent.change(search(), { target: { value: "nothing like it" } });
    expect(shown()).toEqual([]);
    expect(screen.getByText("No open PRs match “nothing like it”.")).toBeTruthy();
  });

  it("marks a pull request another session shows, and does not let it be picked", async () => {
    await mount();
    await screen.findByText("Session overview table");
    expect(within(option(783)).getByText("Linked to another session")).toBeTruthy();
    expect(option(783).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(option(783));
    expect(option(783).getAttribute("aria-selected")).toBe("false");
    fireEvent.change(search(), { target: { value: "783" } });
    expect((screen.getByRole("button", { name: /^Link/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says before linking that a pull request on another branch keeps Push on the session's branch", async () => {
    await mount();
    await screen.findByText("Teams invite emails");
    // The first row is picked to begin with, as on the screen.
    expect(option(788).getAttribute("aria-selected")).toBe("true");
    const note = screen.getByTestId("link-pr-different-branch");
    expect(note.textContent).toBe("Different branch#788 is on raccoon/approval-cards-diff; this session is on raccoon/approval-diff. Checks and review will come from #788, and Push still goes to this session’s branch.");
    fireEvent.click(option(790));
    expect(screen.queryByTestId("link-pr-different-branch")).toBeNull();
    // Arrow keys move the pick and skip a row that cannot be linked.
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(option(785).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("link-pr-different-branch").textContent).toContain("#785 is on raccoon/publish-feed");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(option(790).getAttribute("aria-selected")).toBe("true");
  });

  it("links the picked pull request with Enter, then shows the Branch tab", async () => {
    const { panelTab, prLinks } = await mount();
    const changed = vi.fn();
    prLinks.onPrLinksChanged(changed);
    await screen.findByText("Teams invite emails");
    fireEvent.change(search(), { target: { value: "teams" } });
    expect(screen.getByRole("button", { name: /^Link #786/ })).toBeTruthy();
    fireEvent.submit(search().closest("form")!);
    await waitFor(() => expect(called("pr_link")).toEqual([{
      sessionKey: "s1",
      association: { url: "https://github.com/terminalx-ai/terminalx/pull/786", number: 786, head: "teams-invite", scope: { kind: "local", cwd: session.cwd } },
    }]));
    await waitFor(() => expect(screen.queryByText("Link a pull request")).toBeNull());
    expect(changed).toHaveBeenCalledWith("s1");
    expect(panelTab.takePanelTab()).toBe("branch");
  });

  it("keeps the dialog open and says why when linking is refused", async () => {
    await mount();
    await screen.findByText("Teams invite emails");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "pr_link") throw "#788 is linked to another session";
      return [];
    });
    fireEvent.click(screen.getByRole("button", { name: /^Link #788/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("#788 is linked to another session");
    expect(screen.getByText("Link a pull request")).toBeTruthy();
  });

  it("says so when the repository has no open pull requests", async () => {
    answer = () => ({ repository: "acme/quiet", total: 0, prs: [], here: [], elsewhere: [] });
    await mount();
    expect((await screen.findByTestId("link-pr-none")).textContent).toBe("acme/quiet has no open pull requests.");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((screen.getByRole("button", { name: /^Link/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says GitHub cannot be reached instead of showing an empty list", async () => {
    answer = () => { throw "error connecting to api.github.com"; };
    await mount();
    const alert = await screen.findByTestId("link-pr-unreachable");
    expect(alert.textContent).toContain("Can’t reach GitHub");
    expect(alert.textContent).toContain("error connecting to api.github.com");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText(/has no open pull requests/)).toBeNull();
  });

  it("says when more pull requests are open than it lists", async () => {
    answer = () => ({ ...candidates(), total: 412 });
    await mount();
    expect(await screen.findByText(/412 open PRs in terminalx-ai\/terminalx\. The 5 most recent are listed\./)).toBeTruthy();
  });

  it("marks one this session already shows", async () => {
    answer = () => ({ ...candidates(), here: ["https://github.com/terminalx-ai/terminalx/pull/790"] });
    await mount();
    await screen.findByText("Teams invite emails");
    expect(within(option(790)).getByText("Shown in this session")).toBeTruthy();
    expect(option(790).getAttribute("aria-disabled")).toBe("true");
  });
});
