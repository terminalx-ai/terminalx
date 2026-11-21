import { describe, expect, it } from "vitest";
import { CRON_WEEKDAYS, cronWeekdayCode } from "@/lib/automationSchedule";
import { FIRST_WEEK, LAST_WEEK, addDays, blockBox, dragTarget, dutyAt, eventsText, lanes, movedSchedule, oftenText, wallClock, weekLabel, weekShown, weekUnknown } from "@/lib/botCalendar";
import type { AutomationSchedule } from "@/types/automations";
import type { CalendarBlock } from "@/types/botCalendar";

const preset = (preset: AutomationSchedule["preset"], hour: number, minute: number, weekdays: string[] = [], timezone = "UTC"): AutomationSchedule =>
  ({ kind: "preset", preset, hour, minute, weekdays, timezone, dtstart: "2026-01-01T00:00:00Z" });
const cron = (expression: string, timezone = "UTC"): AutomationSchedule => ({ kind: "cron", cron: expression, weekdays: [], timezone, dtstart: "2026-01-01T00:00:00Z" });

describe("moving a duty by dragging its block (PRO-473)", () => {
  it("changes a daily or weekday duty's time, never its days", () => {
    expect(movedSchedule(preset("daily", 18, 0), { day: 4, minute: 1080 }, { day: 4, minute: 990 }, "UTC")).toEqual({ schedule: preset("daily", 16, 30) });
    expect(movedSchedule(preset("weekdays", 9, 0, ["MO", "TU", "WE", "TH", "FR"]), { day: 1, minute: 540 }, { day: 3, minute: 600 }, "UTC"))
      .toEqual({ schedule: preset("weekdays", 10, 0, ["MO", "TU", "WE", "TH", "FR"]) });
  });

  it("moves a weekly duty to the day and time it was dropped on, across midnight too", () => {
    expect(movedSchedule(preset("weekly", 11, 0, ["MO"]), { day: 0, minute: 660 }, { day: 2, minute: 840 }, "UTC")).toEqual({ schedule: preset("weekly", 14, 0, ["WE"]) });
    expect(movedSchedule(preset("weekly", 23, 0, ["SU"]), { day: 6, minute: 1380 }, { day: 0, minute: 30 }, "UTC")).toEqual({ schedule: preset("weekly", 0, 30, ["MO"]) });
  });

  it("shifts a schedule kept in another time zone by the same amount", () => {
    // 09:00 in New York is drawn at 14:00 in the owner's UTC week; dropped at 15:30, it becomes 10:30 in New York.
    expect(movedSchedule(preset("daily", 9, 0, [], "America/New_York"), { day: 2, minute: 840 }, { day: 2, minute: 930 }, "UTC"))
      .toEqual({ schedule: preset("daily", 10, 30, [], "America/New_York") });
  });

  it("moves a simple cron schedule, and says why it leaves others as they are", () => {
    expect(movedSchedule(cron("0 9 * * 2"), { day: 0, minute: 540 }, { day: 1, minute: 615 }, "UTC")).toEqual({ schedule: cron("15 10 * * 3") });
    expect(movedSchedule(cron("0 10,14 * * *"), { day: 2, minute: 840 }, { day: 2, minute: 960 }, "UTC")).toEqual({ schedule: cron("0 10,16 * * *") });
    expect(movedSchedule(cron("0 10,14 * * *"), { day: 2, minute: 840 }, { day: 2, minute: 870 }, "UTC")).toMatchObject({ reason: expect.stringMatching(/share the minute/) });
    expect(movedSchedule(cron("0 10,14 * * *"), { day: 2, minute: 840 }, { day: 2, minute: 600 }, "UTC")).toEqual({ reason: "It already wakes at that hour." });
    expect(movedSchedule(cron("0 9 * * *"), { day: 2, minute: 540 }, { day: 3, minute: 540 }, "UTC")).toMatchObject({ reason: expect.stringMatching(/every day/) });
    expect(movedSchedule(cron("0 9 1 * *"), { day: 2, minute: 540 }, { day: 2, minute: 600 }, "UTC")).toMatchObject({ reason: expect.stringMatching(/cron schedule/) });
    // 01:00 in New York is drawn at 06:00 UTC; dropped at 00:00 it would be the evening before there.
    expect(movedSchedule(cron("0 1 * * *", "America/New_York"), { day: 2, minute: 360 }, { day: 2, minute: 0 }, "UTC")).toMatchObject({ reason: expect.stringMatching(/same day/) });
  });
});

describe("the week's grid and rows", () => {
  it("puts blocks that would cover each other side by side, and lone ones full width", () => {
    const block = (day: number, minute: number): CalendarBlock => ({ dutyId: `${day}-${minute}`, botId: "b", day, minute, at: "", state: "next", count: 1 });
    const placed = lanes([block(0, 600), block(0, 610), block(0, 900), block(1, 600), block(0, 640), block(0, 620)]);
    expect([0, 1, 2, 3, 4, 5].map((index) => placed.get(index))).toEqual([
      // 10:00, 10:10 and 10:20 need three lanes; 10:40 takes the first one back, once 10:00 has ended.
      { lane: 0, of: 3 }, { lane: 1, of: 3 }, { lane: 0, of: 1 }, { lane: 0, of: 1 }, { lane: 0, of: 3 }, { lane: 2, of: 3 },
    ]);
  });

  it("draws a long run at its length, beside what starts during it, and one near midnight inside its day (PRO-497)", () => {
    const block = (minute: number, minutes?: number): CalendarBlock => ({ dutyId: `${minute}`, botId: "b", day: 0, minute, at: "", state: "done", count: 1, minutes });
    // 10:00 for two hours: 11:30 starts during it; 12:30 after it.
    const placed = lanes([block(600, 120), block(690), block(750)]);
    expect([0, 1, 2].map((index) => placed.get(index))).toEqual([{ lane: 0, of: 2 }, { lane: 1, of: 2 }, { lane: 0, of: 1 }]);
    expect(blockBox(block(600, 120))).toEqual({ top: 10 * 46 + 1, height: 2 * 46 - 2 });
    expect(blockBox(block(600))).toEqual({ top: 10 * 46 + 1, height: 22 });
    // Ends inside the day: 23:50 moved up; a run past midnight cut at it.
    const late = blockBox(block(23 * 60 + 50));
    expect(late.top + late.height).toBeLessThanOrEqual(24 * 46);
    const across = blockBox(block(23 * 60, 180));
    expect([across.top, across.top + across.height]).toEqual([23 * 46 + 1, 24 * 46 - 1]);
    // Two near midnight still go side by side where they are drawn.
    const ends = lanes([block(23 * 60 + 40), block(23 * 60 + 55)]);
    expect([0, 1].map((index) => ends.get(index)?.of)).toEqual([2, 2]);
  });

  it("knows an older runtime's answer to the week it does not know", () => {
    expect(weekUnknown("Unknown bots operation dutyWeek")).toBe(true);
    expect(weekUnknown("Unknown bots operation dutyWeeks")).toBe(false);
    expect(weekUnknown("The runtime could not read the week.") || weekUnknown(null)).toBe(false);
  });

  it("words a counted row for the days before today, today and the days to come", () => {
    const count = { ran: 78, reports: 0, failed: 0, planned: 0, scheduled: 96, notKept: 0, capped: false };
    expect(oftenText(count, "past", true)).toBe("78 checks · quiet");
    expect(oftenText({ ...count, reports: 2 }, "past", true, false)).toBe("78 · 2 reports");
    expect(oftenText({ ...count, ran: 33, reports: 1 }, "today", true)).toBe("33 so far · 1 report");
    expect(oftenText({ ...count, ran: 0, planned: 40 }, "future", true)).toBe("40 to come");
    expect(oftenText({ ...count, ran: 0, scheduled: 0 }, "future", true)).toBe("off that day");
    expect(oftenText({ ...count, ran: 0 }, "past", false)).toBe("–");
    expect(eventsText({ ...count, ran: 6 }, "past", true)).toBe("6 events · quiet");
    expect(eventsText({ ...count, ran: 9, reports: 1 }, "past", true, false)).toBe("9 · 1 report");
    expect(eventsText({ ...count, ran: 0 }, "future", true)).toBe("as they arrive");
    expect(eventsText({ ...count, ran: 0, failed: 0 }, "future", false)).toBe("–");
    // A day a log no longer reaches back over: never "none ran", and what is kept is a floor.
    expect(oftenText({ ...count, ran: 0, notKept: 1 }, "past", true)).toBe("history not kept");
    expect(oftenText({ ...count, ran: 28, notKept: 1 }, "past", true)).toBe("at least 28 checks · quiet");
    expect(oftenText({ ...count, ran: 5, notKept: 1 }, "today", true)).toBe("at least 5 so far · quiet");
    expect(eventsText({ ...count, ran: 0, notKept: 1 }, "past", true)).toBe("history not kept");
    expect(eventsText({ ...count, ran: 3, notKept: 1 }, "past", true)).toBe("at least 3 events · quiet");
    expect(oftenText({ ...count, ran: 0, planned: 400, capped: true }, "future", true)).toBe("at least 400 to come");
  });

  it("moves a dragged block by whole steps from its own time", () => {
    // A step is 15 minutes: 11.5 pixels.
    expect(dragTarget({ day: 2, minute: 600 }, 2, 11)).toEqual({ day: 2, minute: 600 });
    expect(dragTarget({ day: 2, minute: 600 }, 2, 11.5)).toEqual({ day: 2, minute: 615 });
    expect(dragTarget({ day: 2, minute: 600 }, 3, -23)).toEqual({ day: 3, minute: 570 });
    expect(dragTarget({ day: 2, minute: 610 }, 2, 12)).toEqual({ day: 2, minute: 625 });
    expect(dragTarget({ day: 2, minute: 10 }, 2, -100)).toEqual({ day: 2, minute: 0 });
    expect(dragTarget({ day: 2, minute: 1420 }, 2, 100)).toEqual({ day: 2, minute: 1425 });
  });

  it("numbers cron days as the scheduler does, 1 = Sunday to 7 = Saturday, and moves a duty to every weekday", () => {
    expect(CRON_WEEKDAYS).toEqual({ SU: 1, MO: 2, TU: 3, WE: 4, TH: 5, FR: 6, SA: 7 });
    expect(cronWeekdayCode(0)).toBeNull();
    expect(cronWeekdayCode(8)).toBeNull();
    // From Monday (2) at 09:00 to each day of the grid, Monday … Sunday.
    expect([0, 1, 2, 3, 4, 5, 6].map((day) => {
      const moved = movedSchedule(cron("0 9 * * 2"), { day: 0, minute: 540 }, { day, minute: 540 }, "UTC");
      return "schedule" in moved ? moved.schedule.cron : moved.reason;
    })).toEqual(["0 9 * * 2", "0 9 * * 3", "0 9 * * 4", "0 9 * * 5", "0 9 * * 6", "0 9 * * 7", "0 9 * * 1"]);
    // From Saturday (7) and Sunday (1), across the week's end.
    expect(movedSchedule(cron("0 9 * * 7"), { day: 5, minute: 540 }, { day: 6, minute: 540 }, "UTC")).toEqual({ schedule: cron("0 9 * * 1") });
    expect(movedSchedule(cron("0 9 * * 1"), { day: 6, minute: 540 }, { day: 0, minute: 540 }, "UTC")).toEqual({ schedule: cron("0 9 * * 2") });
    expect(movedSchedule(cron("0 9 * * 0"), { day: 6, minute: 540 }, { day: 0, minute: 540 }, "UTC")).toMatchObject({ reason: expect.stringMatching(/cron schedule/) });
  });

  it("stops the arrows at the weeks the runtime shows", () => {
    expect(weekShown(FIRST_WEEK) && weekShown(LAST_WEEK)).toBe(true);
    expect(weekShown(addDays(FIRST_WEEK, -7)) || weekShown(addDays(LAST_WEEK, 7))).toBe(false);
  });

  it("labels and steps weeks, and reads the clock in the owner's time zone", () => {
    expect(weekLabel(["2026-11-16", "", "", "", "", "", "2026-11-22"])).toBe("16–22 Nov");
    expect(weekLabel(["2026-11-30", "", "", "", "", "", "2026-12-06"])).toBe("30 Nov – 6 Dec");
    // PRO-497: another year's week says its year, and one across a new year both.
    expect(weekLabel(["2026-11-16", "", "", "", "", "", "2026-11-22"], "2026-11-20")).toBe("16–22 Nov");
    expect(weekLabel(["2025-11-17", "", "", "", "", "", "2025-11-23"], "2026-11-20")).toBe("17–23 Nov 2025");
    expect(weekLabel(["2027-03-29", "", "", "", "", "", "2027-04-04"], "2026-11-20")).toBe("29 Mar – 4 Apr 2027");
    expect(weekLabel(["2026-12-28", "", "", "", "", "", "2027-01-03"], "2026-11-20")).toBe("28 Dec 2026 – 3 Jan 2027");
    expect(addDays("2026-11-30", 7)).toBe("2026-12-07");
    expect(addDays("2026-01-05", -7)).toBe("2025-12-29");
    expect(wallClock("Asia/Tokyo", new Date("2026-11-16T15:30:00Z"))).toEqual({ ymd: "2026-11-17", minute: 30 });
    expect(wallClock("America/New_York", new Date("2026-11-16T15:30:00Z"))).toEqual({ ymd: "2026-11-16", minute: 10 * 60 + 30 });
  });

  it("starts a duty added at a clicked hour as a weekly one on that day, at that time, in the week's time zone", () => {
    expect(dutyAt(3, 15 * 60, "Europe/London").schedule).toMatchObject({ kind: "preset", preset: "weekly", weekdays: ["TH"], hour: 15, minute: 0, timezone: "Europe/London" });
  });
});
