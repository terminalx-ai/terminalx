import { useCallback, useEffect, useState } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { Sidebar } from "@/components/layout/Sidebar";
import { NewSessionView } from "@/components/session/NewSessionView";
import { SessionView } from "@/components/session/SessionView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { bootSessions, selectSession, useSessionStore } from "@/lib/sessions";
import { applyEvent, subscribeAgentEvents } from "@/lib/agentEvents";
import { agent } from "@/lib/api";
import { loadModels } from "@/lib/models";
import { startNotifications } from "@/lib/notify";
import { Toasts } from "@/components/ui/Toasts";

export const TITLEBAR_INSET = 78; // traffic-light clearance, px

/**
 * Three columns under one drag strip: sidebar, workspace, optional right panel.
 * The title bar is ours (overlay style), so every column draws its own strip of
 * height --titlebar-h and the whole strip is a deep drag region.
 */
export function AppShell() {
  const prefs = usePrefs();
  const store = useSessionStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void subscribeAgentEvents();
    void bootSessions();
    void loadModels();
    startNotifications();
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

  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+e", togglePanel);
  useHotkey("mod+,", openSettings);
  useHotkey("mod+n", newSession);

  const sidebarOpen = prefs.sidebarOpen;
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId) ?? null;

  return (
    <div className="flex h-full w-full">
      <Toasts />
      {sidebarOpen && <Sidebar onToggle={toggleSidebar} onOpenSettings={openSettings} onNewSession={newSession} />}

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
              <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">New session</span>
              <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} keys={keycaps("mod+e")}>
                <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" onClick={togglePanel}>
                  <PanelRight />
                </Button>
              </WithTooltip>
            </header>
            <section className="flex min-h-0 flex-1 flex-col">
              <NewSessionView onCreated={onCreated} />
            </section>
          </>
        )}
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
