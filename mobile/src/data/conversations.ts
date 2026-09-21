import type { ColumnId } from "@terminalx/portable/dashboard";
import type { SessionStatus, SessionSummary } from "./host-api";

export type ConversationTab = SessionSummary["tabs"][number];
export interface ConversationRow {
  key: string;
  session: SessionSummary;
  tab: ConversationTab;
  label: string;
  column: ColumnId;
}

export const conversationKey = (hostId: string, sessionId: string, tabId: string) => JSON.stringify([hostId, sessionId, tabId]);
export const providerName = (harness: string) => ({ claude: "Claude Code", codex: "Codex" })[harness] ?? harness;
export const statusLabel = (status: SessionStatus) => ({ idle: "Idle", in_progress: "Working", completed: "Completed", waiting: "Needs you" })[status];

export function conversationLabel(tab: ConversationTab, tabs: ConversationTab[]): string {
  const provider = providerName(tab.harness);
  const title = tab.title?.trim();
  const base = title && title !== provider ? `${provider} · ${title}` : provider;
  // UUIDv7 IDs sort by creation time. Use them only to keep readable numbering
  // consistent when the host sends the same tabs in a different order.
  const duplicates = tabs.filter((other) => other.harness === tab.harness && (other.title?.trim() || provider) === (title || provider))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (duplicates.length < 2) return base;
  const number = duplicates.findIndex((other) => other.id === tab.id) + 1;
  return base === provider ? `${provider} ${number}` : `${base} (${number})`;
}

export function conversationRows(sessions: SessionSummary[], query = ""): ConversationRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.flatMap((session) => session.tabs.map((tab): ConversationRow => ({
    key: JSON.stringify([session.id, tab.id]), session, tab,
    label: conversationLabel(tab, session.tabs),
    column: tab.status === "waiting" ? "needs" : tab.status === "in_progress" ? "working" : "done",
  }))).filter(({ session, tab, label }) => {
    const value = [session.title, session.project, session.worktree, session.issueRef, label, tab.harness, tab.id].join(" ").toLowerCase();
    return words.every((word) => value.includes(word));
  });
}
