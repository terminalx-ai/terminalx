import { describe, expect, it } from "vitest";
import { chosenSessionName, generatedSessionName, isReferenceName, promptReference } from "./sessionNames";

// The same cases as src-tauri/src/session_names.rs: the two must agree.
describe("generatedSessionName", () => {
  it("leaves a prompt of one sentence alone", () => {
    expect(generatedSessionName("Fix the login bug")).toBeNull();
    expect(generatedSessionName("  ")).toBeNull();
  });

  it("leads with a ticket or PR reference", () => {
    expect(generatedSessionName("Implement PRO-123: short generated names. Read the code first and then change it.")).toBe("PRO-123 Short generated names");
    expect(generatedSessionName("Review #456 and leave comments. Be thorough about the tests.")).toBe("#456 Review and leave comments");
    const issue = "Work on Linear issue ENG-42: Fix login timeout\n\nUsers get logged out.\n\nIssue link: https://linear.app/acme/issue/ENG-42\nWhen done, summarise what changed.";
    expect(generatedSessionName(issue)).toBe("ENG-42 Fix login timeout");
    const pr = "Tidy it up.\n\nContinue work on pull request #12: Speed up the sidebar\nhttps://github.com/o/r/pull/12";
    expect(generatedSessionName(pr)).toBe("#12 Speed up the sidebar");
    expect(isReferenceName("Review #456 and leave comments. Be thorough.")).toBe(true);
  });

  it("skips role preambles", () => {
    expect(generatedSessionName("You are the owner's chief of staff for the company. Please triage the support inbox every morning, then report.")).toBe("Triage the support inbox every morning");
    expect(generatedSessionName("Continue work from the last session. Add dark mode to the settings page. Keep tests green.")).toBe("Add dark mode to the settings");
    expect(generatedSessionName("## Goal\n\nMake the sidebar names readable at a glance.\n\n## Why\n\nThey all look alike.")).toBe("Make the sidebar names readable");
  });

  it("skips the attribution line", () => {
    expect(generatedSessionName('[TerminalX Effective User v1] {"authority":"host","userId":"u"}\nPlease fix sign in on the phone. It loops.')).toBe("Fix sign in on the phone");
  });

  it("is at most six words and deterministic", () => {
    const prompt = "Refactor the session list rendering code so that it stops reallocating on every frame. More detail follows.";
    expect(generatedSessionName(prompt)).toBe("Refactor the session list rendering code");
    expect(generatedSessionName(prompt)).toBe(generatedSessionName(prompt));
  });

  it("takes only upper-case keys as references", () => {
    expect(promptReference("see pro-12 and utf-8 and ABC-x")).toBeNull();
    expect(promptReference("see (PRO-12), please")).toBe("PRO-12");
  });
});

describe("chosenSessionName", () => {
  it("prefers a reference name, then the agent's title, then the clause", () => {
    expect(chosenSessionName("Implement PRO-123: short names. Read the code first.", "Session naming")).toBe("PRO-123 Short names");
    const plain = "You are a careful engineer. Speed up the sidebar. Measure first.";
    expect(chosenSessionName(plain, "Sidebar performance")).toBe("Sidebar performance");
    expect(chosenSessionName(plain)).toBe("Speed up the sidebar");
    expect(chosenSessionName("Fix it")).toBeNull();
    expect(chosenSessionName("Fix it", "Fix a bug")).toBe("Fix a bug");
  });
});
