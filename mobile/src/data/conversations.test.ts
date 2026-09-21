import { describe, expect, it } from "vitest";
import { conversationKey, conversationRows } from "./conversations";
import type { SessionSummary } from "./host-api";

const session: SessionSummary = {
  id: "worktree", title: "Create a new issue", project: "TerminalX", worktree: "issue-132", modified: "2026-09-15",
  tabs: [
    { id: "claude-1", harness: "claude", status: "waiting" },
    { id: "codex-1", harness: "codex", status: "in_progress" },
    { id: "codex-2", harness: "codex", status: "idle" },
    { id: "codex-3", harness: "codex", title: "Review", status: "completed" },
  ],
};

describe("mobile conversation rows", () => {
  it("exposes every tab with its own status and target", () => {
    const rows = conversationRows([session]);
    expect(rows.map(({ tab, column }) => [tab.id, column])).toEqual([
      ["claude-1", "needs"], ["codex-1", "working"], ["codex-2", "done"], ["codex-3", "done"],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
    expect(new Set(rows.map((row) => row.label)).size).toBe(4);
    expect(rows[0].label).toBe("Claude Code");
  });

  it("searches provider, tab title and worktree together", () => {
    expect(conversationRows([session], "codex issue").map((row) => row.tab.id)).toEqual(["codex-1", "codex-2", "codex-3"]);
    expect(conversationRows([session], "REVIEW terminalx").map((row) => row.tab.id)).toEqual(["codex-3"]);
    expect(conversationRows([session], "claude code").map((row) => row.tab.id)).toEqual(["claude-1"]);
    expect(conversationRows([session], "missing")).toEqual([]);
  });

  it("keeps duplicate labels and keys stable when summaries reorder after reconnect", () => {
    const before = conversationRows([session]);
    const after = conversationRows([{ ...session, tabs: [...session.tabs].reverse() }]);
    for (const row of before) expect(after.find((other) => other.key === row.key)?.label).toBe(row.label);
    expect(conversationRows([{ ...session, tabs: [] }])).toEqual([]);
  });

  it("gives unnamed conversations readable numbered names without exposing IDs", () => {
    const rows = conversationRows([session]);
    expect(rows.map((row) => row.label)).toEqual(["Claude Code", "Codex 1", "Codex 2", "Codex · Review"]);
    for (const row of rows) expect(row.label).not.toContain(row.tab.id);
    expect(conversationRows([{ ...session, worktree: "feature" }], "codex 2").map((row) => row.tab.id)).toEqual(["codex-2"]);
  });

  it("preserves tab names and distinguishes duplicated names", () => {
    const rows = conversationRows([{ ...session, tabs: [
      { id: "tab-a", title: " Review ", harness: "codex", status: "idle" },
      { id: "tab-b", title: "Review", harness: "codex", status: "idle" },
      { id: "tab-c", title: "Fix login", harness: "claude", status: "idle" },
    ] }]);
    expect(rows.map((row) => row.label)).toEqual(["Codex · Review (1)", "Codex · Review (2)", "Claude Code · Fix login"]);
  });

  it("scopes state by host, worktree and tab without delimiter collisions", () => {
    const keys = [conversationKey("a", "b", "c"), conversationKey("other", "b", "c"), conversationKey("a", "other", "c"), conversationKey("a", "b", "other"), conversationKey("a:b", "c", "d"), conversationKey("a", "b:c", "d")];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
