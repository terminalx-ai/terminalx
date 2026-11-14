import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reset: vi.fn(), reload: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({ agent: { resetChat: mocks.reset }, errorMessage: String }));
vi.mock("@/lib/agentEvents", () => ({ reloadTabHistory: mocks.reload }));
vi.mock("@/lib/sessions", () => ({ refreshSessions: mocks.refresh }));
import { ResetChatDialog, overlapRefusal } from "./ResetChatDialog";
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
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", 9, false, null);
  expect(mocks.reload).toHaveBeenCalledWith("s", "t");
});
it("resets files when checked and remembers the choice for next time", async () => {
  const { onClose } = show();
  fireEvent.click(screen.getByRole("checkbox", { name: "Also reset files" }));
  expect(getPrefs().resetFiles).toBe(true);
  expect(screen.getByText(/go back to how they were when it ended/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", 9, true, null);
  cleanup();
  show(4);
  expect((screen.getByRole("checkbox", { name: "Also reset files" }) as HTMLInputElement).checked).toBe(true);
});
it("warns about files other chats changed and resets anyway on confirmation", async () => {
  setPrefs({ resetFiles: true });
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["src/a.ts","b [1].txt"]. Resetting files removes those changes too. Confirm: reset:e:i:n:x');
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
  expect(mocks.reset).toHaveBeenNthCalledWith(1, "s", "t", 9, true, null);
  expect(mocks.reset).toHaveBeenNthCalledWith(2, "s", "t", 9, true, "reset:e:i:n:x");
});
it("Cancel after the overlap warning changes nothing, and a later plain reset sends no confirmation", async () => {
  setPrefs({ resetFiles: true });
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["a.txt"]. Resetting files removes those changes too. Confirm: reset:shown');
  const { onClose } = show();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This file was changed");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(mocks.reset).toHaveBeenCalledOnce();
  cleanup();
  show();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(2));
  expect(mocks.reset).toHaveBeenLastCalledWith("s", "t", 9, true, null);
});
it("a changed choice drops the shown confirmation", async () => {
  setPrefs({ resetFiles: true });
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["a.txt"]. Resetting files removes those changes too. Confirm: reset:shown');
  show();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("checkbox", { name: "Also reset files" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Also reset files" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(2));
  expect(mocks.reset).toHaveBeenLastCalledWith("s", "t", 9, true, null);
});
it("undo says the restored files go back and confirms an overlap the same way", async () => {
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["a.txt"]. Undoing the reset removes those changes too. Confirm: undo-reset:t');
  const onClose = vi.fn();
  render(<ResetChatDialog sessionId="s" tabId="t" endSeq={null} filesRestored={3} onClose={onClose} onWarning={vi.fn()} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/The 3 files it restored go back to how they were before the reset/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
  expect((await screen.findByRole("alert")).textContent).toContain("since the reset");
  fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenNthCalledWith(2, "s", "t", null, false, "undo-reset:t");
});
it("undo shows the overlap list even when this window has no restored-file count", async () => {
  mocks.reset.mockRejectedValueOnce('Other changes to these files would be overwritten: ["a.txt"]. Undoing the reset removes those changes too. Confirm: undo-reset:t');
  const onClose = vi.fn();
  render(<ResetChatDialog sessionId="s" tabId="t" endSeq={null} filesRestored={0} onClose={onClose} onWarning={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Undo reset" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("a.txt");
  expect(alert.textContent).not.toContain("Confirm:");
  fireEvent.click(screen.getByRole("button", { name: "Undo anyway" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenNthCalledWith(2, "s", "t", null, false, "undo-reset:t");
});
it("reads the paths and token out of an overlap refusal only", () => {
  expect(overlapRefusal('Error: Other changes to these files would be overwritten: ["x.txt"]. Resetting files removes those changes too. Confirm: reset:a:b:c:d')).toEqual({ paths: ["x.txt"], token: "reset:a:b:c:d" });
  expect(overlapRefusal("Files changed during reset. Nothing was reset; try again.")).toBeNull();
  expect(overlapRefusal("Other changes to these files would be overwritten: not json. Confirm: x")).toBeNull();
  expect(overlapRefusal('Other changes to these files would be overwritten: ["x.txt"]. No token here.')).toBeNull();
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
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", null, false, null);
  expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("Chat reset"));
});
