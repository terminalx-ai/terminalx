import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceSetup } from "@/lib/workspaceSetup";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), send: vi.fn(), patch: vi.fn(), select: vi.fn(), active: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, errorMessage: (error: unknown) => String(error) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
  mocks.listeners.set(event, handler); return () => mocks.listeners.delete(event);
}) }));
vi.mock("@/lib/sessions", () => ({ selectSession: mocks.select, setActiveTab: mocks.active, useSessionStore: () => ({ sessions: [{ id: "s1", title: "New workspace", activeTab: "t1", tabs: [{ id: "t1", harness: "codex" }] }] }) }));
vi.mock("@/lib/sessionBackend", () => ({ localSessionBackend: () => ({ send: mocks.send, patchTab: mocks.patch }) }));
vi.mock("@/lib/agentEvents", () => ({ applyEvent: vi.fn() }));
vi.mock("./TerminalView", () => ({ TerminalView: ({ id }: { id: string }) => <div data-testid="setup-terminal">{id}</div> }));
import { WorkspaceSetupToasts } from "./WorkspaceSetupNotice";
import { WorkspaceSetupPane } from "./WorkspaceSetupPane";
import { bootWorkspaceSetup, setupFixPrompt } from "@/lib/workspaceSetup";
import { getPrefs } from "@/lib/prefs";

const run: WorkspaceSetup = { sessionId: "s1", paneId: "s1:workspace-setup-first", command: "bun install", status: "failed", exitCode: 7, error: null, hasPane: true };

beforeEach(async () => {
  mocks.invoke.mockImplementation(async (_command, args) => args.operation === "list" ? [] : "\x1b[31mdependency missing\x1b[0m\r\n");
  mocks.send.mockResolvedValue({ events: [], queued: false });
  mocks.active.mockResolvedValue(undefined);
  await bootWorkspaceSetup();
  mocks.listeners.get("session_deleted")?.({ payload: "s1" });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps a failed setup terminal with its result and reruns explicitly", async () => {
  render(<WorkspaceSetupPane run={run} />);
  expect(screen.getByRole("status").textContent).toBe("Setup failed · Exit 7");
  expect(screen.getByTestId("setup-terminal").textContent).toBe(run.paneId);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rerun" })));
  expect(mocks.invoke).toHaveBeenCalledWith("workspace_setup", { operation: "rerun", sessionId: "s1" });
});

it("disables rerun while setup is running", () => {
  render(<WorkspaceSetupPane run={{ ...run, status: "running" }} />);
  expect((screen.getByRole("button", { name: "Rerun" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reads the retained log when its PTY is gone", async () => {
  render(<WorkspaceSetupPane run={{ ...run, hasPane: false }} />);
  expect(await screen.findByText("dependency missing")).toBeTruthy();
  expect(screen.queryByTestId("setup-terminal")).toBeNull();
});

it("offers Show log and sends the attached log only after Ask agent to fix", async () => {
  render(<WorkspaceSetupToasts />);
  act(() => mocks.listeners.get("workspace_setup_changed")?.({ payload: run }));
  expect(screen.getByText("Setup failed")).toBeTruthy();
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show log" }));
  expect(mocks.select).toHaveBeenCalledWith("s1");
  expect(getPrefs()).toMatchObject({ panelOpen: true, panelTerminalOpen: true });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" })));
  expect(mocks.send).toHaveBeenCalledWith("t1", expect.stringContaining("<setup-log>\ndependency missing\n\n</setup-log>"), []);
  expect(mocks.send.mock.calls[0][1]).not.toContain("\x1b");
  await waitFor(() => expect(screen.queryByText("Setup failed")).toBeNull());
});

it("reports a refused fix prompt and keeps the log available", async () => {
  mocks.send.mockRejectedValue(new Error("Agent is unavailable"));
  render(<WorkspaceSetupToasts />);
  act(() => mocks.listeners.get("workspace_setup_changed")?.({ payload: { ...run, paneId: "second" } }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" })));
  expect(screen.getByRole("alert").textContent).toContain("Agent is unavailable");
  expect(screen.getByRole("button", { name: "Show log" })).toBeTruthy();
});

it("bounds an attached log and explicitly identifies a truncated tail", () => {
  const prompt = setupFixPrompt(run, "x".repeat(100_000) + "failure at end");
  expect(prompt.length).toBeLessThan(66_000);
  expect(prompt).toContain("Earlier output omitted");
  expect(prompt).toContain("failure at end");
});

it("stops the exact running or queued attempt and keeps rerun disabled while stopping", async () => {
  const view = render(<WorkspaceSetupPane run={{ ...run, status: "pending", hasPane: false }} />);
  expect(screen.getByRole("status").textContent).toContain("Setup queued");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
  expect(mocks.invoke).toHaveBeenCalledWith("workspace_setup", { operation: "stop", sessionId: "s1", paneId: run.paneId });
  view.rerender(<WorkspaceSetupPane run={{ ...run, status: "stopping" }} />);
  expect((screen.getByRole("button", { name: "Stopping…" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<WorkspaceSetupPane run={{ ...run, status: "stopped" }} />);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect((screen.getByRole("button", { name: "Rerun" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows the timeout failure in the retained result", () => {
  render(<WorkspaceSetupPane run={{ ...run, exitCode: 124, error: "Setup timed out after 30 minutes. Rerun to try again." }} />);
  expect(screen.getByRole("alert").textContent).toContain("timed out after 30 minutes");
  expect(screen.getByRole("button", { name: "Rerun" })).toBeTruthy();
});
