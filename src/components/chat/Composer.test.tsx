import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabEntry } from "@/types/session";

const { dragDropListener, invoke, openDialog } = vi.hoisted(() => ({ dragDropListener: vi.fn(), invoke: vi.fn(), openDialog: vi.fn() }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  MicButton: () => null,
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
}));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn() }));
vi.mock("@/lib/models", () => ({
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "auto", label: "Auto", hint: "" }],
  modeLabel: () => "Auto",
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [],
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));

const { Composer } = await import("./Composer");

const tab: TabEntry = {
  id: "tab-1",
  harness: "codex",
  model: "default",
  permissionMode: "auto",
  status: "idle",
  created: "2026-09-04T00:00:00Z",
  modified: "2026-09-04T00:00:00Z",
};

function TestComposer({ onSend }: { onSend: (text: string, images: { mediaType: string; data: string; name?: string }[]) => Promise<void> | void }) {
  const [draft, setDraft] = useState("");
  return <Composer tab={tab} busy={false} draft={draft} onDraftChange={setDraft} onSend={onSend} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
}

beforeEach(() => {
  dragDropListener.mockResolvedValue(vi.fn());
  invoke.mockReset();
  openDialog.mockReset();
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "attachment-1") });
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("composer height", () => {
  // jsdom performs no layout, so scrollHeight is what the test says it is —
  // 0 stands in for a textarea inside a display: none tab panel.
  let scrollHeight = 0;
  const observers: ResizeObserverCallback[] = [];
  class CapturingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const layOut = () => observers.forEach((notify) => notify([], {} as ResizeObserver));

  beforeEach(() => {
    scrollHeight = 0;
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => scrollHeight);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the intrinsic height when measured while hidden", () => {
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;

    expect(textarea.style.height).toBe("");
    expect(textarea.rows).toBe(1);
  });

  it("fits the content once the textarea is laid out", () => {
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;

    scrollHeight = 52;
    layOut();

    expect(textarea.style.height).toBe("52px");
  });

  it("does not shrink a fitted textarea back to nothing when hidden again", () => {
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;
    scrollHeight = 52;
    layOut();

    scrollHeight = 0;
    fireEvent.change(textarea, { target: { value: "still hidden" } });

    expect(textarea.style.height).toBe("52px");
  });

  it("measures again once the web fonts settle", async () => {
    let fontsSettled!: () => void;
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>((resolve) => (fontsSettled = resolve)) } });
    scrollHeight = 40;
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.height).toBe("40px");

    scrollHeight = 46;
    fontsSettled();

    await waitFor(() => expect(textarea.style.height).toBe("46px"));
  });

  it("caps the height at ten lines", () => {
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;

    scrollHeight = 900;
    fireEvent.change(textarea, { target: { value: "a".repeat(2_000) } });

    expect(textarea.style.height).toBe("240px");
  });
});

describe("composer attachments", () => {
  it("selects files from the attach icon", async () => {
    openDialog.mockResolvedValue(["/tmp/proof.png"]);
    invoke.mockResolvedValue({ name: "proof.png", mediaType: "image/png", data: "AQID" });
    const onSend = vi.fn();
    render(<TestComposer onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    expect(await screen.findByAltText("proof.png")).toBeTruthy();
    expect(openDialog).toHaveBeenCalledWith({ multiple: true, title: "Attach files" });
    expect(invoke).toHaveBeenCalledWith("read_image_file", { path: "/tmp/proof.png" });
  });

  it("clears the browser-picker attachment after send", async () => {
    const onSend = vi.fn();
    const { container } = render(<TestComposer onSend={onSend} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const image = new File([new Uint8Array([1, 2, 3])], "raccoon.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [image] } });

    expect(await screen.findByAltText("raccoon.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("", [expect.objectContaining({ name: "raccoon.png", mediaType: "image/png" })]));
    expect(screen.queryByAltText("raccoon.png")).toBeNull();
    expect(input.value).toBe("");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("accepts an image dropped onto the composer", async () => {
    const onSend = vi.fn();
    const { container } = render(<TestComposer onSend={onSend} />);
    const image = new File([new Uint8Array([4, 5, 6])], "drop.webp", { type: "image/webp" });
    const dropTarget = container.querySelector("textarea")!.parentElement!;

    fireEvent.drop(dropTarget, { dataTransfer: { files: [image], types: ["Files"] } });

    expect(await screen.findByAltText("drop.webp")).toBeTruthy();
  });

  it("keeps an attachment when sending fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("offline"));
    const { container } = render(<TestComposer onSend={onSend} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const image = new File([new Uint8Array([7, 8, 9])], "retry.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [image] } });
    expect(await screen.findByAltText("retry.png")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(screen.getByAltText("retry.png")).toBeTruthy();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:preview");
  });
});
