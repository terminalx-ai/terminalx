import { describe, expect, it } from "vitest";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";

describe("cloudAgentLabel", () => {
  it.each([
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["  unknown-agent  ", "unknown-agent"],
    ["", "Agent"],
    ["  ", "Agent"],
    ["claude", "Claude Code"],
    ["CODEX", "Codex"],
    ["cursor", "Cursor"],
    ["opencode", "OpenCode"],
  ])("labels %j as %j", (harness, label) => {
    expect(cloudAgentLabel(harness)).toBe(label);
  });
});
