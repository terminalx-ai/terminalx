import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TurnChanges } from "./TurnChanges";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { turnCheckpoint: vi.fn(), keepTurn: vi.fn(), undoTurn: vi.fn(), restoreUndo: vi.fn() }, errorMessage: (e: unknown) => String(e) }));
const checkpoint = { sessionId: "session", tabId: "tab", seq: 7 };
const saved = { number: 2, reviewed: false, undone: false, files: [{ path: "shell-edit.ts", status: "modified", additions: 3, deletions: 1 }] };
const card = () => render(<TurnChanges changes={[]} cwd="/repo" checkpoint={checkpoint} />);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.turnCheckpoint).mockResolvedValue(saved as never); });
afterEach(cleanup);

it("shows the checkpoint's files even when no tool reported an edit, and persists Keep", async () => {
  card();
  expect(await screen.findByRole("button", { name: "Keep" })).toBeDefined();
  expect(screen.getByText("shell-edit.ts")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
  expect(api.keepTurn).toHaveBeenCalledWith("session", "tab", 7);
  expect(screen.getByRole("status").textContent).toBe("Kept");
});

it("loads reviewed state after remounting", async () => {
  vi.mocked(api.turnCheckpoint).mockResolvedValue({ ...saved, reviewed: true } as never);
  card();
  expect(await screen.findByText("Kept")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
});

it("undoes the latest turn in one click", async () => {
  vi.mocked(api.undoTurn).mockResolvedValue({ overlap: [], token: "tree:index", undone: true });
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByText("Undone")).toBeDefined();
  expect(api.undoTurn).toHaveBeenCalledWith("session", "tab", 7, null);
});

it("explains overlap before confirmation and sends the preview token only on Undo anyway", async () => {
  vi.mocked(api.undoTurn).mockResolvedValueOnce({ overlap: ["shell-edit.ts"], token: "current:index", undone: false })
    .mockResolvedValueOnce({ overlap: [], token: "current:index", undone: true });
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/Other tabs or sessions worked on these files during this turn/)).toBeDefined();
  expect(within(dialog).getByText("shell-edit.ts")).toBeDefined();
  expect(api.undoTurn).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Undo anyway" }));
  expect(await screen.findByText("Undone")).toBeDefined();
  expect(api.undoTurn).toHaveBeenLastCalledWith("session", "tab", 7, "current:index");
});

it("cancels an overlapping undo and leaves actions available", async () => {
  vi.mocked(api.undoTurn).mockResolvedValue({ overlap: ["shell-edit.ts"], token: "tree", undone: false });
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(api.undoTurn).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
});

it("keeps the actions after failure and prevents duplicate requests while busy", async () => {
  let reject!: (e: Error) => void;
  vi.mocked(api.undoTurn).mockReturnValue(new Promise((_, no) => { reject = no; }));
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect((screen.getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(api.undoTurn).toHaveBeenCalledTimes(1);
  reject(new Error("Agent is working"));
  expect((await screen.findByRole("alert")).textContent).toContain("Agent is working");
  expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
});

it("leaves legacy turns without checkpoints as file chips", async () => {
  vi.mocked(api.turnCheckpoint).mockResolvedValue(null);
  render(<TurnChanges changes={[{ path: "old.ts", kind: "update", added: 1, removed: 0 }]} checkpoint={checkpoint} />);
  await waitFor(() => expect(api.turnCheckpoint).toHaveBeenCalled());
  expect(screen.getByText("old.ts")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

const backupRef = "refs/raccoon-checkpoints/session/tab-7/before-undo";

it("exposes the Undo backup and restores it in one click", async () => {
  vi.mocked(api.undoTurn).mockResolvedValue({ overlap: [], token: "tree:index", undone: true, backupRef });
  vi.mocked(api.restoreUndo).mockResolvedValue({ overlap: [], token: "restored", undone: true });
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  const restore = await screen.findByRole("button", { name: "Restore what Undo removed" });
  expect(restore.getAttribute("title")).toContain(backupRef);
  fireEvent.click(restore);
  expect(await screen.findByText("Restored")).toBeDefined();
  expect(api.restoreUndo).toHaveBeenCalledWith("session", "tab", 7, null);
  expect(screen.queryByRole("button", { name: "Restore what Undo removed" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("loads the backup on remount and requires confirmation before replacing newer edits", async () => {
  vi.mocked(api.turnCheckpoint).mockResolvedValue({ ...saved, reviewed: true, undone: true, backupRef } as never);
  vi.mocked(api.restoreUndo).mockResolvedValueOnce({ overlap: ["shell-edit.ts"], token: "restore:new:index", undone: false })
    .mockResolvedValueOnce({ overlap: [], token: "restored", undone: true });
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Restore what Undo removed" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/These files changed after Undo/)).toBeDefined();
  expect(api.restoreUndo).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore anyway" }));
  expect(await screen.findByText("Restored")).toBeDefined();
  expect(api.restoreUndo).toHaveBeenLastCalledWith("session", "tab", 7, "restore:new:index");
});

it("keeps recovery available after cancellation or failure", async () => {
  vi.mocked(api.turnCheckpoint).mockResolvedValue({ ...saved, reviewed: true, undone: true, backupRef } as never);
  vi.mocked(api.restoreUndo).mockResolvedValueOnce({ overlap: ["shell-edit.ts"], token: "restore:new:index", undone: false })
    .mockRejectedValueOnce(new Error("Agent is working"));
  card();
  fireEvent.click(await screen.findByRole("button", { name: "Restore what Undo removed" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(api.restoreUndo).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Restore what Undo removed" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Agent is working");
  expect(screen.getByText("Undone")).toBeDefined();
  expect((screen.getByRole("button", { name: "Restore what Undo removed" }) as HTMLButtonElement).disabled).toBe(false);
});

it("explains an expired checkpoint without offering an unsafe restore", async () => {
  vi.mocked(api.turnCheckpoint).mockResolvedValue({ ...saved, unavailableReason: "This checkpoint has expired under the workspace retention limit." } as never);
  card();
  expect(await screen.findByText(/checkpoint has expired/)).toBeDefined();
  expect(screen.getByText("shell-edit.ts")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
});
