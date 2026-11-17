import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { TabEntry } from "@/types/session";

// PRO-408: Continue in a new tab of a machine session, done on the machine.
// This computer's commands are recorded: the dialog must reach none of them.
const invoked = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string) => void invoked.push(command), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), useModels: () => [], loadModels: vi.fn() }));

const { MachineContinuationDialog } = await import("./ContinuationDialogMachine");

const source = { id: "t1", harness: "claude", model: "opus", effort: "high", permissionMode: "plan", status: "completed", title: "Login", created: "" } as unknown as TabEntry;

function machine(continueInNewTab: CloudSessionModel["continueInNewTab"], continueBlocked: string | null = null): CloudSessionModel {
  return {
    machine: { machineId: "m1", projectId: "p1", name: "Mac mini" },
    agents: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }],
    client: null,
    continueInNewTab,
    continueBlocked,
  } as unknown as CloudSessionModel;
}

afterEach(() => {
  cleanup();
  invoked.length = 0;
});

describe("Continue in a new tab on a machine", () => {
  it("says what the machine answered when the context could not be read, stays open, and can be tried again", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("No usable saved context exists for this conversation.")).mockResolvedValueOnce({ tabId: "t2", queued: false });
    const onClose = vi.fn();
    render(<MachineContinuationDialog cloud={machine(run)} source={source} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue in New Tab" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("No usable saved context exists for this conversation.");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue in New Tab" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith({ sourceTabId: "t1", agent: "claude", model: "opus", effort: "high", mode: "plan", context: "focused" });
    expect(invoked).toEqual([]);
  });

  it("starts another agent at its own defaults: the source's effort is not carried to it", async () => {
    const run = vi.fn(async () => ({ tabId: "t2", queued: true }));
    render(<MachineContinuationDialog cloud={machine(run)} source={source} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Agent" }), { target: { value: "codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue in New Tab" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ sourceTabId: "t1", agent: "codex", model: undefined, effort: null, mode: "plan", context: "focused" }));
  });

  it("says why it cannot start while the machine is away, and starts nothing", () => {
    const run = vi.fn();
    render(<MachineContinuationDialog cloud={machine(run, "Can't send until Mac mini is back")} source={source} onClose={() => undefined} />);
    expect(screen.getByTestId("machine-continue-blocked").textContent).toBe("Can't send until Mac mini is back");
    const start = screen.getByRole("button", { name: "Continue in New Tab" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(run).not.toHaveBeenCalled();
  });
});
