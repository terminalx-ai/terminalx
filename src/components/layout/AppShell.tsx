import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { Sidebar } from "@/components/layout/Sidebar";
import { NewSessionView } from "@/components/session/NewSessionView";
import { IssuesView } from "@/components/issues/IssuesView";
import { AgentDashboard } from "@/components/dashboard/AgentDashboard";
import { SessionView } from "@/components/session/SessionView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { bootSessions, openAgents, openIssues, selectSession, setSessionSearch, useSessionStore } from "@/lib/sessions";
import { applyEvent, subscribeAgentEvents } from "@/lib/agentEvents";
import { agent } from "@/lib/api";
import { loadModels } from "@/lib/models";
import { startNotifications } from "@/lib/notify";
import { subscribeTabPty } from "@/lib/tabViews";
import { Toasts } from "@/components/ui/Toasts";
import { BypassDialog } from "@/components/session/BypassDialog";
import { SettleDialog } from "@/components/session/SettleDialog";
import { WorkspaceDeleteDialog } from "@/components/session/WorkspaceDeleteDialog";
import { bootStatus, useStatus } from "@/lib/status";

const StatusBar = lazy(() => import("@/components/layout/StatusBar").then((module) => ({ default: module.StatusBar })));
const statusBarFallback = <div aria-hidden className="h-[22px] shrink-0 border-t border-hairline bg-background/70" />;

export const TITLEBAR_INSET = 78; // traffic-light clearance, px

/**
 * Three columns under one drag strip: sidebar, workspace, optional right panel.
 * The title bar is ours (overlay style), so every column draws its own strip of
 * height --titlebar-h and the whole strip is a deep drag region.
 */
export function AppShell() {
  const prefs = usePrefs();
  const status = useStatus();
  const store = useSessionStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void subscribeAgentEvents();
    void subscribeTabPty();
    void bootSessions();
    void loadModels();
    startNotifications();
    void bootStatus();
  }, []);

  // The first prompt of a new session is sent right after the worktree exists.
  const onCreated = useCallback((sessionId: string, tabId: string, text: string) => {
    void agent
      .send(sessionId, tabId, text)
      .then((out) => out.events.forEach(applyEvent))
      .catch((e) => console.error("first send failed", e));
  }, []);

  const toggleSidebar = useCallback(() => setPrefs({ sidebarOpen: !prefs.sidebarOpen }), [prefs.sidebarOpen]);
  const togglePanel = useCallback(() => setPrefs({ panelOpen: !prefs.panelOpen }), [prefs.panelOpen]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const newSession = useCallback(() => selectSession(null), []);
  const showIssues = useCallback(() => openIssues(), []);
  const showAgents = useCallback(() => openAgents(), []);

  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+e", togglePanel);
  useHotkey("mod+,", openSettings);
  useHotkey("mod+n", newSession);
  useHotkey("mod+i", showIssues);
  useHotkey("mod+shift+a", showAgents);
  useHotkey("mod+k", setSessionSearch);

  const sidebarOpen = prefs.sidebarOpen;
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId) ?? null;

  return (
    <div className="flex h-full w-full flex-col">
      <Toasts />
      <BypassDialog />
      <SettleDialog />
      <WorkspaceDeleteDialog />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <Sidebar onToggle={toggleSidebar} onOpenSettings={openSettings} onOpenIssues={showIssues} onOpenAgents={showAgents} onSearch={setSessionSearch} />}

        <main className="flex h-full min-w-0 flex-1 flex-col">
          {selected ? (
            <ErrorBoundary key={selected.id} label="the session">
              <SessionView session={selected} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
            </ErrorBoundary>
          ) : (
            <>
              <header
                data-tauri-drag-region="deep"
                className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2"
                style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
              >
                {!sidebarOpen && (
                  <WithTooltip label="Show sidebar" keys={keycaps("mod+b")}>
                    <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={toggleSidebar}>
                      <PanelLeft />
                    </Button>
                  </WithTooltip>
                )}
                {/* The dashboard draws its own title, so the strip stays quiet for it. */}
                <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">
                  {store.view === "issues" ? "Issues" : store.view === "agents" ? "" : "New session"}
                </span>
                <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} keys={keycaps("mod+e")}>
                  <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" onClick={togglePanel}>
                    <PanelRight />
                  </Button>
                </WithTooltip>
              </header>
              <section className="flex min-h-0 flex-1 flex-col">
                {store.view === "issues" ? (
                  <IssuesView onCreated={onCreated} />
                ) : store.view === "agents" ? (
                  <AgentDashboard />
                ) : (
                  <NewSessionView onCreated={onCreated} />
                )}
              </section>
            </>
          )}
        </main>
      </div>

      {status.settings.visible ? (
        <ErrorBoundary label="the status bar" fallback={null}>
          <Suspense fallback={statusBarFallback}>
            <StatusBar />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
