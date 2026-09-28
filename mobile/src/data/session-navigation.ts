import type { SessionSummary } from "./host-api";
import { conversationLabel } from "./conversations";

export function agentConversations(session: SessionSummary) {
  return session.tabs.map((tab) => {
    const label = conversationLabel(tab, session.tabs);
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
