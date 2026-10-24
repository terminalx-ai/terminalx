import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry, TabEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), prepare: vi.fn(), start: vi.fn(), send: vi.fn(), add: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, agent: { ...actual.agent, prepareContinuation: mocks.prepare, ensureStarted: mocks.start, send: mocks.send }, api: { ...actual.api, listHarnesses: async () => [{ id: "claude", name: "Claude Code", available: true }] } };
});
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ projects: [{ path: "/repo", kind: "git", issuePipeline: { enabled: true, autoMerge: true, resolveConflicts: true } }] }),
  addTab: mocks.add,
}));
vi.mock("@/lib/agentEvents", () => ({ applyEvent: vi.fn() }));
vi.mock("@/lib/models", async (original) => ({
  ...await original<typeof import("@/lib/models")>(), loadModels: vi.fn(async () => {}), refreshModels: vi.fn(),
  useModels: () => [{ harness: "claude", id: "opus", label: "Opus", efforts: ["high"], defaultEffort: "high", isDefault: true, acceptsImages: true }],
}));
import { ContinuationDialog } from "./ContinuationDialog";
const source = { id: "source", harness: "claude", model: "opus", effort: "high", permissionMode: "plan", status: "completed" } as TabEntry;
const session = { id: "author", projectPath: "/repo", cwd: "/repo/work", title: "Work", tabs: [source] } as SessionEntry;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({ sessionId: "author", tabId: "source", title: "Work", cwd: session.cwd, provider: "claude", sourceActive: false, transcriptPath: "/history", lastPrompt: "Work", lastUpdate: "Ready" });
  mocks.add.mockResolvedValue({ ...source, id: "next" });
  mocks.start.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue({ events: [] });
});
afterEach(cleanup);

it.each(["existing", "absent", "merged", "cleaned", "refused", "stopped"])("carries both off choices through the real continuation flow: %s pipeline", async (state) => {
  const launchSession = state === "cleaned" ? { ...session, cwd: session.projectPath, worktreeRemoved: true, branch: "main", baseRef: null } : session;
  mocks.prepare.mockResolvedValue({ sessionId: "author", tabId: "source", title: "Work", cwd: launchSession.cwd, provider: "claude", sourceActive: false, transcriptPath: "/history", lastPrompt: "Work", lastUpdate: "Ready" });
  const prior = { id: "p", projectPath: "/repo", author: { sessionId: "author", tabId: "source" }, autoMerge: true, resolveConflicts: true, events: [], stage: "work", state: "working" };
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command !== "issue_pipeline_continue") return null;
    // This is the native boundary, not a stub of launchContinuation or its
    // preparation helper. Engine tests exercise the command's state transition.
    expect(args).toEqual({ sessionId: "author", tabId: "next", options: { autoMerge: false, resolveConflicts: false } });
    if (state === "refused") throw new Error("Author is busy; permissions revoked, handoff refused");
    if (state === "stopped") throw new Error("Resume this pipeline before handing it to a new author conversation.");
    if (["absent", "merged", "cleaned"].includes(state)) return null;
    return { pipeline: { ...prior, author: { sessionId: "author", tabId: "next" }, ...args.options }, authorBrief: "PIPELINE HANDOFF" };
  });
  render(<ContinuationDialog session={launchSession} source={source} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start New Session" }).hasAttribute("disabled")).toBe(false));
  for (const name of ["Merge when green", "Resolve conflicts automatically"]) {
    const toggle = screen.getByRole("switch", { name });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  }
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("issue_pipeline_continue", expect.anything()));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "issue_pipeline_start")).toBe(false);
  if (state === "refused" || state === "stopped") {
    await screen.findByText(state === "refused" ? /Author is busy/ : /Resume this pipeline/);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(mocks.send).toHaveBeenCalled());
    expect(mocks.invoke.mock.invocationCallOrder[mocks.invoke.mock.calls.findIndex(([command]) => command === "issue_pipeline_continue")]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
    expect(mocks.send.mock.calls[0][2].includes("PIPELINE HANDOFF")).toBe(state === "existing");
    expect(mocks.send.mock.calls[0].slice(0, 2)).toEqual(["author", "next"]);
    expect(mocks.send.mock.calls[0][2]).toContain('"workingDirectory": "' + launchSession.cwd + '"');
    expect(mocks.send.mock.calls[0][2]).toContain("/history");
  }
});
