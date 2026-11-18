import { expect, it } from "vitest";
import { handOffText, logSteps, parseRunLog } from "./CheckLogTab";

it("reads gh's job, step and timestamp columns off each line, keeping the step", () => {
  const lines = parseRunLog("test\tSet up job\t2026-11-16T10:00:00.1234567Z Runner 2.320\ntest\tRun bun test\t2026-11-16T10:00:01Z ##[error]Process completed with exit code 1.\nplain line\n");
  expect(lines).toEqual([
    { step: "Set up job", text: "Runner 2.320" },
    { step: "Run bun test", text: "##[error]Process completed with exit code 1." },
    { step: null, text: "plain line" },
  ]);
  expect(logSteps(lines)).toEqual(["Set up job", "Run bun test"]);
});

it("says what Fix errors sends from the log tab", () => {
  expect(handOffText(1)).toBe("Send the failure to the agent. The logs go in as one attachment, trimmed to 256 KB.");
  expect(handOffText(2)).toBe("Send both failures to the agent. The logs go in as one attachment, trimmed to 256 KB.");
  expect(handOffText(3)).toBe("Send all 3 failures to the agent. The logs go in as one attachment, trimmed to 256 KB.");
});
