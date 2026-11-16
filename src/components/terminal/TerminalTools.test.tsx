import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef, useRef, type ReactNode, type RefObject } from "react";
const term = vi.hoisted(() => ({
  getSelection: vi.fn(() => "error output"), clearSelection: vi.fn(), onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
  focus: vi.fn(), loadAddon: vi.fn(), scrollToLine: vi.fn(),
  getSelectionPosition: vi.fn((): { start: { x: number; y: number }; end?: { x: number; y: number } } | undefined => ({ start: { x: 0, y: 2 } })),
  buffer: { active: { viewportY: 100 } }, rows: 20, cols: 80, element: undefined as HTMLElement | undefined,
  onScroll: vi.fn(() => ({ dispose: vi.fn() })), onResize: vi.fn(() => ({ dispose: vi.fn() })),
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

afterEach(() => { cleanup(); vi.clearAllMocks(); term.element = undefined; });

/** The tools inside a frame that has the focus, as a terminal view mounts them. */
function Framed({ children }: { children: (frame: RefObject<HTMLDivElement | null>) => ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  return <div ref={frame} data-testid="frame"><button type="button">focus</button>{children(frame)}</div>;
}
const focusFrame = () => act(() => screen.getByRole("button", { name: "focus" }).focus());
const press = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
function openSearch() {
  render(<Framed>{(frame) => <TerminalTools id="pane" shown frame={frame} />}</Framed>);
  focusFrame();
  // jsdom is not a Mac: the find key is Ctrl+F.
  press({ key: "f", ctrlKey: true });
  return screen.getByRole("search", { name: "Find in terminal" });
}

describe("terminal search", () => {
  it("draws no control over the output until it is asked for", () => {
    render(<TerminalTools id="pane" shown frame={createRef()} />);
    expect(screen.queryByRole("button", { name: "Search terminal" })).toBeNull();
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("is a card in a row of its own, with match case, whole word and regex toggles and the keys it takes", () => {
    const bar = openSearch();
    const row = screen.getByTestId("terminal-find-row");
    expect(row.contains(bar)).toBe(true);
    // In the layout, not over it.
    expect(row.className).not.toMatch(/\babsolute\b/);
    expect(bar.className).not.toMatch(/\babsolute\b/);
    expect(bar.className).toContain("w-[475px]");
    expect(within(bar).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["↵ next", "⇧↵ previous", "Ctrl+Alt+C match case", "esc closes"]);
    for (const name of ["Match case", "Match whole word", "Use regular expression"]) expect(within(bar).getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    expect(within(bar).getByRole("button", { name: "Match case" }).textContent).toBe("Aa");
    expect(within(bar).getByRole("button", { name: "Match whole word" }).textContent).toBe("ab");
    expect(within(bar).getByRole("button", { name: "Use regular expression" }).textContent).toBe(".*");
  });

  it("passes each toggle to the search, and Ctrl+Alt+C toggles match case from the field", () => {
    const bar = openSearch();
    fireEvent.change(within(bar).getByRole("textbox", { name: "Find in terminal" }), { target: { value: "ne+dle" } });
    expect(search.findNext).toHaveBeenLastCalledWith("ne+dle", expect.objectContaining({ caseSensitive: false, wholeWord: false, regex: false }));
    fireEvent.click(within(bar).getByRole("button", { name: "Match whole word" }));
    expect(search.findNext).toHaveBeenLastCalledWith("ne+dle", expect.objectContaining({ wholeWord: true, regex: false }));
    fireEvent.click(within(bar).getByRole("button", { name: "Use regular expression" }));
    expect(search.findNext).toHaveBeenLastCalledWith("ne+dle", expect.objectContaining({ wholeWord: true, regex: true }));
    press({ key: "c", code: "KeyC", ctrlKey: true, altKey: true });
    expect(within(bar).getByRole("button", { name: "Match case" }).getAttribute("aria-pressed")).toBe("true");
    expect(search.findNext).toHaveBeenLastCalledWith("ne+dle", expect.objectContaining({ caseSensitive: true, wholeWord: true, regex: true }));
    fireEvent.click(within(bar).getByRole("button", { name: "Previous match" }));
    expect(search.findPrevious).toHaveBeenLastCalledWith("ne+dle", expect.objectContaining({ caseSensitive: true, wholeWord: true, regex: true }));
  });

  it("says when a regular expression does not parse instead of failing", () => {
    const bar = openSearch();
    search.findNext.mockImplementationOnce(() => { throw new SyntaxError("Invalid regular expression"); });
    fireEvent.change(within(bar).getByRole("textbox", { name: "Find in terminal" }), { target: { value: "[a-" } });
    expect(within(bar).getByRole("status").textContent).toBe("Invalid pattern");
  });

  it("updates background results without undoing the user's viewport, while explicit navigation still searches", () => {
    openSearch();
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

  it("is a pill under the selection's last line, with an icon and its keys, and stays inside the frame", () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    term.element = document.createElement("div");
    term.element.append(screenEl);
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
    // 80 columns of 8px and 20 rows of 16px, 40px below the frame's top (under its header).
    vi.spyOn(screenEl, "getBoundingClientRect").mockReturnValue(rect(10, 40, 640, 320));
    term.getSelectionPosition.mockReturnValue({ start: { x: 2, y: 103 }, end: { x: 30, y: 104 } });
    render(<TerminalChatContext value={add}><Framed>{(frame) => <TerminalTools id="pane" shown frame={frame} />}</Framed></TerminalChatContext>);
    const frame = screen.getByTestId("frame");
    const frameRect = vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect(0, 0, 700, 400));
    const pill = screen.getByTestId("terminal-add-to-chat");
    vi.spyOn(pill, "getBoundingClientRect").mockReturnValue(rect(0, 0, 150, 26));
    // A scroll places it again, now that sizes are known.
    act(() => (term.onScroll.mock.calls[0] as unknown as [() => void])[0]());
    // Row 4 of the viewport ends at 40 + 5 × 16 = 120; the pill sits 6px under it, ending at column 30.
    expect(pill.style.top).toBe("126px");
    expect(pill.style.left).toBe(`${10 + 30 * 8 - 150}px`);
    const button = within(pill).getByRole("button", { name: "Add to chat" });
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.querySelector("kbd")?.textContent).toBe("Ctrl+Shift+L");

    // The last line at the frame's bottom: the pill goes over the selection instead, still in the frame.
    frameRect.mockReturnValue(rect(0, 0, 700, 370));
    term.getSelectionPosition.mockReturnValue({ start: { x: 0, y: 118 }, end: { x: 79, y: 119 } });
    act(() => (term.onScroll.mock.calls[0] as unknown as [() => void])[0]());
    const top = parseInt(pill.style.top), left = parseInt(pill.style.left);
    expect(top + 26).toBeLessThanOrEqual(370 - 8);
    expect(top).toBe(40 + 18 * 16 - 6 - 26);
    expect(left + 150).toBeLessThanOrEqual(700 - 8);
  });

  it("adds the selection with Ctrl+Shift+L while the terminal has the focus", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    render(<TerminalChatContext value={add}><Framed>{(frame) => <TerminalTools id="pane" shown frame={frame} />}</Framed></TerminalChatContext>);
    // Elsewhere the keys are the app's (Pull latest), not the terminal's.
    press({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    expect(add).not.toHaveBeenCalled();
    focusFrame();
    await act(async () => { press({ key: "L", code: "KeyL", ctrlKey: true, shiftKey: true }); });
    expect(add).toHaveBeenCalledExactlyOnceWith("error output");
  });

  it("has no add action when there is no agent draft destination", () => {
    render(<TerminalTools id="pane" shown frame={createRef()} />);
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(term.onSelectionChange).not.toHaveBeenCalled();
  });
});
