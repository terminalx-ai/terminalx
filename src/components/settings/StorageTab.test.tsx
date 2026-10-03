import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Leftover } from "@/types/session";

const ask = vi.fn();
const scanLeftovers = vi.fn();
const removeLeftovers = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...args: unknown[]) => ask(...args) }));
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
    ask.mockReset();
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

  it("deletes nothing when the confirmation is declined", async () => {
    ask.mockResolvedValue(false);
    render(<StorageTab />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("they are not moved to the Trash");
    expect(removeLeftovers).not.toHaveBeenCalled();
  });

  it("deletes only the confirmed, removable rows and reports what was freed", async () => {
    ask.mockResolvedValue(true);
    removeLeftovers.mockResolvedValue({ removed: [clean.id, transcripts.id], failed: [], freedBytes: 2_518_000_000 });
    render(<StorageTab />);
    await screen.findByText("quiet-amber-fox");
    fireEvent.click(screen.getByRole("button", { name: "Select all removable" }));
    scanLeftovers.mockResolvedValue([unsaved]);
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    await waitFor(() => expect(removeLeftovers).toHaveBeenCalledWith([clean.id, transcripts.id]));
    expect(await screen.findByText("Deleted 2 items and freed 2.5 GB.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("quiet-amber-fox")).toBeNull());
    expect(screen.getByText("dirty-red-owl")).toBeTruthy();
  });

  it("shows why something could not be deleted", async () => {
    ask.mockResolvedValue(true);
    removeLeftovers.mockResolvedValue({ removed: [], failed: [{ id: clean.id, error: "Has 1 uncommitted file." }], freedBytes: 0 });
    render(<StorageTab />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    expect(await screen.findByText("Kept: Has 1 uncommitted file.")).toBeTruthy();
    expect(screen.getByText(/1 could not be deleted and was kept/)).toBeTruthy();
  });
});
