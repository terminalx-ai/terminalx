import { describe, expect, it } from "vitest";
import { inScratch, isQuickChat, quickChatPlace, quickChatsOf, sessionProjectName } from "./quickChats";
import { buildPaletteIndex } from "./commandPalette";
import type { SessionEntry } from "@/types/session";

const scratch = "/Users/me/.raccoon/quick/0198-aaaa";
function chat(patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "0198-aaaa",
    kind: "quick",
    projectPath: scratch,
    cwd: scratch,
    worktreeRemoved: false,
    title: "What is a monad?",
    created: "2026-10-01T00:00:00.000Z",
    modified: "2026-10-01T00:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: [{ id: "t1", harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: "x", modified: "x" }],
    activeTab: "t1",
    ...patch,
  };
}
const ordinary: SessionEntry = { ...chat({ id: "s-project", title: "Fix login" }), kind: undefined, projectPath: "/repos/api", cwd: "/repos/api" };

describe("quick chats", () => {
  it("is told from a project session by its kind, never by its path", () => {
    expect(isQuickChat(chat())).toBe(true);
    expect(isQuickChat(ordinary)).toBe(false);
    // A session stored before quick chats has no kind at all.
    expect(isQuickChat({ kind: undefined })).toBe(false);
    expect(isQuickChat({ kind: "project" })).toBe(false);
  });

  it("names where it runs: its scratch folder, or the folder it was pointed at", () => {
    expect(inScratch(chat())).toBe(true);
    expect(quickChatPlace(chat())).toBe("Scratch folder");
    const pointed = chat({ cwd: "/Users/me/notes/" });
    expect(inScratch(pointed)).toBe(false);
    expect(quickChatPlace(pointed)).toBe("notes");
    // A project session at its project root is not "in scratch".
    expect(inScratch(ordinary)).toBe(false);
  });

  it("is never named after its scratch directory, which ends in its own id", () => {
    expect(sessionProjectName(chat(), undefined)).toBe("Quick chat");
    expect(sessionProjectName(ordinary, { name: "API" })).toBe("API");
    expect(sessionProjectName(ordinary, null)).toBe("api");
  });

  it("lists quick chats only, pinned first then newest, without the archived ones", () => {
    const old = chat({ id: "old", modified: "2026-09-01T00:00:00.000Z" });
    const recent = chat({ id: "recent", modified: "2026-10-05T00:00:00.000Z" });
    const pinned = chat({ id: "pinned", pinned: true, modified: "2026-08-01T00:00:00.000Z" });
    const archived = chat({ id: "archived", archived: true });
    const all = [old, ordinary, archived, recent, pinned];
    expect(quickChatsOf(all).map((s) => s.id)).toEqual(["pinned", "recent", "old"]);
    expect(quickChatsOf(all, { archived: true }).map((s) => s.id)).toContain("archived");
  });

  it("is found in the command palette as a quick chat, with no id shown for a project or a place", () => {
    const index = buildPaletteIndex([chat(), chat({ id: "pointed", cwd: "/Users/me/notes", title: "Notes" }), ordinary], [{ path: "/repos/api", name: "API" }], {}, [{ id: "claude", name: "Claude" } as never]);
    const rows = new Map(index.sessions.map((row) => [row.sessionId, row.secondary]));
    expect(rows.get("0198-aaaa")).toBe("Quick chat · Scratch folder · Claude");
    expect(rows.get("pointed")).toBe("Quick chat · notes · Claude");
    expect(rows.get("s-project")).toBe("API · api · Claude");
  });
});
