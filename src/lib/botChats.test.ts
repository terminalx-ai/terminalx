import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

vi.mock("@/lib/api", () => ({ botsApi: { homeChat: vi.fn(), newChat: vi.fn() } }));

const { botChats, botOf, botViewFor, listedUnderBot, spentToday } = await import("./botChats");

const session = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, kind: "quick", projectPath: `/scratch/${id}`, cwd: "/bots/b1", title: id, created: "2026-11-20T09:00:00Z", modified: "2026-11-20T09:00:00Z",
  archived: false, pinned: false, tabs: [], activeTab: null, ...extra,
} as SessionEntry);

describe("a bot's chats (PRO-468)", () => {
  it("are the sessions that name the bot, the home chat first, and the sessions they started", () => {
    const home = session("home", { bot: { id: "b1", home: true }, modified: "2026-11-20T08:00:00Z" });
    const older = session("older", { bot: { id: "b1" }, modified: "2026-11-20T09:00:00Z" });
    const newer = session("newer", { bot: { id: "b1" }, modified: "2026-11-20T10:00:00Z" });
    const archived = session("archived", { bot: { id: "b1" }, archived: true });
    const other = session("other", { bot: { id: "b2", home: true } });
    const started = session("started", { kind: undefined, projectPath: "/repo", parent: { sessionId: "newer" } });
    const unrelated = session("unrelated", { kind: undefined, projectPath: "/repo", parent: { sessionId: "elsewhere" } });
    const { chats, startedBy } = botChats([older, archived, other, started, home, newer, unrelated], "b1");
    expect(chats.map((chat) => chat.id)).toEqual(["home", "newer", "older"]);
    expect(startedBy.map((chat) => chat.id)).toEqual(["started"]);
    expect(botOf(home)).toBe("b1");
    expect(botOf(started)).toBeNull();
  });

  it("leave the sidebar only for a bot that is listed", () => {
    const chat = session("home", { bot: { id: "b1", home: true } });
    expect(listedUnderBot(chat, [{ id: "b1" }])).toBe(true);
    expect(listedUnderBot(chat, [{ id: "b2" }])).toBe(false);
    expect(listedUnderBot(chat, [])).toBe(false);
    expect(listedUnderBot(session("plain"), [{ id: "b1" }])).toBe(false);
  });

  it("open in their bot's view while Bots is on", () => {
    const chat = session("home", { bot: { id: "b1", home: true } });
    const view = { view: "welcome", selectedBotId: null };
    expect(botViewFor(true, [{ id: "b1" }], chat, view)).toEqual({ botId: "b1", chatId: "home" });
    expect(botViewFor(false, [{ id: "b1" }], chat, view)).toBeNull();
    expect(botViewFor(true, [], chat, view)).toBeNull();
    expect(botViewFor(true, [{ id: "b1" }], session("plain"), { view: "bot", selectedBotId: "b1" })).toBeNull();
    expect(botViewFor(true, [{ id: "b1" }], null, { view: "bot", selectedBotId: "b1" })).toEqual({ botId: "b1", chatId: null });
    expect(botViewFor(false, [{ id: "b1" }], null, { view: "bot", selectedBotId: "b1" })).toBeNull();
  });

  it("count what was spent today", () => {
    const now = new Date("2026-11-20T15:00:00");
    const usage = (updated: string, costUsd: number | null) => ({ models: [{ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd }], updated });
    const tab = (id: string, value: ReturnType<typeof usage>) => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "", modified: "", usage: value });
    const chats = [
      session("a", { tabs: [tab("t1", usage(new Date("2026-11-20T10:00:00").toISOString(), 1.5)), tab("t2", usage(new Date("2026-11-19T10:00:00").toISOString(), 9))] as never }),
      session("b", { tabs: [tab("t3", usage(new Date("2026-11-20T11:00:00").toISOString(), 0.7)), tab("t4", usage(new Date("2026-11-20T11:00:00").toISOString(), null))] as never }),
    ];
    expect(spentToday(chats, now)).toBe("$2.20 today");
    expect(spentToday([], now)).toBe("$0.00 today");
  });
});
