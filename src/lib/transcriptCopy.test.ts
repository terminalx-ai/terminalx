import { describe, expect, it } from "vitest";
import { transcriptText } from "./transcriptCopy";
import type { AgentEvent } from "@/types/events";

const at = (seq: number, payload: object): AgentEvent => ({ id: `e${seq}`, sessionId: "s", tabId: "t", harness: "claude", seq, ts: "2026-11-16T10:00:00Z", payload } as AgentEvent);

describe("a chat's transcript to copy (PRO-381)", () => {
  const events = [
    at(1, { type: "user_message", text: "Why is the test flaky?", queued: false }),
    at(2, { type: "turn_started" }),
    at(3, { type: "turn_completed", status: "ok", finalText: "It races the clock.", authFailed: false }),
    at(4, { type: "user_message", text: "Fix it", queued: false }),
    at(5, { type: "turn_started" }),
    at(6, { type: "turn_completed", status: "ok", finalText: "Done: it waits for the timer now.", authFailed: false }),
  ];

  it("is each prompt and its reply, as Markdown or as plain text", () => {
    expect(transcriptText(events, "markdown", "Claude Code")).toBe(
      "## You\n\nWhy is the test flaky?\n\n## Claude Code\n\nIt races the clock.\n\n## You\n\nFix it\n\n## Claude Code\n\nDone: it waits for the timer now.",
    );
    expect(transcriptText(events, "text", "Claude Code")).toBe(
      "You:\nWhy is the test flaky?\n\nClaude Code:\nIt races the clock.\n\nYou:\nFix it\n\nClaude Code:\nDone: it waits for the timer now.",
    );
  });

  it("is empty before anything was said", () => {
    expect(transcriptText([], "markdown", "Codex")).toBe("");
  });
});
