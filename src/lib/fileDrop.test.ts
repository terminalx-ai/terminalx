import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dragDropListener, unlisten } = vi.hoisted(() => ({ dragDropListener: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }) }));

import { registerFileDropTarget, type FileDropTarget } from "./fileDrop";

type Payload = { type: string; paths?: string[]; position?: { x: number; y: number } };
const cleanups: (() => void)[] = [];
let under: Element | null = null;

function target(anywhere = false) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const t = { element: () => el, anywhere, onDragChange: vi.fn(), onDrop: vi.fn() } satisfies FileDropTarget;
  cleanups.push(registerFileDropTarget(t));
  return { ...t, el };
}

async function emit(payload: Payload) {
  await vi.waitFor(() => expect(dragDropListener).toHaveBeenCalled());
  await dragDropListener.mock.calls.at(-1)![0]({ payload: { position: { x: 10, y: 10 }, ...payload } });
}

beforeEach(() => {
  vi.clearAllMocks();
  dragDropListener.mockResolvedValue(unlisten);
  document.elementFromPoint = () => under;
});

afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  document.body.replaceChildren();
  under = null;
});

describe("routing a file drop", () => {
  it("subscribes once however many targets there are, and lets go after the last", async () => {
    const offs = [registerFileDropTarget(target()), registerFileDropTarget(target(true))];
    expect(dragDropListener).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(dragDropListener.mock.results[0].type).toBe("return"));
    await Promise.resolve();
    for (const off of offs) off();
    for (const off of cleanups.splice(0)) off();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("gives the drop to the target under the pointer and to nobody else", async () => {
    const terminal = target();
    const composer = target(true);
    const child = terminal.el.appendChild(document.createElement("span"));
    under = child;
    await emit({ type: "enter", paths: ["/a"] });
    expect(terminal.onDragChange).toHaveBeenLastCalledWith(true, "files");
    expect(composer.onDragChange).toHaveBeenLastCalledWith(false, "files");
    await emit({ type: "drop", paths: ["/a"] });
    expect(terminal.onDrop).toHaveBeenCalledExactlyOnceWith(["/a"]);
    expect(composer.onDrop).not.toHaveBeenCalled();
    expect(terminal.onDragChange).toHaveBeenLastCalledWith(false, "files");
  });

  it("gives a drop on the composer to the composer", async () => {
    const terminal = target();
    const composer = target(true);
    under = composer.el;
    await emit({ type: "drop", paths: ["/a"] });
    expect(composer.onDrop).toHaveBeenCalledExactlyOnceWith(["/a"]);
    expect(terminal.onDrop).not.toHaveBeenCalled();
  });

  it("gives a drop elsewhere in the window to a composer that is shown, never to a terminal", async () => {
    const terminal = target();
    const composer = target(true);
    const hidden = target(true);
    hidden.el.checkVisibility = () => false;
    under = document.body;
    await emit({ type: "over" });
    expect(composer.onDragChange).toHaveBeenLastCalledWith(true, "files");
    expect(hidden.onDragChange).toHaveBeenLastCalledWith(false, "files");
    await emit({ type: "drop", paths: ["/a"] });
    expect(composer.onDrop).toHaveBeenCalledOnce();
    expect(hidden.onDrop).not.toHaveBeenCalled();
    expect(terminal.onDrop).not.toHaveBeenCalled();
  });

  it("follows the pointer from one target to the other, and clears on leave", async () => {
    const terminal = target();
    const composer = target(true);
    under = terminal.el;
    await emit({ type: "over" });
    under = composer.el;
    await emit({ type: "over" });
    expect(terminal.onDragChange).toHaveBeenLastCalledWith(false, "files");
    expect(composer.onDragChange).toHaveBeenLastCalledWith(true, "files");
    await emit({ type: "leave" });
    expect(composer.onDragChange).toHaveBeenLastCalledWith(false, "files");
  });

  it("says a drag with no paths is text, for as long as that drag lasts", async () => {
    const terminal = target();
    under = terminal.el;
    await emit({ type: "enter", paths: [] });
    await emit({ type: "over" });
    expect(terminal.onDragChange).toHaveBeenLastCalledWith(true, "text");
    await emit({ type: "drop", paths: [] });
    expect(terminal.onDrop).toHaveBeenCalledExactlyOnceWith([]);
    await emit({ type: "enter", paths: ["/a"] });
    expect(terminal.onDragChange).toHaveBeenLastCalledWith(true, "files");
  });

  it("gives a drop on no target to one composer: the focused one, else the newest", async () => {
    const first = target(true);
    const second = target(true);
    under = document.body;
    await emit({ type: "drop", paths: ["/a"] });
    expect(second.onDrop).toHaveBeenCalledOnce();
    expect(first.onDrop).not.toHaveBeenCalled();

    const input = first.el.appendChild(document.createElement("input"));
    input.focus();
    await emit({ type: "over" });
    expect(first.onDragChange).toHaveBeenLastCalledWith(true, "files");
    expect(second.onDragChange).toHaveBeenLastCalledWith(false, "files");
    await emit({ type: "drop", paths: ["/b"] });
    expect(first.onDrop).toHaveBeenCalledExactlyOnceWith(["/b"]);
    expect(second.onDrop).toHaveBeenCalledOnce();
  });

  it("reads the position as CSS pixels on macOS and Linux, and as device pixels on Windows", async () => {
    target();
    const at = vi.fn(() => null);
    document.elementFromPoint = at;
    vi.stubGlobal("devicePixelRatio", 2);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await emit({ type: "over", position: { x: 100, y: 60 } });
    expect(at).toHaveBeenLastCalledWith(100, 60);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await emit({ type: "over", position: { x: 100, y: 60 } });
    expect(at).toHaveBeenLastCalledWith(100, 60);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    await emit({ type: "over", position: { x: 100, y: 60 } });
    expect(at).toHaveBeenLastCalledWith(50, 30);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
