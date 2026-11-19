import { expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@/types/events";
vi.mock("@/lib/sessions", () => ({ getSessions: () => ({ sessions: [] }), patchTab: vi.fn() }));
vi.mock("@/lib/notify", () => ({ noteStatusChange: vi.fn() }));
import { buildTranscript } from "@terminalx/portable/transcript";
import { applyEvent, dropTabLog, getTabLog } from "./agentEvents";

const event = (seq: number, payload: Payload): AgentEvent => ({ seq, ts: `2026-11-19T10:00:${String(seq).padStart(2, "0")}Z`, id: `e${seq}`, sessionId: "late-test", tabId: "tab", harness: "codex", payload });

// #1284: a follow-up queued on a native Codex tab. The runtime's broadcast of
// the queued message came first; the send's own reply carried the same event
// back after the agent had already taken it, started a turn for it and
// answered. Appended at the end, that copy drew a second, uncleared Queued
// card, took the new turn's prompt for itself, and left the chat out of step
// with the terminal until a history read put it right.
it("places a late copy of a queued message by seq, so the reply is drawn under the message", () => {
  const queued = event(3, { type: "user_message", queued: true, text: "and the tests?" });
  const live: AgentEvent[] = [
    event(1, { type: "user_message", queued: false, text: "fix the bug" }),
    event(2, { type: "assistant_text", text: "Looking." }),
    queued,
    ...Array.from({ length: 9 }, (_, i) => event(4 + i, { type: "reasoning", text: `step ${i}` })),
    event(13, { type: "turn_completed", status: "ok", authFailed: false }),
    event(14, { type: "turn_started", promptSeq: 3 }),
    event(15, { type: "assistant_text", text: "The tests pass." }),
  ];
  for (const ev of live) applyEvent(ev);
  // The send's reply, last.
  applyEvent({ ...queued });
  const log = getTabLog("late-test", "tab");
  expect(log.events.map((ev) => ev.seq)).toEqual(live.map((ev) => ev.seq));

  const transcript = buildTranscript(log.events, false);
  const queuedCards = transcript.turns.flatMap((turn) => turn.work.filter((item) => item.kind === "queued"));
  expect(queuedCards).toEqual([]);
  const answer = transcript.turns.find((turn) => turn.prompt?.seq === 3);
  expect(answer?.prompt?.text).toBe("and the tests?");
  expect(answer?.work).toEqual([expect.objectContaining({ kind: "text", text: "The tests pass." })]);
  dropTabLog("late-test", "tab");
});

it("places an event that arrives out of order where a history read would", () => {
  for (const seq of [1, 2, 4]) applyEvent(event(seq, { type: "assistant_text", text: `t${seq}` }));
  applyEvent(event(3, { type: "assistant_text", text: "t3" }));
  expect(getTabLog("late-test", "tab").events.map((ev) => ev.seq)).toEqual([1, 2, 3, 4]);
  // A saved event takes the place of an indicator at its seq; an indicator never displaces a saved one.
  applyEvent({ ...event(5, { type: "usage_update", contextUsed: 1 } as Payload), id: "u5" });
  applyEvent(event(6, { type: "assistant_text", text: "t6" }));
  applyEvent(event(5, { type: "assistant_text", text: "t5" }));
  applyEvent({ ...event(6, { type: "usage_update", contextUsed: 2 } as Payload), id: "u6" });
  expect(getTabLog("late-test", "tab").events.map((ev) => [ev.seq, ev.payload.type])).toEqual([[1, "assistant_text"], [2, "assistant_text"], [3, "assistant_text"], [4, "assistant_text"], [5, "assistant_text"], [6, "assistant_text"]]);
  dropTabLog("late-test", "tab");
});

it("a transcript draws a repeated message once", () => {
  const queued = event(2, { type: "user_message", queued: true, text: "next" });
  const transcript = buildTranscript([
    event(1, { type: "user_message", queued: false, text: "first" }),
    queued,
    event(3, { type: "turn_completed", status: "ok", authFailed: false }),
    event(4, { type: "turn_started", promptSeq: 2 }),
    queued,
    event(5, { type: "assistant_text", text: "answer" }),
  ], false);
  expect(transcript.turns.flatMap((turn) => turn.work.filter((item) => item.kind === "queued"))).toEqual([]);
  expect(transcript.turns.find((turn) => turn.prompt?.seq === 2)?.work).toEqual([expect.objectContaining({ kind: "text", text: "answer" })]);
});
