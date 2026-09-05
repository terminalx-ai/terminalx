import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasEscapeOverlay, registerHotkey } from "@/lib/hotkeys";
import { StarNagCard, StarReminder, type StarReminderView } from "./StarReminder";

const { invoke, callbacks } = vi.hoisted(() => ({
  invoke: vi.fn(),
  callbacks: new Set<(event: { payload: StarReminderView }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: StarReminderView }) => void) => {
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  }),
}));

const direct: StarReminderView = { revision: 1, visible: true, mode: "direct", busy: false, error: null };
const browser: StarReminderView = { ...direct, mode: "browser" };
function emit(view: StarReminderView) { act(() => { callbacks.forEach((cb) => cb({ payload: view })); }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => command === "star_nag_ready" ? direct : { ...direct, revision: 2, visible: false });
  history.replaceState({}, "", "/");
});
afterEach(() => { cleanup(); callbacks.clear(); vi.useRealTimers(); });

describe("card", () => {
  it("has the requested copy, keeps focus and remains visible past ordinary toast timeout", () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(<><textarea aria-label="Composer" /><StarNagCard view={direct} onAction={onAction} onDismiss={onDismiss} /></>);
    const composer = screen.getByRole("textbox");
    composer.focus();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole("heading", { name: "Enjoying TerminalX?" })).toBeTruthy();
    expect(screen.getByText("TerminalX is open source. If it helped today, a GitHub star helps other developers find it.")).toBeTruthy();
    expect(document.activeElement).toBe(composer);
    expect(onAction).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["Later", "Dismiss"])("%s defers the reminder", (name) => {
    const onDismiss = vi.fn();
    render(<StarNagCard view={direct} onAction={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("Escape dismisses before a later registered agent-stop hotkey and preserves composer focus", () => {
    const onDismiss = vi.fn();
    const stop = vi.fn();
    render(<><textarea aria-label="Composer" /><StarNagCard view={direct} onAction={vi.fn()} onDismiss={onDismiss} /></>);
    const unregister = registerHotkey("escape", stop);
    const composer = screen.getByRole("textbox");
    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
    unregister();
  });

  it("preserves the editor Find bar’s Escape behavior while the reminder is visible", () => {
    const onDismiss = vi.fn();
    const editorEscape = vi.fn();
    render(<><div className="editor-pane"><input aria-label="Find" onKeyDown={editorEscape} /></div><StarNagCard view={direct} onAction={vi.fn()} onDismiss={onDismiss} /></>);
    const find = screen.getByRole("textbox", { name: "Find" });
    find.focus();
    fireEvent.keyDown(find, { key: "Escape" });
    expect(editorEscape).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(find);
  });

  it("lets a dialog consume Escape", () => {
    const onDismiss = vi.fn();
    const closeDialog = vi.fn();
    render(<><div role="dialog" aria-label="Approval" /><StarNagCard view={direct} onAction={vi.fn()} onDismiss={onDismiss} /></>);
    const unregister = registerHotkey("escape", closeDialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalledOnce();
    unregister();
  });

  it("lets a picker receive Escape without dismissing the card or stopping an agent", () => {
    const onDismiss = vi.fn();
    const stop = vi.fn();
    const nativeEscape = vi.fn();
    render(<><div role="listbox" /><textarea onKeyDown={nativeEscape} /><StarNagCard view={direct} onAction={vi.fn()} onDismiss={onDismiss} /></>);
    const unregister = registerHotkey("escape", () => hasEscapeOverlay() ? false : stop());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(nativeEscape).toHaveBeenCalledOnce();
    unregister();
  });

  it("disables repeated actions and consumes Escape during a star attempt", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(<StarNagCard view={{ ...direct, busy: true }} onAction={onAction} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Starring…" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onAction).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("backend connection", () => {
  it("displays without taking action and sends a single explicit direct-star command", async () => {
    const pending = deferred<StarReminderView>();
    invoke.mockImplementation((command: string) => command === "star_nag_ready" ? Promise.resolve(direct) : pending.promise);
    render(<StarReminder />);
    const star = await screen.findByRole("button", { name: "Star on GitHub" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["star_nag_ready"]);
    fireEvent.click(star);
    fireEvent.click(star);
    expect(invoke.mock.calls.filter(([command]) => command === "star_nag_act")).toHaveLength(1);
    await act(async () => pending.resolve({ ...direct, revision: 2, visible: false }));
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("direct failure leaves an explicit browser fallback; only another click takes it", async () => {
    invoke.mockImplementation(async (command: string) => command === "star_nag_ready" ? direct : { ...browser, revision: 2, error: "Couldn’t star from the app. You can open GitHub instead." });
    render(<StarReminder />);
    fireEvent.click(await screen.findByRole("button", { name: "Star on GitHub" }));
    const open = await screen.findByRole("button", { name: "Open GitHub" });
    expect(screen.getByRole("status").textContent).toContain("Couldn’t star");
    expect(invoke.mock.calls.filter(([command]) => command === "star_nag_act")).toHaveLength(1);
    invoke.mockResolvedValue({ ...browser, revision: 3, visible: false });
    fireEvent.click(open);
    await waitFor(() => expect(screen.queryByRole("heading")).toBeNull());
    expect(screen.queryByText("Starred")).toBeNull();
  });

  it("browser failures remain retryable and Later still works", async () => {
    invoke.mockImplementation(async (command: string) => command === "star_nag_ready" ? browser : { ...browser, revision: 2, error: "Couldn’t open your browser. Please try again." });
    render(<StarReminder />);
    fireEvent.click(await screen.findByRole("button", { name: "Open GitHub" }));
    await screen.findByRole("status");
    expect(screen.getByRole("button", { name: "Open GitHub" }).hasAttribute("disabled")).toBe(false);
    invoke.mockResolvedValue({ ...browser, revision: 3, visible: false });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByRole("heading")).toBeNull());
    expect(invoke).toHaveBeenLastCalledWith("star_nag_dismiss");
  });

  it("does not reshow from an old event or snapshot after dismissal", async () => {
    render(<StarReminder />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("heading")).toBeNull());
    emit(direct);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("reports typing and cleans up its subscription", async () => {
    const component = render(<StarReminder />);
    await screen.findByRole("heading");
    fireEvent.keyDown(window, { key: "Shift" });
    expect(invoke).not.toHaveBeenCalledWith("star_nag_input");
    fireEvent.keyDown(window, { key: "a" });
    expect(invoke).toHaveBeenCalledWith("star_nag_input");
    component.unmount();
    expect(callbacks.size).toBe(0);
  });

  it("development preview uses the real card without any backend calls", () => {
    history.replaceState({}, "", "/?preview=star-reminder&starMode=direct");
    render(<StarReminder />);
    fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
    expect(screen.queryByRole("heading")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
