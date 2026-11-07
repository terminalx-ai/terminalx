import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HeldQueueTray } from "./HeldQueueTray";
import type { HeldQueue } from "@/types/events";
import type { HeldQueueChange } from "@/lib/heldQueue";

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
  fireEvent.change(editor, { target: { value: "corrected" } });
  fireEvent.click(screen.getByText("Save"));
  await screen.findByText("corrected");
  expect(screen.getByText("screenshot.png")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Move follow-up 2 up"));
  await waitFor(() => expect(within(screen.getAllByRole("listitem")[0]).getByText("corrected")).toBeTruthy());
  fireEvent.click(screen.getByLabelText("Delete follow-up 2"));
  await waitFor(() => expect(screen.queryByText("first")).toBeNull());
  fireEvent.click(screen.getByText("Resume"));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ type: "pause", paused: false }));
  fireEvent.click(screen.getAllByText("Send now")[0]);
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
