import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { FakeAgentRuntime } from "@/test/fakeAgentRuntime";
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
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn(), useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
const listed = vi.hoisted(() => ({ models: [] as import("@/lib/api").ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  EFFORT_LABEL: {},
  PERMISSION_MODES: [{ id: "auto", label: "Auto", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => listed.models,
}));
vi.mock("@/lib/dialogs", () => ({ chooseMode: vi.fn() }));

const { Composer } = await import("./Composer");
const { setPrefs } = await import("@/lib/prefs");
const { sendShortcut } = await import("@/lib/shortcuts");
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

  it("a file dropped from this computer is mentioned to a local agent, and left alone for a cloud one", async () => {
    invoke.mockImplementation(async (command: string) => (command === "read_image_file" ? null : []));
    let drop: (event: { payload: { type: string; paths: string[] } }) => Promise<void> = async () => undefined;
    let listening = 0;
    dragDropListener.mockImplementation(async (listener: typeof drop) => {
      drop = listener;
      listening += 1;
      return vi.fn();
    });
    function Dropped({ remote }: { remote: boolean }) {
      const [draft, setDraft] = useState("");
      return <Composer tab={tab} remote={remote} busy={false} draft={draft} onDraftChange={setDraft} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
    }
    const view = render(<Dropped remote={false} />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(listening).toBeGreaterThan(0));
    await act(async () => drop({ payload: { type: "drop", paths: ["/Users/me/notes.txt"] } }));
    expect(box.value).toBe("@/Users/me/notes.txt ");
    expect(screen.queryByTestId("attach-notice")).toBeNull();
    view.unmount();
    listening = 0;

    render(<Dropped remote />);
    const cloudBox = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(listening).toBeGreaterThan(0));
    await act(async () => drop({ payload: { type: "over", paths: [] } }));
    expect(screen.getByText("Drop images to attach")).toBeTruthy();
    await act(async () => drop({ payload: { type: "drop", paths: ["/Users/me/notes.txt"] } }));
    expect(cloudBox.value).toBe("");
    // It says why, instead of ignoring the file without a word (an over-5 MB image reads the same way).
    expect(screen.getByTestId("attach-notice").textContent).toBe("notes.txt was not attached: only images (PNG, JPEG, GIF, WebP) up to 5 MB can be sent to a cloud agent.");
    // The next image attached clears it.
    invoke.mockImplementation(async (command: string) => (command === "read_image_file" ? { mediaType: "image/png", data: "YWJj", name: "shot.png" } : []));
    await act(async () => drop({ payload: { type: "drop", paths: ["/Users/me/shot.png"] } }));
    expect(screen.queryByTestId("attach-notice")).toBeNull();
    expect(await screen.findByAltText("shot.png")).toBeTruthy();
  });

  it("hands over the very same image when a failed send is tried again", async () => {
    const sent: unknown[] = [];
    const onSend = vi.fn(async (_text: string, images: unknown[]) => {
      sent.push(images[0]);
      if (sent.length === 1) throw new Error("offline");
    });
    const { container } = render(<TestComposer onSend={onSend} />);
    const image = new File([new Uint8Array([1, 2, 3])], "retry.png", { type: "image/png" });
    fireEvent.drop(container.querySelector("textarea")!.parentElement!, { dataTransfer: { files: [image], types: ["Files"] } });
    await screen.findByAltText("retry.png");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(sent[1]).toBe(sent[0]);
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
    listed.models = [claude("opus", "Opus", { alias: true, resolved: "claude-opus-5-5", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }), claude("claude-opus-5-5", "Opus 5.5"), claude("claude-opus-5", "Opus 5")];
  });
  afterEach(() => {
    listed.models = [];
  });

  it("names the version the CLI says the alias runs, and says the alias follows the latest", () => {
    show();
    const button = screen.getByTitle("Model: Opus (latest, running Opus 5.5)");
    expect(button.textContent).toBe("Opus 5.5latest");
  });

  it("reads differently on the alias and on the same version pinned", () => {
    show({ tab: { ...onOpus, model: "claude-opus-5-5" } });
    expect(screen.getByTitle("Model: Opus 5.5").textContent).toBe("Opus 5.5");
  });

  it("names what the session itself reported over what the CLI listed", () => {
    show({ reportedModel: "claude-opus-5" });
    expect(screen.getByTitle("Model: Opus (latest, running Opus 5)").textContent).toBe("Opus 5latest");
  });

  it("claims no version for a cloud tab until its session reports one", () => {
    const view = show({ modelsAreLocal: false });
    expect(screen.getByTitle("Model: Opus (latest)").textContent).toBe("Opuslatest");
    view.unmount();
    show({ modelsAreLocal: false, reportedModel: "claude-opus-5-5" });
    expect(screen.getByTitle("Model: Opus (latest, running Opus 5.5)").textContent).toBe("Opus 5.5latest");
  });

  it("offers a cloud tab the aliases only, and keeps a pinned version it is already on", async () => {
    const view = show({ modelsAreLocal: false });
    mouseClick(screen.getByTitle("Model: Opus (latest)"));
    let menu = await screen.findByRole("menu");
    // The desktop's pinned versions may not exist on the workspace's CLI.
    expect(menu.textContent).not.toContain("Pinned version");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Opuslatest", "low", "high"]);
    view.unmount();
    show({ modelsAreLocal: false, tab: { ...onOpus, model: "claude-opus-5" } });
    mouseClick(screen.getByTitle("Model: Opus 5"));
    menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Opuslatest", "Opus 5", "low", "high"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Opus 5" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("offers the alias and, apart, the versions that can be pinned", async () => {
    const onSetModel = vi.fn();
    show({ onSetModel });
    mouseClick(screen.getByTitle("Model: Opus (latest, running Opus 5.5)"));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Pinned version");
    const items = within(menu).getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(items).toEqual(["Opuslatest · Opus 5.5", "Opus 5.5", "Opus 5", "low", "high"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Opus 5" }));
    expect(onSetModel).toHaveBeenCalledWith("claude-opus-5");
  });

  it("offers the VM's pinned versions and resolved alias, then aliases only when disconnected", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.agents[0].models = [claude("opus", "Opus", { alias: true, isDefault: true, resolved: "claude-opus-4-6" }), claude("claude-opus-4-6", "Opus 4.6")];
    const client = new WorkspaceRpcClient(runtime);
    runtime.connect();
    const onSetModel = vi.fn();
    show({ modelsAreLocal: false, modelClient: client, onSetModel });
    const button = await screen.findByTitle("Model: Opus (latest, running Opus 4.6)");
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("latest · Opus 4.6")).toBeTruthy();
    expect(within(menu).queryByRole("menuitemradio", { name: "Opus 5.5" })).toBeNull();
    mouseClick(within(menu).getByRole("menuitemradio", { name: "Opus 4.6" }));
    expect(onSetModel).toHaveBeenCalledWith("claude-opus-4-6");
    act(() => runtime.emit({ state: "suspended" }));
    mouseClick(screen.getByTitle("Model: Opus (latest)"));
    const offline = await screen.findByRole("menu");
    expect(within(offline).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Opuslatest", "low", "high"]);
  });

  it("reads a stored pinned id the list no longer carries", async () => {
    show({ tab: { ...onOpus, model: "claude-opus-4-8" } });
    // Still what the tab runs: it is named, not passed off as the default,
    const button = screen.getByTitle("Model: Opus 4.8");
    expect(button.textContent).toBe("Opus 4.8");
    // and it keeps the effort menu of its family and its own ticked row.
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Opuslatest · Opus 5.5", "Opus 5.5", "Opus 5", "Opus 4.8", "low", "high"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Opus 4.8" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("the pickers show what the agent is running (#404)", () => {
  const entry = (harness: string, id: string, label: string, extra: Partial<import("@/lib/api").ModelInfo> = {}) => ({ id, label, harness, efforts: ["low", "high"], defaultEffort: "low", acceptsImages: true, isDefault: false, upgrade: null, description: null, ...extra });
  const onSol: TabEntry = { ...tab, harness: "codex", model: "gpt-5.6-sol", effort: "low" };
  const show = (shown: TabEntry, props: Partial<Parameters<typeof Composer>[0]> = {}) =>
    render(<Composer tab={shown} busy={false} draft="" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} {...props} />);
  const ticked = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio").filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent);
  const pending = () => screen.queryByTestId("composer-settings-pending")?.textContent ?? null;

  beforeEach(() => {
    listed.models = [entry("codex", "gpt-5.6-sol", "GPT-5.6 Sol", { isDefault: true }), entry("codex", "gpt-6-astra", "GPT-6 Astra")];
  });
  afterEach(() => {
    listed.models = [];
  });

  it("says nothing is on its way when the tab is on what was chosen", async () => {
    show(onSol);
    expect(pending()).toBeNull();
    mouseClick(screen.getByTitle("Model: GPT-5.6 Sol · low"));
    expect(ticked(await screen.findByRole("menu"))).toEqual(["GPT-5.6 Sol", "low"]);
  });

  it("keeps showing the running model and effort while a change waits for the turn", async () => {
    show({ ...onSol, requestedModel: "gpt-6-astra", requestedEffort: "high" }, { busy: true });
    // Never the model the agent is not on yet.
    const button = screen.getByTitle("Model: GPT-5.6 Sol · low");
    expect(button.textContent).toBe("GPT-5.6 Sollow");
    expect(pending()).toBe("Switching to GPT-6 Astra · High after this turn");
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    expect(ticked(menu)).toEqual(["GPT-5.6 Sol", "low"]);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["GPT-5.6 Sol", "GPT-6 Astraswitching…", "low", "highswitching…"]);
  });

  it("says a change to an idle agent is on its way, for either setting alone", () => {
    const view = show({ ...onSol, requestedModel: "gpt-6-astra" });
    expect(pending()).toBe("Switching to GPT-6 Astra…");
    view.unmount();
    show({ ...onSol, requestedEffort: "high" });
    expect(pending()).toBe("Switching to High effort…");
  });

  it("moves to the new values once the agent runs them, and back to nothing pending when it refuses", () => {
    const view = show({ ...onSol, requestedModel: "gpt-6-astra" }, { busy: true });
    view.rerender(<Composer tab={{ ...onSol, model: "gpt-6-astra" }} busy={false} draft="" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />);
    expect(screen.getByTitle("Model: GPT-6 Astra · low")).toBeTruthy();
    expect(pending()).toBeNull();
    // Refused: the request is gone and the tab is where it was.
    view.rerender(<Composer tab={onSol} busy={false} draft="" onDraftChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />);
    expect(screen.getByTitle("Model: GPT-5.6 Sol · low")).toBeTruthy();
    expect(pending()).toBeNull();
  });

  it("shows a model and an effort the app has never heard of as the agent reported them", async () => {
    show({ ...onSol, model: "gpt-9-nova", effort: "ultra" });
    const button = screen.getByTitle("Model: GPT-9 Nova · ultra");
    expect(button.textContent).toBe("GPT-9 Novaultra");
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    expect(ticked(menu)).toEqual(["GPT-9 Nova", "ultra"]);
    // What can be chosen instead is still offered.
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["GPT-5.6 Sol", "GPT-6 Astra", "GPT-9 Nova", "low", "high", "ultra"]);
  });

  it("names a requested model it has no entry for by its id", () => {
    show({ ...onSol, requestedModel: "gpt-9-nova", requestedEffort: "ultra" });
    expect(pending()).toBe("Switching to GPT-9 Nova · Ultra…");
  });

  it("keeps showing the mode the agent is in while another waits for the restart (#417)", async () => {
    show({ ...onSol, permissionMode: "plan", requestedPermissionMode: "auto" }, { busy: true });
    const button = screen.getByTitle("Permission mode: Plan");
    expect(screen.getByTestId("permission-mode-label").textContent).toBe("Plan");
    expect(pending()).toBe("Switching to Auto after this turn");
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    expect(ticked(menu)).toEqual([]);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Autoswitching…"]);
  });

  it("names a waiting mode alongside a waiting model", () => {
    show({ ...onSol, requestedModel: "gpt-6-astra", requestedPermissionMode: "plan" }, { busy: true });
    expect(pending()).toBe("Switching to GPT-6 Astra and Plan mode after this turn");
  });

  it("shows a mode set in the terminal that the picker does not offer as reported (#417)", async () => {
    show({ ...onSol, permissionMode: "never, workspace-write" });
    const button = screen.getByTitle("Permission mode: never, workspace-write");
    expect(screen.getByTestId("permission-mode-label").textContent).toBe("never, workspace-write");
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    // It is the one ticked, and what the picker does offer is still there to choose.
    expect(ticked(menu)).toEqual(["never, workspace-writeSet in the terminal."]);
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["never, workspace-writeSet in the terminal.", "Auto"]);
  });

  it("ticks the picker's entry for a mode stored under an older spelling", async () => {
    listed.models = [];
    show({ ...tab, permissionMode: "auto" });
    mouseClick(screen.getByTitle("Permission mode: Auto"));
    const menu = await screen.findByRole("menu");
    expect(ticked(menu)).toEqual(["Auto"]);
    expect(screen.queryByTestId("permission-mode-reported")).toBeNull();
  });

  it("offers no effort for an agent that has none", async () => {
    listed.models = [entry("cursor", "auto", "Auto", { isDefault: true, efforts: [], defaultEffort: null }), entry("cursor", "gpt-5", "GPT-5", { efforts: [], defaultEffort: null })];
    // A stale effort on the tab is not shown either.
    show({ ...tab, harness: "cursor", model: "auto", effort: "high" });
    const button = screen.getByTitle("Model: Auto");
    expect(button.textContent).toBe("Auto");
    mouseClick(button);
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).not.toContain("Effort");
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Auto", "GPT-5"]);
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

  describe("with the reader's own keys (Settings → Shortcuts)", () => {
    afterEach(() => setPrefs({ shortcuts: {} }));

    it("sends on the chosen key, and Return then only breaks the line", async () => {
      // `mod` is Ctrl in jsdom, which is not a Mac.
      setPrefs({ shortcuts: { "composer.send": ["mod+enter"] } });
      const onSend = vi.fn();
      render(<HistoryComposer onSend={onSend} />);
      type("a new message");
      // Not taken by the composer: the textarea breaks the line itself.
      expect(press("Enter")).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
      expect(press("Enter", { ctrlKey: true })).toBe(true);
      await waitFor(() => expect(onSend).toHaveBeenCalledWith("a new message", []));
    });

    it("does not send at all when Send has no key", () => {
      setPrefs({ shortcuts: { "composer.send": [] } });
      const onSend = vi.fn();
      render(<HistoryComposer onSend={onSend} />);
      type("a new message");
      expect(press("Enter")).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
    });

    it("breaks the line on a New line key that is not Return", () => {
      setPrefs({ shortcuts: { "composer.newLine": ["mod+j"] } });
      render(<HistoryComposer onSend={vi.fn()} />);
      type("one two", 3);
      expect(!fireEvent.keyDown(field(), { key: "j", code: "KeyJ", ctrlKey: true })).toBe(true);
      expect(field().value).toBe("one\n two");
      expect(field().selectionStart).toBe(4);
    });

    it("recalls messages on the chosen keys, and the arrows only move the caret", () => {
      setPrefs({ shortcuts: { "composer.historyPrevious": ["mod+up"], "composer.historyNext": ["mod+down"] } });
      render(<HistoryComposer />);
      expect(press("ArrowUp")).toBe(false);
      expect(field().value).toBe("");
      expect(press("ArrowUp", { ctrlKey: true })).toBe(true);
      expect(field().value).toBe("third message");
      expect(press("ArrowDown", { ctrlKey: true })).toBe(true);
      expect(field().value).toBe("");
    });

    it("runs Send from the command palette whatever its key is", async () => {
      setPrefs({ shortcuts: { "composer.send": [] } });
      const onSend = vi.fn();
      render(<HistoryComposer onSend={onSend} />);
      type("a new message");
      sendShortcut("composer.send", field());
      await waitFor(() => expect(onSend).toHaveBeenCalledWith("a new message", []));
    });
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

  // The flake behind four blocked merges: the list's arrival used to queue a "back to the first row" in a
  // passive effect, and a key that landed after the rows were painted but before that effect ran was
  // answered first and then undone by it.
  it("a key pressed in the frame the @ list arrives still moves the highlight", async () => {
    let deliver: (hits: { path: string; name: string; score: number }[]) => void = () => {};
    invoke.mockImplementation((command: string) => (command === "search_files" ? new Promise((resolve) => (deliver = resolve)) : Promise.resolve(command === "list_slash_commands" ? [] : null)));
    render(<HistoryComposer cwd="/repo-race" />);
    const selected = () => screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")?.textContent;

    type("@");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_files", expect.anything()));

    // Outside act, as in the app: React commits the rows, and runs the commit's passive effects in a
    // later task. The observer's callback is the first thing to run after the commit, before them.
    const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const acting = scope.IS_REACT_ACT_ENVIRONMENT;
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await new Promise<void>((resolve) => {
        const painted = new MutationObserver(() => {
          if (!screen.queryByText("b.ts")) return;
          painted.disconnect();
          field().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
          resolve();
        });
        painted.observe(document.body, { childList: true, subtree: true });
        deliver([{ path: "src/a.ts", name: "a.ts", score: 1 }, { path: "src/b.ts", name: "b.ts", score: 1 }]);
      });
      // Let the commit's passive effects and the key's own render run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      scope.IS_REACT_ACT_ENVIRONMENT = acting;
    }
    await act(async () => {});
    expect(selected()).toContain("b.ts");
  });

  it("lists a cloud tab's commands from its source instead of the local CLI, and says why some are missing", async () => {
    const list = { commands: [{ name: "compact", description: "Shorten", source: "builtin" as const }], note: "Other commands need someone who can approve permissions." };
    const load = vi.fn(async () => list);
    function CloudComposer({ sourceKey }: { sourceKey: string }) {
      const [draft, setDraft] = useState("");
      return <Composer tab={tab} commands={{ key: sourceKey, known: () => null, load }} busy={false} draft={draft} onDraftChange={setDraft} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
    }
    const view = render(<CloudComposer sourceKey="cloud|restricted|live" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "/", selectionStart: 1 } });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["/compactShorten"]);
    expect(screen.getByTestId("picker-note").textContent).toBe(list.note);
    // A command that is not offered: the list stays to say why, with nothing to pick.
    fireEvent.change(box, { target: { value: "/model", selectionStart: 6 } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByRole("listbox").textContent).toContain(list.note);
    // The same source on a later render is not read again; another one is.
    view.rerender(<CloudComposer sourceKey="cloud|restricted|live" />);
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<CloudComposer sourceKey="cloud|all|live" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(invoke).not.toHaveBeenCalledWith("list_slash_commands", expect.anything());
  });

  it("lists a cloud tab's files from its source, and completes the mention with the path on the workspace", async () => {
    const search = vi.fn(async (query: string) => (query === "log" ? [{ path: "src/auth/login.rs", name: "login.rs", score: 1 }] : [{ path: "README.md", name: "README.md", score: 0 }]));
    function CloudComposer({ connected }: { connected: boolean }) {
      const [draft, setDraft] = useState("");
      return <Composer tab={tab} files={connected ? { key: "cloud:o:w|s-1", search } : null} busy={false} draft={draft} onDraftChange={setDraft} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
    }
    const view = render(<CloudComposer connected />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    // The button opens the list on the shallowest files, as a bare `@` does locally.
    fireEvent.click(screen.getByRole("button", { name: "Mention a file" }));
    expect((await screen.findByRole("option")).textContent).toContain("README.md");
    fireEvent.change(box, { target: { value: "read @log", selectionStart: 9 } });
    await waitFor(() => expect(screen.getByRole("option").textContent).toContain("src/auth/login.rs"));
    expect(search).toHaveBeenLastCalledWith("log", 30);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("read @src/auth/login.rs ");
    expect(invoke).not.toHaveBeenCalledWith("search_files", expect.anything());
    // Not connected: no list and no button, and nothing is asked.
    view.rerender(<CloudComposer connected={false} />);
    search.mockClear();
    expect(screen.queryByRole("button", { name: "Mention a file" })).toBeNull();
    fireEvent.change(box, { target: { value: "read @", selectionStart: 6 } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it("asks a cloud tab's source again when the reader starts a command and the list is still empty", async () => {
    const lists = [Promise.reject(new Error("unavailable")), Promise.resolve({ commands: [], note: null }), Promise.resolve({ commands: [{ name: "compact", description: "", source: "builtin" as const }], note: null })];
    lists[0]!.catch(() => undefined);
    const load = vi.fn(() => lists[Math.min(load.mock.calls.length - 1, 2)]!);
    function CloudComposer() {
      const [draft, setDraft] = useState("");
      return <Composer tab={tab} commands={{ key: "cloud|all|live", known: () => null, load }} busy={false} draft={draft} onDraftChange={setDraft} onSend={vi.fn()} onStop={vi.fn()} onSetModel={vi.fn()} onSetEffort={vi.fn()} onSetMode={vi.fn()} />;
    }
    render(<CloudComposer />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    // The CLI had not answered; then it listed nothing; the third `/` gets the list.
    fireEvent.change(box, { target: { value: "/", selectionStart: 1 } });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "", selectionStart: 0 } });
    fireEvent.change(box, { target: { value: "/", selectionStart: 1 } });
    expect((await screen.findByRole("option")).textContent).toBe("/compact");
    expect(load).toHaveBeenCalledTimes(3);
    // With a list in hand, starting a command asks nobody.
    fireEvent.change(box, { target: { value: "", selectionStart: 0 } });
    fireEvent.change(box, { target: { value: "/c", selectionStart: 2 } });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("a cloud tab with no source and no directory has no command list", () => {
    render(<TestComposer onSend={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/", selectionStart: 1 } });
    expect(screen.queryByRole("listbox")).toBeNull();
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
