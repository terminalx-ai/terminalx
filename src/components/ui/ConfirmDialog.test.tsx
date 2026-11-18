import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmDialogHost } from "./ConfirmDialog";
import { chooseInApp, confirmInApp, pendingConfirm } from "@/lib/confirm";

afterEach(cleanup);

/** Ask, and let React draw the question. The answer comes back boxed: an async function would wait for a bare promise. */
async function asking<T>(question: () => Promise<T>): Promise<{ answer: Promise<T> }> {
  let answer!: Promise<T>;
  await act(async () => { answer = question(); });
  return { answer };
}
const labels = (dialog: HTMLElement) => within(dialog).getAllByRole("button").map((button) => button.textContent);

// PRO-400, design 17.01: in-scope confirmations use the app card; Quit is an exception (PRO-455).
describe("the app's confirmation dialog", () => {
  it("asks with the question as its title, what happens below, the safe choice left and the red action right", async () => {
    render(<ConfirmDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const { answer: answer } = await asking(() => confirmInApp({ title: 'Delete "Fix login"?', body: "Its transcript is removed.\n\nThere is no undo.", action: "Delete", destructive: true }));
    const dialog = screen.getByRole("dialog", { name: 'Delete "Fix login"?' });
    expect(dialog.textContent).toContain("Its transcript is removed.");
    expect(labels(dialog)).toEqual(["Cancel", "Delete"]);
    const action = within(dialog).getByRole("button", { name: "Delete" });
    expect(action.className).toContain("bg-destructive");
    // Return picks the right-most: the action holds the focus when the card opens.
    expect(document.activeElement).toBe(action);
    await act(async () => { fireEvent.click(action); });
    expect(await answer).toBe(true);
    expect(screen.queryByRole("dialog", { name: 'Delete "Fix login"?' })).toBeNull();
  });

  it("cancels from its button and on Escape, and an action that destroys nothing is not red", async () => {
    render(<ConfirmDialogHost />);
    const { answer: first } = await asking(() => confirmInApp({ title: "Switch the default organization to Beta?", action: "Switch", cancel: "Stay" }));
    const dialog = screen.getByRole("dialog");
    expect(labels(dialog)).toEqual(["Stay", "Switch"]);
    expect(within(dialog).getByRole("button", { name: "Switch" }).className).not.toContain("bg-destructive");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Stay" })); });
    expect(await first).toBe(false);

    const { answer: second } = await asking(() => confirmInApp({ title: "Replace 2 matches?", action: "Replace" }));
    await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); });
    expect(await second).toBe(false);
    expect(pendingConfirm()).toBeNull();
  });

  it("offers a second way forward between the two, and says which was chosen", async () => {
    render(<ConfirmDialogHost />);
    const { answer: answer } = await asking(() => chooseInApp({ title: 'Delete "Fix login"?', action: "Delete session", alternative: "Also delete the workspace…", destructive: true }));
    const dialog = screen.getByRole("dialog");
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
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" })); });
    expect(await first).toBe(true);
    // Nothing came back for the repeat, and the same question can be asked afresh once it is answered.
    expect(pendingConfirm()).toBeNull();
    const { answer: later } = await asking(() => confirmInApp(request));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep editing" })); });
    expect(await later).toBe(false);
  });

  it("asks one question at a time, in the order they were asked", async () => {
    render(<ConfirmDialogHost />);
    const { answer: first } = await asking(() => confirmInApp({ title: "First?", action: "Yes" }));
    const { answer: second } = await asking(() => confirmInApp({ title: "Second?", action: "Yes" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog", { name: "First?" })).getByRole("button", { name: "Yes" })); });
    expect(await first).toBe(true);
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog", { name: "Second?" })).getByRole("button", { name: "Cancel" })); });
    expect(await second).toBe(false);
  });
});
