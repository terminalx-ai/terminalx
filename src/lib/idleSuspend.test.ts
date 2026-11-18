import { describe, expect, it } from "vitest";
import { idleSuspendCapNote, idleSuspendChoices, idleSuspendLabel, idleSuspendSentence, initialIdleSuspend } from "@/lib/idleSuspend";

describe("idle windows in words (PRO-410)", () => {
  it("names each window, and 0 as Never", () => {
    expect([0, 1, 5, 15, 60, 120, 90].map(idleSuspendLabel)).toEqual(["Never", "1 minute", "5 minutes", "15 minutes", "1 hour", "2 hours", "90 minutes"]);
  });

  it("ends a price with what happens when it sits idle", () => {
    expect(idleSuspendSentence(0)).toBe("It keeps running until you stop it.");
    expect(idleSuspendSentence(15)).toBe("It stops itself after 15 idle minutes.");
    expect(idleSuspendSentence(1)).toBe("It stops itself after 1 idle minute.");
  });

  it("offers the windows shortest first, then Never, without repeats or anything malformed", () => {
    expect(idleSuspendChoices([0, 60, 5, 15, 10, 30, 15, -1, 2.5])).toEqual([5, 10, 15, 30, 60, 0]);
    expect(idleSuspendChoices([])).toEqual([]);
  });

  it("explains a cap only when it takes Never away", () => {
    expect(idleSuspendCapNote(30, [5, 10, 15, 30])).toBe("Your organization stops idle workspaces after at most 30 minutes, so Never is not offered.");
    expect(idleSuspendCapNote(null, [5, 0])).toBeNull();
    expect(idleSuspendCapNote(undefined, [5])).toBeNull();
    expect(idleSuspendCapNote(30, [5, 0])).toBeNull();
  });

  it("starts on the choice made while it is offered, else the default, else the shortest", () => {
    expect(initialIdleSuspend([5, 15, 0], 15)).toBe(15);
    expect(initialIdleSuspend([5, 15, 0], 15, 0)).toBe(0);
    expect(initialIdleSuspend([5, 10], 15, 0)).toBe(5);
    expect(initialIdleSuspend([5, 10], 10, 60)).toBe(10);
    expect(initialIdleSuspend([], 15)).toBeNull();
  });
});
