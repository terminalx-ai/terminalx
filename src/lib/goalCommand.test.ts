import { expect, it } from "vitest";
import { goalCommandProblem } from "./goalCommand";

it("preserves provider-defined goal commands and the composer's attachment policy", () => {
  expect(goalCommandProblem("/goal objective", "claude")).toBe("unsupported");
  expect(goalCommandProblem("/goal objective", "claude", true)).toBe("unsupported");
  expect(goalCommandProblem("/goal objective", "claude", false, [{ name: "goal" }])).toBeNull();
  expect(goalCommandProblem("/goal", "codex")).toBe("empty");
  expect(goalCommandProblem("/goal", "codex", true)).toBeNull();
  for (const text of ["/goal objective", "/goal pause", "/goal resume", "ordinary text", "/goals"]) {
    expect(goalCommandProblem(text, "codex")).toBeNull();
  }
});
