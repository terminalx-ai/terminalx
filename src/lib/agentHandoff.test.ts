import { describe, expect, it } from "vitest";
import { otherAgent, secondOpinionPrompt, SECOND_OPINION_CHARS } from "./agentHandoff";
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
  it("bounds an oversized Claude Write and answer while keeping the edit inventory", () => {
    const selected = turn();
    selected.prompt!.text = "Prompt ".repeat(20_000);
    selected.work = [
      { kind: "text", key: "answer", seq: 3, text: "Answer ".repeat(20_000) },
      { kind: "message", key: "followup", seq: 2, text: "Follow-up ".repeat(20_000) },
      { kind: "tool", key: "write", call: call([{ path: "generated.ts", kind: "create", newText: Array(20_000).fill("export const generated = true;").join("\n") }], { name: "Write" }) },
      { kind: "tool", key: "other", call: call([{ path: "small.ts", kind: "update", oldText: "before", newText: "after" }]) },
    ];
    const prompt = secondOpinionPrompt(selected);
    expect(prompt.length).toBeLessThanOrEqual(SECOND_OPINION_CHARS);
    expect(prompt).toContain('"generated.ts" (create): +20000/-0 lines');
    expect(prompt).toContain('"small.ts" (update): +1/-1 lines');
    expect(prompt).toContain("[Truncated to fit the second-opinion prompt.]");
    expect(prompt).toContain("+export const generated = true;");
    expect(prompt).toContain("-before");
    expect(prompt).toContain("+after");
    expect(prompt).toContain("read the named paths from the workspace");
    expect(prompt).toContain("current files may differ");
  });
  it("caps total Codex patch bodies without losing later paths or line counts", () => {
    const selected = turn();
    selected.work.push({ kind: "tool", key: "patch", call: call(Array.from({ length: 12 }, (_, i) => ({ path: `file-${i}.ts`, kind: "update", unified: `@@ -1 +1,10000 @@\n-old\n${Array(10_000).fill("+new").join("\n")}` }))) });
    const prompt = secondOpinionPrompt(selected);
    expect(prompt.length).toBeLessThanOrEqual(SECOND_OPINION_CHARS);
    expect(prompt).toContain("Diff bodies omitted for");
    for (let i = 0; i < 12; i++) expect(prompt).toContain(`"file-${i}.ts" (update): +10000/-1 lines`);
  });
  it("shares a file's body budget across repeated edits", () => {
    const selected = turn();
    selected.work.push({ kind: "tool", key: "repeated", call: call([
      { path: "file.ts", kind: "create", newText: "x".repeat(100_000) },
      { path: "file.ts", kind: "update", unified: "-first\n+second" },
    ]) });
    const prompt = secondOpinionPrompt(selected);
    expect(prompt).toContain("this file's preview limit was reached");
    expect(prompt).toContain('"file.ts" (update): +1/-1 lines');
    expect(prompt).not.toContain("+second");
  });
  it("bounds even an oversized inventory and malicious fence runs without cutting open a fence", () => {
    const selected = turn();
    selected.prompt!.text = "`".repeat(50_000);
    selected.work.push({ kind: "text", key: "huge-answer", seq: 5, text: "😀".repeat(30_000) });
    selected.work.push({ kind: "tool", key: "many", call: call(Array.from({ length: 3_000 }, (_, i) => ({ path: `${i}-${"`".repeat(600)}`, kind: "create", newText: "😀".repeat(3_100) }))) });
    const prompt = secondOpinionPrompt(selected);
    expect(prompt.length).toBeLessThanOrEqual(SECOND_OPINION_CHARS);
    expect(prompt).toContain("additional edits omitted from this list");
    let fence: string | null = null;
    for (const line of prompt.split("\n")) {
      if (fence) {
        if (line === fence) fence = null;
        else if (/^`+$/.test(line)) expect(line.length).toBeLessThan(fence.length);
      } else {
        const opening = /^(`{3,})(?:text|diff)$/.exec(line);
        if (opening) fence = opening[1];
      }
    }
    expect(fence).toBeNull();
    expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
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
