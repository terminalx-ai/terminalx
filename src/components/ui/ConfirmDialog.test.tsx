import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost } from "./ConfirmDialog";
import { chooseInApp, confirmInApp, pendingConfirm, type ConfirmRequest } from "@/lib/confirm";

const desktop = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
  listen: vi.fn<(
    event: string,
    receive: (event: { payload: [string, ConfirmRequest | null] }) => Promise<void>,
  ) => Promise<() => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: desktop.isTauri, invoke: desktop.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: desktop.listen }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

/** Ask, and let React draw the question. The answer comes back boxed: an async function would wait for a bare promise. */
async function asking<T>(question: () => Promise<T>): Promise<{ answer: Promise<T> }> {
  let answer!: Promise<T>;
  await act(async () => { answer = question(); });
  return { answer };
}
const labels = (dialog: HTMLElement) => within(dialog).getAllByRole("button").map((button) => button.textContent);

describe("the app's confirmation dialog", () => {
  it("asks with the question as its title, what happens below, the safe choice left and the red action right", async () => {
    render(<ConfirmDialogHost />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const { answer: answer } = await asking(() => confirmInApp({ title: 'Delete "Fix login"?', body: "Its transcript is removed.\n\nThere is no undo.", action: "Delete", destructive: true }));
    const dialog = screen.getByRole("alertdialog", { name: 'Delete "Fix login"?' });
    expect(dialog.textContent).toContain("Its transcript is removed.");
    expect(labels(dialog)).toEqual(["Cancel", "Delete"]);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const action = within(dialog).getByRole("button", { name: "Delete" });
    expect(action.className).toContain("bg-destructive");
    expect(action.className).toContain("text-destructive-foreground");
    expect(action.className).toContain("disabled:cursor-not-allowed");
    expect(action.className).not.toContain("disabled:pointer-events-none");
    // Destructive confirmations auto-focus Cancel to prevent accidental deletion on Return.
    expect(document.activeElement).toBe(cancel);
    await act(async () => { fireEvent.click(action); });
    expect(await answer).toBe(true);
    expect(screen.queryByRole("alertdialog", { name: 'Delete "Fix login"?' })).toBeNull();
  });

  it("cancels from its button and on Escape, and an action that destroys nothing is not red", async () => {
    render(<ConfirmDialogHost />);
    const { answer: first } = await asking(() => confirmInApp({ title: "Switch the default organization to Beta?", action: "Switch", cancel: "Stay" }));
    const dialog = screen.getByRole("alertdialog");
    expect(labels(dialog)).toEqual(["Stay", "Switch"]);
    const switchBtn = within(dialog).getByRole("button", { name: "Switch" });
    expect(switchBtn.className).not.toContain("bg-destructive");
    // Non-destructive confirmations focus the primary action.
    expect(document.activeElement).toBe(switchBtn);
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Stay" })); });
    expect(await first).toBe(false);

    const { answer: second } = await asking(() => confirmInApp({ title: "Replace 2 matches?", action: "Replace" }));
    await act(async () => { fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" }); });
    expect(await second).toBe(false);
    expect(pendingConfirm()).toBeNull();
  });

  it("offers a second way forward between the two, and says which was chosen", async () => {
    render(<ConfirmDialogHost />);
    const { answer: answer } = await asking(() => chooseInApp({ title: 'Delete "Fix login"?', action: "Delete session", alternative: "Also delete the workspace…", destructive: true }));
    const dialog = screen.getByRole("alertdialog");
    expect(labels(dialog)).toEqual(["Cancel", "Also delete the workspace…", "Delete session"]);
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Also delete the workspace…" })); });
    expect(await answer).toBe("alternative");
  });

  // The card does not hold the window as a system alert did: the same shortcut pressed again asks the same thing.
  it("does not queue a question that is already waiting; the repeat is declined and the first asker acts once", async () => {
    render(<ConfirmDialogHost />);
    const request = { title: "Close a.ts without saving?", body: "Its unsaved changes are lost.", action: "Discard", cancel: "Keep editing", destructive: true };
    const { answer: first } = await asking(() => confirmInApp(request));
    const { answer: repeat } = await asking(() => confirmInApp({ ...request }));
    expect(await repeat).toBe(false);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" })); });
    expect(await first).toBe(true);
    // Nothing came back for the repeat, and the same question can be asked afresh once it is answered.
    expect(pendingConfirm()).toBeNull();
    const { answer: later } = await asking(() => confirmInApp(request));
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep editing" })); });
    expect(await later).toBe(false);
  });

  it("asks one question at a time, in the order they were asked", async () => {
    render(<ConfirmDialogHost />);
    const { answer: first } = await asking(() => confirmInApp({ title: "First?", action: "Yes" }));
    const { answer: second } = await asking(() => confirmInApp({ title: "Second?", action: "Yes" }));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog", { name: "First?" })).getByRole("button", { name: "Yes" })); });
    expect(await first).toBe(true);
    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog", { name: "Second?" })).getByRole("button", { name: "Cancel" })); });
    expect(await second).toBe(false);
  });

  it("retries a failed quit reply with the same ID and ignores a rejected claim", async () => {
    desktop.isTauri.mockReturnValue(true);
    desktop.listen.mockResolvedValue(() => {});
    desktop.invoke.mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("lost IPC reply"))
      .mockResolvedValue(true);
    render(<ConfirmDialogHost />);
    const [event, receive] = desktop.listen.mock.calls[0];
    expect(event).toBe("quit-prompt");

    const request = {
      title: "Keep work running?",
      action: "Quit and Keep Running",
      alternative: "Quit and Stop All",
      cancel: "Cancel",
    };
    await act(() => receive({ payload: ["expired", request] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    const { answer } = await asking(() => receive({ payload: ["current", request] }));
    const dialog = screen.getByRole("alertdialog", { name: request.title });
    expect(labels(dialog)).toEqual(["Cancel", "Quit and Stop All", "Quit and Keep Running"]);
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Quit and Stop All" })); });
    await answer;
    expect(desktop.invoke.mock.calls).toEqual([
      ["reply_to_quit_prompt", { id: "expired", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "current", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "current", reply: "alternative" }],
      ["reply_to_quit_prompt", { id: "current", reply: "alternative" }],
    ]);
  });

  it("renews a waiting quit card and stops when Rust withdraws it", async () => {
    vi.useFakeTimers();
    const rust = promptChannel("current");
    render(<ConfirmDialogHost />);
    const [, receive] = desktop.listen.mock.calls[0];
    const { answer } = await asking(() => receive({
      payload: ["current", { title: "Quit TerminalX?", action: "Quit Anyway", cancel: "Keep Running" }],
    }));
    expect(screen.getByRole("alertdialog", { name: "Quit TerminalX?" })).toBeTruthy();
    await act(() => receive({ payload: ["older", null] }));
    expect(screen.getByRole("alertdialog", { name: "Quit TerminalX?" })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    rust.withdraw();
    await act(() => receive({ payload: ["current", null] }));
    await answer;
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(desktop.invoke.mock.calls).toEqual([
      ["reply_to_quit_prompt", { id: "current", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "current", reply: "heartbeat" }],
      ["reply_to_quit_prompt", { id: "current", reply: "heartbeat" }],
    ]);
  });

  // Floating and chat web views may emit events too: only Rust's prompt state may dismiss or replace the card.
  it("keeps the card and its heartbeat when a forged event names another prompt", async () => {
    vi.useFakeTimers();
    const rust = promptChannel("current");
    render(<ConfirmDialogHost />);
    const [, receive] = desktop.listen.mock.calls[0];
    const request = { title: "Quit TerminalX?", action: "Quit Anyway", cancel: "Keep Running" };
    const { answer } = await asking(() => receive({ payload: ["current", request] }));

    await act(() => receive({ payload: ["forged", { title: "Something else?", action: "Yes" }] }));
    expect(screen.getByRole("alertdialog", { name: "Quit TerminalX?" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog", { name: "Something else?" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(rust.heartbeats).toBe(1);

    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Quit Anyway" })); });
    await answer;
    expect(rust.answer).toBe("action");
    expect(desktop.invoke.mock.calls).toEqual([
      ["reply_to_quit_prompt", { id: "current", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "forged", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "current", reply: "heartbeat" }],
      ["reply_to_quit_prompt", { id: "current", reply: "action" }],
    ]);
  });

  it("keeps the card when a withdrawal for it arrives while Rust still waits on it", async () => {
    vi.useFakeTimers();
    const rust = promptChannel("current");
    render(<ConfirmDialogHost />);
    const [, receive] = desktop.listen.mock.calls[0];
    const { answer } = await asking(() => receive({
      payload: ["current", { title: "Quit TerminalX?", action: "Quit Anyway", cancel: "Keep Running" }],
    }));

    await act(() => receive({ payload: ["current", null] }));
    expect(screen.getByRole("alertdialog", { name: "Quit TerminalX?" })).toBeTruthy();
    // The probe failing over IPC says nothing either way: the card stays.
    desktop.invoke.mockRejectedValueOnce(new Error("lost IPC reply"));
    await act(() => receive({ payload: ["current", null] }));
    expect(screen.getByRole("alertdialog", { name: "Quit TerminalX?" })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(rust.heartbeats).toBe(2);

    await act(async () => { fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep Running" })); });
    await answer;
    expect(rust.answer).toBe("cancel");
  });

  it("replaces the card when Rust accepts the new prompt's claim", async () => {
    vi.useFakeTimers();
    const rust = promptChannel("first");
    render(<ConfirmDialogHost />);
    const [, receive] = desktop.listen.mock.calls[0];
    const { answer: first } = await asking(() => receive({
      payload: ["first", { title: "Quit TerminalX?", action: "Quit Anyway", cancel: "Keep Running" }],
    }));
    rust.ask("second");
    const { answer: second } = await asking(() => receive({
      payload: ["second", { title: "Keep work running?", action: "Quit and Keep Running", alternative: "Quit and Stop All", cancel: "Cancel" }],
    }));
    await first;
    expect(screen.queryByRole("alertdialog", { name: "Quit TerminalX?" })).toBeNull();
    const dialog = screen.getByRole("alertdialog", { name: "Keep work running?" });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Quit and Stop All" })); });
    await second;
    expect(rust.answer).toBe("alternative");
    // The first card neither answered nor renewed once it was replaced.
    expect(desktop.invoke.mock.calls).toEqual([
      ["reply_to_quit_prompt", { id: "first", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "second", reply: "opened" }],
      ["reply_to_quit_prompt", { id: "second", reply: "heartbeat" }],
      ["reply_to_quit_prompt", { id: "second", reply: "alternative" }],
    ]);
  });
});

/** Rust's `PromptChannel` as the main web view sees it: one pending prompt, claimed once, then renewed or answered. */
function promptChannel(id: string) {
  desktop.isTauri.mockReturnValue(true);
  desktop.listen.mockResolvedValue(() => {});
  const rust = {
    pending: id as string | null,
    opened: false,
    heartbeats: 0,
    answer: undefined as string | undefined,
    ask(next: string) { rust.pending = next; rust.opened = false; },
    withdraw() { rust.pending = null; },
  };
  desktop.invoke.mockImplementation(async (command: string, { id, reply }: { id: string; reply: string }) => {
    expect(command).toBe("reply_to_quit_prompt");
    if (rust.pending !== id) return false;
    if (reply === "opened") return !rust.opened && (rust.opened = true);
    if (!rust.opened) return false;
    if (reply === "heartbeat") { rust.heartbeats++; return true; }
    rust.answer = reply;
    rust.pending = null;
    return true;
  });
  return rust;
}
