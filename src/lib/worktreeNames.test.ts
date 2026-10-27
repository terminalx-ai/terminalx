import { describe, expect, it } from "vitest";
import { isPlaceholderBranch, isWorktreeName, worktreeNameFromPrompt } from "./worktreeNames";

describe("worktree names", () => {
  it("knows a drawn name from one somebody chose, after any branch prefix", () => {
    expect(isWorktreeName("quiet-amber-fox")).toBe(true);
    expect(isWorktreeName("quiet-amber")).toBe(false);
    expect(isWorktreeName("main")).toBe(false);
    expect(isPlaceholderBranch("raccoon/calm-moss-robin")).toBe(true);
    expect(isPlaceholderBranch("dc/pricing-research")).toBe(false);
    expect(isPlaceholderBranch("feat/payments")).toBe(false);
  });
});

describe("worktreeNameFromPrompt", () => {
  it("keeps the words that say what the work is", () => {
    expect(worktreeNameFromPrompt("Can you please fix the login redirect on Safari?")).toBe("fix-login-redirect-safari");
    expect(worktreeNameFromPrompt("Add dark mode to the settings page and the sidebar too")).toBe("add-dark-mode-settings-page");
  });
  it("is empty for a prompt with nothing to name it by", () => {
    expect(worktreeNameFromPrompt("  ")).toBe("");
    expect(worktreeNameFromPrompt("can you please")).toBe("");
  });
});
