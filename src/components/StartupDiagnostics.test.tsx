import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StartupDiagnostics } from "./StartupDiagnostics";
import { NoticeColumn } from "@/components/ui/NoticeColumn";
import { thisComputer } from "@/lib/platform";
import type { StartupSnapshot } from "@/lib/startupDiagnostics";

const mocks = vi.hoisted(() => ({ status: vi.fn(), policy: vi.fn(), probe: vi.fn(), dismiss: vi.fn(), preview: vi.fn(), export: vi.fn(), save: vi.fn(), openUrl: vi.fn() }));
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

const dismissed = (snapshot: StartupSnapshot): StartupSnapshot => ({ ...snapshot, incidents: snapshot.incidents.map((incident) => ({ ...incident, dismissed: { at: 500_000, escalated: true, affectedPanes: 1 } })) });

it("shows the banner in the window's toast stack, not over the composer", async () => {
  render(<><NoticeColumn><div>Claude Code finished</div></NoticeColumn><StartupDiagnostics /></>);
  const banner = await screen.findByRole("status", { name: "Local startup incident" });
  expect(banner.closest("[data-notice-stack]")).toBe(screen.getByText("Claude Code finished").closest("[data-notice-stack]"));
  expect(banner.className).not.toContain("bottom-16");
  expect(screen.getByText("1 affected pane. New local validation is held until launch health is demonstrated.")).toBeTruthy();
});

it("hides the banner for this incident, keeps it hidden after a reload, and shows it for a new incident", async () => {
  mocks.dismiss.mockResolvedValue(dismissed(state));
  render(<StartupDiagnostics />);
  fireEvent.click(await screen.findByRole("button", { name: "Hide startup incident" }));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Local startup incident" })).toBeNull());
  expect(mocks.dismiss).toHaveBeenCalledWith("incident");
  cleanup();
  // A reload reads the dismissal back from the owner's incident record.
  mocks.status.mockResolvedValue(dismissed(state));
  render(<StartupDiagnostics />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await Promise.resolve();
  expect(screen.queryByRole("status", { name: "Local startup incident" })).toBeNull();
  cleanup();
  mocks.status.mockResolvedValue({ ...dismissed(state), incidents: [{ ...dismissed(state).incidents[0], recoveredAt: 600_000 }, { ...state.incidents[0], id: "second", detectedAt: 700_000 }] });
  render(<StartupDiagnostics />);
  expect(await screen.findByRole("status", { name: "Local startup incident" })).toBeTruthy();
});

it("says plainly in the dialog what is still held once the banner is hidden", async () => {
  mocks.status.mockResolvedValue({ ...dismissed(state), incidents: [{ ...dismissed(state).incidents[0], recoveryWaits: ["wait"] }] });
  render(<StartupDiagnostics />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  act(() => { window.dispatchEvent(new Event("open-startup-diagnostics")); });
  const held = await screen.findByRole("note", { name: "Still held" });
  expect(held.textContent).toBe(`The banner is hidden, but nothing was released. Still held until this incident recovers: new heavy local validation on ${thisComputer}, and the checks of 1 pipeline. Recovery also waits on 1 permission prompt in the affected panes or in new launches; answer it yourself.`);
  expect(screen.getByText(/comes back if this incident escalates or reaches more panes/)).toBeTruthy();
});

it("states what is held even while the banner is showing", async () => {
  await open();
  expect(screen.getByRole("note", { name: "Still held" }).textContent).toBe(`Still held until this incident recovers: new heavy local validation on ${thisComputer}, and the checks of 1 pipeline.`);
});

it("pauses background 5s polling while hidden and resumes on visibilitychange", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    visibility.mockReturnValue("hidden");
    render(<StartupDiagnostics />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.status).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
    expect(mocks.status).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    expect(mocks.status).toHaveBeenCalledTimes(2);
  } finally {
    visibility.mockRestore();
    vi.useRealTimers();
  }
});
