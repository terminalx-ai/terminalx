import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dragDropListener } = vi.hoisted(() => ({ dragDropListener: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/terminalWebgl", () => ({ showWebgl: vi.fn(), hideWebgl: vi.fn() }));
vi.mock("@/lib/api", () => ({ pty: {} }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => () => "Someone" }));

import { CloudTerminalPane, dropRefusal } from "./CloudTerminalPane";
import type { CloudTerminal } from "@/lib/cloudTerminals";
import { disposeInstance, type TerminalInstance } from "@/lib/terminal";

const terminal = (fields: Partial<CloudTerminal> = {}): CloudTerminal => ({
  id: "cloud:w1:pty1",
  ptyId: "pty1",
  number: 1,
  title: "Terminal 1",
  epoch: "e1",
  pid: 1,
  exited: false,
  exitCode: null,
  control: "you",
  controllerId: null,
  cols: 80,
  rows: 24,
  gone: null,
  inputError: null,
  sessionId: null,
  ...fields,
});

describe("what a cloud terminal refuses by drag and drop", () => {
  it("never takes a file, even from the person controlling it, but takes their text", () => {
    const refusal = dropRefusal(terminal(), true);
    expect(refusal.files).toMatch(/can't be dropped on a cloud terminal/);
    expect(refusal.text).toBeUndefined();
  });

  it("takes nothing from someone who is watching", () => {
    const watching = dropRefusal(terminal({ control: "other" }), true);
    expect(watching.files).toBe("You are watching this terminal. Take control to drop into it.");
    expect(watching.text).toBe(watching.files);
  });

  it("takes nothing from a viewer", () => {
    const viewer = dropRefusal(terminal({ control: "other" }), false);
    expect(viewer.files).toBe("View only: you cannot drop into this terminal.");
    expect(viewer.text).toBe(viewer.files);
  });

  it("takes nothing once it has ended", () => {
    for (const ended of [terminal({ exited: true }), terminal({ gone: "closed" })]) {
      const refusal = dropRefusal(ended, true);
      expect(refusal.files).toBe("This terminal has ended. Nothing can be dropped on it.");
      expect(refusal.text).toBe(refusal.files);
    }
  });
});

describe("a file dropped on a cloud terminal", () => {
  const write = vi.fn(async () => undefined);
  const paste = vi.fn();
  const base = (): TerminalInstance => {
    const term = { options: {}, focus: vi.fn(), dispose: vi.fn(), paste, onData: vi.fn(), onBinary: vi.fn(), onResize: vi.fn(), cols: 80, rows: 24 };
    return { el: document.createElement("div"), term, fit: {} } as never;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dragDropListener.mockResolvedValue(vi.fn());
    disposeInstance("cloud:w1:pty1");
  });
  afterEach(cleanup);

  it.each([
    ["the controller", terminal(), true, /can't be dropped on a cloud terminal/],
    ["a viewer", terminal({ control: "other" }), false, /View only: you cannot drop/],
  ])("types no local path for %s and says why", async (_who, item, mayControl, reason) => {
    render(<CloudTerminalPane workspace="w1" terminal={item} client={{ write } as never} connected manage={mayControl} base={base} />);
    await waitFor(() => expect(dragDropListener).toHaveBeenCalledOnce());
    document.elementFromPoint = () => screen.getByTestId("terminal-drop-target");
    const onDrag = dragDropListener.mock.calls[0][0];
    await act(() => onDrag({ payload: { type: "drop", paths: ["/Users/me/secret.txt"], position: { x: 1, y: 1 } } }));
    expect(paste).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(reason);
  });
});
