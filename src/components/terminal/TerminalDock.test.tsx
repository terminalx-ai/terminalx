import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  detachAll: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/api", () => ({ pty, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("./TerminalView", () => ({
  TerminalView: ({ id, visible }: { id: string; visible: boolean }) => <div data-testid="terminal-view" data-id={id} data-visible={visible} />,
}));

import { TerminalDock as Dock } from "./TerminalDock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setPrefs } from "@/lib/prefs";
import { dropSessionTerminals } from "@/lib/terminal";

const TerminalDock = (props: { sessionId: string; cwd: string }) => (
  <TooltipProvider>
    <Dock {...props} />
  </TooltipProvider>
);
const shown = () => screen.getAllByTestId("terminal-view").filter((view) => view.dataset.visible === "true").map((view) => view.dataset.id);

beforeEach(() => {
  dropSessionTerminals(["s1"]);
  vi.clearAllMocks();
  setPrefs({ panelTerminalOpen: false });
});

afterEach(cleanup);

describe("the right panel's terminal dock", () => {
  it("starts folded and opens a shell in the session's folder when shown", async () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(pty.spawn).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show terminal" })));
    expect(pty.spawn).toHaveBeenCalledWith(expect.stringMatching(/^s1:dock-/), "/repo", 80, 12, undefined, "Terminal 1");
    // One terminal is just "Terminal"; numbers come with a second.
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
    expect(shown()).toHaveLength(1);
  });

  it("adds more terminals, switches between them and closes them", async () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    const [first, second] = pty.spawn.mock.calls.map(([id]) => id as string);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Terminal 1", "Terminal 2"]);
    expect(shown()).toEqual([second]);

    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));
    expect(shown()).toEqual([first]);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" })));
    expect(pty.kill).toHaveBeenCalledWith(first);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Terminal"]);
    expect(shown()).toEqual([second]);
  });

  it("folds to its tab row and keeps its shells", async () => {
    render(<TerminalDock sessionId="s1" cwd="/repo" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New terminal" })));
    fireEvent.click(screen.getByRole("button", { name: "Hide terminal" }));
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(pty.kill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show terminal" }));
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(shown()).toHaveLength(1);
  });
});
