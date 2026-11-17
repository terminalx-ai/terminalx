import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuationContext } from "@/lib/continuation";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { TabEntry } from "@/types/session";

const calls = vi.hoisted(() => ({ select: vi.fn(), launch: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/terminal", () => ({ selectSessionTab: calls.select }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ harnesses: [{ id: "claude", name: "Claude Code", available: false }, { id: "codex", name: "Codex", available: false }] }) }));
vi.mock("@/components/session/HandoffScene", () => ({ HandoffScene: () => null }));
// The pills are New Session's own; here they report what the dialog asked of them.
vi.mock("@/components/session/SessionAgentControls", () => ({ SessionAgentControls: () => <div data-testid="agent-controls" /> }));
vi.mock("@/lib/useSessionAgent", () => ({
  launchSettingsOf: (tab: TabEntry) => ({ harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode }),
  useSessionAgent: (harnesses: { id: string; available: boolean }[], here: boolean, client: unknown, controlled: { value: { harness: string; model: string; effort: string | null; permissionMode: string } }) => {
    calls.launch.push({ harnesses, here, client, value: controlled.value });
    const harness = harnesses.find((candidate) => candidate.id === controlled.value.harness) ?? null;
    return { harness, modelId: controlled.value.model, effort: controlled.value.effort, mode: controlled.value.permissionMode };
  },
}));

const { MachineContinueDialog } = await import("./MachineContinueDialog");

const source = { id: "tab-1", harness: "claude", model: "opus", effort: "high", permissionMode: "acceptEdits", title: "Fix it", status: "completed", created: "", modified: "" } as TabEntry;

function prepared(patch: Partial<ContinuationContext> = {}): ContinuationContext {
  return {
    sessionId: "rt-1", tabId: "tab-1", title: "Fix it", provider: "claude", providerSessionId: "conv-1", cwd: "/home/dev/api",
    sourceActive: false, transcriptPath: "/home/dev/.claude/projects/api/conv-1.jsonl", fullUnavailableReason: null,
    lastPrompt: "Make the build pass", lastUpdate: "Fixed two tests", partialCapture: null, ...patch,
  };
}

function model(patch: { prepare?: ReturnType<typeof vi.fn>; addAgentTab?: ReturnType<typeof vi.fn>; send?: ReturnType<typeof vi.fn> } = {}) {
  const prepare = patch.prepare ?? vi.fn(async () => prepared());
  const addAgentTab = patch.addAgentTab ?? vi.fn(async () => "tab-2");
  const send = patch.send ?? vi.fn(async () => ({ events: [], queued: false }));
  const cloud = {
    client: { prepareContinuation: prepare },
    backend: { key: "machine:m1:p1:rt-1", logSessionId: "rt-1", generation: "1", send, sendHeldReason: null, readOnlyReason: null },
    agents: [{ id: "claude", name: "Claude Code" }],
    machine: { name: "Mac mini" },
    connected: true,
    addAgentTab,
  } as unknown as CloudSessionModel;
  return { cloud, prepare, addAgentTab, send };
}

beforeEach(() => {
  calls.select.mockReset();
  calls.launch = [];
});
afterEach(cleanup);

describe("Continue in a new tab, on a machine (PRO-408)", () => {
  it("reads the context on the machine, adds a tab there with the source's settings and hands it the conversation", async () => {
    const { cloud, prepare, addAgentTab, send } = model();
    const onClose = vi.fn();
    render(<MachineContinueDialog cloud={cloud} source={source} onClose={onClose} />);
    expect(screen.getByText("Preparing context on Mac mini…")).toBeTruthy();
    await screen.findByTestId("agent-controls");
    expect(prepare).toHaveBeenCalledExactlyOnceWith("rt-1", "tab-1");
    // The machine's agents, its models (not this computer's), starting from the source tab's settings.
    const asked = calls.launch.at(-1) as { harnesses: { id: string; available: boolean }[]; here: boolean; client: unknown; value: unknown };
    expect(asked.harnesses).toEqual([{ id: "claude", name: "Claude Code", available: true }]);
    expect(asked.here).toBe(false);
    expect(asked.client).toBe(cloud.client);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(addAgentTab).toHaveBeenCalledExactlyOnceWith({ agent: "claude", model: "opus", effort: "high", mode: "acceptEdits" });
    expect(send).toHaveBeenCalledOnce();
    const [tabId, prompt, images] = send.mock.calls[0];
    expect(tabId).toBe("tab-2");
    expect(images).toEqual([]);
    expect(prompt).toContain("Continue work from the prior TerminalX conversation");
    // The transcript is the machine's, where the new tab's agent reads it.
    expect(prompt).toContain("/home/dev/.claude/projects/api/conv-1.jsonl");
    expect(calls.select).toHaveBeenCalledWith("machine:m1:p1:rt-1", { kind: "agent", id: "tab-2" });
  });

  it("offers the full transcript only when the machine has one", async () => {
    const { cloud } = model({ prepare: vi.fn(async () => prepared({ transcriptPath: null, fullUnavailableReason: "The saved transcript is gone.", partialCapture: "recent turns" })) });
    render(<MachineContinueDialog cloud={cloud} source={source} onClose={vi.fn()} />);
    await screen.findByTestId("agent-controls");
    expect((screen.getByRole("radio", { name: "Full transcript" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("The saved transcript is gone.")).toBeTruthy();
  });

  it("keeps the new tab when the handoff cannot be sent, and sends it there on the next try, never adding a second tab", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("Can't send until Mac mini is back")).mockResolvedValueOnce({ events: [], queued: false });
    const { cloud, addAgentTab } = model({ send });
    const onClose = vi.fn();
    render(<MachineContinueDialog cloud={cloud} source={source} onClose={onClose} />);
    await screen.findByTestId("agent-controls");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Can't send until Mac mini is back");
    expect(screen.getByText(/The new tab is open/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send Handoff" })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(addAgentTab).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[0])).toEqual(["tab-2", "tab-2"]);
  });

  it("says why when the machine cannot prepare the context, and retries", async () => {
    const prepare = vi.fn().mockRejectedValueOnce(new Error("no such tab")).mockResolvedValueOnce(prepared());
    const { cloud } = model({ prepare });
    render(<MachineContinueDialog cloud={cloud} source={source} onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Could not prepare context on Mac mini: no such tab");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("agent-controls");
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
