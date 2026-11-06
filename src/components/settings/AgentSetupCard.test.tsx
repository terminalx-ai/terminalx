import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInfo } from "@/types/session";
import type { AgentReadiness } from "@/lib/agentReadiness";

const { invoke, listen, refreshHarnesses } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), refreshHarnesses: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/lib/sessions", () => ({ refreshHarnesses }));
vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="terminal-view" data-pane={id} /> }));
import { AgentSetupCard } from "./AgentSetupCard";
import { resetAgentSetupFlows } from "@/lib/agentSetupFlow";

const harness: HarnessInfo = {
  id: "codex", name: "Codex", binary: "codex", available: false, installable: true,
  installHint: "curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login", installUrl: "https://developers.openai.com/codex/cli",
  caps: { images: true, steer: false, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: true, resume: true },
};
const answer = (state: AgentReadiness["state"]): AgentReadiness => ({ state, checkedAt: "2026-11-05T16:00:00Z", version: state === "missing" ? null : "0.166.0" });

const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (event: string, payload: unknown) => handlers.get(event)?.forEach((handler) => handler({ payload }));
/** The embedded sign-in shell exits (PRO-170); and how many still listen for exits. */
const exitLogin = (code: number) => emit("pty_exit", { id: "codex-login", code });
const exits = { get size() { return handlers.get("pty_exit")?.size ?? 0; } };

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentSetupFlows();
  handlers.clear();
  listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)!.delete(handler);
  });
});
afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("agent setup card (PRO-170)", () => {
  it("keeps badge and body together through missing → installed → ready despite a stale harness list", async () => {
    invoke.mockResolvedValue(answer("missing"));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    expect(await screen.findAllByText("Not installed")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Install Codex and sign in" })).toBeTruthy();

    invoke.mockResolvedValue(answer("signed_out"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Sign in required")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Codex setup" })).getAllByRole("status")[0].textContent).toBe("Installed · sign in required");
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install Codex and sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in to Codex" })).toBeTruthy();

    invoke.mockResolvedValue(answer("ready"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Codex setup" })).getByRole("status").textContent).toBe("Ready · local login found");
    expect(screen.queryByText("Sign in required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
  });

  it("uses the readiness result when an installed CLI is removed, and retains manual checks", async () => {
    invoke.mockResolvedValue(answer("ready"));
    render(<ul><AgentSetupCard harness={{ ...harness, available: true }} /></ul>);
    await screen.findByText("Ready");
    invoke.mockResolvedValue(answer("missing"));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findAllByText("Not installed")).toHaveLength(2);
    expect(refreshHarnesses).toHaveBeenCalledOnce();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("keeps badge and body together while checking an embedded login, including a failed sign-in", async () => {
    invoke.mockResolvedValue(answer("signed_out"));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    await screen.findByText("Sign in required");

    for (const [code, state] of [[1, "signed_out"], [0, "ready"]] as const) {
      let finish: (value: AgentReadiness) => void = () => {};
      invoke.mockReturnValueOnce(new Promise<AgentReadiness>((resolve) => { finish = resolve; }));
      act(() => exitLogin(code));
      expect(screen.getByText("Checking…")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("Checking installation and login…");
      expect(screen.queryByText("Sign in required")).toBeNull();
      expect(screen.queryByText("Ready")).toBeNull();
      expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(true);

      await act(async () => finish(answer(state)));
      expect(screen.getByText(state === "ready" ? "Ready" : "Sign in required")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe(state === "ready" ? "Ready · local login found" : "Installed · sign in required");
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(refreshHarnesses).not.toHaveBeenCalled();
  });

  it("updates both labels on the two-minute timer and stops checking after leaving Agents", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    invoke.mockResolvedValue(answer("missing"));
    const { unmount } = render(<ul><AgentSetupCard harness={harness} /></ul>);
    await act(async () => {});
    expect(screen.getAllByText("Not installed")).toHaveLength(2);

    invoke.mockResolvedValue(answer("signed_out"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByText("Sign in required")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Installed · sign in required");
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get it" })).toBeNull();

    hidden.mockReturnValue(true);
    invoke.mockResolvedValue(answer("ready"));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Sign in required")).toBeTruthy();

    hidden.mockReturnValue(false);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Ready · local login found");
    expect(screen.queryByText("Sign in required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);

    unmount();
    exitLogin(0);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(exits.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows checking and unknown consistently without falling back to cached installation status", async () => {
    let reject: (reason: Error) => void = () => {};
    invoke.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    expect(screen.getByText("Checking…")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Checking installation and login…");
    expect(screen.queryByText("Not installed")).toBeNull();
    await act(async () => reject(new Error("private diagnostic")));
    expect(screen.getAllByText("Login not checked")).toHaveLength(2);
    expect(screen.queryByText("private diagnostic")).toBeNull();
  });

  it("offers only the commands to copy for an agent the app cannot install", async () => {
    invoke.mockResolvedValue(answer("missing"));
    render(<ul><AgentSetupCard harness={{ ...harness, installable: false }} /></ul>);
    await screen.findAllByText("Not installed");
    expect(screen.queryByRole("button", { name: "Install Codex and sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByText(harness.installHint)).toBeTruthy();
  });
});

describe("installing from the card (PRO-152)", () => {
  it("runs install then sign-in in its terminal and turns Ready without Check again", async () => {
    let state: AgentReadiness["state"] = "missing";
    invoke.mockImplementation(async (command: string) => (command === "check_agent_readiness" ? answer(state) : null));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    fireEvent.click(await screen.findByRole("button", { name: "Install Codex and sign in" }));

    expect(await screen.findByText("Installing…")).toBeTruthy();
    const pane = screen.getByTestId("terminal-view").getAttribute("data-pane")!;
    expect(invoke).toHaveBeenCalledWith("agent_setup_start", expect.objectContaining({ id: pane, harness: "codex", step: "install" }));
    expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(true);

    state = "signed_out";
    await act(async () => emit("pty_exit", { id: pane, code: 0 }));
    expect(await screen.findByText("Signing in…")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").getAttribute("data-pane")).toBe(pane);
    expect(screen.getByText(/Finish in your browser/)).toBeTruthy();

    state = "ready";
    await act(async () => emit("pty_exit", { id: pane, code: 0 }));
    expect(await screen.findByText("Ready")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("terminal-view")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Ready · local login found");
    expect(invoke.mock.calls.filter(([command]) => command === "agent_setup_start")).toHaveLength(2);
  });

  it("says what went wrong, keeps the output, and tries again", async () => {
    invoke.mockImplementation(async (command: string) => (command === "check_agent_readiness" ? answer("missing") : null));
    render(<ul><AgentSetupCard harness={harness} /></ul>);
    fireEvent.click(await screen.findByRole("button", { name: "Install Codex and sign in" }));
    const pane = (await screen.findByTestId("terminal-view")).getAttribute("data-pane")!;

    for (const [code, text] of [[70, /not writable by you/], [71, /Could not reach the provider/], [72, /could not be downloaded/], [73, /installer stopped/]] as const) {
      await act(async () => emit("pty_exit", { id: pane, code }));
      expect((await screen.findByRole("alert")).textContent).toMatch(text);
      expect(screen.getAllByText("Setup did not finish")).toHaveLength(2);
      expect(screen.getByTestId("terminal-view")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Installing…")).toBeTruthy();
    }
    expect(invoke.mock.calls.filter(([command, args]) => command === "agent_setup_start" && args.id === pane)).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Codex setup" }));
    expect(await screen.findAllByText("Not installed")).toHaveLength(2);
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("pty_kill", { id: pane });
  });
});
