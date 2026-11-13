import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Run, RunPiece } from "@/types/orchestration";
import type { Project, SessionEntry } from "@/types/session";

/**
 * PRO-281: a lead's workers nest under it in the sidebar, whatever worktree
 * they run in, and fold with it; folded, their marks come up to its row.
 */
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("./AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/account/AccountSidebarEntry", () => ({ AccountSidebarEntry: () => null }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));

const { ProjectRail } = await import("./ProjectRail");
const store = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const privacy = await import("@/lib/dataPrivacy");
const { resetExperimentalSettingsForTests } = await import("@/lib/experimentalSettings");
const { resetRunsForTests, useRunViewShown } = await import("@/lib/orchestration");

const projects: Project[] = [{ path: "/repos/web", name: "web", kind: "git" }];
const at = new Date().toISOString();
const usage = (costUsd: number) => ({ models: [{ model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd }] });
const session = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, projectPath: "/repos/web", cwd: `/repos/web/.worktrees/${id}`, worktreeName: id, branch: `raccoon/${id}`, title: `Session ${id}`, created: at, modified: at, pinned: false, archived: false, worktreeRemoved: false, activeTab: `${id}-tab`,
  tabs: [{ id: `${id}-tab`, title: `Talk ${id}`, harness: "claude", model: "sonnet", permissionMode: "auto", status: "idle", created: at, modified: at }],
  ...extra,
});
const worker = (id: string, cost: number, extra: Partial<SessionEntry> = {}) => {
  const entry = session(id, { parent: { sessionId: "lead" }, ...extra });
  entry.tabs[0] = { ...entry.tabs[0], usage: usage(cost) } as SessionEntry["tabs"][number];
  return entry;
};
const piece = (id: string, title: string, extra: Partial<RunPiece>): RunPiece => ({
  id, title, owns: [], dependsOn: [], doneChecks: [{ type: "command", run: "true" }], agent: "claude", model: "sonnet", readsUntrusted: false, attempts: 1, state: "queued",
  brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] }, ...extra,
});
const runOf = (pieces: RunPiece[], extra: Partial<Run> = {}): Run => ({
  id: "run-1", lead: { sessionId: "lead" }, projectPath: "/repos/web", goal: "Move settings reads", state: "running", budget: {}, workerMode: "auto",
  created: at, modified: at, ready: [], waiting: [], estimate: null, unestimated: 0, pieces, ...extra,
});

let sessions: SessionEntry[];
let runs: Run[];
let orchestratorRuns: boolean;
/** What the runtime says of each session's row, by id; absent ones are idle. */
let rowStatuses: Record<string, unknown>;

beforeEach(async () => {
  resetExperimentalSettingsForTests();
  resetRunsForTests();
  mocks.listeners.clear();
  prefs.setPrefs({ sidebarLayout: "simple", sidebarSections: {}, branchSessions: "sidebar" });
  orchestratorRuns = true;
  rowStatuses = {};
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
    if (command === "data_privacy_status") return { enabled: false, managed: false };
    if (command === "list_projects") return { projects, lastSelected: null };
    if (command === "list_sessions") return sessions;
    if (command === "list_harnesses") return [];
    if (command === "chats_dir") return "/store/Chats";
    if (command === "list_workspaces") return [];
    if (command === "experimental_settings") return { nativeCodex: false, orchestratorRuns };
    if (command === "orchestration_runs") return runs;
    if (command === "session_row_statuses") return Object.fromEntries((args as { ids: string[] }).ids.filter((id) => rowStatuses[id]).map((id) => [id, rowStatuses[id]]));
    return undefined;
  });
  await privacy.refreshDataPrivacy();
});
afterEach(cleanup);

function RunShown({ id }: { id: string }) {
  return <span data-testid={`run-shown-${id}`}>{String(useRunViewShown(id))}</span>;
}
const mount = () => render(<TooltipProvider><ProjectRail onHide={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenHome={store.openHome} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} /><RunShown id="lead" /></TooltipProvider>);
async function boot(list: SessionEntry[], listRuns: Run[]) {
  sessions = list;
  runs = listRuns;
  await act(async () => {
    await store.bootSessions();
    await store.refreshEverything();
  });
}
const leadRow = () => document.querySelector<HTMLElement>('[data-lead="lead"]')!;
const workerRows = () => [...document.querySelectorAll<HTMLElement>("[data-worker]")];
/** A worker row as it reads: its piece's title, then its model's tier. */
const workerTitles = () => workerRows().map((row) => `${row.querySelector("div[title]")!.getAttribute("title")} ${row.querySelector("[data-row-meta=model]")!.textContent}`);

const family = () => [
  session("lead", { title: "Move settings reads" }),
  worker("w-map", 0.04),
  worker("w-store", 1.82),
  worker("w-docs", 0),
  session("other", { title: "Fix the permission cards" }),
];
const pieces = () => [
  piece("map", "Map every settings read", { state: "done", model: "haiku", worker: { sessionId: "w-map" } }),
  piece("store", "Typed store module", { state: "running", model: "opus", worker: { sessionId: "w-store" } }),
  piece("docs", "Update the docs", { state: "running", worker: { sessionId: "w-docs" } }),
  piece("cli", "Move CLI code", { state: "queued", dependsOn: ["store"] }),
];

describe("a lead and its workers in the sidebar (PRO-281)", () => {
  it("nests the workers under their lead in the run's order, each named by its piece with its model's tier and its piece's mark", async () => {
    await boot(family(), [runOf(pieces())]);
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(3));
    const workers = within(leadRow()).getByTestId("lead-workers");
    expect(within(workers).getAllByRole("listitem").map((row) => row.dataset.worker)).toEqual(["w-map", "w-store", "w-docs"]);
    expect(workerTitles()).toEqual(["Map every settings read Haiku", "Typed store module Opus", "Update the docs Sonnet"]);
    expect(workerRows().map((row) => row.querySelector("[data-piece-mark]")?.getAttribute("data-piece-mark"))).toEqual(["done", "running", "running"]);
    // The lead is marked as one, and its workers are no rows of their own at the project's level.
    expect(within(leadRow()).getAllByTestId("lead-glyph")).toHaveLength(1);
    const top = screen.getByRole("group", { name: "web" }).querySelectorAll(":scope ul > li:not([data-worker])");
    expect([...top].filter((row) => row.closest("[data-testid=lead-workers]") === null).length).toBe(2);
  });

  it("folds the workers into the lead's row, which then shows pieces done out of total and how many run, and updates them without a reload", async () => {
    await boot(family(), [runOf(pieces())]);
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(3));
    fireEvent.click(within(leadRow()).getByRole("button", { name: "Fold the workers of Talk lead" }));
    expect(workerRows()).toHaveLength(0);
    expect(within(leadRow()).getByTestId("lead-progress").textContent).toBe("1/4");
    expect(within(leadRow()).getByTestId("lead-running").getAttribute("aria-label")).toBe("2 running");
    // The run moves on: its event is all it takes.
    const next = pieces();
    next[1] = { ...next[1], state: "done" };
    act(() => mocks.listeners.get("orchestration_run")!({ payload: runOf(next) }));
    expect(within(leadRow()).getByTestId("lead-progress").textContent).toBe("2/4");
    expect(within(leadRow()).getByTestId("lead-running").getAttribute("aria-label")).toBe("1 running");
    // Open, the lead shows what the run has cost instead.
    fireEvent.click(within(leadRow()).getByRole("button", { name: "Unfold the workers of Talk lead" }));
    expect(leadRow().querySelector("[data-row-meta=spend]")?.textContent).toBe("$1.86");
  });

  it("marks the folded lead when a worker waits for a permission answer, with the reason in its tooltip, and keeps a worker's unread mark on it", async () => {
    const list = family();
    list[3] = { ...list[3], tabs: [{ ...list[3].tabs[0], markedUnread: true }] } as SessionEntry;
    rowStatuses = { "w-store": { tabs: [{ status: "waiting", activity: "needs_permission" }] } };
    await boot(list, [runOf(pieces())]);
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(3));
    // Open: the worker's own row carries its one "Needs approval" mark.
    await waitFor(() => expect(workerRows()[1].querySelector("[data-session-status]")?.getAttribute("data-status-label")).toBe("Needs approval"));
    fireEvent.click(within(leadRow()).getByRole("button", { name: "Fold the workers of Talk lead" }));
    const needs = within(leadRow()).getByTestId("lead-needs");
    expect(needs.dataset.needs).toBe("approval");
    expect(needs.textContent).toBe("1");
    expect(needs.getAttribute("title")).toBe("Needs approval\nTyped store module: Needs permission");
    expect(within(leadRow()).getByRole("img", { name: "Unread" })).toBeTruthy();
  });

  it("raises the lead's Needs you for a blocked piece and for spend past the budget, each with its reason", async () => {
    const blocked = pieces();
    blocked[1] = { ...blocked[1], state: "blocked", note: "Check still fails after 3 tries" };
    await boot(family(), [runOf(blocked, { budget: { dollars: 1 } })]);
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(3));
    // Open, the lead carries the run's own: the budget, and the blocked piece, which is answered in its Run view (PRO-361, 18.03).
    expect(within(leadRow()).getByTestId("lead-needs").getAttribute("title")).toBe("Needs you\nOver budget: $1.86 of $1.00\nTyped store module: Check still fails after 3 tries");
    fireEvent.click(within(leadRow()).getByRole("button", { name: "Fold the workers of Talk lead" }));
    const needs = within(leadRow()).getByTestId("lead-needs");
    expect(needs.dataset.needs).toBe("attention");
    expect(needs.getAttribute("title")).toBe("Needs you\nOver budget: $1.86 of $1.00\nTyped store module: Check still fails after 3 tries");
  });

  it("opens the lead on its run, and a worker's row opens the worker", async () => {
    await boot(family(), [runOf(pieces())]);
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(3));
    fireEvent.click(workerRows()[1].querySelector("button")!);
    expect(store.getSessionStore().selectedSessionId).toBe("w-store");
    fireEvent.click(within(leadRow()).getByRole("button", { name: /Move settings reads|Talk lead/, description: /./ }));
    expect(store.getSessionStore().selectedSessionId).toBe("lead");
    expect(screen.getByTestId("run-shown-lead").textContent).toBe("true");
  });

  it("keeps the lead open while one of its workers is the open session", async () => {
    await boot(family(), [runOf(pieces())]);
    prefs.setPrefs({ sidebarSections: { "lead:lead": "collapsed" } });
    store.selectSession("w-docs");
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(3));
  });

  it("draws every session as before while Settings → Experimental → Orchestrator is off", async () => {
    orchestratorRuns = false;
    await boot(family(), [runOf(pieces())]);
    mount();
    await waitFor(() => expect(screen.getByRole("group", { name: "web" })).toBeTruthy());
    expect(document.querySelector("[data-lead]")).toBeNull();
    expect(workerRows()).toHaveLength(0);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "orchestration_runs")).toBe(false);
  });
});

describe("a session that only started others (PRO-337)", () => {
  it("nests its children with a quieter mark, its own status mark, and no run summary; a run's lead keeps the glyph", async () => {
    // "lead" leads a run; "starter" leads none, and only its children record it as their parent.
    await boot([
      ...family(),
      session("starter", { title: "Try both parsers" }),
      session("kid-a", { title: "Parser A", parent: { sessionId: "starter" } }),
      session("kid-b", { title: "Parser B", parent: { sessionId: "starter" } }),
    ], [runOf(pieces())]);
    // An open worker would hold its lead unfolded: open a session of neither family.
    store.selectSession("other");
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(5));
    const starter = () => document.querySelector<HTMLElement>('[data-lead="starter"]')!;

    // The run's lead: the glyph, and no starter mark.
    expect(within(leadRow()).getAllByTestId("lead-glyph")).toHaveLength(1);
    expect(leadRow().querySelector(":scope > div [data-testid=starter-mark]")).toBeNull();
    // The starter: its children nest under it, it has the quieter mark with its tooltip, and no lead glyph.
    expect(within(within(starter()).getByTestId("lead-workers")).getAllByRole("listitem").map((row) => row.dataset.worker)).toEqual(["kid-a", "kid-b"]);
    const mark = within(starter()).getByTestId("starter-mark");
    expect([mark.getAttribute("aria-label"), mark.getAttribute("title")]).toEqual(["Started these sessions", "Started these sessions"]);
    expect(within(starter()).queryByTestId("lead-glyph")).toBeNull();

    // Folded, the run's lead sums up its run; the starter shows no run summary.
    fireEvent.click(within(leadRow()).getByRole("button", { name: "Fold the workers of Talk lead" }));
    expect(within(leadRow()).getByTestId("lead-progress").textContent).toBe("1/4");
    fireEvent.click(within(starter()).getByRole("button", { name: "Fold the workers of Talk starter" }));
    expect(workerRows()).toHaveLength(0);
    for (const summary of ["lead-progress", "lead-running", "lead-needs", "lead-glyph"]) expect(within(starter()).queryByTestId(summary)).toBeNull();
    expect(within(starter()).getByTestId("starter-mark")).toBeTruthy();

    // Opening it opens the session, not a Run view.
    fireEvent.click(within(starter()).getByRole("button", { name: /Talk starter/, description: /./ }));
    expect(store.getSessionStore().selectedSessionId).toBe("starter");
  });
});

describe("tidy worker rows (PRO-364)", () => {
  /** A worker as a run starts one: its session titled by its piece, its one tab by the brief's first line. */
  const briefed = (id: string, parent: string, title: string) => {
    const entry = session(id, { parent: { sessionId: parent }, title });
    entry.tabs[0] = { ...entry.tabs[0], title: "You are a worker in a run led by another session. Do this one piece and report" } as SessionEntry["tabs"][number];
    return entry;
  };

  it("names every try of a piece by the piece, marks tries past the first, and quiets the earlier ones", async () => {
    const tries = [
      { step: "first", model: "haiku", worker: { sessionId: "w-try1" }, outcome: "failed" },
      { step: "model", model: "sonnet", worker: { sessionId: "w-try2" }, outcome: "failed" },
      { step: "effort", model: "opus", worker: { sessionId: "w-try3" } },
    ] as RunPiece["tries"];
    await boot([
      session("lead", { title: "Move settings reads" }),
      briefed("w-try3", "lead", "Typed store module"),
      briefed("w-map", "lead", "Map every settings read"),
      briefed("w-try1", "lead", "Typed store module"),
      briefed("w-try2", "lead", "Typed store module"),
    ], [runOf([
      piece("map", "Map every settings read", { state: "done", model: "haiku", worker: { sessionId: "w-map" } }),
      piece("store", "Typed store module", { state: "running", model: "opus", worker: { sessionId: "w-try3" }, tries }),
    ])]);
    mount();
    await waitFor(() => expect(workerRows()).toHaveLength(4));
    const rows = within(within(leadRow()).getByTestId("lead-workers")).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.worker)).toEqual(["w-map", "w-try1", "w-try2", "w-try3"]);
    expect(workerTitles()).toEqual(["Map every settings read Haiku", "Typed store module Haiku", "Typed store module Sonnet", "Typed store module Opus"]);
    expect(rows.map((row) => row.querySelector("[data-testid=try-mark]")?.textContent ?? null)).toEqual([null, null, "try 2", "try 3"]);
    // The current try carries the piece's state; the earlier ones are drawn quieter.
    expect(rows.map((row) => row.dataset.earlierTry !== undefined)).toEqual([false, true, true, false]);
    expect(rows[3].querySelector("[data-piece-mark]")?.getAttribute("data-piece-mark")).toBe("running");
    expect(leadRow().textContent).not.toMatch(/You are a worker/);
  });

  it("draws each lead a coordinator started as a lead, folded with its glyph and progress, with its own workers under it", async () => {
    const leads = [
      { id: "lead-a", title: "Sidebar rows", workers: ["a1", "a2"] },
      { id: "lead-b", title: "Stop finished workers", workers: ["b1", "b2", "b3"] },
      { id: "lead-c", title: "Cleanup without a lead", workers: ["c1", "c2"] },
    ];
    await boot([
      session("coord", { title: "PRO-364 coordinator" }),
      ...leads.flatMap((lead) => [briefed(lead.id, "coord", lead.title), ...lead.workers.map((id) => briefed(id, lead.id, `Piece ${id}`))]),
      session("other", { title: "Fix the permission cards" }),
    ], leads.map((lead) => runOf(
      lead.workers.map((id, index) => piece(id, `Piece ${id}`, { state: index === 0 ? "done" : "running", worker: { sessionId: id } })),
      { id: `run-${lead.id}`, lead: { sessionId: lead.id } },
    )));
    store.selectSession("other");
    mount();
    const coord = () => document.querySelector<HTMLElement>('[data-lead="coord"]')!;
    await waitFor(() => expect(within(coord()).getAllByTestId("lead-glyph")).toHaveLength(3));
    // The coordinator leads no run: its leads are its rows.
    expect(within(coord()).getAllByTestId("lead-workers")[0].querySelectorAll(":scope > li").length).toBe(3);
    for (const lead of leads) {
      const row = () => document.querySelector<HTMLElement>(`[data-lead="${lead.id}"]`)!;
      expect(row().closest('[data-lead="coord"]')).toBe(coord());
      expect(within(row()).getAllByTestId("lead-glyph")).toHaveLength(1);
      // Its workers are under it, not under the coordinator, each named by its piece.
      const under = within(row()).getByTestId("lead-workers");
      expect([...under.querySelectorAll(":scope > li")].map((entry) => (entry as HTMLElement).dataset.worker)).toEqual(lead.workers);
      // Folded, it shows its run's progress.
      fireEvent.click(within(row()).getByRole("button", { name: `Fold the workers of ${lead.title}` }));
      expect(within(row()).queryByTestId("lead-workers")).toBeNull();
      expect(within(row()).getByTestId("lead-progress").textContent).toBe(`1/${lead.workers.length}`);
    }
    expect(coord().textContent).not.toMatch(/You are a worker/);
    // The coordinator's own row is no run's lead: it keeps the quieter starter mark.
    expect(coord().querySelector(":scope > div [data-testid=lead-glyph]")).toBeNull();
  });

  it("keeps every lead above an open worker unfolded", async () => {
    await boot([
      session("coord", { title: "Coordinator" }),
      briefed("lead-a", "coord", "Sidebar rows"),
      briefed("a1", "lead-a", "Piece a1"),
    ], [runOf([piece("a1", "Piece a1", { state: "running", worker: { sessionId: "a1" } })], { lead: { sessionId: "lead-a" } })]);
    prefs.setPrefs({ sidebarSections: { "lead:coord": "collapsed", "lead:lead-a": "collapsed" } });
    store.selectSession("a1");
    mount();
    await waitFor(() => expect(document.querySelector('[data-worker="a1"]')).toBeTruthy());
  });
});
