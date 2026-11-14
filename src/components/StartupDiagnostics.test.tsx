import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StartupDiagnostics } from "./StartupDiagnostics";
import type { StartupSnapshot } from "@/lib/startupDiagnostics";

const mocks = vi.hoisted(() => ({ status: vi.fn(), policy: vi.fn(), probe: vi.fn(), preview: vi.fn(), export: vi.fn(), save: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/lib/startupDiagnostics", () => ({ startupDiagnostics: mocks, OPEN_STARTUP_DIAGNOSTICS: "open-startup-diagnostics" }));
vi.mock("@/lib/api", () => ({ errorMessage: String }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const state: StartupSnapshot = {
  policy: { suspectAfterSeconds: 120, escalateAfterSeconds: 300 },
  launches: [{ id: "child", pane: "tab:a", pid: 42, category: "agent", evidence: "readiness", phase: "awaitingReady", startedAt: 0, lastProgressAt: 0, exitCode: null }],
  incidents: [{ id: "incident", detectedAt: 120_000, escalatedAt: 420_000, recoveredAt: null, launches: ["child"], blockedPipelines: ["pipeline"], probe: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue(state);
  mocks.preview.mockResolvedValue({ id: "frozen-preview", content: '{"incidentId":"incident"}' });
  mocks.export.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue("/chosen/report.json");
});
afterEach(cleanup);

async function open() {
  render(<StartupDiagnostics />);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect incident" }));
}

it("shows one actionable host incident and waits for preview and explicit local destination consent", async () => {
  await open();
  expect(screen.getByText("Incident incident")).toBeTruthy();
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.export).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview redacted report" }));
  expect(await screen.findByLabelText("Report preview")).toBeTruthy();
  const save = screen.getByRole("button", { name: "Choose destination and save" });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(save);
  await waitFor(() => expect(mocks.export).toHaveBeenCalledWith("frozen-preview", "/chosen/report.json"));
  expect(mocks.openUrl).not.toHaveBeenCalled();
  expect(await screen.findByText("Report saved locally. Nothing has been uploaded.")).toBeTruthy();
});

it("keeps a timed-out recorder visibly pending and does not offer a duplicate probe", async () => {
  mocks.status.mockResolvedValue({ ...state, incidents: [{ ...state.incidents[0], probe: { id: "probe", startedAt: 130_000, observationTimedOut: true, result: null } }] });
  await open();
  expect(screen.getByText(/recorder is still pending/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run one health probe" }).hasAttribute("disabled")).toBe(true);
  expect(mocks.probe).not.toHaveBeenCalled();
});

it("canceling destination selection does not export or upload", async () => {
  mocks.save.mockResolvedValue(null);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Preview redacted report" }));
  await screen.findByLabelText("Report preview");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Choose destination and save" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.export).not.toHaveBeenCalled();
  expect(mocks.openUrl).not.toHaveBeenCalled();
});

it("shows a recorder owner signal separately and keeps unknown child work held", async () => {
  mocks.status.mockResolvedValue({ ...state, incidents: [{ ...state.incidents[0], probe: {
    id: "probe", startedAt: 130_000, observationTimedOut: true, result: null,
    ownerExit: { finishedAt: 180_000, exitCode: null, signal: 15, failure: null, osError: null },
  } }] });
  await open();
  expect(screen.getByText(/Recorder failure: signal 15/)).toBeTruthy();
  expect(screen.getByText(/No final child result was recorded/)).toBeTruthy();
  expect(screen.queryByText(/recorder is still pending/)).toBeNull();
  expect(screen.getByRole("button", { name: "Run one health probe" }).hasAttribute("disabled")).toBe(true);
});

it("offers a retry only when the saved failure proves the recorder never spawned", async () => {
  mocks.status.mockResolvedValue({ ...state, incidents: [{ ...state.incidents[0], probe: {
    id: "probe", startedAt: 130_000, observationTimedOut: false, result: null,
    ownerExit: { finishedAt: 130_001, exitCode: null, signal: null, failure: "spawn", osError: 2 },
  } }] });
  await open();
  expect(screen.getByText(/Recorder could not start \(OS error 2\)/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run one health probe" }).hasAttribute("disabled")).toBe(false);
});

it("keeps incomplete observation visible even when a prior health result exists", async () => {
  mocks.status.mockResolvedValue({ ...state, censusIncomplete: true });
  await open();
  expect(screen.getByText(/Some owned processes could not be observed/)).toBeTruthy();
  expect(screen.getByText("Incident incident")).toBeTruthy();
});
