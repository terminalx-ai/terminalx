import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HeldQueueTray } from "./HeldQueueTray";
import type { HeldQueue } from "@/types/events";
import type { HeldQueueChange } from "@/lib/heldQueue";

/** A change commits the queue inside act(); the tray unlocks after it resolves, a scheduler task later. */
async function enabled(element: HTMLElement) {
  await waitFor(() => expect((element as HTMLButtonElement).disabled).toBe(false));
  return element;
}

const initial: HeldQueue = { items: ["first", "second", "third"].map(id => ({ id, text: id, images: id === "second" ? [{ url: "/a.png", name: "screenshot.png" }] : [] })), paused: false, sending: null, next: null, error: null };
afterEach(cleanup);

it("collapses, pauses before editing, keeps attachments, reorders, deletes, and resumes", async () => {
  const changed = vi.fn();
  function Tray() {
    const [queue, setQueue] = useState(initial);
    return <HeldQueueTray queue={queue} busy onChange={async change => {
      changed(change);
      setQueue(q => {
        switch (change.type) {
          case "pause": return { ...q, paused: change.paused };
          case "edit": return { ...q, items: q.items.map(item => item.id === change.id ? { ...item, text: change.text } : item) };
          case "delete": return { ...q, items: q.items.filter(item => item.id !== change.id) };
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
  render(<Tray />);
  fireEvent.click(screen.getByRole("button", { name: "3 held follow-ups" }));
  expect(screen.queryByText("second")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "3 held follow-ups" }));
  fireEvent.click(screen.getByLabelText("Edit follow-up 2"));
  const editor = await screen.findByLabelText("Edit held follow-up");
  expect(changed).toHaveBeenLastCalledWith({ type: "pause", paused: true });
  expect(document.activeElement).toBe(editor);
  fireEvent.change(editor, { target: { value: "corrected" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("corrected");
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ type: "pause", paused: false }));
  // The resume call is recorded before the edit closes: wait for the editor to go.
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(document.activeElement).toBe(screen.getByLabelText("Edit follow-up 2"));
  expect(screen.getByText("screenshot.png")).toBeTruthy();
  fireEvent.click(await enabled(screen.getByLabelText("Move follow-up 2 up")));
  await waitFor(() => expect(within(screen.getAllByRole("listitem")[0]).getByText("corrected")).toBeTruthy());
  fireEvent.click(await enabled(screen.getByLabelText("Delete follow-up 2")));
  await waitFor(() => expect(screen.queryByText("first")).toBeNull());
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Deleted held follow-up."));
  fireEvent.click(await enabled(screen.getByText("Pause queue")));
  fireEvent.click(await enabled(await screen.findByText("Resume")));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ type: "pause", paused: false }));
  fireEvent.click(await enabled(screen.getAllByText("Send now")[0]));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ type: "sendNow", id: "second" }));
});

it("sends a drag reorder by stable ids and retains the item when an edit fails", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockRejectedValue(new Error("Disk full"));
  render(<HeldQueueTray queue={initial} busy onChange={change} />);
  fireEvent.dragStart(screen.getByLabelText("Drag follow-up 3"), { dataTransfer: { setData: vi.fn() } });
  fireEvent.dragOver(screen.getAllByRole("listitem")[0]);
  fireEvent.drop(screen.getAllByRole("listitem")[0]);
  await screen.findByRole("alert");
  expect(change).toHaveBeenCalledWith({ type: "move", id: "third", beforeId: "first" });
  expect(screen.getByText("third")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Disk full");
});

it("disables changes when read-only or when a delivery is being claimed", () => {
  const change = vi.fn();
  render(<HeldQueueTray queue={{ ...initial, sending: "first" }} busy onChange={change} />);
  expect((screen.getByText("Pause queue") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getAllByText("Send now")[0]);
  expect(change).not.toHaveBeenCalled();
});

it.each([false, true])("Escape cancels an edit and restores the queue's prior paused=%s state", async paused => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  render(<HeldQueueTray queue={{ ...initial, paused }} busy onChange={change} />);
  const edit = screen.getByLabelText("Edit follow-up 1");
  fireEvent.click(edit);
  const editor = await screen.findByLabelText("Edit held follow-up");
  fireEvent.change(editor, { target: { value: "discard this edit" } });
  fireEvent.keyDown(editor, { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(change.mock.calls.map(([action]) => action)).toEqual(paused
    ? [{ type: "pause", paused: true }]
    : [{ type: "pause", paused: true }, { type: "pause", paused: false }]);
  expect(document.activeElement).toBe(edit);
});

it("saves an edit with Ctrl+Enter and leaves a queue that was already paused paused", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  render(<HeldQueueTray queue={{ ...initial, paused: true }} busy onChange={change} />);
  fireEvent.click(screen.getByLabelText("Edit follow-up 1"));
  const editor = await screen.findByLabelText("Edit held follow-up");
  fireEvent.change(editor, { target: { value: "corrected" } });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(screen.queryByLabelText("Edit held follow-up")).toBeNull());
  expect(change.mock.calls.map(([action]) => action)).toEqual([
    { type: "pause", paused: true }, { type: "edit", id: "first", text: "corrected" },
  ]);
});

it("shows a recovery reason and offers an explicit retry or deletion", async () => {
  const change = vi.fn<(change: HeldQueueChange) => Promise<void>>().mockResolvedValue();
  const error = "The agent has not confirmed an earlier message. Check its terminal or stop the agent, then use Send now to retry.";
  render(<HeldQueueTray queue={{ ...initial, paused: true, error }} busy={false} onChange={change} />);
  expect(screen.getByRole("alert").textContent).toBe(error);
  fireEvent.click(screen.getAllByText("Send now")[0]);
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
