import type { SessionSummary } from "./host-api";

const providers: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function agentConversations(session: SessionSummary) {
  const labels = session.tabs.map((tab) => {
    const provider = providers[tab.harness] ?? tab.harness;
    const title = tab.title?.trim();
    return title && title !== provider && title !== tab.harness ? `${provider} · ${title}` : provider;
  });
  return session.tabs.map((tab, index) => {
    const base = labels[index];
    const duplicates = labels.filter((label) => label === base).length;
    const ordinal = labels.slice(0, index + 1).filter((label) => label === base).length;
    const label = duplicates > 1 ? `${base} (${ordinal})` : base;
    return {
      id: tab.id,
      label,
      status: tab.status,
      href: {
        pathname: "/session/[sessionId]" as const,
        params: { sessionId: session.id, tabId: tab.id, title: label },
      },
    };
  });
}

export type AgentConversation = ReturnType<typeof agentConversations>[number];

export function matchesSession(session: SessionSummary, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const value = [
    session.title, session.project, session.worktree, session.issueRef,
    session.lastPrompt, session.lastReply,
    ...agentConversations(session).map(({ label }) => label),
  ].join(" ").toLowerCase();
  return words.every((word) => value.includes(word));
}
