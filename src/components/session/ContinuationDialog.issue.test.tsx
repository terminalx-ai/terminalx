import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssuePipeline } from "@/types/issuePipeline";
import type { SessionEntry, TabEntry } from "@/types/session";

// #700: an issue's session starts set to resolve conflicts and merge when green.
// Continuing it in a new conversation must not take that back unasked: an off
// sent with the continuation revokes the switch on the session's pipeline.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), prepare: vi.fn(), start: vi.fn(), send: vi.fn(), add: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, agent: { ...actual.agent, prepareContinuation: mocks.prepare, ensureStarted: mocks.start, send: mocks.send }, api: { ...actual.api, listHarnesses: async () => [{ id: "claude", name: "Claude Code", available: true }] } };
});
// A project that chose nothing for the launch switches.
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ projects: [{ path: "/repo", kind: "git", issuePipeline: { enabled: true } }] }),
  addTab: mocks.add,
}));
vi.mock("@/lib/agentEvents", () => ({ applyEvent: vi.fn() }));
vi.mock("@/lib/models", async (original) => ({
  ...await original<typeof import("@/lib/models")>(), loadModels: vi.fn(async () => {}), refreshModels: vi.fn(),
  useModels: () => [{ harness: "claude", id: "opus", label: "Opus", efforts: ["high"], defaultEffort: "high", isDefault: true, acceptsImages: true }],
}));
import { upsertPipeline } from "@/lib/issuePipeline";
import { ContinuationDialog } from "./ContinuationDialog";

const source = { id: "source", harness: "claude", model: "opus", effort: "high", permissionMode: "plan", status: "completed" } as TabEntry;
const issue = { provider: "github", id: "700", identifier: "#700", title: "Merge issue sessions when green", url: "https://example.test/issues/700" };
let sessionCount = 0;

/** An issue's session, with its pipeline as given, or none. Each test has its own session: the pipeline store is the app's. */
function issueSession(pipeline: Partial<IssuePipeline> | null): SessionEntry {
  const id = `issue-author-${++sessionCount}`;
  if (pipeline) {
    upsertPipeline({
      id: `pipeline-${id}`, projectPath: "/repo", issue, branch: "raccoon/700", author: { sessionId: id, tabId: "source" }, reviewer: null,
      autoMerge: true, resolveConflicts: true, stopped: false, stage: "work", state: "working", round: 0, maxRounds: 3, events: [],
      created: "2026-11-01T00:00:00Z", modified: "2026-11-01T00:00:00Z", ...pipeline,
    } as IssuePipeline);
  }
  return { id, projectPath: "/repo", cwd: "/repo/.raccoon/worktrees/700", title: "#700 Merge issue sessions when green", issue, tabs: [source] } as SessionEntry;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue({ ...source, id: "next" });
  mocks.start.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue({ events: [] });
  // `issue_pipeline_continue` answering null: nothing was handed on (the engine's tests cover the handoff).
  mocks.invoke.mockResolvedValue(null);
});
afterEach(cleanup);

async function continueIn(session: SessionEntry) {
  mocks.prepare.mockResolvedValue({ sessionId: session.id, tabId: "source", title: session.title, cwd: session.cwd, provider: "claude", sourceActive: false, transcriptPath: "/history", lastPrompt: "Work", lastUpdate: "Ready" });
  render(<ContinuationDialog session={session} source={source} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start New Session" }).hasAttribute("disabled")).toBe(false));
  const shown = ["Resolve conflicts automatically", "Merge when green"].map((name) => screen.getByRole("switch", { name }).getAttribute("aria-checked"));
  fireEvent.click(screen.getByRole("button", { name: "Start New Session" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("issue_pipeline_continue", expect.anything()));
  const [, args] = mocks.invoke.mock.calls.find(([command]) => command === "issue_pipeline_continue")!;
  return { shown, sent: (args as { options: unknown }).options };
}

it("carries both switches on, as the issue's pipeline holds them", async () => {
  const { shown, sent } = await continueIn(issueSession({ autoMerge: true, resolveConflicts: true }));
  expect(shown).toEqual(["true", "true"]);
  expect(sent).toEqual({ autoMerge: true, resolveConflicts: true });
});

it("carries a switch the pipeline turned off as off, and the other as it is", async () => {
  const { shown, sent } = await continueIn(issueSession({ autoMerge: false, resolveConflicts: true }));
  expect(shown).toEqual(["true", "false"]);
  expect(sent).toEqual({ autoMerge: false, resolveConflicts: true });
});

it("leaves a merged pipeline as history: nothing to hand on, so nothing that could be refused", async () => {
  const { shown, sent } = await continueIn(issueSession({ state: "merged", stage: "merge" }));
  expect(shown).toEqual(["false", "false"]);
  expect(sent).toEqual({ autoMerge: false, resolveConflicts: false });
});

it("starts no automation for an issue's session that has no pipeline", async () => {
  const { shown, sent } = await continueIn(issueSession(null));
  expect(shown).toEqual(["false", "false"]);
  expect(sent).toEqual({ autoMerge: false, resolveConflicts: false });
});
