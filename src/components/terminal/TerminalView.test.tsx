import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webgl = vi.hoisted(() => ({ showWebgl: vi.fn(), hideWebgl: vi.fn(), recoverWebgl: vi.fn() }));
vi.mock("@/lib/terminalWebgl", () => webgl);
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { TerminalView } from "./TerminalView";
import { disposeInstance, ensureTerminalAttached, getInstance, IDLE_TERMINAL_LIMIT, peekInstance, terminalCounters, type TerminalInstance } from "@/lib/terminal";

function instance(): TerminalInstance {
  const term = { options: {}, refresh: vi.fn(), focus: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, buffer: { normal: { length: 0 }, alternate: { length: 0 } } };
  return { el: document.createElement("div"), term, fit: {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  disposeInstance("p1");
});

describe("a terminal view", () => {
  it("can attach a deferred or evicted hidden terminal before switching away from Chat", async () => {
    const ensureAttached = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn(() => ({ ...instance(), ensureAttached }));
    const view = render(<TerminalView id="p1" visible={false} create={create} />);
    expect(create).not.toHaveBeenCalled();
    disposeInstance("p1");
    await ensureTerminalAttached("p1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(ensureAttached).toHaveBeenCalledOnce();
    expect(peekInstance("p1")?.el.isConnected).toBe(false);
    view.unmount();
    disposeInstance("p1");
    await expect(ensureTerminalAttached("p1")).rejects.toThrow("not ready to attach");
  });

  it("restores a retired parser when the window returns without changing tabs", () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    const create = vi.fn(instance);
    const view = render(<TerminalView id="p1" visible create={create} />);
    const first = peekInstance("p1")!;
    try {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(first.el.isConnected).toBe(false);
      disposeInstance("p1"); // The local feed retired its unparsed background queue.
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(peekInstance("p1")).not.toBe(first);
      expect(peekInstance("p1")!.el.isConnected).toBe(true);
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      if (descriptor) Object.defineProperty(document, "hidden", descriptor);
      else delete (document as unknown as Record<string, unknown>).hidden;
    }
  });

  it("recreates an evicted hidden instance when the mounted view is shown again", () => {
    const create = vi.fn(() => ({ ...instance(), restorable: true }));
    const view = render(<TerminalView id="p1" visible create={create} />);
    const first = peekInstance("p1")!;
    view.rerender(<TerminalView id="p1" visible={false} create={create} />);
    for (let i = 0; i < IDLE_TERMINAL_LIMIT; i++) getInstance(`idle-${i}`, create);
    expect(peekInstance("p1")).toBeUndefined();
    expect(first.term.dispose).toHaveBeenCalledOnce();
    view.rerender(<TerminalView id="p1" visible create={create} />);
    const restored = peekInstance("p1")!;
    expect(restored).not.toBe(first);
    expect(restored.el.isConnected).toBe(true);
    expect(webgl.showWebgl).toHaveBeenLastCalledWith(restored.term);
    view.unmount();
    for (let i = 0; i < IDLE_TERMINAL_LIMIT; i++) disposeInstance(`idle-${i}`);
  });

  it("defers terminal creation until first shown, and detaches it again when hidden", () => {
    const inst = instance();
    const create = vi.fn(() => inst);
    // Mounted under something else: an agent's terminal beneath its chat.
    const view = render(<TerminalView id="p1" visible={false} create={create} />);
    expect(create).not.toHaveBeenCalled();
    expect(inst.el.isConnected).toBe(false);
    expect(webgl.showWebgl).not.toHaveBeenCalled();
    expect(terminalCounters()).toMatchObject({ instances: 0, attached: 0, hiddenInDocument: 0 });

    view.rerender(<TerminalView id="p1" visible create={create} />);
    expect(create).toHaveBeenCalledTimes(1);
    expect(inst.el.isConnected).toBe(true);
    expect(webgl.showWebgl).toHaveBeenCalledWith(inst.term);

    view.rerender(<TerminalView id="p1" visible={false} create={create} />);
    expect(inst.el.isConnected).toBe(false);
    expect(webgl.hideWebgl).toHaveBeenCalledWith(inst.term);

    // The instance outlives the view: its buffer is there for the next one.
    view.unmount();
    expect(terminalCounters().instances).toBe(1);
    expect(inst.term.dispose).not.toHaveBeenCalled();
  });
});

it("recovers on focus without replacing the terminal or stealing input focus", () => {
  vi.useFakeTimers();
  const inst = instance();
  const create = vi.fn(() => inst);
  const view = render(<TerminalView id="p1" visible create={create} />);
  act(() => vi.advanceTimersByTime(100));
  vi.mocked(inst.term.focus).mockClear();
  act(() => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(100); });
  expect(webgl.recoverWebgl).toHaveBeenCalledWith(inst.term);
  expect(inst.term.focus).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button", { name: "Redraw terminal" }));
  expect(webgl.recoverWebgl).toHaveBeenCalledTimes(2);
  view.unmount();
  act(() => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(100); });
  expect(webgl.recoverWebgl).toHaveBeenCalledTimes(2);
  expect(inst.term.dispose).not.toHaveBeenCalled();
  vi.useRealTimers();
});


it("keeps both pane terminals visible while only the focused one takes keyboard focus", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const first = instance();
  const second = instance();
  const frame = () => act(() => { frames.splice(0).forEach((callback) => callback(0)); });
  const view = render(<><TerminalView id="p1" visible focused create={() => first} fit={false} /><TerminalView id="p2" visible focused={false} create={() => second} fit={false} /></>);
  try {
    frame();
    expect(first.term.focus).toHaveBeenCalledOnce();
    expect(second.term.focus).not.toHaveBeenCalled();
    view.rerender(<><TerminalView id="p1" visible focused={false} create={() => first} fit={false} /><TerminalView id="p2" visible focused create={() => second} fit={false} /></>);
    frame();
    expect(first.el.isConnected && second.el.isConnected).toBe(true);
    expect(first.term.focus).toHaveBeenCalledOnce();
    expect(second.term.focus).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    disposeInstance("p2");
    vi.unstubAllGlobals();
  }
});

it("reparents the same terminal across view trees with a full idle cache", async () => {
  const create = vi.fn(() => ({ ...instance(), restorable: true }));
  const view = render(<div key="dock"><TerminalView id="p1" visible create={create} /></div>);
  const first = peekInstance("p1")!;
  first.el.textContent = "existing scrollback";
  const release = vi.fn();
  first.release = release;
  for (let i = 0; i < IDLE_TERMINAL_LIMIT; i++) getInstance(`move-idle-${i}`, create);
  await act(async () => view.rerender(<section key="tab"><TerminalView id="p1" visible create={create} /></section>));
  expect(peekInstance("p1")).toBe(first);
  expect(first.el.closest("section")).not.toBeNull();
  expect(first.el.textContent).toBe("existing scrollback");
  expect(first.term.dispose).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  view.unmount();
  for (let i = 0; i < IDLE_TERMINAL_LIMIT; i++) disposeInstance(`move-idle-${i}`);
});

describe("the header row", () => {
  it("sits above the output in the layout, with the shell's icon and name, Move to dock and Clear", () => {
    vi.useFakeTimers();
    const inst = instance();
    Object.assign(inst.term, { clear: vi.fn() });
    const view = render(<TerminalView id="p1" visible create={() => inst} moveToDock />);
    try {
      const header = view.getByTestId("terminal-header");
      const frame = view.getByTestId("terminal-drop-target");
      // A row of the view, before the terminal's host: nothing over the output.
      expect(header.parentElement).toBe(frame);
      expect(header.compareDocumentPosition(frame.querySelector(".terminal-host")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const el of [header, ...header.querySelectorAll("*")]) expect(el.className.toString()).not.toMatch(/\babsolute\b/);
      expect(view.getByTestId("terminal-title").querySelector("svg")).not.toBeNull();
      expect(view.getByTestId("terminal-title").textContent).toBe("Terminal");
      expect(view.getByRole("button", { name: "Move to dock" })).toBeTruthy();
      const clear = view.getByRole("button", { name: /^Clear/ });
      expect(clear.querySelector("kbd")?.textContent).toBe("Ctrl+K");
      fireEvent.click(clear);
      expect(inst.term.clear).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("clears with Ctrl+K only while the focus is in the terminal", () => {
    vi.useFakeTimers();
    const inst = instance();
    Object.assign(inst.term, { clear: vi.fn() });
    const view = render(<><button type="button">outside</button><TerminalView id="p1" visible create={() => inst} shell /></>);
    const press = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })); });
    try {
      act(() => view.getByRole("button", { name: "outside" }).focus());
      press();
      expect(inst.term.clear).not.toHaveBeenCalled();
      act(() => view.getByRole("button", { name: "Redraw terminal" }).focus());
      press();
      expect(inst.term.clear).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("leaves Ctrl+K and Clear alone in a view that is not a plain shell (an agent's terminal)", () => {
    vi.useFakeTimers();
    const inst = instance();
    Object.assign(inst.term, { clear: vi.fn() });
    const view = render(<TerminalView id="p1" visible create={() => inst} />);
    try {
      expect(view.queryByRole("button", { name: /^Clear/ })).toBeNull();
      act(() => view.getByRole("button", { name: "Redraw terminal" }).focus());
      const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
      act(() => { window.dispatchEvent(event); });
      expect(inst.term.clear).not.toHaveBeenCalled();
      // Not taken here, so the command palette's binding still sees it.
      expect(event.defaultPrevented).toBe(false);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("offers Move to tab for a docked shell, and no header where a view asks for none", () => {
    const inst = instance();
    const docked = render(<TerminalView id="p1" visible create={() => inst} redraw={false} moveToTab />);
    expect(docked.getByRole("button", { name: "Move to tab" })).toBeTruthy();
    docked.unmount();
    const bare = render(<TerminalView id="p1" visible create={() => inst} redraw={false} />);
    expect(bare.queryByTestId("terminal-header")).toBeNull();
    bare.unmount();
  });
});

describe("the Option key setting", () => {
  it("reaches a terminal already open, and stops once it is disposed", async () => {
    const { followOptionKey } = await import("./TerminalView");
    const { setPrefs } = await import("@/lib/prefs");
    const open = { options: { macOptionIsMeta: true }, dispose: vi.fn() };
    const closed = { options: { macOptionIsMeta: true }, dispose: vi.fn() };
    followOptionKey(open);
    followOptionKey(closed);
    closed.dispose();
    try {
      setPrefs({ optionAsMeta: false });
      expect(open.options.macOptionIsMeta).toBe(false);
      expect(closed.options.macOptionIsMeta).toBe(true);
      setPrefs({ optionAsMeta: true });
      expect(open.options.macOptionIsMeta).toBe(true);
    } finally {
      setPrefs({ optionAsMeta: true });
      open.dispose();
    }
  });
});