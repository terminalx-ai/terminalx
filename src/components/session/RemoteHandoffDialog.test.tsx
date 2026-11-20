import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuationContext } from "@/lib/continuation";
import type { HandoffActions } from "@/lib/sessionBackend";
import type { TabEntry } from "@/types/session";
import { WorkspaceRpcError } from "@terminalx/portable/workspace";

const calls = vi.hoisted(() => ({ launch: [] as unknown[], models: { reading: null as unknown } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ harnesses: [{ id: "claude", name: "Claude Code", available: false }, { id: "codex", name: "Codex", available: false }] }) }));
vi.mock("@/lib/cloudModels", () => ({ useRuntimeModels: () => calls.models.reading }));
vi.mock("@/components/session/HandoffScene", () => ({ HandoffScene: () => null }));
// The pills are New Session's own; here they report what the dialog asked of them.
vi.mock("@/components/session/SessionAgentControls", () => ({ SessionAgentControls: () => <div data-testid="agent-controls" /> }));
vi.mock("@/lib/useSessionAgent", () => ({
  launchSettingsOf: (tab: TabEntry) => ({ harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode }),
  useSessionAgent: (harnesses: { id: string; name: string; available: boolean }[], here: boolean, client: unknown, controlled: { value: { harness: string; model: string; effort: string | null; permissionMode: string } }) => {
    calls.launch.push({ harnesses, here, client, value: controlled.value });
    const harness = harnesses.find((candidate) => candidate.id === controlled.value.harness) ?? null;
    return { harness, model: null, modelId: controlled.value.model, effort: controlled.value.effort, mode: controlled.value.permissionMode };
  },
}));

const { RemoteHandoffDialog } = await import("./RemoteHandoffDialog");

const source = { id: "tab-1", harness: "claude", model: "opus", effort: "high", permissionMode: "acceptEdits", title: "Fix it", status: "completed", created: "", modified: "" } as TabEntry;
// A runtime that lists its agents (`agents/1`): its models are read before anything starts.
const client = { hasCapability: (capability: string) => capability === "agents/1" } as never;

function prepared(): ContinuationContext {
  return {
    sessionId: "rt-1", tabId: "tab-1", title: "Fix it", provider: "claude", providerSessionId: "conv-1", cwd: "/home/vm/api",
    sourceActive: false, transcriptPath: "/home/vm/.claude/projects/api/conv-1.jsonl", fullUnavailableReason: null,
    lastPrompt: "Make the build pass", lastUpdate: "Fixed two tests", partialCapture: null,
  };
}

function actions(open?: HandoffActions["open"]) {
  const handoff = {
    open: vi.fn(open ?? (async () => ({ tabId: "tab-2", startError: null }))),
    context: vi.fn(async () => prepared()),
  };
  return handoff;
}

beforeEach(() => {
  calls.launch = [];
  calls.models.reading = { agents: [], models: [] };
});
afterEach(cleanup);

describe("a handoff on a remote session (#1327)", () => {
  it("a second opinion goes to the other agent on Plan, once the runtime's models are read, and closes once opened", async () => {
    calls.models.reading = null;
    const handoff = actions();
    const onClose = vi.fn();
    const view = render(<RemoteHandoffDialog handoff={handoff} source={source} agent="codex" modelClient={client} purpose={{ kind: "review", prompt: "Give a second opinion" }} where="the workspace" onClose={onClose} />);
    expect(screen.getByText("Second opinion")).toBeTruthy();
    expect(screen.getByText("Reading the workspace's models…")).toBeTruthy();
    expect(handoff.open).not.toHaveBeenCalled();
    // The runtime's agent, its models (not this computer's).
    const asked = calls.launch.at(-1) as { harnesses: unknown[]; here: boolean; client: unknown };
    expect(asked.harnesses).toEqual([{ id: "codex", name: "Codex", available: true }]);
    expect(asked.here).toBe(false);
    expect(asked.client).toBe(client);
    calls.models.reading = { agents: [], models: [] };
    view.rerender(<RemoteHandoffDialog handoff={handoff} source={source} agent="codex" modelClient={client} purpose={{ kind: "review", prompt: "Give a second opinion" }} where="the workspace" onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Another agent's model is its own default; the review only reads.
    expect(handoff.open).toHaveBeenCalledExactlyOnceWith({ agent: "codex", model: undefined, effort: null, mode: "plan", prompt: "Give a second opinion", requestId: expect.stringMatching(/^handoff-/) });
  });

  it("a retry keeps the tab's own agent and mode; a prompt the runtime could not send leaves the one tab open and says why", async () => {
    const handoff = actions(async () => ({ tabId: "tab-2", startError: "The new tab was opened, but its first prompt could not be sent: no login" }));
    const onClose = vi.fn();
    render(<RemoteHandoffDialog handoff={handoff} source={source} agent="claude" modelClient={client} purpose={{ kind: "retry", prompt: "Run the tests" }} where="the machine" onClose={onClose} />);
    expect((await screen.findByRole("alert")).textContent).toContain("no login");
    expect(handoff.open).toHaveBeenCalledExactlyOnceWith({ agent: "claude", model: "opus", effort: "high", mode: "acceptEdits", prompt: "Run the tests", requestId: expect.stringMatching(/^handoff-/) });
    expect(screen.getByText("The new tab is open; its chat says what went wrong.")).toBeTruthy();
    // Nothing offers to make it again.
    expect(screen.queryByRole("button", { name: "Try Again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
    expect(handoff.open).toHaveBeenCalledOnce();
  });

  it.each([
    { failure: "a dropped connection", error: new Error("Workspace connection dropped"), same: true },
    { failure: "an unknown outcome", error: new WorkspaceRpcError("outcome_unknown", "The workspace connection changed.", "session.handoff"), same: true },
    { failure: "a refusal", error: new WorkspaceRpcError("invalid_params", "agent codex is not offered", "session.handoff"), same: false },
  ])("Try Again after $failure is the same request only while the first may have made a tab", async ({ error, same }) => {
    let fail = true;
    const handoff = actions(async () => {
      if (fail) throw error;
      return { tabId: "tab-2", startError: null };
    });
    const onClose = vi.fn();
    render(<RemoteHandoffDialog handoff={handoff} source={source} agent="codex" modelClient={client} purpose={{ kind: "review", prompt: "Review" }} where="the workspace" onClose={onClose} />);
    expect((await screen.findByRole("alert")).textContent).toBe(error.message);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const ids = handoff.open.mock.calls.map(([params]) => (params as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    // The runtime answers a repeated id from its cache: the tab a lost reply made, never a second one.
    expect(ids[0] === ids[1]).toBe(same);
  });

  it("the composer's handoff reads the conversation on the runtime and hands it on when the reader continues", async () => {
    const handoff = actions();
    const onClose = vi.fn();
    render(<RemoteHandoffDialog handoff={handoff} source={source} agent="codex" modelClient={client} purpose={{ kind: "continue" }} where="the workspace" onClose={onClose} />);
    expect(screen.getByText("Preparing context on the workspace…")).toBeTruthy();
    await screen.findByTestId("agent-controls");
    expect(handoff.context).toHaveBeenCalledExactlyOnceWith("tab-1");
    expect(handoff.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [{ agent, mode, prompt }] = handoff.open.mock.calls[0] as [{ agent: string; mode: string; prompt: string }];
    expect([agent, mode]).toEqual(["codex", "acceptEdits"]);
    expect(prompt).toContain("Continue work from the prior TerminalX conversation");
    // The transcript is the runtime's, where the new tab's agent reads it.
    expect(prompt).toContain("/home/vm/.claude/projects/api/conv-1.jsonl");
  });

  it("says so when the runtime cannot read the conversation, and reads it again on Retry", async () => {
    const handoff = actions();
    handoff.context.mockRejectedValueOnce(new Error("no such tab"));
    render(<RemoteHandoffDialog handoff={handoff} source={source} agent="codex" modelClient={client} purpose={{ kind: "continue" }} where="the workspace" onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not prepare context on the workspace: no such tab");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("agent-controls");
    expect(handoff.context).toHaveBeenCalledTimes(2);
  });
});
