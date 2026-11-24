import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@terminalx/portable/agentSettings";
import { BYPASS_NOT_FROM_PHONE, PHONE_DEFAULT_MODE, effortLabel, isPhoneMode, phoneMode, phoneModeLabel, phoneModes } from "./agent-settings";

// PRO-547 / PRO-548: what a phone may start an agent in. Never bypass, never nothing.
describe("the modes a phone offers", () => {
  it("are the desktop's four guarded modes, in its order, with its names and hints", () => {
    expect(phoneModes()).toEqual([
      { id: "plan", label: "Plan", hint: "Read and plan only; no edits or commands." },
      { id: "manual", label: "Ask every time", hint: "Every edit and command waits for you." },
      { id: "auto", label: "Auto", hint: "Routine actions are approved; risky ones ask." },
      { id: "acceptEdits", label: "Accept edits", hint: "File edits go through; commands still ask." },
    ]);
    // The desktop's list has five: the one left out is Bypass permissions.
    expect(PERMISSION_MODES.filter((mode) => !phoneModes().some((offered) => offered.id === mode.id)).map((mode) => mode.id)).toEqual(["bypassPermissions"]);
  });

  it("offer only what an agent lists, and never Bypass permissions even when it is listed first", () => {
    expect(phoneModes(["bypassPermissions", "manual", "acceptEdits"]).map((mode) => mode.id)).toEqual(["manual", "acceptEdits"]);
    expect(phoneModes(["bypassPermissions"])).toEqual([]);
    expect(phoneModes([])).toEqual([]);
  });

  it("start on Ask every time", () => {
    expect(PHONE_DEFAULT_MODE).toBe("manual");
    expect(phoneModeLabel(PHONE_DEFAULT_MODE)).toBe("Ask every time");
  });
});

describe("the mode a phone sends", () => {
  it("is one of the four, whatever it was handed: a runtime's default of bypass, a blank, or nothing becomes Ask every time", () => {
    for (const mode of ["plan", "manual", "auto", "acceptEdits"]) expect(phoneMode(mode)).toBe(mode);
    for (const mode of ["bypassPermissions", "bypass", "", null, undefined, "dontAsk", "default"]) expect(phoneMode(mode)).toBe("manual");
    expect(isPhoneMode("bypassPermissions")).toBe(false);
  });
});

it("says why Bypass permissions is missing in the owner's words", () => {
  expect(BYPASS_NOT_FROM_PHONE).toBe("Bypass permissions can't be chosen from a phone.");
});

it("names efforts as the app's pickers do", () => {
  expect(effortLabel("xhigh")).toBe("Extra high");
  expect(effortLabel("turbo")).toBe("turbo");
});
