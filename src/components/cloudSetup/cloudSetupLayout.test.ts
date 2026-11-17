import { describe, expect, it } from "vitest";
import { coachAnchorRect } from "./SetupCheckCoach";
import { inviteeName, personColor } from "./InviteStep";

describe("setup check coach (PRO-389)", () => {
  it("points across Send from the composer box's top edge, so the card sits above the box", () => {
    const rect = coachAnchorRect(new DOMRect(1170, 790, 28, 28), new DOMRect(500, 700, 700, 130));
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([1170, 700, 28, 0]);
  });

  it("falls back to Send itself outside a composer box", () => {
    expect(coachAnchorRect(new DOMRect(10, 20, 28, 28), null).y).toBe(20);
  });
});

describe("pending invitation rows (PRO-389)", () => {
  it("makes a name from the address", () => {
    expect(inviteeName("ana.kim@example.com")).toBe("Ana Kim");
    expect(inviteeName("sam+work@example.com")).toBe("Sam");
  });

  it("keeps one colour per person", () => {
    expect(personColor("Ana.Kim@example.com")).toBe(personColor("ana.kim@example.com"));
    expect(new Set(["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io", "f@x.io"].map(personColor)).size).toBeGreaterThan(1);
  });
});
