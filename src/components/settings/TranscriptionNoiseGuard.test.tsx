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
const model = { id: "silero-vad-v6.2", name: "Silero speech detector", license: "MIT", sizeBytes: 1241056, installed: false, readiness: "missing", downloading: false };
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
  mocks.invoke.mockResolvedValue({ ...model, installed: true, readiness: "verifiedFile" });
  render(<TranscriptionNoiseGuard />);
  const button = await screen.findByRole("button", { name: "Delete speech detector" });
  act(() => event({ payload: { id: "whisper-small", error: "unrelated" } }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_delete", { id: model.id }));
});

it("offers explicit reinstall for invalid bytes even when an old installed flag is true", async () => {
  mocks.invoke.mockResolvedValue({ ...model, installed: true, readiness: "invalid" });
  render(<TranscriptionNoiseGuard />);
  const button = await screen.findByRole("button", { name: "Reinstall speech detector" });
  expect(screen.getByRole("status").textContent).toBe("Detector file invalid");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Delete speech detector" })).toBeNull();
  mocks.invoke.mockResolvedValue({ ...model, installed: true, readiness: "verifiedFile" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_download", { id: model.id }));
  await screen.findByRole("button", { name: "Delete speech detector" });
  expect(screen.getByRole("status").textContent).toBe("Detector file verified");
  expect(screen.getByText(/does not confirm native loading or speech detection/)).toBeTruthy();
});
it("keeps verification errors distinct from missing files and retries without downloading", async () => {
  mocks.invoke.mockResolvedValue({ ...model, readiness: "error" });
  render(<TranscriptionNoiseGuard />);
  const button = await screen.findByRole("button", { name: "Retry file verification" });
  expect(screen.getByRole("status").textContent).toContain("could not be verified");
  expect(screen.queryByRole("button", { name: "Download speech detector" })).toBeNull();
  mocks.invoke.mockResolvedValue(model);
  fireEvent.click(button);
  await screen.findByRole("button", { name: "Download speech detector" });
  expect(mocks.invoke.mock.calls.every(([name]) => name === "transcription_detector")).toBe(true);
});
it("shows cancellation during recovery and retains an invalid status after cancellation", async () => {
  mocks.invoke.mockResolvedValue({ ...model, readiness: "invalid", downloading: true });
  render(<TranscriptionNoiseGuard />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel detector download" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_cancel_download", { id: model.id }));
  mocks.invoke.mockResolvedValue({ ...model, readiness: "invalid" });
  act(() => event({ payload: { id: model.id, done: false, error: "download cancelled" } }));
  await screen.findByRole("button", { name: "Reinstall speech detector" });
  expect(screen.getByRole("alert").textContent).toContain("download cancelled");
});
