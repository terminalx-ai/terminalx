import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webgl = vi.hoisted(() => ({ showWebgl: vi.fn(), hideWebgl: vi.fn(), recoverWebgl: vi.fn() }));
vi.mock("@/lib/terminalWebgl", () => webgl);
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { TerminalView } from "./TerminalView";
import { disposeInstance, terminalCounters, type TerminalInstance } from "@/lib/terminal";

function instance(): TerminalInstance {
  const term = { options: {}, refresh: vi.fn(), focus: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, buffer: { normal: { length: 0 }, alternate: { length: 0 } } };
  return { el: document.createElement("div"), term, fit: {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  disposeInstance("p1");
});

describe("a terminal view", () => {
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
