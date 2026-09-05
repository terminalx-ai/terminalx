import { activateBrowserPage, closeBrowserPage } from "@/lib/browser";
import type { BrowserPage } from "@/lib/api";
import { removeTab, setActiveTab } from "@/lib/sessions";
import { closeTerminal, setActiveTerminal, type SelectedSessionTab, type TerminalPane } from "@/lib/terminal";
import type { SessionEntry, TabEntry } from "@/types/session";

export type PeerTab =
  | { kind: "agent"; id: string; created: string; tab: TabEntry }
  | { kind: "terminal"; id: string; created: string; pane: TerminalPane }
  | { kind: "browser"; id: string; created: string; page: BrowserPage };

/** Every tab of a session in creation order: agents, shells and browser pages alike. */
export function peerOrder(session: SessionEntry, panes: TerminalPane[], pages: BrowserPage[] = []): PeerTab[] {
  return [
    ...session.tabs.map((tab): PeerTab => ({ kind: "agent", id: tab.id, created: tab.created, tab })),
    ...panes.filter((pane) => pane.sessionId === session.id && !pane.hidden).map((pane): PeerTab => ({ kind: "terminal", id: pane.id, created: pane.created, pane })),
    ...pages.map((page): PeerTab => ({ kind: "browser", id: page.id, created: page.created, page })),
  ].sort((a, b) => a.created.localeCompare(b.created));
}

export function selectedPeer(session: SessionEntry, tabs: PeerTab[], requested?: SelectedSessionTab): PeerTab | undefined {
  return tabs.find((tab) => tab.kind === requested?.kind && tab.id === requested.id)
    ?? tabs.find((tab) => tab.kind === "agent" && tab.id === session.activeTab)
    ?? tabs.find((tab) => tab.kind === "agent")
    ?? tabs[0];
}

export function tabNodeId(tab: SelectedSessionTab) {
  return `session-${tab.kind}-tab-${encodeURIComponent(tab.id)}`;
}

export function tabPanelId(tab: SelectedSessionTab) {
  return `session-${tab.kind}-panel-${encodeURIComponent(tab.id)}`;
}

export function activatePeer(sessionId: string, tab: SelectedSessionTab) {
  if (tab.kind === "agent") void setActiveTab(sessionId, tab.id);
  else if (tab.kind === "browser") void activateBrowserPage(sessionId, tab.id);
  else setActiveTerminal(sessionId, tab.id);
}

export async function closePeer(sessionId: string, tab: PeerTab, tabs: PeerTab[], selected?: SelectedSessionTab | null) {
  const index = tabs.findIndex((candidate) => candidate.kind === tab.kind && candidate.id === tab.id);
  const remaining = tabs.filter((_, i) => i !== index);
  const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
  if (tab.kind === "agent") await removeTab(sessionId, tab.id);
  else if (tab.kind === "browser") await closeBrowserPage(sessionId, tab.id);
  else await closeTerminal(tab.id);
  if (selected?.kind === tab.kind && selected.id === tab.id && next) activatePeer(sessionId, next);
}

/** A page's label for the sidebar and tab strip: its title, else its host. */
export function browserPageLabel(page: Pick<BrowserPage, "title" | "url">): string {
  const title = page.title.trim();
  if (title && title !== "about:blank") return title;
  if (!page.url || page.url === "about:blank") return "New tab";
  try {
    const parsed = new URL(page.url);
    return parsed.protocol === "file:" ? parsed.pathname.split("/").pop() || page.url : parsed.host || page.url;
  } catch {
    return page.url;
  }
}
