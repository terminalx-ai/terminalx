import { useCallback, useEffect, useState } from "react";
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
import { AutomationsView } from "@/components/automations/AutomationsView";
import { bootAutomations } from "@/lib/automations";
import { openAutomations } from "@/lib/sessions";
import { RightPanel } from "@/components/layout/RightPanel";

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
    void subscribeTabPty();
    void bootSessions();
    void bootAutomations();
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
  const showIssues = useCallback(() => openIssues(), []);
  const showAgents = useCallback(() => openAgents(), []);
  const showAutomations = useCallback(() => openAutomations(), []);

  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+e", togglePanel);
  useHotkey("mod+,", openSettings);
  useHotkey("mod+n", newSession);
  useHotkey("mod+i", showIssues);
  useHotkey("mod+shift+a", showAgents);
  useHotkey("mod+shift+r", showAutomations);
  useHotkey("mod+k", setSessionSearch);

  const sidebarOpen = prefs.sidebarOpen;
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId) ?? null;

  return (
    <div className="flex h-full w-full">
      <Toasts />
      <BypassDialog />
      <SettleDialog />
      <WorkspaceDeleteDialog />
      {sidebarOpen && <Sidebar onToggle={toggleSidebar} onOpenSettings={openSettings} onOpenIssues={showIssues} onOpenAgents={showAgents} onOpenAutomations={showAutomations} onSearch={setSessionSearch} />}

      {selected ? (
        <main className="flex h-full min-w-0 flex-1 flex-col">
          <ErrorBoundary key={selected.id} label="the session">
            <SessionView session={selected} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
          </ErrorBoundary>
        </main>
      ) : (
        <UnselectedWorkspace
          key={store.view}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          onTogglePanel={togglePanel}
          onCreated={onCreated}
        />
      )}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

/** A pre-session checkout has the same full-height panel frame as a session. */
function UnselectedWorkspace({
  sidebarOpen,
  onToggleSidebar,
  onTogglePanel,
  onCreated,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onCreated: (sessionId: string, tabId: string, text: string) => void;
}) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const [useWorktree, setUseWorktree] = useState(prefs.useWorktree);
  const [issueProjectPath, setIssueProjectPath] = useState<string | null>(null);

  const preset = store.newSessionPreset;
  const wanted = preset?.projectPath ?? store.selectedProject ?? prefs.lastProject ?? store.lastProject;
  const newProject = store.projects.find((project) => project.path === wanted) ?? store.projects[0] ?? null;
  const issueProject = store.projects.find((project) => project.path === issueProjectPath) ?? null;
  const project = store.view === "new" ? newProject : store.view === "issues" ? issueProject : null;
  const cwd = store.view === "new" ? (preset?.cwd ?? project?.path ?? null) : project?.path ?? null;
  const workspace = cwd && project ? (store.workspaces[project.path] ?? []).find((item) => item.path === cwd) : null;
  const panelAvailable = !!cwd && !!project;
  const labelMode = preset?.cwd && store.view === "new" ? "branch" : useWorktree ? "base" : "branch";

  return (
    <>
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2"
          style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && (
            <WithTooltip label="Show sidebar" keys={keycaps("mod+b")}>
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          {/* The dashboard draws its own title, so the strip stays quiet for it. */}
          <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">
            {store.view === "issues" ? "Issues" : store.view === "agents" ? "" : store.view === "automations" ? "Automations" : "New session"}
          </span>
          {panelAvailable && (
            <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} keys={keycaps("mod+e")}>
              <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" onClick={onTogglePanel}>
                <PanelRight />
              </Button>
            </WithTooltip>
          )}
        </header>
        <section className="flex min-h-0 flex-1 flex-col">
          {store.view === "issues" ? (
            <IssuesView
              onCreated={onCreated}
              useWorktree={useWorktree}
              onUseWorktreeChange={setUseWorktree}
              onTargetProjectChange={setIssueProjectPath}
            />
          ) : store.view === "agents" ? (
            <AgentDashboard />
          ) : store.view === "automations" ? (
            <AutomationsView />
          ) : (
            <NewSessionView onCreated={onCreated} useWorktree={useWorktree} onUseWorktreeChange={setUseWorktree} />
          )}
        </section>
      </main>
      {prefs.panelOpen && panelAvailable && cwd && project && (
        <RightPanel
          key={cwd}
          cwd={cwd}
          branch={workspace?.branch}
          workingTree
          rootName={project.name}
          labelMode={labelMode}
        />
      )}
    </>
  );
}
