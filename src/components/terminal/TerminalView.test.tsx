import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webgl = vi.hoisted(() => ({ showWebgl: vi.fn(), hideWebgl: vi.fn() }));
vi.mock("@/lib/terminalWebgl", () => webgl);
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { TerminalView } from "./TerminalView";
import { disposeInstance, getInstance, IDLE_TERMINAL_LIMIT, peekInstance, terminalCounters, type TerminalInstance } from "@/lib/terminal";

function instance(): TerminalInstance {
  const term = { options: {}, focus: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, buffer: { normal: { length: 0 }, alternate: { length: 0 } } };
  return { el: document.createElement("div"), term, fit: {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  disposeInstance("p1");
});

describe("a terminal view", () => {
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

  it("keeps its terminal out of the document until it is shown, and takes it out again when hidden", () => {
    const inst = instance();
    const create = () => inst;
    // Mounted under something else: an agent's terminal beneath its chat.
    const view = render(<TerminalView id="p1" visible={false} create={create} />);
    expect(inst.el.isConnected).toBe(false);
    expect(webgl.showWebgl).not.toHaveBeenCalled();
    expect(terminalCounters()).toMatchObject({ instances: 1, attached: 0, hiddenInDocument: 0 });

    view.rerender(<TerminalView id="p1" visible create={create} />);
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
