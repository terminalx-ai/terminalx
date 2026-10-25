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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const verified = { ...model, installed: true, readiness: "verifiedFile" };
const invalid = { ...model, readiness: "invalid" };

it.each(["invalid", "downloading", "rejection"])("keeps newer recovery verification after an older %s response", async (late) => {
  const older = deferred<typeof model>();
  const newer = deferred<typeof model>();
  const statuses = [Promise.resolve(invalid), older.promise, newer.promise];
  mocks.invoke.mockImplementation((command) => command === "transcription_detector" ? statuses.shift() : Promise.resolve());
  render(<TranscriptionNoiseGuard />);
  fireEvent.click(await screen.findByRole("button", { name: "Reinstall speech detector" }));
  await waitFor(() => expect(statuses).toHaveLength(1));
  act(() => event({ payload: { id: model.id, done: true } }));
  await act(async () => { newer.resolve(verified); });
  await screen.findByRole("button", { name: "Delete speech detector" });
  await act(async () => {
    if (late === "rejection") older.reject(new Error("obsolete verification error"));
    else older.resolve({ ...invalid, downloading: late === "downloading" });
  });
  expect(screen.getByRole("status").textContent).toBe("Detector file verified");
  expect(screen.getByRole("button", { name: "Delete speech detector" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel detector download" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["missing", "invalid", "error"])("does not let an older verified response hide newer %s after deletion", async (readiness) => {
  const older = deferred<typeof model>();
  const newer = deferred<typeof model>();
  const statuses = [Promise.resolve(verified), older.promise, newer.promise];
  mocks.invoke.mockImplementation((command) => command === "transcription_detector" ? statuses.shift() : Promise.resolve());
  render(<TranscriptionNoiseGuard />);
  await screen.findByRole("button", { name: "Delete speech detector" });
  // An event inspection is still in flight when the user deletes the file.
  act(() => event({ payload: { id: model.id, done: true } }));
  fireEvent.click(screen.getByRole("button", { name: "Delete speech detector" }));
  await waitFor(() => expect(statuses).toHaveLength(0));
  await act(async () => { newer.resolve({ ...model, readiness }); });
  await act(async () => { older.resolve(verified); });
  const label = readiness === "missing" ? "Download speech detector" : readiness === "invalid" ? "Reinstall speech detector" : "Retry file verification";
  expect(screen.getByRole("button", { name: label })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete speech detector" })).toBeNull();
});

it("invalidates an in-flight verification on progress before completion", async () => {
  const older = deferred<typeof model>();
  mocks.invoke.mockResolvedValueOnce(invalid).mockResolvedValueOnce(undefined).mockImplementationOnce(() => older.promise);
  render(<TranscriptionNoiseGuard />);
  fireEvent.click(await screen.findByRole("button", { name: "Reinstall speech detector" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
  act(() => event({ payload: { id: model.id, received: 42, done: false } }));
  await act(async () => { older.resolve(verified); });
  expect(screen.getByRole("button", { name: "Cancel detector download" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete speech detector" })).toBeNull();
});

it.each(["resolve", "reject"])("ignores a late command %s after a completion event owns verification", async (settle) => {
  const command = deferred<void>();
  const newer = deferred<typeof model>();
  const statuses = [Promise.resolve(invalid), newer.promise];
  mocks.invoke.mockImplementation((name) => name === "transcription_detector" ? statuses.shift() : command.promise);
  render(<TranscriptionNoiseGuard />);
  fireEvent.click(await screen.findByRole("button", { name: "Reinstall speech detector" }));
  act(() => event({ payload: { id: model.id, done: true } }));
  await act(async () => { newer.resolve(verified); });
  await act(async () => {
    if (settle === "resolve") command.resolve(); else command.reject(new Error("obsolete command error"));
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: "Delete speech detector" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a newer verification failure visible when an older verified response arrives", async () => {
  const older = deferred<typeof model>();
  const newer = deferred<typeof model>();
  const statuses = [Promise.resolve(invalid), older.promise, newer.promise];
  mocks.invoke.mockImplementation((name) => name === "transcription_detector" ? statuses.shift() : Promise.resolve());
  render(<TranscriptionNoiseGuard />);
  fireEvent.click(await screen.findByRole("button", { name: "Reinstall speech detector" }));
  await waitFor(() => expect(statuses).toHaveLength(1));
  act(() => event({ payload: { id: model.id, done: true } }));
  await act(async () => { newer.reject(new Error("current verification failed")); });
  await act(async () => { older.resolve(verified); });
  expect(screen.getByRole("alert").textContent).toContain("current verification failed");
  expect(screen.queryByRole("button", { name: "Delete speech detector" })).toBeNull();
});

it.each([false, true])("hydrates pending first metadata (downloading=%s) with current progress and permits cancel before completion", async (downloading) => {
  const first = deferred<typeof model>();
  mocks.invoke.mockResolvedValueOnce(first.promise).mockResolvedValue(model);
  render(<TranscriptionNoiseGuard />);
  await waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
  act(() => {
    event({ payload: { id: model.id, received: 124106, done: false } });
    event({ payload: { id: model.id, received: 620528, done: false } });
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  // The snapshot predates the latest progress, even if it already says active.
  await act(async () => { first.resolve({ ...model, downloading }); });
  const cancel = screen.getByRole("button", { name: "Cancel detector download" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  expect(screen.getByText("50%")).toBeTruthy();
  act(() => event({ payload: { id: model.id, received: 930792, done: false } }));
  expect(screen.getByText("75%")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(cancel);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_cancel_download", { id: model.id }));
});

it.each(["resolve", "reject"])("fences initial hydration %s after terminal completion owns the status", async (settle) => {
  const first = deferred<typeof model>();
  const completed = deferred<typeof model>();
  mocks.invoke.mockResolvedValueOnce(first.promise).mockResolvedValueOnce(completed.promise);
  render(<TranscriptionNoiseGuard />);
  await waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
  act(() => {
    event({ payload: { id: model.id, received: 100, done: false } });
    event({ payload: { id: model.id, done: true } });
  });
  await act(async () => { completed.resolve(verified); });
  await act(async () => {
    if (settle === "resolve") first.resolve({ ...invalid, downloading: true });
    else first.reject(new Error("obsolete hydration failure"));
  });
  expect(screen.getByRole("button", { name: "Delete speech detector" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel detector download" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("discards pending hydration and late progress after unmount", async () => {
  const first = deferred<typeof model>();
  mocks.invoke.mockResolvedValueOnce(first.promise);
  const view = render(<TranscriptionNoiseGuard />);
  await waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(1));
  act(() => event({ payload: { id: model.id, received: 100, done: false } }));
  view.unmount();
  act(() => event({ payload: { id: model.id, received: 200, done: false } }));
  await act(async () => { first.resolve({ ...model, downloading: true }); });
  expect(mocks.off).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Cancel detector download" })).toBeNull();
});
