import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dragDropListener, droppedText } = vi.hoisted(() => ({ dragDropListener: vi.fn(), droppedText: vi.fn(async () => "echo dragged") }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/terminalWebgl", () => ({ showWebgl: vi.fn(), hideWebgl: vi.fn() }));
vi.mock("@/lib/api", () => ({ pty: {}, files: { droppedText } }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => () => "Someone" }));

import { CloudAgentTerminal } from "./CloudAgentTerminal";
import { agentTerminalId } from "@/lib/cloudTerminals";
import type { AgentTerminalTarget } from "@/lib/sessionBackend";
import { disposeInstance, type TerminalInstance } from "@/lib/terminal";

/**
 * The agent's terminal on the VM (PRO-86) passes no drop policy of its own,
 * so it has the one every terminal that is not on this computer starts with:
 * a local path is never typed into the agent CLI's prompt there, and neither
 * is dragged text, whoever is looking.
 */
describe("dropping on a cloud agent's terminal", () => {
  const paste = vi.fn();
  const write = vi.fn(async () => undefined);
  const base = (): TerminalInstance => {
    const term = { options: {}, focus: vi.fn(), dispose: vi.fn(), paste, onData: vi.fn(), onBinary: vi.fn(), onResize: vi.fn(), cols: 80, rows: 24, modes: { bracketedPasteMode: true } };
    return { el: document.createElement("div"), term, fit: { proposeDimensions: () => undefined } } as never;
  };
  // Not connected: the view shows its terminal without asking the runtime for anything.
  const target: AgentTerminalTarget = { workspaceKey: "cloud:o1:w1", client: null, asleep: false, base, process: () => "running", wake: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    dragDropListener.mockResolvedValue(vi.fn());
    disposeInstance(agentTerminalId("cloud:o1:w1", "t1"));
  });
  afterEach(cleanup);

  it.each([
    ["the person who may type there", null],
    ["a viewer", "Viewers cannot type in this workspace."],
    ["someone without control of the tab", "Someone is driving this tab."],
  ])("refuses files and text for %s", async (_who, blocked) => {
    render(<CloudAgentTerminal target={target} generation="g1" tabId="t1" active blocked={blocked} />);
    await waitFor(() => expect(dragDropListener).toHaveBeenCalledOnce());
    document.elementFromPoint = () => screen.getByTestId("terminal-drop-target");
    const onDrag = dragDropListener.mock.calls[0][0];
    const drag = (payload: { type: string; paths: string[] }) => act(() => onDrag({ payload: { position: { x: 1, y: 1 }, ...payload } }));

    await drag({ type: "enter", paths: ["/Users/me/secret.txt"] });
    expect(screen.getByText(/can't be dropped on a cloud terminal/)).toBeTruthy();
    await drag({ type: "drop", paths: ["/Users/me/secret.txt"] });
    expect(screen.getByText(/can't be dropped on a cloud terminal/)).toBeTruthy();

    await drag({ type: "drop", paths: [] });
    expect(screen.getByText("Nothing can be dropped on this terminal.")).toBeTruthy();

    expect(paste).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(target.wake).not.toHaveBeenCalled();
  });
});
