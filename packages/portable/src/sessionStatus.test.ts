import { describe, expect, it } from "vitest";
import cases from "./sessionStatusCases.json";
import { combinedSessionStatus, SESSION_STATUSES, sessionStatus, type SessionStatusInput } from "./sessionStatus";

describe("session status shared by desktop, CLI and phone", () => {
  it.each(cases)("$name", ({ input, expected }) => {
    const before = structuredClone(input);
    expect(sessionStatus(input as SessionStatusInput).id).toBe(expected);
    expect(Object.keys(sessionStatus(input as SessionStatusInput)).sort()).toEqual(["color", "icon", "id", "label", "tooltip"]);
    expect(input).toEqual(before);
  });

  it("covers every label, icon, colour and tooltip", () => {
    expect(new Set(cases.map((test) => test.expected))).toEqual(new Set(SESSION_STATUSES.map((status) => status.id)));
    for (const status of SESSION_STATUSES) for (const field of [status.label, status.icon, status.color, status.tooltip]) expect(field).toBeTruthy();
  });

  it("keeps collapsed rows independent of session and tab order", () => {
    const inputs = cases.map((test) => test.input as SessionStatusInput);
    expect(combinedSessionStatus(inputs).id).toBe("needs_permission");
    expect(combinedSessionStatus(inputs.reverse()).id).toBe("needs_permission");
  });

  it("agent attention wins over every PR state", () => {
    for (const test of cases.filter((test) => "branchStatus" in test.input)) {
      for (const activity of ["needs_permission", "needs_answer", "review_plan"] as const) {
        expect(sessionStatus({ ...test.input, tabs: [{ status: "waiting", activity }] } as SessionStatusInput).id).toBe(activity);
      }
    }
  });
});
