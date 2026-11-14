import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRun, ActionRunOutcome } from "@/lib/api";
import type { RepositoryAction, RepositoryPreviewUrl } from "@/lib/repositoryActions";
import type { Project, SessionEntry } from "@/types/session";

// PRO-363: the header's Run menu, ⌘R and the Open button, against a fake backend.
// This file is a Mac, so ⌘ is the main modifier and ⌘R the default keys.
const mocks = vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  return {
    invoke: vi.fn(),
    runs: [] as ActionRun[],
    ports: [4010, 4011, 4012, 4013, 4014, 4015, 4016, 4017, 4018, 4019] as number[] | null,
    listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const set = mocks.listeners.get(name) ?? new Set();
    mocks.listeners.set(name, set);
    set.add(handler);
    return () => set.delete(handler);
  }),
}));

const { RunMenu, RunRestartOffer, offersRunMenu, runStateText, previewTarget, dismissRestartOffer } = await import("./RunMenu");
const { getTerminalState } = await import("@/lib/terminal");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { getErrorToasts } = await import("@/lib/errorToasts");
const { resolveKeymap } = await import("@/lib/shortcuts");

const action = (id: string, name: string, extra: Partial<RepositoryAction> = {}): RepositoryAction => ({ id, name, icon: "play", command: `pnpm ${id}`, runAfterSetup: false, concurrent: false, hidden: false, ...extra });
const dev = action("dev", "Dev");
const test = action("test", "Test");
const secret = action("secret", "Secret", { hidden: true });
const web: RepositoryPreviewUrl = { id: "web", name: "Web", url: "http://localhost:$PORT" };
const api: RepositoryPreviewUrl = { id: "api", name: "API", url: "http://localhost:$PORT_1/health" };
const docs: RepositoryPreviewUrl = { id: "docs", name: "Docs", url: "https://example.com/docs" };
const session = { id: "s1", projectPath: "/repo", cwd: "/repo/wt", title: "Work", tabs: [], created: "now", modified: "now" } as unknown as SessionEntry;
const project = (actions: RepositoryAction[], previewUrls: RepositoryPreviewUrl[] = []): Project => ({ path: "/repo", name: "Repo", actions, previewUrls });

const run = (actionId: string, extra: Partial<ActionRun> = {}): ActionRun => ({
  sessionId: "s1", actionId, name: actionId, paneId: `s1:action-1-${actionId}`, state: "running", exitCode: null, started: "now", ended: null, ...extra,
});

let outcome: (actionId: string, restart: boolean) => ActionRunOutcome;

beforeEach(() => {
  mocks.runs = [];
  mocks.ports = [4010, 4011, 4012, 4013, 4014, 4015, 4016, 4017, 4018, 4019];
  mocks.listeners.clear();
  outcome = (actionId, restart) => ({ run: run(actionId, { paneId: `s1:action-${restart ? 2 : 1}-${actionId}` }), started: true });
  mocks.invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "action_states") return mocks.runs;
    if (command === "action_run") return outcome(args!.actionId as string, args!.restart as boolean);
    if (command === "workspace_ports") {
      if (!mocks.ports) throw new Error("unknown command workspace_ports");
      return mocks.ports;
    }
    if (command === "browser_open_tab") return { browserPageId: "page-1", url: args!.url, title: "" };
    if (command === "browser_pages") return [];
    return null;
  });
});

afterEach(() => {
  cleanup();
  act(() => dismissRestartOffer("s1"));
});

const openMenu = (element: HTMLElement) => fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: "mouse" });
const runCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "action_run").map(([, args]) => args);
const openedUrls = () => mocks.invoke.mock.calls.filter(([command]) => command === "browser_open_tab").map(([, args]) => (args as { url: string }).url);
const pressRun = () => fireEvent.keyDown(window, { key: "r", code: "KeyR", metaKey: true });
const emit = (name: string, payload: unknown) => { for (const handler of mocks.listeners.get(name) ?? []) handler({ payload }); };

async function renderMenu(p: Project) {
  render(<TooltipProvider><RunMenu session={session} project={p} /><RunRestartOffer session={session} /></TooltipProvider>);
  if (p.actions?.some((entry) => !entry.hidden)) await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("action_states", { sessionId: "s1" }));
  if (p.previewUrls?.length) await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_ports", { sessionId: "s1" }));
}

describe("the Run menu", () => {
  it("lists the visible actions in saved order and leaves hidden ones out", async () => {
    await renderMenu(project([dev, secret, test]));
    openMenu(screen.getByTestId("run-menu-trigger"));
    const menu = await screen.findByTestId("run-menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("data-action-id"))).toEqual(["dev", "test"]);
    expect(menu.textContent).not.toContain("Secret");
  });

  it("shows each action's state: running, or exited with its exit code", async () => {
    mocks.runs = [run("dev"), run("test", { state: "exited", exitCode: 2, ended: "later" })];
    await renderMenu(project([dev, test, action("lint", "Lint")]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run, 1 running" })).toBeTruthy());
    openMenu(screen.getByTestId("run-menu-trigger"));
    const menu = await screen.findByTestId("run-menu");
    const state = (id: string) => menu.querySelector(`[data-action-id="${id}"] [data-testid="run-state"]`)?.textContent ?? null;
    expect([state("dev"), state("test"), state("lint")]).toEqual(["Running", "Exited 2", null]);

    // The runner says the dev server exited with 0: the menu follows.
    mocks.runs = [run("dev", { state: "exited", exitCode: 0 }), run("test", { state: "exited", exitCode: 2 })];
    await act(async () => emit("action_state_changed", { sessionId: "s1", paneId: "s1:action-1-dev" }));
    await waitFor(() => expect(state("dev")).toBe("Exited 0"));
    expect(screen.getByTestId("run-menu-trigger").getAttribute("aria-label")).toBe("Run");
  });

  it("words a run's state, including an exit with no code", () => {
    expect(runStateText(undefined)).toBeNull();
    expect(runStateText(run("dev"))).toBe("Running");
    expect(runStateText(run("dev", { state: "exited", exitCode: 0 }))).toBe("Exited 0");
    expect(runStateText(run("dev", { state: "exited", exitCode: 137 }))).toBe("Exited 137");
    expect(runStateText(run("dev", { state: "exited", exitCode: null }))).toBe("Exited");
  });

  it("runs an action from the menu and shows its terminal tab", async () => {
    await renderMenu(project([dev, test]));
    openMenu(screen.getByTestId("run-menu-trigger"));
    fireEvent.click(within(await screen.findByTestId("run-menu")).getByText("Test"));
    await waitFor(() => expect(runCalls()).toEqual([{ sessionId: "s1", actionId: "test", restart: false }]));
    await waitFor(() => expect(getTerminalState().selected.s1).toEqual({ kind: "terminal", id: "s1:action-1-test" }));
  });

  it("is offered for a session with visible actions or preview URLs, and not for a removed workspace", () => {
    expect(offersRunMenu(session, project([dev]))).toBe(true);
    expect(offersRunMenu(session, project([secret]))).toBe(false);
    expect(offersRunMenu(session, project([secret], [web]))).toBe(true);
    expect(offersRunMenu(session, project([]))).toBe(false);
    expect(offersRunMenu(session, undefined)).toBe(false);
    expect(offersRunMenu({ ...session, worktreeRemoved: true }, project([dev]))).toBe(false);
  });
});

describe("⌘R", () => {
  it("is ⌘R by default on macOS, and Ctrl+Alt+R elsewhere where Ctrl+R is the shell's history search", () => {
    expect(resolveKeymap({}, true)["session.runAction"]).toEqual(["mod+r"]);
    expect(resolveKeymap({}, false)["session.runAction"]).toEqual(["mod+alt+r"]);
  });

  it("runs the first visible action when it is the only one", async () => {
    await renderMenu(project([secret, dev]));
    pressRun();
    await waitFor(() => expect(runCalls()).toEqual([{ sessionId: "s1", actionId: "dev", restart: false }]));
    expect(screen.queryByTestId("run-menu")).toBeNull();
  });

  it("opens the menu as a picker when there are several visible actions, running nothing", async () => {
    await renderMenu(project([dev, secret, test]));
    pressRun();
    const menu = await screen.findByTestId("run-menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([expect.stringContaining("Dev"), expect.stringContaining("Test")]);
    expect(runCalls()).toEqual([]);
    // ⌘R opened the menu, so the key is on the menu, not on its first action.
    expect(within(menu).getByTestId("run-menu-picker-key").textContent).toBe("⌘R");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).not.toContainEqual(expect.stringContaining("⌘R"));
  });

  it("shows ⌘R on the action itself when it is the only one", async () => {
    await renderMenu(project([secret, dev]));
    openMenu(screen.getByTestId("run-menu-trigger"));
    const menu = await screen.findByTestId("run-menu");
    expect(within(menu).getByRole("menuitem").textContent).toContain("⌘R");
    expect(within(menu).queryByTestId("run-menu-picker-key")).toBeNull();
  });

  it("does nothing, and leaves the keys alone, when every action is hidden", async () => {
    await renderMenu(project([secret], [web]));
    const event = new KeyboardEvent("keydown", { key: "r", code: "KeyR", metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(runCalls()).toEqual([]);
    expect(screen.queryByTestId("run-menu-trigger")).toBeNull();
  });
});

describe("an action that is already running", () => {
  it("shows its tab instead of starting it again, and offers to restart it", async () => {
    outcome = (actionId, restart) => restart
      ? { run: run(actionId, { paneId: "s1:action-2-dev" }), started: true }
      : { run: run(actionId, { paneId: "s1:action-1-dev" }), started: false };
    await renderMenu(project([dev]));
    pressRun();
    const offer = await screen.findByTestId("run-restart-offer");
    expect(offer.textContent).toContain("Dev is already running");
    expect(getTerminalState().selected.s1).toEqual({ kind: "terminal", id: "s1:action-1-dev" });

    fireEvent.click(within(offer).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(runCalls()).toEqual([{ sessionId: "s1", actionId: "dev", restart: false }, { sessionId: "s1", actionId: "dev", restart: true }]));
    await waitFor(() => expect(getTerminalState().selected.s1).toEqual({ kind: "terminal", id: "s1:action-2-dev" }));
    await waitFor(() => expect(screen.queryByTestId("run-restart-offer")).toBeNull());
  });

  it("can be left running: Dismiss closes the offer", async () => {
    outcome = (actionId) => ({ run: run(actionId), started: false });
    await renderMenu(project([dev]));
    pressRun();
    fireEvent.click(within(await screen.findByTestId("run-restart-offer")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("run-restart-offer")).toBeNull();
    expect(runCalls()).toHaveLength(1);
  });
});

describe("the Open button", () => {
  it("opens the first preview URL in a TerminalX browser tab, $PORT being the session's first port", async () => {
    await renderMenu(project([dev], [web, api, docs]));
    const open = screen.getByRole("button", { name: "Open Web" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_ports", { sessionId: "s1" }));
    fireEvent.click(open);
    await waitFor(() => expect(openedUrls()).toEqual(["http://localhost:4010/"]));
    expect(mocks.invoke).toHaveBeenCalledWith("browser_open_tab", { workspace: "/repo/wt", url: "http://localhost:4010/", profile: null });
    await waitFor(() => expect(getTerminalState().selected.s1).toEqual({ kind: "browser", id: "page-1" }));
  });

  it("lists the other preview URLs in its menu, $PORT_1 being the second port", async () => {
    await renderMenu(project([dev], [web, api, docs]));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_ports", { sessionId: "s1" }));
    openMenu(screen.getByTestId("open-menu-trigger"));
    const menu = await screen.findByTestId("open-menu");
    await waitFor(() => expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("data-preview-id"))).toEqual(["api", "docs"]));
    expect(menu.textContent).toContain("http://localhost:4011/health");
    fireEvent.click(within(menu).getByText("API"));
    await waitFor(() => expect(openedUrls()).toEqual(["http://localhost:4011/health"]));
  });

  it("has no menu for a single preview URL, and no Run menu without visible actions", async () => {
    await renderMenu(project([secret], [web]));
    expect(screen.getByRole("button", { name: "Open Web" })).toBeTruthy();
    expect(screen.queryByTestId("open-menu-trigger")).toBeNull();
    expect(screen.queryByTestId("run-menu-trigger")).toBeNull();
  });

  it("says why when the session's ports are not known, and still opens a literal URL", async () => {
    mocks.ports = null;
    expect(previewTarget(web, null)).toEqual({ error: "This session's ports are not known yet." });
    expect(previewTarget(docs, null)).toEqual({ url: "https://example.com/docs" });
    await renderMenu(project([], [web, docs]));
    fireEvent.click(screen.getByRole("button", { name: "Open Web" }));
    await waitFor(() => expect(getErrorToasts().some((toast) => toast.action === "Couldn't open Web")).toBe(true));
    expect(openedUrls()).toEqual([]);
    openMenu(screen.getByTestId("open-menu-trigger"));
    fireEvent.click(within(await screen.findByTestId("open-menu")).getByText("Docs"));
    await waitFor(() => expect(openedUrls()).toEqual(["https://example.com/docs"]));
  });
});
