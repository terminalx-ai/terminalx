import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiscardDialog } from "./DiscardDialog";
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
