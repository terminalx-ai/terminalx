import { describe, expect, it } from "vitest";
import { describeSchedule } from "@/lib/automationSchedule";
import type { AutomationSchedule } from "@/types/automations";

function schedule(patch: Partial<AutomationSchedule>): AutomationSchedule {
  return {
    kind: "preset",
    preset: "weekdays",
    hour: 9,
    minute: 0,
    weekdays: [],
    timezone: "Asia/Dubai",
    dtstart: "2026-09-02T09:00:00+04:00",
    ...patch,
  };
}

describe("describeSchedule", () => {
  it("writes the weekday preset as a sentence", () => {
    expect(describeSchedule(schedule({}))).toBe("Weekdays at 09:00");
  });

  it("recognises a five-minute cron schedule", () => {
    expect(describeSchedule(schedule({ kind: "cron", preset: undefined, cron: "*/5 * * * *" }))).toBe("Every 5 minutes");
  });
});
