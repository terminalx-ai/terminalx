import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), off: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({ errorMessage: (e: unknown) => String(e) }));
import { TranscriptionNoiseGuard } from "./TranscriptionNoiseGuard";
let event: (value: { payload: Record<string, unknown> }) => void;
const model = { id: "silero-vad-v6.2", name: "Silero speech detector", license: "MIT", sizeBytes: 1241056, installed: false, downloading: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue(model);
  mocks.listen.mockImplementation(async (_name, callback) => { event = callback; return mocks.off; });
});
afterEach(cleanup);
it("requires an explicit download and displays failures without enabling detection", async () => {
  render(<TranscriptionNoiseGuard />);
  const button = await screen.findByRole("button", { name: "Download speech detector" });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith("transcription_detector");
  fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_download", { id: model.id }));
  act(() => event({ payload: { id: model.id, received: 0, done: false, error: "checksum did not match" } }));
  expect((await screen.findByRole("alert")).textContent).toContain("checksum did not match");
  expect(mocks.invoke.mock.calls.some(([name]) => name === "transcription_personalization_save")).toBe(false);
});
it("shows deletion only after installation and ignores other model events", async () => {
  mocks.invoke.mockResolvedValue({ ...model, installed: true });
  render(<TranscriptionNoiseGuard />);
  const button = await screen.findByRole("button", { name: "Delete speech detector" });
  act(() => event({ payload: { id: "whisper-small", error: "unrelated" } }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_delete", { id: model.id }));
});
