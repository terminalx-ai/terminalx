/**
 * First launch on a Mac with no agent (PRO-152): from the welcome screen to a
 * signed-in agent without leaving it, against a stubbed installer. The
 * backend half (the wrapper, a real terminal, the stub installer and the
 * readiness probe) is `harness::setup::tests::e2e` in `src-tauri`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo } from "@/types/session";
import type { AgentReadiness } from "@/lib/agentReadiness";

const { invoke, listen, store, sessions, setup, pty } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  store: { harnesses: [] as HarnessInfo[] },
  sessions: { addProject: vi.fn(), startSessionIn: vi.fn(), refreshHarnesses: vi.fn() },
  setup: { start: vi.fn() },
  pty: { kill: vi.fn(async () => {}), resize: vi.fn(async () => {}) },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({ errorMessage: String, files: { droppedText: vi.fn(async () => null) }, agentSetup: setup, pty }));
vi.mock("@/lib/account", () => ({ signIn: vi.fn(), useAccount: () => ({ ready: true, busy: false, status: { state: "signed-in" } }) }));
vi.mock("@/lib/prefs", () => ({ setPrefs: vi.fn(), usePrefs: () => ({ projectsDir: null }) }));
vi.mock("@/lib/sessions", () => ({ ...sessions, useSessionStore: () => store }));
vi.mock("@/lib/terminal", () => ({ disposeInstance: vi.fn(), peekInstance: () => undefined }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="terminal-view" data-pane={id} /> }));

const { StartScreen } = await import("./StartScreen");
const { resetAgentSetupFlows } = await import("@/lib/agentSetupFlow");

const caps = { images: true, steer: true, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true };
const agent = (id: string, name: string): HarnessInfo => ({ id, name, binary: id, available: false, installable: true, installHint: `install ${id}`, installUrl: `https://example.com/${id}`, caps });

/** What is on this stubbed Mac: nothing at first. */
let installed: Record<string, AgentReadiness["state"]> = {};
const handlers = new Set<(event: { payload: unknown }) => void>();
const exit = (id: string, code: number) => act(async () => handlers.forEach((handler) => handler({ payload: { id, code } })));

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentSetupFlows();
  handlers.clear();
  installed = { claude: "missing", codex: "missing" };
  store.harnesses = [agent("claude", "Claude Code"), agent("codex", "Codex")];
  // The harness list follows what is installed, as the backend's does.
  sessions.refreshHarnesses.mockImplementation(async () => {
    store.harnesses = store.harnesses.map((harness) => ({ ...harness, available: installed[harness.id] !== "missing" }));
  });
  listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === "pty_exit") handlers.add(handler);
    return () => handlers.delete(handler);
  });
  invoke.mockImplementation(async (command: string, args: { harness: string }) => {
    if (command === "check_agent_readiness") return { state: installed[args.harness], checkedAt: "2026-11-06T09:00:00Z", version: installed[args.harness] === "missing" ? null : "2.1.318" };
    throw new Error(`unexpected ${command}`);
  });
  setup.start.mockResolvedValue(undefined);
});
afterEach(cleanup);

const row = (name: string) => screen.getByRole("region", { name: `${name} setup` });

describe("first run with no agent installed (PRO-152)", () => {
  it("installs, signs in and shows Ready on the welcome screen without Terminal or Check again", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);
    expect(screen.getByTestId("start-no-agent").textContent).toContain("No agent is installed");
    await waitFor(() => expect(within(row("Claude Code")).getByRole("status").textContent).toBe("Not installed"));

    fireEvent.click(screen.getByRole("button", { name: "Install Claude Code and sign in" }));
    await waitFor(() => expect(setup.start).toHaveBeenCalledTimes(1));
    const [pane, harness, step] = setup.start.mock.calls[0];
    expect([harness, step]).toEqual(["claude", "install"]);
    expect(within(row("Claude Code")).getByRole("status").textContent).toBe("Installing · sign-in next");
    expect(within(row("Claude Code")).getByTestId("terminal-view").getAttribute("data-pane")).toBe(pane);
    // One run at a time per agent; the other agent is untouched.
    expect(within(row("Codex")).getByRole("button", { name: "Install Codex and sign in" })).toBeTruthy();

    // The stubbed installer finishes: the CLI is there, not yet signed in.
    installed.claude = "signed_out";
    await exit(pane, 0);
    await waitFor(() => expect(setup.start).toHaveBeenCalledTimes(2));
    expect(setup.start.mock.calls[1].slice(0, 3)).toEqual([pane, "claude", "login"]);
    // The agent now counts as installed, and the setup stays in view for its sign-in.
    expect(store.harnesses[0].available).toBe(true);
    expect(screen.getByTestId("start-no-agent").textContent).toContain("No agent is signed in");
    expect(within(row("Claude Code")).getByRole("status").textContent).toBe("Signing in");
    expect(within(row("Claude Code")).getByTestId("terminal-view").getAttribute("data-pane")).toBe(pane);

    // The browser step is done and the CLI's sign-in exits.
    installed.claude = "ready";
    await exit(pane, 0);
    await waitFor(() => expect(within(row("Claude Code")).getByRole("status").textContent).toBe("Ready · local login found"));
    expect(within(row("Claude Code")).getByText(/Claude Code is ready\. Open a project above/)).toBeTruthy();
    expect(screen.getByTestId("start-no-agent").textContent).toContain("Set up an agent");
    expect(within(row("Claude Code")).queryByTestId("terminal-view")).toBeNull();
    expect(pty.kill).toHaveBeenCalledWith(pane);
    expect(within(row("Codex")).getByRole("status").textContent).toBe("Not installed");
  });

  it("offers a retry when the network is down, and finishes once it is back", async () => {
    render(<StartScreen onOpenSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install Codex and sign in" }));
    await waitFor(() => expect(setup.start).toHaveBeenCalledTimes(1));
    const pane = setup.start.mock.calls[0][0];

    await exit(pane, 71);
    expect(within(row("Codex")).getByRole("alert").textContent).toMatch(/Could not reach the provider/);
    expect(within(row("Codex")).getByRole("status").textContent).toBe("Setup did not finish");

    fireEvent.click(within(row("Codex")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(setup.start).toHaveBeenCalledTimes(2));
    expect(setup.start.mock.calls[1].slice(0, 3)).toEqual([pane, "codex", "install"]);
    installed.codex = "signed_out";
    await exit(pane, 0);
    await waitFor(() => expect(setup.start).toHaveBeenCalledTimes(3));
    installed.codex = "ready";
    await exit(pane, 0);
    await waitFor(() => expect(within(row("Codex")).getByRole("status").textContent).toBe("Ready · local login found"));
  });
});
