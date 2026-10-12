import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Leftover } from "@/types/session";

const scanLeftovers = vi.fn();
const removeLeftovers = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    scanLeftovers: () => scanLeftovers(),
    removeLeftovers: (ids: string[]) => removeLeftovers(ids),
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { StorageTab } from "./StorageTab";

const base = { projectPath: "/p", projectName: "terminalx", agent: null, keptBecause: null };
const clean: Leftover = { ...base, id: "worktree:/p:quiet-amber-fox", kind: "worktree", name: "quiet-amber-fox", paths: ["/p/.raccoon/worktrees/quiet-amber-fox"], sizeBytes: 2_500_000_000 };
const unsaved: Leftover = { ...base, id: "worktree:/p:dirty-red-owl", kind: "worktree", name: "dirty-red-owl", paths: ["/p/.raccoon/worktrees/dirty-red-owl"], sizeBytes: 40_000_000, keptBecause: "2 uncommitted files would be lost." };
const transcripts: Leftover = { ...base, id: "claude:-p--raccoon-worktrees-gone", kind: "agentData", name: "gone", agent: "Claude", paths: ["/h/.claude/projects/-p--raccoon-worktrees-gone"], sizeBytes: 18_000_000 };

describe("StorageTab", () => {
  afterEach(cleanup);
  beforeEach(() => {
    removeLeftovers.mockReset();
    scanLeftovers.mockReset().mockResolvedValue([clean, unsaved, transcripts]);
  });

  it("lists leftovers with sizes, selects nothing, and locks rows with unsaved work", async () => {
    render(<StorageTab />);
    expect(await screen.findByText("quiet-amber-fox")).toBeTruthy();
    expect(screen.getByText("2.5 GB")).toBeTruthy();
    expect(screen.getByText("Claude data · gone")).toBeTruthy();
    expect(screen.getByText("Kept: 2 uncommitted files would be lost.")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /dirty-red-owl/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Delete selected/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(removeLeftovers).not.toHaveBeenCalled();
  });

  it("asks in a dialog that names every item, and deletes nothing when it is declined", async () => {
    render(<StorageTab />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    const dialog = screen.getByRole("dialog", { name: "Clean up leftovers" });
    expect(within(dialog).getByText("Delete 1 item (2.5 GB)? This is everything that will be deleted.")).toBeTruthy();
    expect(within(dialog).getByText(/they are not moved to the Trash/)).toBeTruthy();
    expect(within(within(dialog).getByRole("list", { name: "Items to delete" })).getAllByRole("listitem")).toHaveLength(1);
    // Cancel holds the focus, so Enter cannot confirm the deletion.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removeLeftovers).not.toHaveBeenCalled();
  });

  it("deletes nothing when the dialog is dismissed with Escape", async () => {
    render(<StorageTab />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(removeLeftovers).not.toHaveBeenCalled();
  });

  it("lists every selected item for review, however many there are", async () => {
    const many = Array.from({ length: 150 }, (_, index): Leftover => ({ ...clean, id: `worktree:/p:synthetic-${index}`, name: `synthetic-${index}`, sizeBytes: 1_000_000 }));
    scanLeftovers.mockResolvedValue([...many, unsaved]);
    render(<StorageTab />);
    await screen.findByText("synthetic-0");
    fireEvent.click(screen.getByRole("button", { name: "Select all removable" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    const dialog = screen.getByRole("dialog", { name: "Clean up leftovers" });
    const rows = within(within(dialog).getByRole("list", { name: "Items to delete" })).getAllByRole("listitem");
    expect(rows).toHaveLength(150);
    expect(rows.at(-1)!.textContent).toContain("synthetic-149");
    expect(within(dialog).queryByText(/dirty-red-owl/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Delete 150 items" })).toBeTruthy();
    expect(removeLeftovers).not.toHaveBeenCalled();
  });

  it("deletes only the confirmed, removable rows and reports what was freed", async () => {
    removeLeftovers.mockResolvedValue({ removed: [clean.id, transcripts.id], failed: [], freedBytes: 2_518_000_000 });
    render(<StorageTab />);
    await screen.findByText("quiet-amber-fox");
    fireEvent.click(screen.getByRole("button", { name: "Select all removable" }));
    scanLeftovers.mockResolvedValue([unsaved]);
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    expect(removeLeftovers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 items" }));
    await waitFor(() => expect(removeLeftovers).toHaveBeenCalledWith([clean.id, transcripts.id]));
    expect(await screen.findByText("Deleted 2 items and freed 2.5 GB.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("quiet-amber-fox")).toBeNull());
    expect(screen.getByText("dirty-red-owl")).toBeTruthy();
  });

  it("shows why something could not be deleted", async () => {
    removeLeftovers.mockResolvedValue({ removed: [], failed: [{ id: clean.id, error: "Has 1 uncommitted file." }], freedBytes: 0 });
    render(<StorageTab />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 item" }));
    expect(await screen.findByText("Kept: Has 1 uncommitted file.")).toBeTruthy();
    expect(screen.getByText(/1 could not be deleted and was kept/)).toBeTruthy();
  });
});
