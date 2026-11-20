import { describe, expect, it } from "vitest";
import { TERMINAL_PROMPT_FAILED, terminalPromptError } from "./terminalPrompt";

describe("terminalPromptError", () => {
  it("says the runtime's own refusal as it is", () => {
    expect(terminalPromptError(new Error("runtime.session.terminalPrompt: That question is no longer showing in the agent's terminal.")))
      .toBe("That question is no longer showing in the agent's terminal.");
  });

  it("never echoes anything else", () => {
    expect(terminalPromptError("Could not reach the agent's terminal: Broken pipe (os error 32) at /Users/someone/x")).toBe(TERMINAL_PROMPT_FAILED);
  });
});
