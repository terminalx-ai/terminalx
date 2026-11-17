import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiscardDialog, discardSummary } from "./DiscardDialog";
import type { GitSource } from "@/lib/gitSource";

afterEach(cleanup);
it("discards only after confirmation using the displayed base and both rename paths", async () => {
  const discard = vi.fn().mockResolvedValue(undefined);
  const source = { discard, errorMessage: String } as unknown as GitSource;
  const onClose = vi.fn(), onDiscarded = vi.fn();
  render(<DiscardDialog source={source} file={{ path: "new.ts", oldPath: "old.ts" }} base="start-tree" onClose={onClose} onDiscarded={onDiscarded} />);
  expect(discard).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
  await vi.waitFor(() => expect(onDiscarded).toHaveBeenCalledOnce());
  expect(discard).toHaveBeenCalledWith("new.ts", "start-tree", "old.ts");
  expect(onClose).toHaveBeenCalledOnce();
});
it("reports failures without closing the dialog", async () => {
  const discard = vi.fn().mockRejectedValue(new Error("Cannot replace directory"));
  const onClose = vi.fn();
  render(<DiscardDialog source={{ discard, errorMessage: String } as unknown as GitSource} file={{ path: "folder" }} onClose={onClose} onDiscarded={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Cannot replace directory");
  expect(onClose).not.toHaveBeenCalled();
});

// PRO-400, design 17.01: the dialog names the file and says how many lines go back, and where to.
it("names the file and counts the lines that go back", () => {
  render(<DiscardDialog source={{ discard: vi.fn(), errorMessage: String } as unknown as GitSource} file={{ path: "src/slug.js", status: "modified", additions: 4, deletions: 1 }} onClose={vi.fn()} onDiscarded={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Discard changes to src/slug.js?" });
  expect(dialog.textContent).toContain("4 added and 1 removed line go back to the last commit. This can’t be undone.");
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Discard"]);
  expect(within(dialog).getByRole("button", { name: "Discard" }).className).toContain("bg-destructive");
});
it("says what goes back for each kind of change, with the counts it has", () => {
  expect(discardSummary({ path: "a.ts", additions: 1, deletions: 0 })).toBe("1 added line goes back to the last commit. This can’t be undone.");
  expect(discardSummary({ path: "a.ts", additions: 0, deletions: 12 })).toBe("12 removed lines go back to the last commit. This can’t be undone.");
  expect(discardSummary({ path: "a.ts", additions: 3, deletions: 2 }, "start-tree")).toBe("3 added and 2 removed lines go back to the comparison’s starting version. This can’t be undone.");
  // No counts (a binary file, the file tree, an older runtime): said without them, staged changes included.
  expect(discardSummary({ path: "logo.png" })).toBe("Its changes, staged ones included, go back to the last commit. This can’t be undone.");
  // What the counts do not say: a new file is deleted, and a rename is undone.
  expect(discardSummary({ path: "new.ts", status: "added", additions: 9, deletions: 0 })).toBe("9 added lines go back to the last commit. The file is not in that version, so it is deleted. This can’t be undone.");
  expect(discardSummary({ path: "new.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1 })).toBe("1 added and 1 removed line go back to the last commit. It goes back to old.ts. This can’t be undone.");
});
