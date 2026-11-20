import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, CloudAutomationDto, CloudAutomationDetailDto, CloudSelectedRepository, CloudSchedule, CloudScheduleQuote } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  repositories: vi.fn(),
  available: vi.fn(),
  openRun: vi.fn(),
  estimate: vi.fn(),
  create: vi.fn(),
  setActive: vi.fn(),
  remove: vi.fn(),
  pauseAll: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudAutomations: mocks.list,
    cloudAutomation: mocks.detail,
    cloudWorkspaceRepositories: mocks.repositories,
    phase2DesktopContractsAvailable: mocks.available,
    cloudAutomationEstimate: mocks.estimate,
    cloudAutomationCreate: mocks.create,
    cloudAutomationSetActive: mocks.setActive,
    cloudScheduleDelete: mocks.remove,
    cloudSchedulesPauseAll: mocks.pauseAll,
  },
}));
const scope = vi.hoisted(() => ({
  status: {} as AccountStatus,
  privacy: { enabled: false, ready: true, managed: false },
  accountListeners: new Set<() => void>(),
  privacyListeners: new Set<() => void>(),
}));
vi.mock("@/lib/account", () => ({
  getAccount: () => ({ status: scope.status, ready: true, busy: false }),
  subscribeAccount: (listener: () => void) => { scope.accountListeners.add(listener); return () => scope.accountListeners.delete(listener); },
}));
vi.mock("@/lib/dataPrivacy", () => ({
  getDataPrivacy: () => scope.privacy,
  subscribeDataPrivacy: (listener: () => void) => { scope.privacyListeners.add(listener); return () => scope.privacyListeners.delete(listener); },
}));
vi.mock("@/lib/cloudDashboard", () => ({ openCloudSession: mocks.openRun }));

vi.mock("@/lib/models", async (original) => ({ ...(await original<typeof import("@/lib/models")>()), useModels: () => [] }));

import { CloudSchedulesDialog, CloudSchedulesDialogHost, openSchedulesDialog } from "./CloudSchedulesDialog";

const ID = "schedule_0b9d6b1e-3f5a-4c1d-9f2e-7a1b2c3d4e5f";
const schedule = (fields: Partial<CloudSchedule> = {}): CloudSchedule => ({
  id: ID,
  workspaceId: "ws-1",
  name: "Nightly triage",
  createdBy: "u-me",
  agent: "claude",
  mode: "acceptEdits",
  promptBytes: 22,
  schedule: { preset: "daily", hour: 9, minute: 0, weekdays: [], timezone: "Europe/Berlin" },
  missedRunPolicy: "skip",
  completionPolicy: "suspend",
  maxRunMinutes: 60,
  state: "active",
  nextRunAt: Date.UTC(2026, 9, 13, 7),
  estimate: { currency: "USD", hourlyMicros: 120_000, perRunMaxMinutes: 85, perRunMaxMicros: 170_000, monthlyRuns: 30, monthlyMaxMicros: 5_100_000, keepsMachineRunning: false, runningSlots: 1, maxRunsPerDay: 24 },
  lastRun: { id: "run-1", scheduledFor: Date.UTC(2026, 9, 12, 7), trigger: "schedule", state: "failed", category: "timed-out" },
  ...fields,
});
const quote = (fields: Partial<CloudScheduleQuote> = {}): CloudScheduleQuote => ({
  estimate: { currency: "USD", hourlyMicros: 120_000, perRunMaxMinutes: 85, perRunMaxMicros: 170_000, monthlyRuns: 30, monthlyMaxMicros: 5_100_000, keepsMachineRunning: false, runningSlots: 1, maxRunsPerDay: 24 },
  nextRunAt: Date.UTC(2026, 9, 13, 7),
  supported: true,
  ...fields,
});

let listed: CloudAutomationDto[];
const open = () => render(<CloudSchedulesDialog orgId="org-1" workspaceId="ws-1" name="Docs site" onClose={() => undefined} />);
const row = () => screen.findByTestId(`cloud-schedule-${ID}`);

/** Open the form and fill what a task needs; the cost arrives after the form has rested. */
async function fillForm() {
  fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning report" } });
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Summarise what changed." } });
  // The listed task states its cost too: wait for the form's own.
  await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("Each run wakes this workspace"), { timeout: 3000 });
}

beforeEach(() => {
  scope.status = { state: "signed-in", identity: { email: "a@example.com", organizationId: "org-1", name: "A", organization: "One" }, context: { account: "account-a", scope: "profile-a", revision: "rev-1" }, expiresAt: null, lastError: null };
  scope.privacy = { enabled: false, ready: true, managed: false };
  listed = [schedule()];
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.available.mockResolvedValue(false);
  mocks.repositories.mockResolvedValue({ configured: true, repositories: [] });
  mocks.detail.mockImplementation(async () => ({ schedule: listed[0], runs: [] }));
  mocks.list.mockImplementation(async () => ({ schedules: listed }));
  mocks.estimate.mockResolvedValue(quote());
  mocks.create.mockImplementation(async () => schedule({ id: "schedule_new" }));
  mocks.setActive.mockImplementation(async (_id: string, active: boolean) => {
    listed = [schedule({ state: active ? "active" : "paused", ...(active ? {} : { pausedReason: "by-user" }) })];
    return listed[0];
  });
  mocks.remove.mockImplementation(async () => {
    listed = [];
  });
  mocks.pauseAll.mockResolvedValue({ paused: 3 });
});
afterEach(() => { cleanup(); openSchedulesDialog(null); });

describe("a workspace's scheduled tasks", () => {
  it("lists a task with when it runs, how its last run went and what it costs", async () => {
    open();
    const item = await row();
    expect(mocks.list).toHaveBeenCalledWith("ws-1", "org-1");
    expect(within(item).getByText("Nightly triage")).toBeTruthy();
    expect(within(item).getByText("Active")).toBeTruthy();
    expect(item.textContent).toContain("Daily at 09:00 (Europe/Berlin)");
    expect(item.textContent).toContain("stops after 60 minutes");
    expect(item.textContent).toContain("Failed: it ran past its time limit and was stopped");
    expect(item.textContent).toContain("up to 85 minutes");
    expect(item.textContent).toContain("up to $0.17 at $0.12 an hour");
    expect(item.textContent).toContain("up to $5.10 a month");
    // Who may do it is said, and that it spends by itself.
    expect(screen.getByText(/starts billed compute by itself/)).toBeTruthy();
    expect(screen.getByText(/Only\s+owners and admins/)).toBeTruthy();
  });

  it("pauses at once, and says why a task is paused", async () => {
    open();
    fireEvent.click(within(await row()).getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith(ID, false, "org-1"));
    await waitFor(async () => expect((await row()).textContent).toContain("Paused by a person."));
    // A paused task shows no next run.
    expect((await row()).textContent).not.toContain("Next run");
  });

  it("asks before resuming, because that starts billed compute by itself again", async () => {
    listed = [schedule({ state: "paused", pausedReason: "repeated-failures" })];
    open();
    expect((await row()).textContent).toContain("several runs in a row failed");
    fireEvent.click(within(await row()).getByRole("button", { name: /Resume…/ }));
    expect(mocks.setActive).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("cloud-schedule-resume-confirm");
    expect(confirm.textContent).toContain("runs under your account");
    fireEvent.click(within(confirm).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith(ID, true, "org-1"));
  });

  it("asks before deleting, and shows the server's reason when a machine is still owed a stop", async () => {
    mocks.remove.mockRejectedValueOnce({ code: "cloud_schedule_cleanup_pending", status: 409 });
    open();
    fireEvent.click(within(await row()).getByRole("button", { name: "Delete Nightly triage" }));
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId("cloud-schedule-delete-confirm")).getByRole("button", { name: "Delete" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pause the task, then delete it");
    // Still listed: nothing was deleted.
    expect(await row()).toBeTruthy();
    fireEvent.click(within(await row()).getByRole("button", { name: "Delete Nightly triage" }));
    fireEvent.click(within(screen.getByTestId("cloud-schedule-delete-confirm")).getByRole("button", { name: "Delete" }));
    await screen.findByText("This workspace has no scheduled tasks.");
    expect(mocks.remove).toHaveBeenLastCalledWith(ID, "org-1");
  });

  it("pauses every task of the organization only after a confirmation that says so", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Pause all in the organization/ }));
    expect(mocks.pauseAll).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("cloud-schedules-pause-all-confirm");
    expect(confirm.textContent).toContain("including ones on other workspaces");
    fireEvent.click(within(confirm).getByRole("button", { name: "Pause all" }));
    await screen.findByText(/Paused 3 scheduled tasks in the organization/);
    expect(mocks.pauseAll).toHaveBeenCalledWith("org-1");
  });

  it("says so when the list cannot be read, and offers nothing to change", async () => {
    mocks.list.mockRejectedValue({ code: "organization_admin_required", status: 403 });
    open();
    expect((await screen.findByTestId("cloud-schedules-load-error")).textContent).toContain("Only an owner or admin");
    expect(screen.queryByRole("button", { name: /New scheduled task/ })).toBeNull();
  });

  it("keeps the emergency stop reachable while the list cannot be read and while the form is open", async () => {
    mocks.list.mockRejectedValue({ code: "cloud_workspace_unavailable" });
    open();
    await screen.findByTestId("cloud-schedules-load-error");
    fireEvent.click(screen.getByRole("button", { name: /Pause all in the organization/ }));
    fireEvent.click(within(screen.getByTestId("cloud-schedules-pause-all-confirm")).getByRole("button", { name: "Pause all" }));
    await waitFor(() => expect(mocks.pauseAll).toHaveBeenCalledWith("org-1"));
    cleanup();

    mocks.list.mockImplementation(async () => ({ schedules: listed }));
    open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    expect(screen.getByTestId("cloud-schedule-form")).toBeTruthy();
    const stop = screen.getByRole("button", { name: /Pause all in the organization/ });
    // Above the list and the form, so a long list does not push it off screen.
    for (const below of [screen.getByTestId("cloud-schedules-list"), screen.getByTestId("cloud-schedule-form")])
      expect(stop.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not offer a Resume the server would only refuse, and says why", async () => {
    for (const [pausedReason, why] of [
      ["provider-disconnected", "Connect the organization's compute provider"],
      ["workspace-unavailable", "archived or deleted"],
      ["prompt-forbidden", "different prompt"],
      ["needs-approval", "same permission request again"],
    ]) {
      listed = [schedule({ state: "paused", pausedReason })];
      open();
      const resume = within(await row()).getByRole("button", { name: /Resume…/ }) as HTMLButtonElement;
      expect(resume.disabled).toBe(true);
      expect(screen.getByTestId("cloud-schedule-resume-blocked").textContent).toContain(why);
      fireEvent.click(resume);
      expect(screen.queryByTestId("cloud-schedule-resume-confirm")).toBeNull();
      // It can still be deleted.
      expect((within(await row()).getByRole("button", { name: /Delete/ }) as HTMLButtonElement).disabled).toBe(false);
      cleanup();
    }
    expect(mocks.setActive).not.toHaveBeenCalled();
  });

  it("keeps legacy Resume spend confirmation and shows the native runtime refusal without an estimate preflight", async () => {
    listed = [schedule({ state: "paused", pausedReason: "by-user" })];
    mocks.setActive.mockRejectedValue({ code: "cloud_schedule_runtime_unsupported" });
    open();
    fireEvent.click(within(await row()).getByRole("button", { name: /Resume…/ }));
    fireEvent.click(within(screen.getByTestId("cloud-schedule-resume-confirm")).getByRole("button", { name: "Resume" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Resume the workspace once");
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.setActive).toHaveBeenCalledWith(ID, true, "org-1");
  });
});

describe("a new scheduled task", () => {
  it("shows the cost and the daily cap before anything is saved, and saves only once that is agreed to", async () => {
    open();
    await fillForm();
    expect(mocks.estimate).toHaveBeenLastCalledWith(
      { workspaceId: "ws-1", schedule: expect.objectContaining({ preset: "daily", hour: 9, minute: 0 }), completionPolicy: "suspend", maxRunMinutes: 60 },
      "org-1",
    );
    const cost = screen.getByTestId("cloud-schedule-cost");
    expect(cost.textContent).toContain("up to 85 minutes (starting it, the 60-minute limit, and ending the run): up to $0.17 at $0.12 an hour");
    expect(cost.textContent).toContain("up to $5.10 a month");
    expect(cost.textContent).toContain("At most 24 runs in any 24 hours");
    expect(cost.textContent).toContain("First run");
    const create = screen.getByRole("button", { name: /Create scheduled task/ }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /starts the workspace and billed compute by itself/ }));
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith(
      {
        workspaceId: "ws-1",
        workspaceMode: "existing",
        name: "Morning report",
        agent: "claude",
        mode: "acceptEdits",
        prompt: "Summarise what changed.",
        schedule: expect.objectContaining({ preset: "daily", hour: 9, minute: 0, weekdays: [] }),
        missedRunPolicy: "skip",
        completionPolicy: "suspend",
        maxRunMinutes: 60,
      },
      "org-1",
    );
    // Back to the list, read again.
    await waitFor(() => expect(screen.queryByTestId("cloud-schedule-form")).toBeNull());
  });

  it("offers every permission mode but bypass", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    const modes = [...(screen.getByLabelText("Permission mode") as HTMLSelectElement).options].map((option) => option.value);
    expect(modes).toEqual(["plan", "manual", "auto", "acceptEdits"]);
  });

  it("asks for the cost again when what it depends on changes, and takes the agreement back", async () => {
    open();
    await fillForm();
    const agree = screen.getByRole("checkbox", { name: /billed compute by itself/ }) as HTMLInputElement;
    fireEvent.click(agree);
    expect(agree.checked).toBe(true);
    mocks.estimate.mockResolvedValue(quote({ estimate: { ...quote().estimate, keepsMachineRunning: true, monthlyMaxMicros: 86_400_000 } }));
    fireEvent.change(screen.getByLabelText("After a run"), { target: { value: "keep" } });
    expect(agree.checked).toBe(false);
    await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("left running after a run"), { timeout: 3000 });
    expect(mocks.estimate).toHaveBeenLastCalledWith(expect.objectContaining({ completionPolicy: "keep" }), "org-1");
    expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("$86.40 a month");
  });

  it("cannot be agreed to or saved while the screen shows no cost for the settings on it", async () => {
    open();
    await fillForm();
    const agree = screen.getByRole("checkbox", { name: /billed compute by itself/ }) as HTMLInputElement;
    const create = screen.getByRole("button", { name: /Create scheduled task/ }) as HTMLButtonElement;
    const cost = screen.getByTestId("cloud-schedule-cost");
    fireEvent.click(agree);
    expect(create.disabled).toBe(false);
    // The estimate for the new settings does not come back yet.
    let answer: (value: CloudScheduleQuote) => void = () => undefined;
    mocks.estimate.mockReturnValue(new Promise<CloudScheduleQuote>((resolve) => (answer = resolve)));
    for (const change of [
      () => fireEvent.change(screen.getByLabelText("After a run"), { target: { value: "keep" } }),
      () => fireEvent.change(screen.getByLabelText("Time limit in minutes"), { target: { value: "240" } }),
      () => fireEvent.change(screen.getByLabelText("Time"), { target: { value: "10:30" } }),
    ]) {
      change();
      // At once, before the form has rested: the cost of the old settings is gone.
      expect(cost.textContent).toContain("Reading the cost");
      expect(cost.textContent).not.toContain("$");
      expect(agree.disabled).toBe(true);
      expect(agree.checked).toBe(false);
      expect(create.disabled).toBe(true);
      fireEvent.click(agree);
      fireEvent.submit(screen.getByTestId("cloud-schedule-form"));
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(cost.textContent).toContain("Reading the cost");
    expect(create.disabled).toBe(true);
    fireEvent.submit(screen.getByTestId("cloud-schedule-form"));
    expect(mocks.create).not.toHaveBeenCalled();
    // The answer for what is on screen makes it agreeable again, unticked.
    await act(async () => answer(quote({ estimate: { ...quote().estimate, keepsMachineRunning: true, monthlyMaxMicros: 86_400_000 } })));
    expect(cost.textContent).toContain("$86.40 a month");
    expect(agree.disabled).toBe(false);
    expect(agree.checked).toBe(false);
    expect(create.disabled).toBe(true);
    fireEvent.click(agree);
    fireEvent.click(create);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ completionPolicy: "keep", maxRunMinutes: 240 }), "org-1"));
  });

  it("says before the tick when the server would refuse the task whatever it says", async () => {
    mocks.estimate.mockResolvedValue(quote({ refusal: "cloud_workspace_quota_exceeded" }));
    open();
    await fillForm();
    expect(screen.getByTestId("cloud-schedule-refusal").textContent).toContain("already as many scheduled tasks as allowed");
    expect((screen.getByRole("checkbox", { name: /billed compute by itself/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Create scheduled task/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId("cloud-schedule-form"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("says what a mode means with nobody watching, and asks for the zone of an hourly task too", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    fireEvent.change(screen.getByLabelText("Permission mode"), { target: { value: "manual" } });
    expect(screen.getByTestId("cloud-schedule-mode-note").textContent).toContain("stops at the agent's first edit or command");
    fireEvent.click(screen.getByRole("radio", { name: "Hourly" }));
    expect(screen.getByLabelText("Time zone")).toBeTruthy();
  });

  it("says a server without the estimate is one that cannot say the cost, not one that cannot be reached", async () => {
    mocks.estimate.mockRejectedValue({ code: "cloud_schedule_estimate_not_supported", status: 404 });
    open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    const cost = await screen.findByText(/cannot say yet what a scheduled task costs/, undefined, { timeout: 3000 });
    expect(cost.textContent).not.toContain("could not be reached");
  });

  it("cannot be saved on a workspace whose runtime cannot run it, and says what to do", async () => {
    mocks.estimate.mockResolvedValue(quote({ supported: false }));
    open();
    await fillForm();
    expect(screen.getByTestId("cloud-schedule-unsupported").textContent).toContain("Resume the workspace once");
    expect((screen.getByRole("checkbox", { name: /billed compute by itself/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Create scheduled task/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cannot be saved while the cost is unknown", async () => {
    mocks.estimate.mockRejectedValue({ code: "cloud_workspace_unavailable" });
    open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    await screen.findByText(/The cost could not be read/, undefined, { timeout: 3000 });
    expect((screen.getByRole("button", { name: /Create scheduled task/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the form and shows the server's reason when the prompt is refused", async () => {
    mocks.create.mockRejectedValue({ code: "cloud_schedule_prompt_slash_command", status: 422 });
    open();
    await fillForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /billed compute by itself/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create scheduled task/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("slash command");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Summarise what changed.");
  });
});

describe("the scheduled tasks dialog host", () => {
  it("opens for the workspace it is asked for and closes again", async () => {
    render(<CloudSchedulesDialogHost />);
    expect(screen.queryByTestId("cloud-schedules-dialog")).toBeNull();
    act(() => openSchedulesDialog({ orgId: "org-1", workspaceId: "ws-1", name: "Docs site" }));
    expect((await screen.findByTestId("cloud-schedules-dialog")).textContent).toContain("Scheduled tasks for Docs site");
    act(() => openSchedulesDialog(null));
    expect(screen.queryByTestId("cloud-schedules-dialog")).toBeNull();
  });
});


describe("batched hosted automation target transitions", () => {
  const a = { orgId: "org-1", workspaceId: "ws-1", name: "Docs site" };
  const b = { orgId: "org-1", workspaceId: "ws-2", name: "Other workspace" };
  const openHost = async () => {
    render(<CloudSchedulesDialogHost />);
    act(() => openSchedulesDialog(a));
    await screen.findByRole("button", { name: /New scheduled task/ });
  };
  it("retires an agreed quote across a batched A-B-A switch even when A is the same object", async () => {
    await openHost(); await fillForm(); agreeToCost();
    expect(createButton().disabled).toBe(false);
    act(() => { openSchedulesDialog(b); openSchedulesDialog(a); });
    expect(screen.queryByTestId("cloud-schedule-form")).toBeNull();
    await fillForm();
    expect((screen.getByRole("checkbox", { name: /starts the workspace and billed compute/ }) as HTMLInputElement).checked).toBe(false);
    expect(createButton().disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("discards a pending quote from before a batched A-B-A switch", async () => {
    const old = deferred<CloudScheduleQuote>();
    mocks.estimate.mockReturnValueOnce(old.promise).mockResolvedValue(quote({ estimate: { ...quote().estimate, monthlyMaxMicros: 9_000_000 } }));
    await openHost();
    fireEvent.click(screen.getByRole("button", { name: /New scheduled task/ }));
    await waitFor(() => expect(mocks.estimate).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await act(async () => { openSchedulesDialog(b); openSchedulesDialog(a); old.resolve(quote()); await Promise.resolve(); });
    expect(screen.queryByTestId("cloud-schedule-form")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    expect(screen.getByTestId("cloud-schedule-cost").textContent).not.toContain("$5.10");
    expect(createButton().disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("$9.00"), { timeout: 3000 });
  });
  it.each(["create", "resume"])("does not refresh from old %s completion during a batched target A-B-A switch", async (operation) => {
    const old = deferred<CloudAutomationDto>();
    if (operation === "resume") listed = [schedule({ state: "paused" })];
    await openHost();
    if (operation === "create") {
      mocks.create.mockReturnValue(old.promise);
      await fillForm(); agreeToCost(); fireEvent.click(createButton());
      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    } else {
      mocks.setActive.mockReturnValue(old.promise);
      fireEvent.click(within(await row()).getByRole("button", { name: /Resume…/ }));
      fireEvent.click(within(screen.getByTestId("cloud-schedule-resume-confirm")).getByRole("button", { name: "Resume" }));
      await waitFor(() => expect(mocks.setActive).toHaveBeenCalledTimes(1));
    }
    await act(async () => {
      openSchedulesDialog(b); openSchedulesDialog(a); old.resolve(schedule());
      // Let old continuations run while the target transitions are still batched.
      await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("cloud-schedule-form")).toBeNull();
    expect(mocks.list.mock.calls.every(([workspace]) => workspace === "ws-1")).toBe(true);
  });
});

const selectedRepository = (fields: Partial<CloudSelectedRepository> = {}): CloudSelectedRepository => ({
  id: "repository-row-7", fullName: "acme/app", cloneUrl: "https://github.com/acme/app.git", defaultBranch: "main", private: true, state: "accessible", reason: null, ...fields,
});
const githubAutomation = (fields: Partial<CloudAutomationDto> = {}): CloudAutomationDto => ({
  ...schedule(), workspaceMode: "fresh", schedule: null, nextRunAt: null,
  archiveAfterDays: 365, archiveOnPrMerge: true,
  githubTrigger: { repositoryId: "repository-row-7", event: "opened", filters: [], allowForkPullRequests: false }, ...fields,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const agreeToCost = () => fireEvent.click(screen.getByRole("checkbox", { name: /starts the workspace and billed compute/ }));
const createButton = () => screen.getByRole("button", { name: /Create scheduled task/ }) as HTMLButtonElement;
function publishAccount(patch: Partial<AccountStatus>) {
  scope.status = { ...scope.status, ...patch };
  for (const listener of [...scope.accountListeners]) listener();
}
async function githubForm() {
  mocks.repositories.mockResolvedValue({ configured: true, repositories: [selectedRepository()] });
  open();
  fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR review" } });
  fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Review the changes." } });
  fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "github" } });
  await screen.findByRole("option", { name: "acme/app" });
  fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "repository-row-7" } });
}

describe("accepted raw cloud automations", () => {
  it("renders nullable GitHub timing without a fake next run and preserves fork/filter/cleanup readback", async () => {
    listed = [githubAutomation({ nextRunAt: Date.now(), githubTrigger: { repositoryId: "repository-row-7", event: "pushed", filters: [{ field: "author", operator: "is-not", value: "bot" }], allowForkPullRequests: true } })];
    open();
    const item = await row();
    expect(item.textContent).toContain("GitHub · pushed");
    expect(item.textContent).toContain("author is-not bot");
    expect(item.textContent).toContain("Allow pull requests from forks: Yes");
    expect(item.textContent).toContain("Archive after 365 days");
    expect(item.textContent).toContain("Archive when the PR merges");
    expect(item.textContent).not.toContain("Next run");
    expect(item.textContent).not.toContain("Daily at");
    expect(item.textContent).toContain("not a delivery forecast");
    expect(mocks.estimate).not.toHaveBeenCalled();
  });

  it("holds advanced resume/create/estimate in production while raw pause and delete need no preflight", async () => {
    listed = [githubAutomation()];
    open();
    const item = await row();
    mocks.detail.mockRejectedValue({ code: "cloud_workspace_unavailable" });
    fireEvent.click(within(item).getByRole("button", { name: "Show runs" }));
    await screen.findByText(/Could not read runs/);
    mocks.detail.mockClear();
    fireEvent.click(within(item).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith(ID, false, "org-1"));
    listed = [githubAutomation({ state: "paused", pausedReason: "by-user" })];
    // Remount to read the advanced paused row rather than the legacy mock response.
    cleanup(); open();
    expect((within(await row()).getByRole("button", { name: /Resume…/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("cloud-schedule-resume-blocked").textContent).toContain("not enabled yet");
    fireEvent.click(within(await row()).getByRole("button", { name: "Delete Nightly triage" }));
    fireEvent.click(within(screen.getByTestId("cloud-schedule-delete-confirm")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(ID, "org-1"));
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(mocks.setActive.mock.calls.every((call) => call[1] === false)).toBe(true);
    cleanup();
    await githubForm();
    fireEvent.change(screen.getByLabelText("Workspace mode"), { target: { value: "fresh" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("not enabled yet");
    expect(createButton().disabled).toBe(true);
    fireEvent.submit(screen.getByTestId("cloud-schedule-form"));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.estimate).not.toHaveBeenCalled();
  });

  it("sends one exact GitHub trigger with five AND filters and explicit fork consent; estimate excludes create-only data", async () => {
    mocks.available.mockResolvedValue(true); // Test service only; production remains false.
    mocks.estimate.mockResolvedValue(quote({ estimate: { ...quote().estimate, monthlyRuns: 720 } }));
    await githubForm();
    expect(screen.queryByLabelText("Time")).toBeNull();
    expect(screen.queryByLabelText("A missed run")).toBeNull();
    fireEvent.change(screen.getByLabelText("GitHub event"), { target: { value: "merged" } });
    for (let index = 1; index <= 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
      fireEvent.change(screen.getByLabelText(`Filter ${index} field`), { target: { value: index === 1 ? "baseBranch" : "label" } });
      fireEvent.change(screen.getByLabelText(`Filter ${index} operator`), { target: { value: "is-not" } });
      fireEvent.change(screen.getByLabelText(`Filter ${index} value`), { target: { value: ` value-${index} ` } });
    }
    expect((screen.getByRole("button", { name: "Add filter" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Allow pull requests from forks" }));
    await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("720/month"), { timeout: 3000 });
    expect(screen.getByTestId("cloud-schedule-cost").textContent).not.toContain("First run");
    const githubTrigger = { repositoryId: "repository-row-7", event: "merged", filters: Array.from({ length: 5 }, (_, index) => ({ field: index === 0 ? "baseBranch" : "label", operator: "is-not", value: `value-${index + 1}` })), allowForkPullRequests: true };
    expect(mocks.estimate).toHaveBeenLastCalledWith({ workspaceId: "ws-1", completionPolicy: "suspend", maxRunMinutes: 60, githubTrigger }, "org-1");
    agreeToCost(); fireEvent.click(createButton());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ workspaceId: "ws-1", workspaceMode: "existing", name: "PR review", prompt: "Review the changes.", agent: "claude", mode: "acceptEdits", completionPolicy: "suspend", maxRunMinutes: 60, missedRunPolicy: "skip", githubTrigger }, "org-1"));
  });

  it("quotes fresh mode without prompt/cleanup, includes creation once, and saves 365-day plus PR cleanup", async () => {
    mocks.available.mockResolvedValue(true);
    mocks.estimate.mockResolvedValue(quote({ estimate: { ...quote().estimate, createPerRunMinutes: 20, perRunMaxMinutes: 105, perRunMaxMicros: 210_000 } }));
    open(); await fillForm();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Europe/Berlin" } });
    fireEvent.change(screen.getByLabelText("Workspace mode"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText("Archive after days"), { target: { value: "365" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Archive when the PR merges" }));
    await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("105 minutes, including 20 minutes"), { timeout: 3000 });
    const schedule = { preset: "daily", hour: 9, minute: 0, weekdays: [], timezone: "Europe/Berlin" };
    expect(mocks.estimate).toHaveBeenLastCalledWith({ workspaceId: "ws-1", workspaceMode: "fresh", schedule, completionPolicy: "suspend", maxRunMinutes: 60 }, "org-1");
    agreeToCost();
    fireEvent.change(screen.getByLabelText("Archive after days"), { target: { value: "366" } });
    expect(screen.getByText(/whole number from 1 to 365/)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Archive after days"), { target: { value: "365" } });
    await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("Creation is already included"), { timeout: 3000 });
    agreeToCost(); fireEvent.click(createButton());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ workspaceId: "ws-1", workspaceMode: "fresh", archiveAfterDays: 365, archiveOnPrMerge: true, schedule, name: "Morning report", prompt: "Summarise what changed.", agent: "claude", mode: "acceptEdits", missedRunPolicy: "skip", completionPolicy: "suspend", maxRunMinutes: 60 }, "org-1"));
  });

  it("uses only allocated own run workspaces and distinguishes archive due from observed archival", async () => {
    listed = [githubAutomation()];
    mocks.detail.mockResolvedValue({ schedule: listed[0], runs: [
      { id: "unallocated", state: "creating-workspace", trigger: "github", scheduledFor: 1, workspaceId: null },
      { id: "placeholder", state: "queued", trigger: "github", scheduledFor: 1, workspaceId: "ws-1" },
      { id: "allocated", state: "working", trigger: "github", scheduledFor: 1, workspaceId: "fresh-ws-9", tabId: "tab-9", workBranch: "terminalx/review-9", archiveAt: 1 },
      { id: "archived", state: "completed", trigger: "github", scheduledFor: 1, workspaceId: "fresh-ws-8", sessionId: "session-8", tabId: "tab-8", archiveAt: 1, archivedAt: 2 },
    ] });
    open();
    fireEvent.click(within(await row()).getByRole("button", { name: "Show runs" }));
    const unallocated = await screen.findByTestId("automation-run-unallocated");
    expect(unallocated.textContent).toContain("Creating workspace");
    expect(within(unallocated).queryByRole("button")).toBeNull();
    expect(within(screen.getByTestId("automation-run-placeholder")).queryByRole("button")).toBeNull();
    const allocated = screen.getByTestId("automation-run-allocated");
    expect(allocated.textContent).toContain("Archive due");
    expect(allocated.textContent).toContain("archival not observed");
    expect(allocated.textContent).not.toContain("Archived ");
    expect(screen.getByTestId("automation-run-archived").textContent).toContain("Archived ");
    fireEvent.click(within(allocated).getByRole("button", { name: "Open run workspace" }));
    expect(mocks.openRun).toHaveBeenCalledWith("cloud:org-1:fresh-ws-9", "tab-9");
    fireEvent.click(within(screen.getByTestId("automation-run-archived")).getByRole("button", { name: "Open run workspace" }));
    expect(mocks.openRun).toHaveBeenLastCalledWith("cloud:org-1:fresh-ws-8:session-8", "tab-8");
    expect(mocks.detail).toHaveBeenCalledWith(ID, "org-1");
    expect(mocks.setActive).not.toHaveBeenCalled();
  });

  it("invalidates an agreed quote across a mode A-B-A change immediately and excludes hidden cleanup on existing mode", async () => {
    mocks.available.mockResolvedValue(true);
    open(); await fillForm(); agreeToCost();
    const old = deferred<CloudScheduleQuote>();
    mocks.estimate.mockReturnValue(old.promise);
    fireEvent.change(screen.getByLabelText("Workspace mode"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText("Archive after days"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Workspace mode"), { target: { value: "existing" } });
    expect(createButton().disabled).toBe(true);
    expect(screen.getByTestId("cloud-schedule-cost").textContent).not.toContain("$");
    await waitFor(() => expect(mocks.estimate).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await act(async () => old.resolve(quote()));
    expect(createButton().disabled).toBe(true);
    agreeToCost(); fireEvent.click(createButton());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("archiveAfterDays");
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("archiveOnPrMerge");
  });
});

describe("automation React scope fences", () => {
  it.each(["account", "profile", "organization", "revision", "A-B-A"])("clears the old list and rejects delayed data after %s changes", async (change) => {
    const old = deferred<{ schedules: CloudAutomationDto[] }>();
    mocks.list.mockReturnValueOnce(old.promise).mockResolvedValue({ schedules: [] });
    open();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    act(() => {
      const context = scope.status.context!;
      if (change === "account") publishAccount({ context: { ...context, account: "account-b" } });
      if (change === "profile") publishAccount({ context: { ...context, scope: "profile-b" } });
      if (change === "organization") publishAccount({ identity: { ...scope.status.identity!, organizationId: "org-2" } });
      if (change === "revision") publishAccount({ context: { ...context, revision: "rev-2" } });
      if (change === "A-B-A") { publishAccount({ context: { ...context, account: "b" } }); publishAccount({ context }); }
    });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve({ schedules: [schedule({ name: "Stale secret" })] }));
    expect(screen.queryByText("Stale secret")).toBeNull();
    expect(screen.getByText("This workspace has no scheduled tasks.")).toBeTruthy();
  });

  it("clears visible data synchronously on privacy changes and never revives a pending list", async () => {
    const old = deferred<{ schedules: CloudAutomationDto[] }>();
    mocks.list.mockReturnValue(old.promise);
    open();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    act(() => { scope.privacy = { ...scope.privacy, enabled: true }; for (const listener of [...scope.privacyListeners]) listener(); });
    expect(screen.queryByTestId("cloud-schedules-dialog")).toBeNull();
    await act(async () => old.resolve({ schedules: [schedule()] }));
    expect(screen.queryByText("Nightly triage")).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("clears already rendered rows and rejects old detail after an account revision", async () => {
    const old = deferred<CloudAutomationDetailDto>();
    mocks.detail.mockReturnValue(old.promise);
    open();
    fireEvent.click(within(await row()).getByRole("button", { name: "Show runs" }));
    mocks.list.mockReturnValue(new Promise(() => {}));
    act(() => publishAccount({ context: { ...scope.status.context!, revision: "rev-next" } }));
    expect(screen.queryByText("Nightly triage")).toBeNull();
    await act(async () => old.resolve({ schedule: schedule(), runs: [{ id: "secret", scheduledFor: 1, state: "working", trigger: "github", workBranch: "old-secret-branch" }] }));
    expect(screen.queryByText(/old-secret-branch/)).toBeNull();
  });

  it("does not use an old quote after target workspace A-B-A changes", async () => {
    const old = deferred<CloudScheduleQuote>();
    mocks.estimate.mockReturnValueOnce(old.promise).mockResolvedValue(quote({ estimate: { ...quote().estimate, monthlyMaxMicros: 9_000_000 } }));
    const view = open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    await waitFor(() => expect(mocks.estimate).toHaveBeenCalledTimes(1), { timeout: 3000 });
    view.rerender(<CloudSchedulesDialog orgId="org-1" workspaceId="ws-2" name="Two" onClose={() => {}} />);
    expect(screen.queryByTestId("cloud-schedule-form")).toBeNull();
    view.rerender(<CloudSchedulesDialog orgId="org-1" workspaceId="ws-1" name="One" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    await act(async () => old.resolve(quote()));
    expect(screen.getByTestId("cloud-schedule-cost").textContent).not.toContain("$5.10");
    expect(createButton().disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("cloud-schedule-cost").textContent).toContain("$9.00"), { timeout: 3000 });
  });

  it("discards a repository response from a previous organization scope", async () => {
    const old = deferred<{ configured: boolean; repositories: CloudSelectedRepository[] }>();
    mocks.repositories.mockReturnValueOnce(old.promise).mockResolvedValue({ configured: true, repositories: [] });
    const view = open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "github" } });
    await waitFor(() => expect(mocks.repositories).toHaveBeenCalledWith("org-1"));
    view.rerender(<CloudSchedulesDialog orgId="org-2" workspaceId="ws-2" name="Two" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "github" } });
    await act(async () => old.resolve({ configured: true, repositories: [selectedRepository({ fullName: "old/private" })] }));
    expect(screen.queryByRole("option", { name: "old/private" })).toBeNull();
    expect(mocks.repositories).toHaveBeenLastCalledWith("org-2");
  });

  it.each(["create", "resume"])("ignores delayed %s completion after account A-B-A without refreshing the new scope", async (operation) => {
    const old = deferred<CloudAutomationDto>();
    if (operation === "create") {
      mocks.create.mockReturnValue(old.promise);
      open(); await fillForm(); agreeToCost(); fireEvent.click(createButton());
      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    } else {
      listed = [schedule({ state: "paused" })];
      mocks.setActive.mockReturnValue(old.promise);
      open();
      fireEvent.click(within(await row()).getByRole("button", { name: /Resume…/ }));
      fireEvent.click(within(screen.getByTestId("cloud-schedule-resume-confirm")).getByRole("button", { name: "Resume" }));
      await waitFor(() => expect(mocks.setActive).toHaveBeenCalledTimes(1));
    }
    act(() => { const context = scope.status.context!; publishAccount({ context: { ...context, account: "b" } }); publishAccount({ context }); });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    await act(async () => old.resolve(schedule()));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("cloud-schedule-form")).toBeTruthy();
  });
});

describe("automation hold and selected repository refusals", () => {
  it("never quotes or creates GitHub without a selected accessible row ID", async () => {
    mocks.available.mockResolvedValue(true);
    mocks.repositories.mockResolvedValue({ configured: true, repositories: [selectedRepository({ id: null })] });
    open();
    fireEvent.click(await screen.findByRole("button", { name: /New scheduled task/ }));
    fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "github" } });
    const option = await screen.findByRole("option", { name: "acme/app (repository ID unavailable)" });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("accessible repository with a repository ID");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(createButton().disabled).toBe(true);
    expect(mocks.estimate).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByTestId("cloud-schedule-form"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not apply a stale readiness true to the new account and keeps emergency stop independent of readiness failure", async () => {
    const old = deferred<boolean>();
    mocks.available.mockReturnValueOnce(old.promise).mockRejectedValue({ code: "cloud_workspace_unavailable" });
    listed = [githubAutomation({ state: "paused" })];
    open(); await row();
    act(() => publishAccount({ context: { ...scope.status.context!, account: "b", revision: "b" } }));
    await row();
    await act(async () => old.resolve(true));
    expect((within(await row()).getByRole("button", { name: /Resume…/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Pause all in the organization/ }));
    fireEvent.click(within(screen.getByTestId("cloud-schedules-pause-all-confirm")).getByRole("button", { name: "Pause all" }));
    await waitFor(() => expect(mocks.pauseAll).toHaveBeenCalledWith("org-1"));
    expect(mocks.estimate).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.setActive).not.toHaveBeenCalled();
  });
});
