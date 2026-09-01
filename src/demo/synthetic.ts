import type { AgentEvent, Payload } from "@/types/events";

/** A plausible long conversation: prompts, tool calls, answers. */
export function syntheticLog(turns: number, liveLast: boolean): AgentEvent[] {
  const out: AgentEvent[] = [];
  let seq = 0;
  const push = (payload: Payload) => {
    seq++;
    out.push({
      id: `e${seq}`,
      sessionId: "demo",
      tabId: "demo-tab",
      harness: "claude",
      seq,
      ts: new Date(1_700_000_000_000 + seq * 4000).toISOString(),
      payload,
    });
  };
  for (let i = 0; i < turns; i++) {
    push({ type: "user_message", text: `Turn ${i + 1}: refactor module ${i} and explain the change.`, queued: false });
    push({ type: "reasoning", text: "Looking at the module structure before touching anything." });
    for (let k = 0; k < 3; k++) {
      const id = `c${i}-${k}`;
      push({ type: "tool_call_started", callId: id, name: "Read", toolType: "file_read", input: { file_path: `/tmp/repo/src/mod${i}/file${k}.ts` }, title: "Read" });
      push({ type: "tool_call_completed", callId: id, result: { text: "export const x = 1;\n".repeat(20), isError: false } });
    }
    const edit = `e${i}`;
    push({ type: "tool_call_started", callId: edit, name: "Edit", toolType: "file_edit", input: { file_path: `/tmp/repo/src/mod${i}/index.ts` }, title: "Edit" });
    push({ type: "file_edits", callId: edit, edits: [{ path: `/tmp/repo/src/mod${i}/index.ts`, oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;\nconst c = 4;", kind: "update" }] });
    push({ type: "tool_call_completed", callId: edit, result: { text: "ok", isError: false } });
    const last = i === turns - 1;
    if (!(last && liveLast)) {
      push({
        type: "assistant_text",
        text: `## Module ${i}\n\nI changed **b** and added *c*. Here is the shape:\n\n\`\`\`ts\nexport function mod${i}() {\n  return ${i};\n}\n\`\`\`\n\n- one\n- two\n- three\n`,
      });
      push({ type: "turn_completed", status: "ok", durationMs: 12000 + i * 10, authFailed: false, usage: { contextUsed: 30000 + i * 100, contextMax: 200000 } });
    }
  }
  return out;
}
