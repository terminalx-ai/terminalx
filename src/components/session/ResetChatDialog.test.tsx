import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reset: vi.fn(), reload: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({ agent: { resetChat: mocks.reset }, errorMessage: String }));
vi.mock("@/lib/agentEvents", () => ({ reloadTabHistory: mocks.reload }));
vi.mock("@/lib/sessions", () => ({ refreshSessions: mocks.refresh }));
import { ResetChatDialog, overlapPaths } from "./ResetChatDialog";
import { getPrefs, setPrefs } from "@/lib/prefs";
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); setPrefs({ resetFiles: false }); mocks.reset.mockResolvedValue(null); mocks.reload.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue(undefined); });
function show(endSeq: number | null = 9) {
  const onClose = vi.fn(), onWarning = vi.fn();
  render(<ResetChatDialog sessionId="s" tabId="t" endSeq={endSeq} onClose={onClose} onWarning={onWarning} />);
  return { onClose, onWarning };
}
it("confirms the selected turn and leaves files alone by default", async () => {
  const { onClose } = show();
  expect((screen.getByRole("checkbox", { name: "Also reset files" }) as HTMLInputElement).checked).toBe(false);
  expect(mocks.reset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", 9, false);
  expect(mocks.reload).toHaveBeenCalledWith("s", "t");
});
it("resets files when checked and remembers the choice for next time", async () => {
  const { onClose } = show();
  fireEvent.click(screen.getByRole("checkbox", { name: "Also reset files" }));
  expect(getPrefs().resetFiles).toBe(true);
  expect(screen.getByText(/go back to how they were when it ended/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", 9, true);
  cleanup();
  show(4);
  expect((screen.getByRole("checkbox", { name: "Also reset files" }) as HTMLInputElement).checked).toBe(true);
});
it("warns about files other chats changed and resets anyway on confirmation", async () => {
  setPrefs({ resetFiles: true });
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["src/a.ts","b [1].txt"]. Resetting files removes those changes too.');
  const { onClose } = show();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("2 files were changed by another chat or by hand");
  expect(alert.textContent).toContain("src/a.ts");
  expect(alert.textContent).toContain("b [1].txt");
  expect(onClose).not.toHaveBeenCalled();
  expect(mocks.reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reset anyway" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenNthCalledWith(2, "s", "t", 9, true);
});
it("Cancel after the overlap warning changes nothing", async () => {
  setPrefs({ resetFiles: true });
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["a.txt"]. Resetting files removes those changes too.');
  const { onClose } = show();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This file was changed");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(mocks.reset).toHaveBeenCalledOnce();
});
it("undo says the restored files go back and confirms an overlap the same way", async () => {
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["a.txt"]. Undoing the reset removes those changes too.');
  const onClose = vi.fn();
  render(<ResetChatDialog sessionId="s" tabId="t" endSeq={null} filesRestored={3} onClose={onClose} onWarning={vi.fn()} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/The 3 files it restored go back to how they were before the reset/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
  expect((await screen.findByRole("alert")).textContent).toContain("since the reset");
  fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenNthCalledWith(2, "s", "t", null, false);
});
it("reads the paths out of an overlap refusal only", () => {
  expect(overlapPaths('Error: Other changes to these files would be overwritten: ["x.txt"]. Resetting files removes those changes too.')).toEqual(["x.txt"]);
  expect(overlapPaths("Files changed during reset. Nothing was reset; try again.")).toBeNull();
  expect(overlapPaths("Other changes to these files would be overwritten: not json")).toBeNull();
});
it("keeps format errors in the dialog without replacing history", async () => {
  mocks.reset.mockRejectedValue("Unknown transcript format");
  const { onClose } = show();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Unknown transcript format");
  expect(mocks.reload).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
it("confirms undo and cannot repeat a committed reset after a refresh failure", async () => {
  mocks.reload.mockRejectedValue(new Error("disconnected"));
  const { onClose, onWarning } = show(null);
  fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", null, false);
  expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("Chat reset"));
});
