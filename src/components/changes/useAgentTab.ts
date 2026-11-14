import { useCallback } from "react";
import { agent } from "@/lib/api";
import { applyEvent } from "@/lib/agentEvents";
import { patchTab, useSessionStore } from "@/lib/sessions";

/**
 * The session's agent tab, to ask it something from a panel, as Merge into
 * does (BranchPanel): `unavailable` says why nothing can be sent, and `send`
 * delivers the prompt, applies the events it answers with and says whether
 * it was queued behind a turn.
 */
export function useAgentTab(sessionId: string | undefined): {
  unavailable: string | null;
  send: (prompt: string) => Promise<{ queued: boolean }>;
} {
  const session = useSessionStore().sessions.find((s) => s.id === sessionId);
  const tab = session?.tabs.find((candidate) => candidate.id === session.activeTab);
  const unavailable = !session || !tab ? "Open an agent tab in this workspace to ask the agent."
    : tab.front === "terminal" ? "The agent tab is in terminal view. Switch it to chat to ask the agent." : null;
  const sessionKey = session?.id;
  const tabId = tab?.id;
  const send = useCallback(async (prompt: string) => {
    if (!sessionKey || !tabId) throw new Error("Open an agent tab in this workspace to ask the agent.");
    const result = await agent.send(sessionKey, tabId, prompt);
    for (const event of result.events) applyEvent(event);
    if (!result.queued) patchTab(sessionKey, tabId, { status: "in_progress" });
    return { queued: result.queued };
  }, [sessionKey, tabId]);
  return { unavailable, send };
}
