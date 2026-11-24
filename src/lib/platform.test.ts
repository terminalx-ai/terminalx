import { describe, expect, it } from "vitest";
import { PLATFORM_PROFILES, detectPlatform, hostFamily, profile, profileFor, thisComputer } from "./platform";

describe("the computer's platform", () => {
  it("takes the system the desktop app names over what the browser reports", () => {
    expect(detectPlatform("windows", "MacIntel")).toBe("windows");
    expect(detectPlatform("macos", "Win32")).toBe("macos");
    expect(detectPlatform("linux", "")).toBe("linux");
  });

  it("falls back to the browser's platform outside the app, and to none it does not know", () => {
    expect(detectPlatform(undefined, "MacIntel")).toBe("macos");
    expect(detectPlatform(undefined, "iPad")).toBe("macos");
    expect(detectPlatform(undefined, "Win32")).toBe("windows");
    expect(detectPlatform(undefined, "Linux x86_64")).toBe("linux");
    expect(detectPlatform("plan9", "")).toBeNull();
  });

  it("names the computer by its system, and an unknown one by plain nouns", () => {
    expect([profileFor("macos").thisComputer, profileFor("windows").thisComputer, profileFor("linux").thisComputer]).toEqual(["this Mac", "this PC", "this computer"]);
    expect(profileFor("plan9")).toBe(PLATFORM_PROFILES.linux);
    expect(profileFor(null).ThisComputer).toBe("This computer");
  });

  it("gives every system every word, with shortcut keys drawn as each system draws them", () => {
    for (const [family, words] of Object.entries(PLATFORM_PROFILES)) {
      for (const key of ["osName", "computerWord", "thisComputer", "ThisComputer", "yourComputer"] as const) expect(words[key], `${family}.${key}`).toMatch(/\S/);
      expect(words.ThisComputer[0], family).toBe(words.ThisComputer[0].toUpperCase());
    }
    expect([PLATFORM_PROFILES.macos.keyStyle, PLATFORM_PROFILES.macos.keyJoiner]).toEqual(["symbols", ""]);
    expect([PLATFORM_PROFILES.windows.keyStyle, PLATFORM_PROFILES.windows.keyJoiner]).toEqual(["words", "+"]);
  });

  it("speaks of a test's computer, which names no system, as a plain computer", () => {
    expect(hostFamily).toBeNull();
    expect(profile).toBe(PLATFORM_PROFILES.linux);
    expect(thisComputer).toBe("this computer");
  });
});
