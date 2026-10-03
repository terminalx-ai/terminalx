import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabEntry } from "@/types/session";
import { accessibilityPress, mouseClick } from "@/test/press";

const { dragDropListener, invoke, openDialog } = vi.hoisted(() => ({ dragDropListener: vi.fn(), invoke: vi.fn(), openDialog: vi.fn() }));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: dragDropListener }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  // Only what the composer hands it: whether dictating into this composer is off.
  MicButton: ({ disabled }: { disabled?: boolean }) => (disabled === undefined ? null : <button aria-label="Dictate" disabled={disabled} />),
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
}));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn() }));
const listed = vi.hoisted(() => ({ models: [] as import("@/lib/api").ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "auto", label: "Auto", hint: "" }],
  modeLabel: () => "Auto",
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => listed.models,
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));

const { Composer } = await import("./Composer");
const { resetComposerHistory, sentMessages } = await import("./useComposerHistory");
const { buildTranscript } = await import("@/lib/transcript");
const { RECOVERY_PROMPT } = await import("@/lib/recovery");

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
  resetComposerHistory();
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

  it("fits the content once the textarea is laid out", async () => {
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;

    scrollHeight = 52;
    layOut();

    await waitFor(() => expect(textarea.style.height).toBe("52px"));
  });

  it("does not shrink a fitted textarea back to nothing when hidden again", async () => {
    const { container } = render(<TestComposer onSend={vi.fn()} />);
    const textarea = container.querySelector("textarea")!;
    scrollHeight = 52;
    layOut();
    await waitFor(() => expect(textarea.style.height).toBe("52px"));

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

describe("composer pickers", () => {
  // hidden: an open modal menu hides the rest of the page from the accessibility tree.
  const picker = (name: RegExp) => screen.getByRole("button", { name, hidden: true });

  it("the model and permission pickers open on a real mouse click and close on a second one", async () => {
    const models = await import("@/lib/models");
    render(<TestComposer onSend={vi.fn()} />);
    for (const [name, label] of [[/Default/, "Model"], [/Auto/, "Permissions"]] as const) {
      mouseClick(picker(name));
      const menu = await screen.findByRole("menu");
      expect(menu.textContent).toContain(label);
      expect(picker(name).getAttribute("aria-expanded")).toBe("true");
      mouseClick(picker(name));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
    // Opening the model picker re-reads the models.
    expect(models.refreshModels).toHaveBeenCalled();
  });

  it("open on an accessibility press (a click with no pointerdown)", async () => {
    render(<TestComposer onSend={vi.fn()} />);
    for (const name of [/Default/, /Auto/]) {
      accessibilityPress(picker(name));
      await screen.findByRole("menu");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  });
});

describe("a Claude alias in the model picker (#256)", () => {
  const claude = (id: string, label: string, extra: Partial<import("@/lib/api").ModelInfo> = {}) => ({ id, label, harness: "claude", efforts: [], defaultEffort: null, acceptsImages: true, isDefault: false, upgrade: null, description: null, ...extra });
  const onOpus: TabEntry = { ...tab, harness: "claude", model: "opus" };
  const show = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
    render(<Composer tab={onOpus} busy={false} draft="" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} {...props} />);

  beforeEach(() => {
    listed.models = [claude("opus", "Opus", { alias: true, resolved: "claude-opus-5-5", isDefault: true }), claude("claude-opus-5-5", "Opus 5.5"), claude("claude-opus-5", "Opus 5")];
  });
  afterEach(() => {
    listed.models = [];
  });

  it("names the version the CLI says the alias runs, and says the alias follows the latest", () => {
    show();
    const button = screen.getByRole("button", { name: /Opus 5\.5/ });
    expect(button.getAttribute("title")).toBe("Model: Opus (latest, running Opus 5.5)");
  });

  it("names what the session itself reported over what the CLI listed", () => {
    show({ reportedModel: "claude-opus-5" });
    expect(screen.getByRole("button", { name: /Opus 5$/ }).getAttribute("title")).toBe("Model: Opus (latest, running Opus 5)");
  });

  it("claims no version for a cloud tab until its session reports one", () => {
    const view = show({ modelsAreLocal: false });
    expect(screen.getByTitle("Model: Opus (latest)").textContent).not.toContain("5.5");
    view.unmount();
    show({ modelsAreLocal: false, reportedModel: "claude-opus-5-5" });
    expect(screen.getByRole("button", { name: /Opus 5\.5/ })).toBeTruthy();
  });

  it("offers the alias and, apart, the versions that can be pinned", async () => {
    const onSetModel = vi.fn();
    show({ onSetModel });
    mouseClick(screen.getByRole("button", { name: /Opus 5\.5/ }));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Pinned version");
    const items = within(menu).getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(items).toEqual(["Opuslatest · Opus 5.5", "Opus 5.5", "Opus 5"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Opus 5" }));
    expect(onSetModel).toHaveBeenCalledWith("claude-opus-5");
  });

  it("reads a stored pinned id the list no longer carries", () => {
    show({ tab: { ...onOpus, model: "claude-opus-4-8" } });
    // Still what the tab runs: it is named, not passed off as the default.
    expect(screen.getByRole("button", { name: /Opus 4\.8/ }).getAttribute("title")).toBe("Model: Opus 4.8");
  });
});

describe("a shared cloud tab's limits (PRO-30 review)", () => {
  it("disables the model and mode pickers with the reason, and hides Stop when this reader may not stop", () => {
    const onSetMode = vi.fn();
    render(
      <Composer
        tab={tab}
        busy
        draft=""
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onSetModel={vi.fn()}
        onSetEffort={vi.fn()}
        onSetMode={onSetMode}
        settingsLockedReason="Only a workspace admin or someone who can approve permissions changes the model, effort or permission mode"
        canStop={false}
      />,
    );
    const model = screen.getByRole("button", { name: /^Model: Only a workspace admin/ }) as HTMLButtonElement;
    const mode = screen.getByRole("button", { name: /^Permission mode: Only a workspace admin/ }) as HTMLButtonElement;
    expect(model.disabled && mode.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("turns Attach files and Dictate off with the composer for someone who may not send (a viewer)", () => {
    const base = { tab, busy: false, draft: "", onDraftChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSetModel: vi.fn(), onSetEffort: vi.fn(), onSetMode: vi.fn() };
    const { rerender } = render(<Composer {...base} disabled disabledReason="You can view this workspace; ask an admin for driver access" />);
    expect((screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Dictate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    // A click on the disabled paperclip opens nothing.
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(openDialog).not.toHaveBeenCalled();
    rerender(<Composer {...base} />);
    expect((screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Dictate" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when a chosen setting has not reached the agent yet", () => {
    const base = { tab, busy: false, draft: "", onDraftChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onSetModel: vi.fn(), onSetEffort: vi.fn(), onSetMode: vi.fn() };
    const { rerender } = render(<Composer {...base} settingsNote="Model, effort and mode changes apply with your next message" />);
    expect(screen.getByTestId("composer-settings-note").textContent).toBe("Model, effort and mode changes apply with your next message");
    // The pickers stay usable: this is not a lock.
    expect(screen.queryByRole("button", { name: /^Model: / })).toBeNull();
    rerender(<Composer {...base} />);
    expect(screen.queryByTestId("composer-settings-note")).toBeNull();
  });

  it("keeps the pickers and Stop by default", () => {
    render(<Composer tab={tab} busy draft="" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Model: / })).toBeNull();
  });
});

describe("composer history (PRO-85)", () => {
  const SENT = ["first message", "second message", "third message"];
  // The draft lives outside the composer, as a tab's does, so it outlasts a remount.
  const drafts = new Map<string, string>();

  function HistoryComposer({ history = SENT, cwd, onSend = vi.fn(), id = "tab-history" }: { history?: string[]; cwd?: string; onSend?: (text: string) => Promise<void> | void; id?: string }) {
    const [draft, setDraft] = useState(drafts.get(id) ?? "");
    const change = (text: string) => {
      drafts.set(id, text);
      setDraft(text);
    };
    return <Composer tab={{ ...tab, id }} cwd={cwd} busy={false} draft={draft} onDraftChange={change} onSend={onSend} history={history} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
  }

  const field = () => document.querySelector("textarea") as HTMLTextAreaElement;
  /** A real key press on the composer; true when the composer took it (the caret did not move instead). */
  const press = (key: "ArrowUp" | "ArrowDown" | "Enter", init: KeyboardEventInit = {}) => !fireEvent.keyDown(field(), { key, ...init });
  const type = (text: string, caret = text.length) => {
    fireEvent.change(field(), { target: { value: text } });
    field().setSelectionRange(caret, caret);
    fireEvent.select(field());
  };

  beforeEach(() => {
    drafts.clear();
    // jsdom has no layout; the picker scrolls its highlighted row into view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("Up on an empty composer shows the last message, then older ones; Down comes back to the newest and then the draft", () => {
    render(<HistoryComposer />);

    expect(press("ArrowUp")).toBe(true);
    expect(field().value).toBe("third message");
    press("ArrowUp");
    expect(field().value).toBe("second message");
    press("ArrowUp");
    expect(field().value).toBe("first message");
    // Nothing older: the key is left to the caret.
    expect(press("ArrowUp")).toBe(false);
    expect(field().value).toBe("first message");

    press("ArrowDown");
    expect(field().value).toBe("second message");
    press("ArrowDown");
    expect(field().value).toBe("third message");
    press("ArrowDown");
    expect(field().value).toBe("");
    expect(press("ArrowDown")).toBe(false);
    expect(field().value).toBe("");
  });

  it("puts the caret at the end of a recalled message", () => {
    render(<HistoryComposer />);
    press("ArrowUp");
    expect([field().selectionStart, field().selectionEnd]).toEqual([13, 13]);
  });

  it("keeps the unsent draft and restores it past the newest message", () => {
    render(<HistoryComposer />);
    type("half written");

    press("ArrowUp");
    press("ArrowUp");
    expect(field().value).toBe("second message");
    press("ArrowDown");
    press("ArrowDown");

    expect(field().value).toBe("half written");
  });

  it("does nothing on Down when no history is being browsed, and nothing at all without history", () => {
    const { unmount } = render(<HistoryComposer />);
    type("a draft");
    expect(press("ArrowDown")).toBe(false);
    expect(field().value).toBe("a draft");
    unmount();

    render(<HistoryComposer history={[]} id="tab-empty" />);
    expect(press("ArrowUp")).toBe(false);
    expect(field().value).toBe("");
  });

  it("moves the caret inside a multi-line draft; history starts only from its first line and gives the draft back whole", () => {
    render(<HistoryComposer />);
    const text = "line one\nline two\nline three";

    // On the last line and on a middle line, Up is the caret's.
    type(text);
    expect(press("ArrowUp")).toBe(false);
    type(text, 12);
    expect(press("ArrowUp")).toBe(false);
    expect(press("ArrowDown")).toBe(false);
    expect(field().value).toBe(text);

    // On the first line it recalls, and Down brings every line back.
    type(text, 4);
    expect(press("ArrowDown")).toBe(false);
    expect(press("ArrowUp")).toBe(true);
    expect(field().value).toBe("third message");
    expect(press("ArrowDown")).toBe(true);
    expect(field().value).toBe(text);
  });

  it("walks on through a recalled multi-line message, but moves the caret once the reader has placed it", () => {
    render(<HistoryComposer history={["older", "two\nlines"]} />);
    press("ArrowUp");
    expect(field().value).toBe("two\nlines");
    press("ArrowUp");
    expect(field().value).toBe("older");
    press("ArrowDown");
    expect(field().value).toBe("two\nlines");

    // Caret moved to the first line: Down is the caret's, Up still recalls.
    field().setSelectionRange(1, 1);
    expect(press("ArrowDown")).toBe(false);
    expect(field().value).toBe("two\nlines");
    expect(press("ArrowUp")).toBe(true);
    expect(field().value).toBe("older");
  });

  it("leaves a selection, modified arrows and IME composition alone", () => {
    render(<HistoryComposer />);
    expect(press("ArrowUp", { shiftKey: true })).toBe(false);
    expect(press("ArrowUp", { altKey: true })).toBe(false);
    expect(press("ArrowUp", { metaKey: true })).toBe(false);
    expect(press("ArrowUp", { isComposing: true })).toBe(false);
    type("some words");
    field().setSelectionRange(0, 4);
    expect(press("ArrowUp")).toBe(false);
    expect(field().value).toBe("some words");
  });

  it("sends an edited recalled message without changing the history, and gives back the draft set aside for it", async () => {
    const history = [...SENT];
    const onSend = vi.fn();
    render(<HistoryComposer history={history} onSend={onSend} />);
    type("work in progress");
    press("ArrowUp");
    fireEvent.change(field(), { target: { value: "third message, edited" } });

    // The edit is kept while browsing…
    field().setSelectionRange(0, 0);
    press("ArrowUp");
    expect(field().value).toBe("second message");
    press("ArrowDown");
    expect(field().value).toBe("third message, edited");

    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("third message, edited", []));
    // …and the history itself is untouched; the unsent draft is back.
    expect(history).toEqual(SENT);
    await waitFor(() => expect(field().value).toBe("work in progress"));
    press("ArrowUp");
    expect(field().value).toBe("third message");
  });

  it("clears the composer after an ordinary send, and Shift+Return still does not send", async () => {
    const onSend = vi.fn();
    render(<HistoryComposer onSend={onSend} />);
    type("a new message");
    press("Enter", { shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("a new message", []));
    await waitFor(() => expect(field().value).toBe(""));
  });

  it("an open @ or / menu takes the arrows", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "list_slash_commands") return [{ name: "compact", description: "", source: "builtin" }, { name: "clear", description: "", source: "builtin" }];
      if (command === "search_files") return [{ path: "src/a.ts", name: "a.ts", score: 1 }, { path: "src/b.ts", name: "b.ts", score: 1 }];
      return null;
    });
    render(<HistoryComposer cwd="/repo" />);
    const selected = () => screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")?.textContent;

    type("@");
    await screen.findByText("b.ts");
    expect(selected()).toContain("a.ts");
    expect(press("ArrowDown")).toBe(true);
    expect(selected()).toContain("b.ts");
    expect(press("ArrowUp")).toBe(true);
    expect(selected()).toContain("a.ts");
    expect(field().value).toBe("@");

    type("/");
    await screen.findByText("/clear");
    press("ArrowUp");
    expect(selected()).toContain("/clear");
    expect(field().value).toBe("/");

    // Escape shuts the menu; the arrows are the history's again.
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    press("ArrowUp");
    expect(field().value).toBe("third message");
  });

  it("an empty menu (no match) takes the arrows too", async () => {
    invoke.mockImplementation(async (command: string) => (command === "list_slash_commands" ? [{ name: "compact", description: "", source: "builtin" }] : []));
    render(<HistoryComposer cwd="/repo-empty" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_slash_commands", expect.anything()));
    type("/zzz");
    await screen.findByText("No matching command");
    expect(press("ArrowUp")).toBe(false);
    expect(field().value).toBe("/zzz");
  });

  it("a recalled /command does not open its menu, so the arrows keep walking", async () => {
    invoke.mockImplementation(async (command: string) => (command === "list_slash_commands" ? [{ name: "compact", description: "", source: "builtin" }] : []));
    render(<HistoryComposer cwd="/repo-slash" history={["earlier", "/compact"]} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_slash_commands", expect.anything()));
    await Promise.resolve();

    press("ArrowUp");
    expect(field().value).toBe("/compact");
    expect(screen.queryByRole("listbox")).toBeNull();
    press("ArrowUp");
    expect(field().value).toBe("earlier");
  });

  it("the model and permission menus take the arrows while open", async () => {
    render(<HistoryComposer />);
    for (const name of [/Default/, /Auto/]) {
      mouseClick(screen.getByRole("button", { name, hidden: true }));
      await screen.findByRole("menu");
      expect(press("ArrowUp")).toBe(false);
      expect(field().value).toBe("");
      mouseClick(screen.getByRole("button", { name, hidden: true }));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
    press("ArrowUp");
    expect(field().value).toBe("third message");
  });

  it("is back after a remount, and a remount while browsing still returns the draft", () => {
    const first = render(<HistoryComposer />);
    type("typed before the switch");
    press("ArrowUp");
    expect(field().value).toBe("third message");
    first.unmount();

    render(<HistoryComposer />);
    expect(field().value).toBe("third message");
    press("ArrowUp");
    expect(field().value).toBe("second message");
    press("ArrowDown");
    press("ArrowDown");
    expect(field().value).toBe("typed before the switch");
  });

  it("keeps each tab's history and place apart", () => {
    render(
      <>
        <HistoryComposer id="tab-a" history={["from a"]} />
        <HistoryComposer id="tab-b" history={["from b"]} />
      </>,
    );
    const [a, b] = Array.from(document.querySelectorAll("textarea"));
    fireEvent.keyDown(a, { key: "ArrowUp" });
    fireEvent.keyDown(b, { key: "ArrowUp" });
    expect([a.value, b.value]).toEqual(["from a", "from b"]);
  });
});

describe("sentMessages", () => {
  let seq = 0;
  const user = (text: string, queued = false, ts = "2026-10-01T10:00:00Z") => ({ id: `e${++seq}`, seq, sessionId: "s", tabId: "t", harness: "codex", ts, payload: { type: "user_message" as const, text, queued } });
  const done = () => ({ id: `e${++seq}`, seq, sessionId: "s", tabId: "t", harness: "codex", ts: "2026-10-01T10:00:00Z", payload: { type: "turn_completed" as const, status: "ok" as const, authFailed: false } });
  const entry = (text: string, state: string, createdAt: number, kind = "send") => ({ clientCommandId: `c${++seq}`, tabId: "t", kind, text, state, createdAt, updatedAt: createdAt }) as never;

  it("lists a tab's prompts and the follow-ups queued behind a running turn, in order", () => {
    const transcript = buildTranscript([user("one"), done(), user("two"), user("queued while working", true)] as never, true);
    expect(sentMessages(transcript)).toEqual(["one", "two", "queued while working"]);
  });

  it("adds a cloud tab's mailbox commands and queued follow-ups that the transcript does not hold yet", () => {
    const transcript = buildTranscript([user("one", false, "2026-10-01T10:00:00Z"), done()] as never, false);
    const at = Date.parse("2026-10-01T10:05:00Z");
    const history = sentMessages(transcript, {
      entries: [
        entry("queued in the mailbox", "queued", at + 2),
        entry("not sent yet", "unsent", at + 1),
        entry("steered", "outcome-unknown", at + 3, "steer"),
        entry("one", "applied", at),
        entry("", "queued", at, "stop"),
        entry("allow", "queued", at, "permission-decision"),
      ],
      followUps: [{ text: "follow-up on the runtime" }],
    });
    // What ended without reaching the agent sits where it was written; what the runtime queued comes before what is still on its way.
    expect(history).toEqual(["one", "steered", "follow-up on the runtime", "not sent yet", "queued in the mailbox"]);
  });

  it("lists a repeated message once, where it was last sent, and leaves out the app's recovery prompt", () => {
    const transcript = buildTranscript([user("again"), done(), user("other"), done(), user(RECOVERY_PROMPT), done(), user("again"), done()] as never, false);
    expect(sentMessages(transcript)).toEqual(["other", "again"]);
  });
});
