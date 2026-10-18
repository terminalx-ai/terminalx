import { describe, expect, it } from "vitest";
import type { AgentEvent, Payload } from "@terminalx/portable/events";
import { buildTranscript } from "@terminalx/portable/transcript";
import type { ChatNote } from "../data/host-api";
import { conversationItems, type ConversationItem } from "./conversation-items";

const at = (seq: number, ts: string, payload: Payload): AgentEvent => ({ id: `e${seq}`, sessionId: "worktree", tabId: "claude", harness: "claude", seq, ts, payload } as AgentEvent);
const note = (id: string, body: string, createdAt: string, extra: Partial<ChatNote> = {}): ChatNote => ({ id, body, createdAt: Date.parse(createdAt), author: { userId: "user-1", displayName: "Paresh" }, ...extra });
const rows = (events: AgentEvent[], notes: ChatNote[], tabId = "claude") => conversationItems(buildTranscript(events, true).turns, notes, tabId).map(describeRow);
const describeRow = (item: ConversationItem) => item.kind === "note" ? `note: ${item.note.body}`
  : item.row.kind === "prompt" ? `prompt: ${item.row.text}`
    : item.row.kind === "work" && "text" in item.row.item ? `${item.row.item.kind}: ${item.row.item.text}` : item.row.kind;
const sent = (text: string, seq = 2, ts = "2026-10-18T10:00:01Z", queued = false) => at(seq, ts, { type: "user_message", text, queued });

describe("a session's conversation rows (#541)", () => {
  it("shows a note sent to this tab's agent once, as the prompt it became", () => {
    const promoted = note("n1", "run the tests", "2026-10-18T10:00:00Z", { promotedTo: [{ tabId: "claude", seq: 2 }] });
    expect(rows([sent("run the tests")], [promoted])).toEqual(["prompt: run the tests"]);
  });

  it("still shows that note in a conversation it was not sent to", () => {
    const promoted = note("n1", "run the tests", "2026-10-18T10:00:00Z", { promotedTo: [{ tabId: "codex", seq: 4 }] });
    expect(rows([sent("run the tests")], [promoted])).toEqual(["note: run the tests", "prompt: run the tests"]);
  });

  it("shows a worktree note once, between the turns around it", () => {
    const events = [sent("first", 1, "2026-10-18T09:00:00Z"), sent("second", 2, "2026-10-18T11:00:00Z")];
    expect(rows(events, [note("n1", "deploying at 5", "2026-10-18T10:00:00Z")])).toEqual(["prompt: first", "note: deploying at 5", "prompt: second"]);
  });

  it("takes an unmarked note an older phone sent to the agent for the message it became", () => {
    const events = [sent("run the tests")];
    expect(rows(events, [note("n1", "run the tests", "2026-10-18T10:00:00Z")])).toEqual(["prompt: run the tests"]);
    // The retry after a failed promotion saved the text a second time.
    expect(rows(events, [note("n1", "run the tests", "2026-10-18T09:59:40Z"), note("n2", "run the tests", "2026-10-18T10:00:00Z")])).toEqual(["prompt: run the tests"]);
    // Held while the agent was busy, the message is still one row.
    const busy = [sent("start", 1, "2026-10-18T09:59:00Z"), sent("run the tests", 2, "2026-10-18T10:00:01Z", true)];
    expect(rows(busy, [note("n1", "run the tests", "2026-10-18T10:00:00Z")])).toEqual(["prompt: start", "queued: run the tests"]);
  });

  it("keeps an unmarked note that is not that message", () => {
    const later = [sent("run the tests", 2, "2026-10-18T10:05:00Z")];
    expect(rows(later, [note("n1", "run the tests", "2026-10-18T10:00:00Z")])).toEqual(["note: run the tests", "prompt: run the tests"]);
    const earlier = [sent("run the tests", 2, "2026-10-18T09:59:59Z")];
    expect(rows(earlier, [note("n1", "run the tests", "2026-10-18T10:00:00Z")])).toEqual(["prompt: run the tests", "note: run the tests"]);
    const someoneElse = [at(2, "2026-10-18T10:00:01Z", { type: "user_message", author: { userId: "user-2", displayName: "Sam" }, text: "run the tests", queued: false })];
    expect(rows(someoneElse, [note("n1", "run the tests", "2026-10-18T10:00:00Z")])).toEqual(["note: run the tests", "prompt: run the tests"]);
    // A note marked as sent elsewhere is not guessed about here.
    expect(rows([sent("run the tests")], [note("n1", "run the tests", "2026-10-18T10:00:00Z", { promotedTo: [{ tabId: "codex", seq: 4 }] })])).toEqual(["note: run the tests", "prompt: run the tests"]);
  });
});
