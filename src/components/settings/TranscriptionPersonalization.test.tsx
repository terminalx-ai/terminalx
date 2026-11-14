import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptionDiagnostic, TranscriptionPersonalizationData } from "@/lib/transcriptionPersonalization";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), start: vi.fn(), stop: vi.fn(), listen: vi.fn(), off: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/api", () => ({ errorMessage: (e: unknown) => String(e) }));
vi.mock("@/lib/dictation", () => ({ startDictation: mocks.start, stopDictation: mocks.stop, useDictation: () => ({ phase: "idle", target: null, error: null }) }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ projects: [{ path: "/project", name: "Project" }], sessions: [] }) }));
import { TranscriptionPersonalization } from "./TranscriptionPersonalization";

let diagnostic: (event: { payload: TranscriptionDiagnostic }) => void;
const initial = (): TranscriptionPersonalizationData => ({ options: { context: false, project: false, session: false, terminal: false, composer: false, remoteContext: false, dictionary: false, replacements: false, snippets: false, learn: false, guards: false, noiseGuard: false, retakes: false, normalize: false, code: false, fillers: false, language: null, sensitiveTargets: [] }, entries: [] });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation(async (event, callback) => { if (event === "transcription_diagnostic") diagnostic = callback; return mocks.off; });
  mocks.invoke.mockImplementation(async (command, args) => command === "transcription_personalization_save" ? args.data : initial());
});
afterEach(cleanup);

it("saves a scoped dictionary spelling through the local store", async () => {
  render(<TranscriptionPersonalization />);
  fireEvent.click(await screen.findByRole("button", { name: "Add term" }));
  fireEvent.change(screen.getByLabelText("Written term"), { target: { value: "TerminalX" } });
  fireEvent.change(screen.getByLabelText("Sounds like (one spelling per line)"), { target: { value: "terminal ex" } });
  fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "/project" } });
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_personalization_save", { data: { ...initial(), entries: [expect.objectContaining({ kind: "vocabulary", heard: "", written: "TerminalX", soundsLike: ["terminal ex"], project: "/project" })] } }));
  expect(await screen.findByText("TerminalX")).toBeTruthy();
});

it("keeps failed saves visible and leaves the last saved setting intact", async () => {
  render(<TranscriptionPersonalization />);
  const control = await screen.findByRole("switch", { name: "Use context from TerminalX" });
  mocks.invoke.mockRejectedValueOnce(new Error("Store unavailable"));
  fireEvent.click(control);
  expect((await screen.findByRole("alert")).textContent).toContain("Store unavailable");
  expect(control.getAttribute("aria-checked")).toBe("false");
});

it("starts real dictation and displays only diagnostic-target events", async () => {
  const { unmount } = render(<TranscriptionPersonalization />);
  const start = await screen.findByRole("button", { name: "Start test" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  expect(mocks.start).toHaveBeenCalledWith("transcription-test", { target: "transcription-test", project: null, coding: true, remote: false, sensitive: false, projectTerms: [], session: [], terminal: [], composer: "" });
  act(() => diagnostic({ payload: { raw: "private other transcript", finalText: "unrelated", biasTerms: [], engine: "Apple", target: "other-tab" } }));
  expect(screen.queryByText("private other transcript")).toBeNull();
  act(() => diagnostic({ payload: { raw: "terminal ex", finalText: "TerminalX", biasTerms: ["TerminalX"], engine: "Apple", target: "transcription-test" } }));
  expect(screen.getByText("terminal ex")).toBeTruthy();
  expect(screen.getByText("TerminalX")).toBeTruthy();
  expect(screen.getByText("Bias terms: TerminalX")).toBeTruthy();
  unmount();
  expect(mocks.off).toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
});

it("only reads project names with context enabled and passes them to the diagnostic", async () => {
  render(<TranscriptionPersonalization />);
  fireEvent.change(await screen.findByLabelText("Test project"), { target: { value: "/project" } });
  expect(mocks.invoke).not.toHaveBeenCalledWith("transcription_project_terms", expect.anything());
  mocks.invoke.mockImplementation(async (command, args) => command === "transcription_project_terms" ? ["TranscriptionTab.tsx"] : command === "transcription_personalization_save" ? args.data : initial());
  fireEvent.click(screen.getByRole("switch", { name: "Use context from TerminalX" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Use context from TerminalX" }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(screen.getByRole("switch", { name: "Project file names and branch" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_project_terms", { cwd: "/project" }));
  const start = screen.getByRole("button", { name: "Start test" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  expect(mocks.start).toHaveBeenCalledWith("transcription-test", expect.objectContaining({ project: "/project", projectTerms: ["TranscriptionTab.tsx"] }));
});

it("clears diagnostic content on reset and ignores delayed results", async () => {
  render(<TranscriptionPersonalization />);
  const start = await screen.findByRole("button", { name: "Start test" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  const payload = { raw: "old recording", finalText: "old result", biasTerms: [], engine: "Apple", target: "transcription-test" };
  act(() => diagnostic({ payload }));
  expect(screen.getByText("old recording")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset all personalisation data" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset everything" }));
  await waitFor(() => expect(screen.queryByText("old recording")).toBeNull());
  act(() => diagnostic({ payload }));
  expect(screen.queryByText("old recording")).toBeNull();
});

it("reloads after a revision conflict without losing the entry being edited", async () => {
  render(<TranscriptionPersonalization />);
  fireEvent.click(await screen.findByRole("button", { name: "Add term" }));
  fireEvent.change(screen.getByLabelText("Written term"), { target: { value: "TerminalX" } });
  mocks.invoke.mockRejectedValueOnce(new Error("Personalization changed; reload before saving"));
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await screen.findByRole("alert");
  mocks.invoke.mockResolvedValueOnce({ ...initial(), revision: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect((screen.getByLabelText("Written term") as HTMLTextAreaElement).value).toBe("TerminalX");
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("transcription_personalization_save", { data: expect.objectContaining({ revision: 2, entries: [expect.objectContaining({ written: "TerminalX" })] }) }));
});

it("imports entries against the current store revision instead of the exported revision", async () => {
  mocks.invoke.mockResolvedValueOnce({ ...initial(), revision: 5 });
  const { container } = render(<TranscriptionPersonalization />);
  await screen.findByRole("button", { name: "Import JSON" });
  const file = new File(["{}"], "personalization.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => JSON.stringify({ ...initial(), revision: 20 }) });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_personalization_save", { data: { ...initial(), revision: 5 } }));
});

it("does not write an export when the native save dialog is cancelled", async () => {
  mocks.save.mockResolvedValueOnce(null);
  render(<TranscriptionPersonalization />);
  fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.invoke).not.toHaveBeenCalledWith("transcription_personalization_export", expect.anything());
});

it("exports to the path chosen in the native save dialog", async () => {
  mocks.save.mockResolvedValueOnce("/tmp/chosen-transcription.json");
  render(<TranscriptionPersonalization />);
  fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("transcription_personalization_export", { path: "/tmp/chosen-transcription.json" }));
});

it("shows native export errors and makes retry available", async () => {
  mocks.save.mockResolvedValueOnce("/tmp/chosen-transcription.json");
  render(<TranscriptionPersonalization />);
  const button = await screen.findByRole("button", { name: "Export JSON" });
  mocks.invoke.mockRejectedValueOnce(new Error("Export destination is not writable"));
  fireEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).toContain("Export destination is not writable");
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
