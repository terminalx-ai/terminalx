import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSchedule, CloudScheduleQuote } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  estimate: vi.fn(),
  create: vi.fn(),
  setActive: vi.fn(),
  remove: vi.fn(),
  pauseAll: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudSchedules: mocks.list,
    cloudScheduleEstimate: mocks.estimate,
    cloudScheduleCreate: mocks.create,
    cloudScheduleSetActive: mocks.setActive,
    cloudScheduleDelete: mocks.remove,
    cloudSchedulesPauseAll: mocks.pauseAll,
  },
}));
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

let listed: CloudSchedule[];
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
  listed = [schedule()];
  for (const mock of Object.values(mocks)) mock.mockReset();
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
afterEach(cleanup);

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

  it("does not offer Resume on a workspace whose runtime cannot run scheduled tasks", async () => {
    mocks.estimate.mockResolvedValue(quote({ supported: false }));
    listed = [schedule({ state: "paused", pausedReason: "by-user" })];
    open();
    await waitFor(async () => expect((within(await row()).getByRole("button", { name: /Resume…/ }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("cloud-schedule-resume-blocked").textContent).toContain("Resume the workspace once");
    // Only a read was sent to find out.
    expect(mocks.setActive).not.toHaveBeenCalled();
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
