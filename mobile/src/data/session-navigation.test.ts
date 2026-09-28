import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import type { SessionSummary } from "./host-api";
import { agentConversations, matchesSession } from "./session-navigation";

// Captured from the reported worktree's live desktop index, reduced to the
// summary fields used for navigation. No transcript or credentials are included.
const session: SessionSummary = JSON.parse(readFileSync(new FileURL("./fixtures/multi-agent-worktree.json", import.meta.url), "utf8"));

describe("worktree conversation navigation", () => {
  it("offers Claude and Codex with separate destinations and statuses", () => {
    const conversations = agentConversations(session);
    expect(conversations.map(({ label }) => label)).toEqual(["Claude Code", "Codex"]);
    expect(conversations.map(({ status }) => status)).toEqual(["completed", "in_progress"]);
    expect(conversations.map(({ href }) => href.params.tabId)).toEqual([
      "01a06e9d-7fee-7263-8539-eed1fd76b18d",
      "01a06f07-f2d9-74c0-8bb4-124fa8a232de",
    ]);
    for (const { href } of conversations) {
      expect(href.pathname).toBe("/session/[sessionId]");
      expect(href.params.sessionId).toBe(session.id);
    }
  });

  it("finds a worktree by its non-first provider as well as its workspace", () => {
    expect(matchesSession(session, "codex raccoon")).toBe(true);
    expect(matchesSession(session, "claude code")).toBe(true);
    expect(matchesSession(session, "opencode")).toBe(false);
  });
});
