import { describe, expect, it } from "vitest";
import { ORCHESTRATE_TITLE, PLAN_A_RUN_PROMPT, orchestrateOffered, orchestratePrompt } from "./orchestrateStart";
import { PLAN_A_RUN_PROMPT as RUN_VIEW_PROMPT } from "@/components/orchestration/RunView";

describe("Orchestrate (PRO-337)", () => {
  const localGit = { local: true, git: true };

  it("is offered only with Orchestration runs on, for a session that could lead a run", () => {
    expect(orchestrateOffered(true, localGit)).toBe(true);
    // The Experimental switch off, or not read yet.
    expect(orchestrateOffered(false, localGit)).toBe(false);
    expect(orchestrateOffered(undefined, localGit)).toBe(false);
    // Where SessionView's canLead or isGit is false.
    expect(orchestrateOffered(true, { local: true, git: false })).toBe(false);
    expect(orchestrateOffered(true, { local: false, git: true })).toBe(false);
    expect(orchestrateOffered(true, { ...localGit, cloud: true })).toBe(false);
    expect(orchestrateOffered(true, { ...localGit, quick: true })).toBe(false);
    expect(orchestrateOffered(true, { ...localGit, compact: true })).toBe(false);
  });

  it("ends the first prompt with what Plan a run sends", () => {
    expect(RUN_VIEW_PROMPT).toBe(PLAN_A_RUN_PROMPT);
    const prompt = orchestratePrompt("Work on issue #12: Fix parser\n\nThe parser drops quotes.\n\nEnd every reply with a status block.");
    expect(prompt).toBe(`Work on issue #12: Fix parser\n\nThe parser drops quotes.\n\nEnd every reply with a status block.\n\n${PLAN_A_RUN_PROMPT}`);
    expect(prompt.endsWith(PLAN_A_RUN_PROMPT)).toBe(true);
    expect(orchestratePrompt("  ")).toBe(PLAN_A_RUN_PROMPT);
  });

  it("says in its tooltip that the run asks first", () => {
    expect(ORCHESTRATE_TITLE).toContain("waits for your Approve before any worker starts");
  });
});
