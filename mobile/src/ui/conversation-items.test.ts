import { describe, expect, it } from "vitest";
import type { Turn } from "@terminalx/portable/transcript";
import type { ChatNote } from "@mobile/data/host-api";
import { conversationItems } from "./conversation-items";

const ts = "2026-10-20T10:00:00.000Z";
const at = Date.parse(ts);
const turn = (text: string, author?: { userId: string; displayName: string }): Turn => ({ key: "t5", seq: 5, ts, prompt: { text, author, ts, seq: 5 }, work: [], toolCount: 0, editedFiles: 0, live: false });
const note = (body: string, createdAt: number, extra: Partial<ChatNote> = {}): ChatNote => ({ id: "n", body, createdAt, author: { userId: "me", displayName: "Paresh" }, ...extra });
const kinds = (turns: Turn[], notes: ChatNote[], tabId = "claude") => conversationItems(turns, notes, tabId).map((item) => item.kind);

describe("one row per message sent to the agent (#541)", () => {
  it("leaves out a note promoted to this tab, however long before its prompt it was saved", () => {
    const promoted = note("Ship it", at - 86_400_000, { promotedTo: [{ tabId: "claude", seq: 5 }] });
    expect(conversationItems([turn("Ship it")], [promoted], "claude")).toEqual([expect.objectContaining({ kind: "turn", row: expect.objectContaining({ kind: "prompt", text: "Ship it" }) })]);
    expect(kinds([turn("codex transcript")], [promoted], "codex")).toEqual(["note", "turn"]);
  });

  it("leaves out an unrecorded note an older phone saved moments before the same prompt", () => {
    for (const before of [0, 1_200, 30_000]) expect(kinds([turn("Ship it")], [note("Ship it", at - before)])).toEqual(["turn"]);
    expect(kinds([turn("  Ship it\n")], [note("Ship it", at - 500)])).toEqual(["turn"]);
  });

  it("keeps a note that does not match a prompt sent just after it", () => {
    expect(kinds([turn("Ship it")], [note("Ship it", at - 30_001)])).toEqual(["note", "turn"]);
    expect(kinds([turn("Ship it")], [note("Ship it", at + 1)])).toEqual(["turn", "note"]);
    expect(kinds([turn("Ship it now")], [note("Ship it", at - 500)])).toEqual(["note", "turn"]);
    expect(kinds([turn("Ship it", { userId: "someone-else", displayName: "Sam" })], [note("Ship it", at - 500)])).toEqual(["note", "turn"]);
    expect(kinds([turn("Ship it", { userId: "me", displayName: "Paresh" })], [note("Ship it", at - 500)])).toEqual(["turn"]);
  });

  it("matches a message still queued inside a running turn", () => {
    const running: Turn = { ...turn("Earlier prompt"), ts: new Date(at - 60_000).toISOString(), prompt: undefined, work: [{ kind: "queued", text: "Then this", key: "q9", seq: 9, ts }] };
    expect(kinds([running], [note("Then this", at - 800)])).toEqual(["turn"]);
  });
});
