import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HeldQueueTray, againNow } from "./HeldQueueTray";
import type { HeldQueue } from "@/types/events";
import type { HeldQueueChange } from "@/lib/heldQueue";
import { dismissError, getErrorToasts, runErrorAction } from "@/lib/errorToasts";

/** A change commits the queue inside act(); the tray unlocks after it resolves, a scheduler task later. */
async function enabled(element: HTMLElement) {
  await waitFor(() => expect((element as HTMLButtonElement).disabled).toBe(false));
  return element;
}

const initial: HeldQueue = { items: ["first", "second", "third"].map(id => ({ id, text: id, images: id === "second" ? [{ url: "/a.png", name: "screenshot.png" }] : [] })), paused: false, sending: null, next: null, error: null };
afterEach(cleanup);

function TrayWith({ changed, fail }: { changed: (change: HeldQueueChange) => void; fail?: (change: HeldQueueChange) => boolean }) {
  const [queue, setQueue] = useState(initial);
  return <HeldQueueTray queue={queue} busy scope="t1" onChange={async change => {
    changed(change);
    if (fail?.(change)) throw new Error("Codex didn't answer within 10 seconds");
    setQueue(q => {
      switch (change.type) {
        case "pause": return { ...q, paused: change.paused };
        case "edit": return { ...q, items: q.items.map(item => item.id === change.id ? { ...item, text: change.text } : item) };
        case "delete": case "sendNow": return { ...q, items: q.items.filter(item => item.id !== change.id) };
        case "move": {
          const item = q.items.find(item => item.id === change.id)!;
          const items = q.items.filter(item => item.id !== change.id);
          items.splice(change.beforeId ? items.findIndex(item => item.id === change.beforeId) : items.length, 0, item);
          return { ...q, items };
        }
        default: return q;
      }
    });
  }} />;
}

afterEach(() => { for (const toast of getErrorToasts()) dismissError(toast.id); });

it("collapses, edits without pausing, keeps attachments inline, reorders from the keyboard, deletes, pauses and resumes", async () => {
  const changed = vi.fn();
  render(<TrayWith changed={changed} />);
  expect(screen.getByText("Held until the turn ends · 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide held follow-ups" }));
  expect(screen.queryByText("second")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show held follow-ups" }));
  // The attachment is a chip on the row's one line.
  expect(within(screen.getAllByRole("listitem")[1]).getByText("screenshot.png")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Edit follow-up 2"));
  const editor = await screen.findByLabelText("Edit held follow-up");
  expect(screen.getByText("Editing held message 2")).toBeTruthy();
  // The queue keeps running while a message is edited.
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByText("Pause queue")).toBeTruthy();
  expect(document.activeElement).toBe(editor);
  fireEvent.change(editor, { target: { value: "corrected" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("corrected");
  expect(changed.mock.calls.map(([action]) => action)).toEqual([{ type: "edit", id: "second", text: "corrected" }]);
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(document.activeElement).toBe(screen.getByLabelText("Edit follow-up 2"));
  fireEvent.keyDown(await enabled(screen.getByLabelText("Edit follow-up 2")), { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(within(screen.getAllByRole("listitem")[0]).getByText("corrected")).toBeTruthy());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Moved held follow-up to position 1."));
  fireEvent.click(await enabled(screen.getByLabelText("Delete follow-up 2")));
  await waitFor(() => expect(screen.queryByText("first")).toBeNull());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Deleted held follow-up."));
  fireEvent.click(await enabled(screen.getByText("Pause queue")));
  expect((await screen.findByTestId("held-paused")).textContent).toBe("Paused");
  fireEvent.click(await enabled(await screen.findByText("Resume")));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ type: "pause", paused: false }));
  fireEvent.click(await enabled(screen.getByLabelText("Send follow-up 1 now")));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ type: "sendNow", id: "second" }));
});

it("says a failed reorder and a failed resume apart, marks the row that went back, and tries again (PRO-380)", async () => {
  const changed = vi.fn();
  let failing = true;
  render(<TrayWith changed={changed} fail={() => failing} />);
  fireEvent.dragStart(screen.getByLabelText("Drag follow-up 3"), { dataTransfer: { setData: vi.fn() } });
  fireEvent.dragOver(screen.getAllByRole("listitem")[0]);
  fireEvent.drop(screen.getAllByRole("listitem")[0]);
  await waitFor(() => expect(getErrorToasts()).toHaveLength(1));
  expect(changed).toHaveBeenCalledWith({ type: "move", id: "third", beforeId: "first" });
  expect(within(screen.getAllByRole("listitem")[2]).getByText("third")).toBeTruthy();
  expect(within(screen.getAllByRole("listitem")[2]).getByTestId("held-moved-back").textContent).toBe("moved back");
  const reorder = getErrorToasts()[0];
  expect(reorder.title).toBe("Couldn't reorder held messages");
  expect(reorder.action).toBe("“third” went back to 3rd");
  expect(reorder.cause).toBe("Codex didn't answer within 10 seconds");
  expect(reorder.actions?.map(action => action.label)).toEqual(["Try again"]);

  fireEvent.click(await enabled(screen.getByText("Pause queue")));
  await waitFor(() => expect(getErrorToasts()).toHaveLength(2));
  // A second failure is a toast of its own; the first is still there.
  expect(getErrorToasts().map(toast => toast.title)).toEqual(["Couldn't reorder held messages", "Couldn't pause the held messages"]);

  failing = false;
  await runErrorAction(reorder.id, reorder.actions![0]);
  expect(changed).toHaveBeenLastCalledWith({ type: "move", id: "third", beforeId: "first" });
  await waitFor(() => expect(within(screen.getAllByRole("listitem")[0]).getByText("third")).toBeTruthy());
  expect(screen.queryByTestId("held-moved-back")).toBeNull();
  expect(getErrorToasts().map(toast => toast.title)).toEqual(["Couldn't pause the held messages"]);
});

it("says a failed resume keeps the queue paused and in order", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockRejectedValue(new Error("Codex didn't answer within 10 seconds"));
  render(<HeldQueueTray queue={{ ...initial, paused: true }} busy onChange={change} />);
  fireEvent.click(screen.getByText("Resume"));
  await waitFor(() => expect(getErrorToasts()).toHaveLength(1));
  const [toast] = getErrorToasts();
  expect(toast.title).toBe("Couldn't resume the held messages");
  expect(toast.action).toBe("They're still paused and in the same order");
  expect(toast.actions?.[0].label).toBe("Try again");
});

it("disables changes when read-only or when a delivery is being claimed", () => {
  const change = vi.fn();
  render(<HeldQueueTray queue={{ ...initial, sending: "first" }} busy onChange={change} />);
  expect((screen.getByText("Pause queue") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("Send follow-up 1 now"));
  expect(change).not.toHaveBeenCalled();
});

it("Escape cancels an edit and changes nothing", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  render(<HeldQueueTray queue={initial} busy onChange={change} />);
  const edit = screen.getByLabelText("Edit follow-up 1");
  fireEvent.click(edit);
  const editor = await screen.findByLabelText("Edit held follow-up");
  fireEvent.change(editor, { target: { value: "discard this edit" } });
  fireEvent.keyDown(editor, { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(change).not.toHaveBeenCalled();
  // The row is drawn anew once the editor closes; its Edit button has focus back.
  expect(document.activeElement).toBe(screen.getByLabelText("Edit follow-up 1"));
  expect(edit.isConnected).toBe(false);
});

it("saves with Return, and saves and sends now with Ctrl+Enter", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  render(<HeldQueueTray queue={initial} busy onChange={change} />);
  fireEvent.click(screen.getByLabelText("Edit follow-up 1"));
  let editor = await screen.findByLabelText("Edit held follow-up");
  fireEvent.change(editor, { target: { value: "corrected" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(change.mock.calls.map(([action]) => action)).toEqual([{ type: "edit", id: "first", text: "corrected" }]);
  fireEvent.click(await enabled(screen.getByLabelText("Edit follow-up 1")));
  editor = await screen.findByLabelText("Edit held follow-up");
  fireEvent.change(editor, { target: { value: "and now" } });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(change).toHaveBeenCalledTimes(3));
  expect(change.mock.calls.slice(1).map(([action]) => action)).toEqual([{ type: "edit", id: "first", text: "and now" }, { type: "sendNow", id: "first" }]);
});

it("closes the editor and says so when the message went out first", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  const { rerender } = render(<HeldQueueTray queue={initial} busy onChange={change} />);
  fireEvent.click(screen.getByLabelText("Edit follow-up 1"));
  await screen.findByLabelText("Edit held follow-up");
  rerender(<HeldQueueTray queue={{ ...initial, items: initial.items.slice(1) }} busy onChange={change} />);
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(getErrorToasts().at(-1)?.title).toBe("Couldn't save the held message");
  expect(change).not.toHaveBeenCalled();
});

it("shows a recovery reason and offers an explicit retry or deletion", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  const error = "The agent has not confirmed an earlier message. Check its terminal or stop the agent, then use Send now to retry.";
  render(<HeldQueueTray queue={{ ...initial, paused: true, error }} busy={false} onChange={change} />);
  expect(screen.getByRole("alert").textContent).toBe(error);
  fireEvent.click(screen.getByLabelText("Send follow-up 1 now"));
  await waitFor(() => expect(change).toHaveBeenCalledWith({ type: "sendNow", id: "first" }));
  await waitFor(() => expect((screen.getByLabelText("Delete follow-up 1") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByLabelText("Delete follow-up 1"));
  await waitFor(() => expect(change).toHaveBeenCalledWith({ type: "delete", id: "first" }));
});

it("hides an empty paused tray and does not let editing cancel a pending Send now", () => {
  const change = vi.fn();
  const { rerender } = render(<HeldQueueTray queue={{ ...initial, items: [], paused: true }} busy={false} onChange={change} />);
  expect(screen.queryByRole("region", { name: "Held follow-ups" })).toBeNull();
  rerender(<HeldQueueTray queue={{ ...initial, next: "first" }} busy onChange={change} />);
  expect((screen.getByLabelText("Edit follow-up 1") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Drag follow-up 1").tabIndex).toBe(-1);
  fireEvent.click(screen.getByLabelText("Edit follow-up 1"));
  expect(change).not.toHaveBeenCalled();
});

it("tries a failed move again to the same position in the queue as it is by then, and not for a message no longer held", () => {
  const move: HeldQueueChange = { type: "move", id: "third", beforeId: "first" };
  // "first" has since moved to the end: the move still goes to the top.
  const reordered = { ...initial, items: [initial.items[1], initial.items[2], initial.items[0]] };
  expect(againNow(move, 0, reordered)).toEqual({ type: "move", id: "third", beforeId: "second" });
  expect(againNow({ type: "move", id: "first", beforeId: null }, 2, initial)).toEqual({ type: "move", id: "first", beforeId: null });
  const gone = { ...initial, items: initial.items.filter(item => item.id !== "third") };
  expect(() => againNow(move, 0, gone)).toThrow("That message is no longer held.");
  expect(() => againNow({ type: "delete", id: "third" }, -1, gone)).toThrow("That message is no longer held.");
  expect(againNow({ type: "pause", paused: false }, -1, gone)).toEqual({ type: "pause", paused: false });
});

it("runs Try again through the tray's lock: not while another change or a delivery is under way", async () => {
  let release!: () => void;
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Codex didn't answer within 10 seconds"))
    .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }))
    .mockResolvedValue();
  const { rerender } = render(<HeldQueueTray queue={{ ...initial, paused: true }} busy scope="lock" onChange={change} />);
  fireEvent.click(screen.getByText("Resume"));
  await waitFor(() => expect(getErrorToasts()).toHaveLength(1));
  const [toast] = getErrorToasts();
  // Another change is under way: the retry says so and changes nothing.
  fireEvent.click(await enabled(screen.getByLabelText("Delete follow-up 1")));
  await runErrorAction(toast.id, toast.actions![0]);
  expect(change).toHaveBeenCalledTimes(2);
  expect(getErrorToasts()[0].cause).toBe("The held messages are changing. Try again in a moment.");
  release();
  // A delivery is being claimed: the same.
  rerender(<HeldQueueTray queue={{ ...initial, paused: true, sending: "first" }} busy scope="lock" onChange={change} />);
  await runErrorAction(toast.id, getErrorToasts()[0].actions![0]);
  expect(change).toHaveBeenCalledTimes(2);
  rerender(<HeldQueueTray queue={{ ...initial, paused: true }} busy scope="lock" onChange={change} />);
  await waitFor(() => expect((screen.getByText("Resume") as HTMLButtonElement).disabled).toBe(false));
  await runErrorAction(toast.id, getErrorToasts()[0].actions![0]);
  expect(change).toHaveBeenLastCalledWith({ type: "pause", paused: false });
  expect(getErrorToasts()).toHaveLength(0);
});
