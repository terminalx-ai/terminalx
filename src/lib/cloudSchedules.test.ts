import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudScheduleEstimate } from "@/lib/api";

const mocks = vi.hoisted(() => ({ cloudSchedules: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { cloudSchedules: mocks.cloudSchedules } }));

import { PERMISSION_MODES } from "@/lib/models";
import {
  SCHEDULE_MODES,
  blankScheduleForm,
  costLines,
  describeTiming,
  formatMicros,
  pausedText,
  probeSchedules,
  resetSchedulesOffers,
  runText,
  scheduleErrorMessage,
  scheduleFormErrors,
  scheduleInput,
  schedulesOffer,
  timingOf,
} from "./cloudSchedules";

const estimate = (fields: Partial<CloudScheduleEstimate> = {}): CloudScheduleEstimate => ({
  currency: "USD",
  hourlyMicros: 120_000,
  perRunMaxMicros: 480_000,
  monthlyRuns: 30,
  monthlyMaxMicros: 14_400_000,
  keepsMachineRunning: false,
  runningSlots: 1,
  maxRunsPerDay: 24,
  ...fields,
});

const filled = () => ({ ...blankScheduleForm(), name: " Nightly triage ", prompt: "Triage the new issues.", timezone: "Europe/Berlin" });

describe("scheduled tasks: what the dialog says", () => {
  it("says when a task runs", () => {
    const timing = { hour: 9, minute: 5, weekdays: [] as string[], timezone: "Europe/Berlin" };
    expect(describeTiming({ ...timing, preset: "hourly" })).toBe("Every hour at :05");
    expect(describeTiming({ ...timing, preset: "daily" })).toBe("Daily at 09:05 (Europe/Berlin)");
    expect(describeTiming({ ...timing, preset: "weekdays" })).toBe("Monday to Friday at 09:05 (Europe/Berlin)");
    // Days in the week's order, whatever order they were picked in.
    expect(describeTiming({ ...timing, preset: "weekly", weekdays: ["thu", "mon"] })).toBe("Weekly on Mon, Thu at 09:05 (Europe/Berlin)");
  });

  it("writes money from millionths, with enough digits for a small rate", () => {
    expect(formatMicros(480_000, "USD")).toBe("$0.48");
    expect(formatMicros(14_400_000, "USD")).toBe("$14.40");
    expect(formatMicros(1_500, "USD")).toBe("$0.0015");
    expect(formatMicros(480_000, "not a currency")).toBe("0.48 not a currency");
  });

  it("states the cost of a run, of a month and the daily cap", () => {
    const lines = costLines(estimate(), 240);
    expect(lines[0]).toBe("Each run wakes this workspace and costs up to $0.48 (240 minutes at $0.12 an hour).");
    expect(lines[1]).toBe("About 30 runs a month: up to $14.40 a month.");
    expect(lines[2]).toContain("At most 24 runs in any 24 hours.");
    expect(lines[2]).toContain("running-workspace slots");
  });

  it("says plainly that a workspace left running can cost a whole month", () => {
    const lines = costLines(estimate({ keepsMachineRunning: true, monthlyMaxMicros: 86_400_000 }), 5);
    expect(lines[1]).toContain("left running after a run");
    expect(lines[1]).toContain("$86.40 a month");
  });

  it("says why a task is paused and how a run went", () => {
    expect(pausedText({ state: "active" })).toBeNull();
    expect(pausedText({ state: "paused", pausedReason: "paused-all" })).toContain("every other scheduled task");
    expect(pausedText({ state: "paused", pausedReason: "cleanup-failed" })).toContain("could not be stopped");
    expect(pausedText({ state: "paused", pausedReason: "something-new" })).toBe("Paused.");
    expect(runText({ state: "completed" })).toBe("Completed");
    expect(runText({ state: "failed", category: "timed-out" })).toBe("Failed: it ran past its time limit and was stopped");
    expect(runText({ state: "skipped", category: "daily-cap" })).toBe("Skipped: 24 runs had already started in 24 hours");
    expect(runText({ state: "failed", category: "something-new" })).toBe("Failed: something-new");
    expect(scheduleErrorMessage("cloud_schedule_cleanup_pending")).toContain("Pause the task");
    expect(scheduleErrorMessage("something_new")).toBe("That did not work (something_new).");
  });
});

describe("scheduled tasks: the form", () => {
  it("never offers or sends bypass permissions", () => {
    expect(SCHEDULE_MODES.map((mode) => mode.id)).toEqual(["plan", "manual", "auto", "acceptEdits"]);
    // The launch modes, named the same way, without the one that asks nothing.
    const launch = PERMISSION_MODES.filter((mode) => mode.id !== "bypassPermissions");
    expect(SCHEDULE_MODES.map(({ id, label }) => ({ id, label }))).toEqual(launch.map(({ id, label }) => ({ id, label })));
    expect(blankScheduleForm().mode).toBe("acceptEdits");
    const bypass = { ...filled(), mode: "bypassPermissions" };
    expect(scheduleFormErrors(bypass).mode).toContain("cannot bypass permissions");
    expect(scheduleInput(bypass, "ws-1")).toBeNull();
    expect(scheduleInput({ ...filled(), mode: "" }, "ws-1")).toBeNull();
  });

  it("turns a filled form into the request, without blank fields", () => {
    expect(scheduleFormErrors(filled())).toEqual({});
    expect(scheduleInput(filled(), "ws-1")).toEqual({
      workspaceId: "ws-1",
      name: "Nightly triage",
      agent: "claude",
      mode: "acceptEdits",
      prompt: "Triage the new issues.",
      schedule: { preset: "daily", hour: 9, minute: 0, weekdays: [], timezone: "Europe/Berlin" },
      missedRunPolicy: "skip",
      completionPolicy: "suspend",
      maxRunMinutes: 60,
    });
    expect(scheduleInput({ ...filled(), model: "sonnet", effort: "high" }, "ws-1")).toMatchObject({ model: "sonnet", effort: "high" });
  });

  it("says what is wrong before anything is sent", () => {
    expect(scheduleFormErrors({ ...filled(), name: "  " }).name).toBeTruthy();
    expect(scheduleFormErrors({ ...filled(), name: "x".repeat(81) }).name).toBeTruthy();
    expect(scheduleFormErrors({ ...filled(), prompt: " " }).prompt).toBeTruthy();
    expect(scheduleFormErrors({ ...filled(), prompt: "x".repeat(32 * 1024 + 1) }).prompt).toContain("32 KB");
    // A first-line "!" is a shell command to the CLI in any permission mode.
    expect(scheduleFormErrors({ ...filled(), prompt: "  !rm -rf ." }).prompt).toContain("shell command");
    expect(scheduleFormErrors({ ...filled(), preset: "weekly", weekdays: [] }).weekdays).toBeTruthy();
    expect(scheduleFormErrors({ ...filled(), time: "25:00" }).time).toBeTruthy();
    for (const minutes of [4, 241, 7.5, Number.NaN]) expect(scheduleFormErrors({ ...filled(), maxRunMinutes: minutes }).maxRunMinutes).toBeTruthy();
    expect(scheduleInput({ ...filled(), maxRunMinutes: 241 }, "ws-1")).toBeNull();
  });

  it("gives the times as the server takes them", () => {
    expect(timingOf({ preset: "hourly", time: "00:15", weekdays: ["mon"], timezone: "UTC" })).toEqual({ preset: "hourly", hour: 0, minute: 15, weekdays: [], timezone: "UTC" });
    expect(timingOf({ preset: "weekly", time: "07:30", weekdays: ["sun", "mon"], timezone: "UTC" })).toEqual({ preset: "weekly", hour: 7, minute: 30, weekdays: ["mon", "sun"], timezone: "UTC" });
    expect(timingOf({ preset: "daily", time: "", weekdays: [], timezone: "UTC" })).toBeNull();
    expect(timingOf({ preset: "daily", time: "09:00", weekdays: [], timezone: "" })).toBeNull();
  });
});

describe("scheduled tasks: whether they are offered", () => {
  beforeEach(() => {
    resetSchedulesOffers();
    mocks.cloudSchedules.mockReset();
  });

  it("offers them once the server has listed them, and asks only once", async () => {
    mocks.cloudSchedules.mockResolvedValue({ schedules: [] });
    expect(schedulesOffer("org-1")).toBe("unknown");
    await probeSchedules("org-1", 1_000);
    expect(schedulesOffer("org-1")).toBe("offered");
    await probeSchedules("org-1", 9_999_999);
    expect(mocks.cloudSchedules).toHaveBeenCalledTimes(1);
    expect(mocks.cloudSchedules).toHaveBeenCalledWith(null, "org-1");
    // Another organization is its own question.
    expect(schedulesOffer("org-2")).toBe("unknown");
  });

  it("offers nothing to someone the server refuses or on a server without them, and asks again only later", async () => {
    mocks.cloudSchedules.mockRejectedValue({ code: "organization_admin_required", status: 403 });
    await probeSchedules("org-1", 1_000);
    expect(schedulesOffer("org-1")).toBe("not-offered");
    await probeSchedules("org-1", 1_000 + 9 * 60_000);
    expect(mocks.cloudSchedules).toHaveBeenCalledTimes(1);
    // Made an admin, or the feature turned on, since.
    mocks.cloudSchedules.mockResolvedValue({ schedules: [] });
    await probeSchedules("org-1", 1_000 + 11 * 60_000);
    expect(schedulesOffer("org-1")).toBe("offered");
  });
});
