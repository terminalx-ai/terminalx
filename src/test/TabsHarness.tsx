import { useLayoutEffect } from "react";
import { SessionNode } from "@/components/layout/SidebarTree";
import { TabDialogs } from "@/components/session/TabDialogs";
import { TabActions } from "@/components/session/TabStrip";
import { WorkspaceTabStrip } from "@/components/session/WorkspaceTabStrip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pagesFor, useBrowser } from "@/lib/browser";
import { useSessionStore } from "@/lib/sessions";
import { workspaceSessions } from "@/lib/tabLayouts";
import { useTerminals } from "@/lib/terminal";
import { resolveSessionTab, setVisibleSessionTab } from "@/lib/visibleTab";

/**
 * The open session's tabs as the main window shows them, without the rest of
 * the session view: the title bar strip and the tab shortcuts, the sidebar's
 * rows for the workspace's sessions, the tab dialogs, and a composer and a
 * terminal to type in. The tab on screen is worked out the way the session
 * view does it, from the same stores.
 */
export function TabsHarness({ readOnlyReason, hideSingle }: { readOnlyReason?: string; hideSingle?: boolean }) {
  const store = useSessionStore();
  const terminals = useTerminals();
  const pages = useBrowser().pages;
  const session = store.sessions.find((candidate) => candidate.id === store.selectedSessionId) ?? null;
  const selected = session
    ? resolveSessionTab({
        requested: terminals.selected[session.id],
        agentIds: session.tabs.map((tab) => tab.id),
        activeTab: session.activeTab,
        terminalIds: terminals.panes.filter((pane) => pane.sessionId === session.id && !pane.hidden).map((pane) => pane.id),
        browserIds: pagesFor(pages, session.cwd).map((page) => page.id),
      })
    : null;
  const sessionId = session?.id ?? null;
  const kind = selected?.kind ?? null;
  const id = selected?.id ?? null;
  useLayoutEffect(() => {
    if (!sessionId) return;
    setVisibleSessionTab(sessionId, kind && id ? { kind, id } : null);
    return () => setVisibleSessionTab(sessionId, null);
  }, [sessionId, kind, id]);
  if (!session) return null;
  const harnessNames = new Map(store.harnesses.map((harness) => [harness.id, harness.name]));
  return (
    <TooltipProvider>
      <header>
        <WorkspaceTabStrip session={session} selected={selected} placement="titlebar" readOnlyReason={readOnlyReason} hideSingle={hideSingle} />
        <TabActions key={session.id} session={session} selected={selected} />
      </header>
      <div role="tree" aria-label="Sidebar">
        {workspaceSessions(store.sessions, session).map((member) => (
          <SessionNode key={member.id} session={member} selected={member.id === session.id} expanded onToggle={() => undefined} tabViews={{}} mobileDriven={new Set()} harnessNames={harnessNames} />
        ))}
      </div>
      <TabDialogs />
      <textarea aria-label="Composer" />
      <div className="xterm">
        <textarea aria-label="Terminal input" />
      </div>
    </TooltipProvider>
  );
}
