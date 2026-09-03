import { describe, expect, it } from "vitest";
import { bucketSessions, NO_FILTERS } from "@terminalx/portable/dashboard";
import { buildTranscript } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";

describe("portable mobile folds", () => {
  it("uses the desktop three-bucket session rules", () => {
    const base = { projectPath: "/code/app", cwd: "/code/app", title: "Task", modified: "2026-01-01T00:00:00Z", archived: false };
    const sessions = [
      { ...base, id: "needs", tabs: [{ harness: "codex", status: "waiting" as const }] },
      { ...base, id: "working", tabs: [{ harness: "codex", status: "in_progress" as const }] },
      { ...base, id: "done", tabs: [{ harness: "codex", status: "completed" as const }] },
    ];
    const buckets = bucketSessions(sessions, { query: "", filters: NO_FILTERS, projectName: () => "App" });
    expect(buckets.needs.map(({ id }) => id)).toEqual(["needs"]);
    expect(buckets.working.map(({ id }) => id)).toEqual(["working"]);
    expect(buckets.done.map(({ id }) => id)).toEqual(["done"]);
  });

  it("merges an ordered event page into the shared transcript model", () => {
    const event = (seq: number, payload: AgentEvent["payload"]): AgentEvent => ({ id: `event-${seq}`, sessionId: "session", tabId: "tab", harness: "codex", seq, ts: `2026-01-01T00:00:0${seq}Z`, payload });
    const events: AgentEvent[] = [
      event(1, { type: "user_message", text: "Check it", queued: false }),
      event(2, { type: "assistant_text", text: "Done" }),
      event(3, { type: "turn_completed", status: "ok", authFailed: false }),
    ];
    const transcript = buildTranscript(events, false);
    expect(transcript.turns).toHaveLength(1);
    expect(transcript.turns[0]?.prompt?.text).toBe("Check it");
    expect(transcript.turns[0]?.work).toContainEqual(expect.objectContaining({ kind: "text", text: "Done" }));
  });
});
