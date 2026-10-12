import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Leftover, LeftoverProgress, LeftoverRemoval } from "@/types/session";

const scanLeftovers = vi.fn();
const removeLeftovers = vi.fn();
/** The backend's progress events, as the removal that is listening hears them. */
const events = { run: null as string | null, listener: null as ((progress: LeftoverProgress) => void) | null };
const emit = (progress: LeftoverProgress) => act(() => void events.listener?.(progress));

vi.mock("@/lib/api", () => ({
  api: {
    scanLeftovers: () => scanLeftovers(),
    removeLeftovers: (ids: string[], run: string) => {
      events.run = run;
      return removeLeftovers(ids);
    },
    onLeftoverProgress: async (run: string, onProgress: (progress: LeftoverProgress) => void) => {
      events.listener = (progress) => events.run === run && onProgress(progress);
      return () => (events.listener = null);
    },
    setQuitWarning: async () => undefined,
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { resetLeftoverRun } from "@/lib/leftoverRun";
import { StorageTab } from "./StorageTab";

const base = { projectPath: "/p", projectName: "terminalx", agent: null, keptBecause: null };
const clean: Leftover = { ...base, id: "worktree:/p:quiet-amber-fox", kind: "worktree", name: "quiet-amber-fox", paths: ["/p/.raccoon/worktrees/quiet-amber-fox"], sizeBytes: 2_500_000_000 };
const unsaved: Leftover = { ...base, id: "worktree:/p:dirty-red-owl", kind: "worktree", name: "dirty-red-owl", paths: ["/p/.raccoon/worktrees/dirty-red-owl"], sizeBytes: 40_000_000, keptBecause: "2 uncommitted files would be lost." };
const transcripts: Leftover = { ...base, id: "claude:-p--raccoon-worktrees-gone", kind: "agentData", name: "gone", agent: "Claude", paths: ["/h/.claude/projects/-p--raccoon-worktrees-gone"], sizeBytes: 18_000_000 };

describe("StorageTab", () => {
  afterEach(() => {
    cleanup();
    act(() => resetLeftoverRun());
  });
  beforeEach(() => {
    events.run = events.listener = null;
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

  it("shows how far a deletion is while it runs, and still does after Settings was left and opened again", async () => {
    let answer!: (removal: LeftoverRemoval) => void;
    removeLeftovers.mockImplementation(() => new Promise<LeftoverRemoval>((resolve) => (answer = resolve)));
    const first = render(<StorageTab />);
    await screen.findByText("quiet-amber-fox");
    fireEvent.click(screen.getByRole("button", { name: "Select all removable" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 items" }));
    await waitFor(() => expect(removeLeftovers).toHaveBeenCalledTimes(1));

    // First everything is looked at again, and that is said rather than only spun.
    const bar = () => screen.getByRole("progressbar", { name: "Leftovers deleted" });
    expect(bar().getAttribute("aria-valuetext")).toBe("0 of 2 done");
    expect(screen.getByText("Checking everything again before anything is deleted…")).toBeTruthy();
    // Nothing else can be started meanwhile.
    for (const name of ["Scan again", "Select all removable", /Delete selected/]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);

    emit({ kind: "checking", total: 2 });
    emit({ kind: "started", index: 0, total: 2, id: clean.id });
    expect(screen.getByText("Deleting quiet-amber-fox…")).toBeTruthy();
    emit({ kind: "finished", index: 0, total: 2, id: clean.id, freedBytes: 2_500_000_000, error: null });
    emit({ kind: "started", index: 1, total: 2, id: transcripts.id });
    expect(bar().getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
    expect(screen.getByText("2.5 GB freed so far")).toBeTruthy();
    expect(screen.getByText("1 deleted · 0 kept")).toBeTruthy();
    expect(screen.getByText("Deleting Claude data · gone…")).toBeTruthy();

    // Settings is left and opened again while it runs: the run was never the tab's.
    first.unmount();
    const scans = scanLeftovers.mock.calls.length;
    render(<StorageTab />);
    expect(bar().getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText("Deleting Claude data · gone…")).toBeTruthy();
    // The list is not read while it is being changed.
    expect(scanLeftovers).toHaveBeenCalledTimes(scans);
    expect(removeLeftovers).toHaveBeenCalledTimes(1);

    scanLeftovers.mockResolvedValue([unsaved]);
    emit({ kind: "finished", index: 1, total: 2, id: transcripts.id, freedBytes: 0, error: "This is no longer a leftover; it was not deleted." });
    await act(async () => answer({ removed: [clean.id], failed: [{ id: transcripts.id, error: "This is no longer a leftover; it was not deleted." }], freedBytes: 2_500_000_000 }));
    expect(await screen.findByText("Deleted 1 item and freed 2.5 GB. 1 could not be deleted and was kept.")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    // Now it is read again, once.
    await waitFor(() => expect(scanLeftovers).toHaveBeenCalledTimes(scans + 1));
    expect(await screen.findByText("dirty-red-owl")).toBeTruthy();
  });

  it("keeps a result on screen while the tab is open, as the app mounts it, and opens clean the next time", async () => {
    removeLeftovers.mockResolvedValue({ removed: [clean.id], failed: [], freedBytes: 2_500_000_000 });
    const first = render(
      <StrictMode>
        <StorageTab />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 item" }));
    expect(await screen.findByText("Deleted 1 item and freed 2.5 GB.")).toBeTruthy();
    // It was read here, so leaving Settings is the end of it.
    first.unmount();
    await act(async () => undefined);
    render(
      <StrictMode>
        <StorageTab />
      </StrictMode>,
    );
    await screen.findByText("quiet-amber-fox");
    expect(screen.queryByText(/^Deleted/)).toBeNull();
  });

  it("says so when the whole deletion failed", async () => {
    removeLeftovers.mockRejectedValue(new Error("the project list could not be read"));
    render(<StorageTab />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /quiet-amber-fox/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1 item" }));
    expect((await screen.findByRole("alert")).textContent).toBe("the project list could not be read");
    expect(screen.queryByText(/^Deleted/)).toBeNull();
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
