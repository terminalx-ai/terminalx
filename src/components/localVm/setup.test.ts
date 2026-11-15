import { describe, expect, it } from "vitest";
import { sessionLabel } from "./setup";

describe("the guest session's state", () => {
  it("names a guest no one is signed in to, and one whose screen may be locked (review 2)", () => {
    expect(sessionLabel({ state: "blocked", reasonCode: "guest_gui_session_unavailable" })).toMatch(/^Login needed/);
    expect(sessionLabel({ state: "unknown", reasonCode: "guest_screen_unlock_unverified" })).toMatch(/may be locked/);
    // Neither reads as merely paused or unverified any more.
    for (const label of [sessionLabel({ state: "blocked", reasonCode: "guest_gui_session_unavailable" }), sessionLabel({ state: "unknown", reasonCode: "guest_screen_unlock_unverified" })]) {
      expect(label).not.toMatch(/^(Paused|Not verified)$/);
    }
    expect(sessionLabel({ state: "ready", reasonCode: "" })).toBe("Connected");
  });
});
