import { describe, expect, it } from "vitest";
import { adjacentSession, nextAttentionSession } from "./sessionNavigation";

describe("next and previous session", () => {
  const sessions = [
    { id: "old", created: "2026-11-01", modified: "2026-11-01", pinned: false },
    { id: "cloud:org:workspace:session", created: "2026-11-05", modified: "2026-11-05", pinned: false },
    { id: "pinned", created: "2026-10-01", modified: "2026-10-01", pinned: true },
    { id: "archived", created: "2026-11-06", modified: "2026-11-06", pinned: false, archived: true },
  ];
  it("includes local and cloud sessions, skips archives, and wraps in sidebar order", () => {
    expect(adjacentSession(sessions, "pinned", 1)).toBe("cloud:org:workspace:session");
    expect(adjacentSession(sessions, "old", 1)).toBe("pinned");
    expect(adjacentSession(sessions, "pinned", -1)).toBe("old");
  });
  it("keeps sidebar message order when renaming changes modified, using created only without a message", () => {
    const conversations = [
      { id: "A", created: "2026-10-01", lastMessageAt: "2026-11-03", modified: "2026-11-03", pinned: false },
      { id: "B", created: "2026-10-02", lastMessageAt: "2026-11-02", modified: "2026-11-06", pinned: false },
      { id: "C", created: "2026-11-01", lastMessageAt: null, modified: "2026-11-01", pinned: false },
    ];
    expect(adjacentSession(conversations, "A", 1)).toBe("B");
    expect(adjacentSession(conversations, "C", -1)).toBe("B");
    expect(adjacentSession(conversations, "B", 1)).toBe("C");
  });
  it("enters at either end when no session is selected and handles empty lists", () => {
    expect(adjacentSession(sessions, null, 1)).toBe("pinned");
    expect(adjacentSession(sessions, null, -1)).toBe("old");
    expect(adjacentSession([], null, 1)).toBeNull();
    expect(adjacentSession([sessions[3]], "archived", -1)).toBeNull();
  });
});

it("cycles waiting sessions in dashboard order, without including unread or archived sessions", () => {
  const make = (id: string, status: "waiting" | "completed" | "idle", modified: string, archived = false) => ({
    id, title: id, projectPath: "/repo", cwd: "/repo", modified, archived,
    tabs: [{ harness: "claude", status, markedUnread: true }],
  });
  const sessions = [make("old", "waiting", "2026-01-01"), make("new", "waiting", "2026-01-03"), make("archived", "waiting", "2026-01-04", true), make("unread", "completed", "2026-01-05")];
  expect(nextAttentionSession(sessions, null)?.id).toBe("new");
  expect(nextAttentionSession(sessions, "new")?.id).toBe("old");
  expect(nextAttentionSession(sessions, "old")?.id).toBe("new");
  expect(nextAttentionSession([sessions[0]], "old")?.id).toBe("old");
  expect(nextAttentionSession(sessions.slice(2), null)).toBeNull();
  expect(nextAttentionSession([], null)).toBeNull();
});

it("follows custom local order in both directions while retaining recency when off", () => {
  const sessions = ["a", "b", "c", "new"].map((id) => ({ id, created: "2026-01-01", pinned: id === "a" }));
  const order = { custom: true, sessions: ["c", "b", "a"], projects: [], revision: 1 };
  expect(adjacentSession(sessions, "c", 1, order)).toBe("b");
  expect(adjacentSession(sessions, "b", -1, order)).toBe("c");
  expect(adjacentSession(sessions, "a", 1, order)).toBe("new");
  expect(adjacentSession(sessions, "a", 1, { ...order, custom: false })).toBe("b");
});
