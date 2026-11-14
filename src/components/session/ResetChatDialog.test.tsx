import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reset: vi.fn(), reload: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({ agent: { resetChat: mocks.reset }, errorMessage: String }));
vi.mock("@/lib/agentEvents", () => ({ reloadTabHistory: mocks.reload }));
vi.mock("@/lib/sessions", () => ({ refreshSessions: mocks.refresh }));
import { ResetChatDialog } from "./ResetChatDialog";
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.reset.mockResolvedValue(null); mocks.reload.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue(undefined); });
function show(endSeq: number | null = 9) {
  const onClose = vi.fn(), onWarning = vi.fn();
  render(<ResetChatDialog sessionId="s" tabId="t" endSeq={endSeq} onClose={onClose} onWarning={onWarning} />);
  return { onClose, onWarning };
}
it("confirms the selected turn with file restore unavailable", async () => {
  const { onClose } = show();
  expect((screen.getByRole("checkbox", { name: "Also reset files" }) as HTMLInputElement).disabled).toBe(true);
  expect(mocks.reset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.reset).toHaveBeenCalledWith("s", "t", 9, false);
  expect(mocks.reload).toHaveBeenCalledWith("s", "t");
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
