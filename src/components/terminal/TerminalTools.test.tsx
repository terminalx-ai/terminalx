import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
const term = vi.hoisted(() => ({
  getSelection: vi.fn(() => "error output"), clearSelection: vi.fn(), onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
  focus: vi.fn(), loadAddon: vi.fn(), scrollToLine: vi.fn(),
  getSelectionPosition: vi.fn(() => ({ start: { x: 0, y: 2 } })), buffer: { active: { viewportY: 100 } }, rows: 20,
}));
const search = vi.hoisted(() => {
  let listener: ((results: { resultCount: number; resultIndex: number }) => void) | undefined;
  return {
    findNext: vi.fn(), findPrevious: vi.fn(), clearDecorations: vi.fn(), dispose: vi.fn(),
    onDidChangeResults: vi.fn((next: typeof listener) => { listener = next; return { dispose: () => { listener = undefined; } }; }),
    emitResults: (results: { resultCount: number; resultIndex: number }) => listener?.(results),
  };
});
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {
  findNext = search.findNext;
  findPrevious = search.findPrevious;
  clearDecorations = search.clearDecorations;
  dispose = search.dispose;
  onDidChangeResults = search.onDidChangeResults;
} }));
vi.mock("@/lib/terminal", () => ({ peekInstance: () => ({ term }) }));
vi.mock("./TerminalChat", async () => ({ TerminalChatContext: (await import("react")).createContext(null) }));
import { TerminalTools } from "./TerminalTools";
import { TerminalChatContext } from "./TerminalChat";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("terminal search", () => {
  it("updates background results without undoing the user's viewport, while explicit navigation still searches", () => {
    render(<TerminalTools id="pane" shown frame={createRef()} />);
    fireEvent.click(screen.getByRole("button", { name: "Search terminal" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal" }), { target: { value: "needle" } });
    expect(search.findNext).toHaveBeenCalledWith("needle", expect.objectContaining({ caseSensitive: false }));

    // Incoming output reports results again while the selected match is offscreen.
    act(() => search.emitResults({ resultCount: 2, resultIndex: 0 }));
    expect(screen.getByRole("status").textContent).toBe("1 of 2");
    expect(term.scrollToLine).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(search.findNext).toHaveBeenCalledTimes(2);
    expect(search.findPrevious).toHaveBeenCalledWith("needle", expect.objectContaining({ caseSensitive: false }));
  });
});

describe("terminal selection action", () => {
  it("offers selected output and prevents duplicate attachment saves", async () => {
    let finish!: () => void;
    const add = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<TerminalChatContext value={add}><TerminalTools id="pane" shown frame={createRef()} /></TerminalChatContext>);
    const button = screen.getByRole("button", { name: "Add to chat" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(add).toHaveBeenCalledExactlyOnceWith("error output");
    expect(term.clearSelection).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(term.clearSelection).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("Added to chat draft");
  });

  it("keeps the selection and exposes errors so adding can be retried", async () => {
    const add = vi.fn().mockRejectedValue(new Error("Disk full"));
    render(<TerminalChatContext value={add}><TerminalTools id="pane" shown frame={createRef()} /></TerminalChatContext>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add to chat" })));
    expect(screen.getByRole("alert").textContent).toBe("Disk full");
    expect(term.clearSelection).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add to chat" }).hasAttribute("disabled")).toBe(false);
  });

  it("has no add action when there is no agent draft destination", () => {
    render(<TerminalTools id="pane" shown frame={createRef()} />);
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(term.onSelectionChange).not.toHaveBeenCalled();
  });
});
