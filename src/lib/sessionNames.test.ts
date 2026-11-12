import { describe, expect, it } from "vitest";
import { generatedSessionName, isReferenceName, promptReference } from "./sessionNames";

describe("generatedSessionName", () => {
  it("leaves a prompt of one sentence alone", () => {
    expect(generatedSessionName("Fix the login bug")).toBeNull();
  });

  it("leads with a ticket or PR reference", () => {
    const name = generatedSessionName("Implement PRO-123: short generated names. Read the code first and then change it.")!;
    expect(name.startsWith("PRO-123 ")).toBe(true);
    expect(name.split(" ").length).toBeLessThanOrEqual(6);
    expect(generatedSessionName("Review #456 and leave comments. Be thorough about the tests.")!.split(" ")[0]).toBe("#456");
    expect(isReferenceName("Review #456 and leave comments. Be thorough.")).toBe(true);
  });

  it("skips role preambles", () => {
    expect(generatedSessionName("You are the owner's chief of staff for the company. Please triage the support inbox every morning, then report.")).toBe("Triage the support inbox every morning");
    expect(generatedSessionName("Continue work from the last session. Add dark mode to the settings page. Keep tests green.")).toBe("Add dark mode to the settings");
  });

  it("is at most six words and deterministic", () => {
    const prompt = "Refactor the session list rendering code so that it stops reallocating on every frame. More detail follows.";
    const name = generatedSessionName(prompt)!;
    expect(name.split(" ").length).toBeLessThanOrEqual(6);
    expect(generatedSessionName(prompt)).toBe(name);
  });

  it("takes only upper-case keys as references", () => {
    expect(promptReference("see pro-12 and utf-8 and ABC-x")).toBeNull();
    expect(promptReference("see (PRO-12), please")).toBe("PRO-12");
  });
});
