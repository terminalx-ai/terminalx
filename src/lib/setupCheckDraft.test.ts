import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { dismissSetupCheckCoach, useSetupCheckCoach } from "./setupCheckDraft";

describe("setupCheckDraft coach dismissal (U-41)", () => {
  it("dismissSetupCheckCoach is a safe no-op for unknown tabs and dismisses active coach entries", () => {
    // Unknown tab: no-op without throwing.
    expect(() => dismissSetupCheckCoach("unknown-tab")).not.toThrow();

    // Seed localStorage with a pending coach entry and verify hook + dismissal.
    localStorage.setItem(
      "terminalx.setup-check-draft.v1",
      JSON.stringify([
        {
          orgId: "org-1",
          workspaceId: "ws-1",
          text: "Set up this computer",
          tabId: "tab-setup-check",
          coachDismissed: false,
          createdAt: Date.now(),
        },
      ]),
    );
    const { result } = renderHook(() => useSetupCheckCoach("tab-setup-check"));
    act(() => dismissSetupCheckCoach("tab-setup-check"));
    expect(result.current.show).toBe(false);
    localStorage.removeItem("terminalx.setup-check-draft.v1");
  });
});
