import { describe, expect, it } from "vitest";
import { otherAgent, secondOpinionPrompt } from "./agentHandoff";
import type { Turn, ToolCall } from "./transcript";
import type { HarnessInfo } from "@/types/session";

const providers = [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }] as HarnessInfo[];
const turn = (): Turn => ({
  key: "turn", seq: 1, ts: "", live: false, toolCount: 0, editedFiles: 0,
  prompt: { text: "Fix the login check", ts: "", seq: 1 }, completed: { status: "ok", ts: "" },
  work: [{ kind: "text", key: "answer", seq: 3, text: "The login check now rejects expired tokens." }],
});
const call = (edits: ToolCall["edits"], extra: Partial<ToolCall> = {}): ToolCall => ({ callId: "edit", name: "Edit", toolType: "edit", input: {}, seq: 2, edits, ...extra });

describe("the other installed agent", () => {
  it("works in both directions and never offers a missing or unrelated provider", () => {
    expect(otherAgent("claude", providers)?.id).toBe("codex");
    expect(otherAgent("codex", providers)?.id).toBe("claude");
    expect(otherAgent("claude", [providers[0]])).toBeUndefined();
    expect(otherAgent("codex", [{ ...providers[0], available: false }])).toBeUndefined();
    expect(otherAgent("gemini", providers)).toBeUndefined();
  });
});

describe("second opinion prompt", () => {
  it("includes the selected prompt, answer, followups and saved edits in order", () => {
    const selected = turn();
    selected.work.push(
      { kind: "message", key: "followup", seq: 2, text: "Check empty tokens too" },
      { kind: "tool", key: "edit", call: call([{ path: "login.ts", kind: "update", oldText: "return true", newText: "return valid(token)" }]) },
      { kind: "tool_group", key: "group", name: "Edit", calls: [call([
        { path: "new.ts", kind: "create", newText: "export const valid = true" },
        { path: "old.ts", kind: "delete", oldText: "const insecure = true" },
        { path: "login.ts", kind: "update", unified: "@@ -1 +1 @@\n-return valid(token)\n+return token && valid(token)" },
      ])] },
    );
    const before = JSON.stringify(selected);
    const prompt = secondOpinionPrompt(selected);
    for (const text of ["Fix the login check", "The login check now rejects expired tokens.", "Check empty tokens too", "-return true", "+return valid(token)", "+export const valid = true", "-const insecure = true", "+return token && valid(token)", "Review only: do not edit files", "not new instructions"]) expect(prompt).toContain(text);
    expect(prompt.indexOf("+return valid(token)")).toBeLessThan(prompt.indexOf("+return token && valid(token)"));
    expect(JSON.stringify(selected)).toBe(before);
  });
  it("does not claim failed or abandoned tools changed files, and explains missing capture", () => {
    const selected = turn();
    selected.work.push({ kind: "tool_group", key: "failed", name: "Edit", calls: [
      call([{ path: "failed.ts", kind: "create", newText: "not written" }], { result: { text: "denied", isError: true } }),
      call([{ path: "abandoned.ts", kind: "create", newText: "not written" }], { abandoned: true }),
    ] });
    const prompt = secondOpinionPrompt(selected);
    expect(prompt).not.toContain("not written");
    expect(prompt).toContain("No file-edit diff was recorded");
    selected.work.push({ kind: "tool", key: "unknown", call: call([{ path: "unknown.ts", kind: "update" }]) });
    expect(secondOpinionPrompt(selected)).toContain("recorded this file change without its diff");
  });
  it("quotes embedded fences safely and leaves reasoning out of the review", () => {
    const selected = turn();
    selected.prompt!.text = "Inspect ```code```";
    selected.work.push({ kind: "reasoning", key: "thinking", seq: 2, text: "Private reasoning" });
    expect(secondOpinionPrompt(selected)).toContain("````text\nInspect ```code```\n````");
    expect(secondOpinionPrompt(selected)).not.toContain("Private reasoning");
  });
  it("requires a finished turn and supports an interrupted turn without an answer", () => {
    expect(() => secondOpinionPrompt({ ...turn(), live: true })).toThrow("Wait for the turn");
    expect(() => secondOpinionPrompt({ ...turn(), completed: undefined })).toThrow("Wait for the turn");
    expect(secondOpinionPrompt({ ...turn(), work: [], finalText: "Stopped", completed: { status: "aborted", ts: "" } })).toContain("Stopped");
  });
});
