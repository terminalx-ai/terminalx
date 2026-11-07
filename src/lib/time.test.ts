import { expect, it } from "vitest";
import { recentTime } from "./time";

const now = Date.parse("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const H = 3_600_000;

it("gives an age for the last six days, and none older", () => {
  expect(recentTime(ago(5_000), now)).toBe("now");
  expect(recentTime(ago(8 * H), now)).toBe("8h");
  expect(recentTime(ago(6 * 24 * H), now)).toBe("6d");
  expect(recentTime(ago(8 * 24 * H), now)).toBe("");
  expect(recentTime("not a date", now)).toBe("");
});
