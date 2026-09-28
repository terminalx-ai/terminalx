import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import type { SessionSummary } from "./host-api";
import { agentConversations } from "./session-navigation";
import { conversationRows } from "./conversations";

// Captured from the reported worktree's live desktop index, reduced to the
// summary fields used for navigation, with identifiers and title anonymized.
const session: SessionSummary = JSON.parse(readFileSync(new FileURL("./fixtures/multi-agent-worktree.json", import.meta.url), "utf8"));

describe("worktree conversation navigation", () => {
  it("offers Claude and Codex with separate destinations and statuses", () => {
    const conversations = agentConversations(session);
    expect(conversations.map(({ label }) => label)).toEqual(["Claude Code", "Codex"]);
    expect(conversations.map(({ status }) => status)).toEqual(["completed", "in_progress"]);
    expect(conversations.map(({ href }) => href.params.tabId)).toEqual([
      "agent-claude",
      "agent-codex",
    ]);
    for (const { href } of conversations) {
      expect(href.pathname).toBe("/session/[sessionId]");
      expect(href.params.sessionId).toBe(session.id);
    }
  });

  it("finds a worktree by its non-first provider as well as its workspace", () => {
    expect(conversationRows([session], "codex example-project").map(({ tab }) => tab.id)).toEqual(["agent-codex"]);
    expect(conversationRows([session], "claude code")).toHaveLength(1);
    expect(conversationRows([session], "opencode")).toHaveLength(0);
  });
});
