import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

vi.mock("@/lib/api", () => ({ botsApi: { homeChat: vi.fn(), newChat: vi.fn() } }));

const { actingBotOf, botChats, botOf, botViewFor, listedUnderBot, spentTodayLabel, usageKey } = await import("./botChats");

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

  it("show what the bot spent today, read again whenever its sessions record usage", () => {
    expect(spentTodayLabel(null)).toBe("— today");
    expect(spentTodayLabel(0)).toBe("$0.00 today");
    expect(spentTodayLabel(11.2)).toBe("$11.20 today");
    const usage = (costUsd: number | null) => ({ models: [{ model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd }], updated: "" });
    const tab = (id: string, value?: ReturnType<typeof usage>) => ({ id, harness: "claude", model: "", permissionMode: "plan", status: "idle", created: "", modified: "", usage: value });
    const before = [session("a", { tabs: [tab("t1", usage(1.5)), tab("t2")] as never })];
    const after = [session("a", { tabs: [tab("t1", usage(1.75)), tab("t2")] as never })];
    expect(usageKey(before)).not.toBe(usageKey(after));
    expect(usageKey(before)).toBe(usageKey([...before]));
  });

  it("list every session that works for the bot under it, however far from its chat, and keep them out of the project lists", () => {
    const chat = session("chat", { bot: { id: "b1" } });
    const child = session("child", { kind: undefined, projectPath: "/repo", parent: { sessionId: "chat" }, botStarted: { id: "b1" } });
    const grandchild = session("grandchild", { kind: undefined, projectPath: "/repo", parent: { sessionId: "child" }, botStarted: { id: "b1" }, modified: "2026-11-20T10:00:00Z" });
    const other = session("other", { kind: undefined, projectPath: "/repo", botStarted: { id: "b2" } });
    expect(botChats([chat, child, grandchild, other], "b1").startedBy.map((entry) => entry.id)).toEqual(["grandchild", "child"]);
    expect(actingBotOf(grandchild)).toBe("b1");
    expect(listedUnderBot(grandchild, [{ id: "b1" }])).toBe(true);
    expect(listedUnderBot(grandchild, [])).toBe(false);
    // A session the bot started opens as itself, not in the bot's view.
    expect(botViewFor(true, [{ id: "b1" }], grandchild, { view: "welcome", selectedBotId: null })).toBeNull();
  });

  it("put the newest made home chat first, as the app answers", () => {
    const older = session("older", { bot: { id: "b1", home: true }, created: "2026-11-01T00:00:00Z", modified: "2026-11-20T12:00:00Z" });
    const newer = session("newer", { bot: { id: "b1", home: true }, created: "2026-11-10T00:00:00Z", modified: "2026-11-10T00:00:00Z" });
    expect(botChats([older, newer], "b1").chats.map((chat) => chat.id)).toEqual(["newer", "older"]);
  });
});
