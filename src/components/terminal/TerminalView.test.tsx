import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webgl = vi.hoisted(() => ({ showWebgl: vi.fn(), hideWebgl: vi.fn() }));
vi.mock("@/lib/terminalWebgl", () => webgl);
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { TerminalView } from "./TerminalView";
import { disposeInstance, terminalCounters, type TerminalInstance } from "@/lib/terminal";

function instance(): TerminalInstance {
  const term = { options: {}, focus: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24, buffer: { normal: { length: 0 }, alternate: { length: 0 } } };
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
