import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { SettingsTab } from "@/components/settings/SettingsPage";
import { Sidebar } from "@/components/layout/Sidebar";
import { NewSessionView } from "@/components/session/NewSessionView";
import { IssuesView } from "@/components/issues/IssuesView";
import { AgentDashboard } from "@/components/dashboard/AgentDashboard";
import { SkillsView } from "@/components/skills/SkillsView";
import { SessionView } from "@/components/session/SessionView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { bootSessions, openAgents, openAutomations, openIssues, openSkills, openStats, selectSession, useSessionStore } from "@/lib/sessions";
import { applyEvent, subscribeAgentEvents } from "@/lib/agentEvents";
import { agent, type ImageInput } from "@/lib/api";
import { loadModels } from "@/lib/models";
import { startNotifications } from "@/lib/notify";
import { subscribeTabPty } from "@/lib/tabViews";
import { Toasts } from "@/components/ui/Toasts";
import { BypassDialog } from "@/components/session/BypassDialog";
import { SettleDialog } from "@/components/session/SettleDialog";
import { WorkspaceDeleteDialog } from "@/components/session/WorkspaceDeleteDialog";
import { bootStatus, useStatus } from "@/lib/status";
import { AutomationsView } from "@/components/automations/AutomationsView";
import { bootAutomations } from "@/lib/automations";
import { RightPanel } from "@/components/layout/RightPanel";
import { CommandPalette } from "@/components/command/CommandPalette";
import { bootAccount } from "@/lib/account";
import { bootPairing } from "@/lib/pairing";
import { useEditors } from "@/lib/editors";
import { EditorSplit } from "@/components/editor/EditorSplit";

const StatusBar = lazy(() => import("@/components/layout/StatusBar").then((module) => ({ default: module.StatusBar })));
const StatsUsageView = lazy(() => import("@/components/stats/StatsUsageView").then((module) => ({ default: module.StatsUsageView })));
const SettingsPage = lazy(() => import("@/components/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const statusBarFallback = <div aria-hidden className="h-[22px] shrink-0 border-t border-hairline bg-background/70" />;
const viewFallback = <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-faint">Loading view…</div>;

export const TITLEBAR_INSET = 78; // traffic-light clearance, px

/**
 * Main content between one navigation sidebar and the optional right panel.
 * The title bar is ours (overlay style), so every column draws its own strip of
 * height --titlebar-h and the whole strip is a deep drag region.
 */
export function AppShell() {
  const prefs = usePrefs();
  const status = useStatus();
  const store = useSessionStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    void subscribeAgentEvents();
    void subscribeTabPty();
    void bootSessions();
    void bootAutomations();
    void loadModels();
    startNotifications();
    void bootStatus();
    void bootAccount();
    void bootPairing();
  }, []);

  // The first prompt of a new session is sent right after the worktree exists.
  const onCreated = useCallback((sessionId: string, tabId: string, text: string, images?: ImageInput[]) => {
    void agent
      .send(sessionId, tabId, text, images)
      .then((out) => out.events.forEach(applyEvent))
      .catch((e) => console.error("first send failed", e));
  }, []);

  const toggleSidebar = useCallback(() => setPrefs({ sidebarOpen: !prefs.sidebarOpen }), [prefs.sidebarOpen]);
  const togglePanel = useCallback(() => setPrefs({ panelOpen: !prefs.panelOpen }), [prefs.panelOpen]);
  const openSettings = useCallback((tab: SettingsTab = "general") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const openAccountSettings = useCallback(() => {
    setSettingsTab("account");
    setSettingsOpen(true);
  }, []);
  const openAgentSettings = useCallback(() => {
    setSettingsTab("agents");
    setSettingsOpen(true);
  }, []);
  const newSession = useCallback(() => selectSession(null), []);
  const showIssues = useCallback(() => openIssues(), []);
  const showAgents = useCallback(() => openAgents(), []);
  const showStats = useCallback(() => openStats(), []);
  const showSkills = useCallback(() => openSkills(), []);
  const showAutomations = useCallback(() => openAutomations(), []);

  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+e", togglePanel);
  useHotkey("mod+,", () => openSettings());
  useHotkey("mod+n", newSession);
  useHotkey("mod+i", showIssues);
  useHotkey("mod+shift+a", showAgents);
  useHotkey("mod+shift+u", showStats);
  useHotkey("mod+shift+k", showSkills);
  useHotkey("mod+shift+r", showAutomations);
  useHotkey("mod+k", () => setPaletteOpen(true), { global: true });

  const sidebarOpen = prefs.sidebarOpen;
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId) ?? null;

  return (
    <div className="flex h-full w-full flex-col">
      <Toasts />
      <BypassDialog />
      <SettleDialog />
      <WorkspaceDeleteDialog />
      <div className="flex min-h-0 flex-1">
        {settingsOpen ? (
          <Suspense fallback={viewFallback}>
            <SettingsPage initialTab={settingsTab} onBack={() => setSettingsOpen(false)} />
          </Suspense>
        ) : (
          <>
            {sidebarOpen && (
              <Sidebar
                onToggle={toggleSidebar}
                onOpenSettings={openSettings}
                onOpenAccount={openAccountSettings}
                onOpenIssues={showIssues}
                onOpenAgents={showAgents}
                onOpenStats={showStats}
                onOpenAutomations={showAutomations}
                onOpenSkills={showSkills}
                onSearch={() => setPaletteOpen(true)}
              />
            )}

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
          </>
        )}
      </div>

      {status.settings.visible ? (
        <ErrorBoundary label="the status bar" fallback={null}>
          <Suspense fallback={statusBarFallback}>
            <StatusBar onOpenAgentSettings={openAgentSettings} onOpenUsageDetails={showStats} />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {paletteOpen ? <CommandPalette open onOpenChange={setPaletteOpen} onOpenSettings={openSettings} onCreated={onCreated} /> : null}
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
  onCreated: (sessionId: string, tabId: string, text: string, images?: ImageInput[]) => void;
}) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const editors = useEditors();
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
  const checkoutEditorId = cwd ? `checkout:${cwd}` : null;
  const hasCheckoutEditors = !!checkoutEditorId && editors.editors.some((editor) => editor.sessionId === checkoutEditorId);
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
            {store.view === "issues"
              ? "Issues"
              : store.view === "agents" || store.view === "skills" || store.view === "stats"
                ? ""
                : store.view === "automations"
                  ? "Automations"
                  : "New session"}
          </span>
          {panelAvailable && (
            <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} keys={keycaps("mod+e")}>
              <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" onClick={onTogglePanel}>
                <PanelRight />
              </Button>
            </WithTooltip>
          )}
        </header>
        <section className="@container/editor-host relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {store.view === "issues" ? (
              <IssuesView
                onCreated={onCreated}
                useWorktree={useWorktree}
                onUseWorktreeChange={setUseWorktree}
                onTargetProjectChange={setIssueProjectPath}
              />
            ) : store.view === "agents" ? (
              <AgentDashboard />
            ) : store.view === "stats" ? (
              <Suspense fallback={viewFallback}>
                <StatsUsageView />
              </Suspense>
            ) : store.view === "automations" ? (
              <AutomationsView initialAutomationId={store.selectedAutomationId} />
            ) : store.view === "skills" ? (
              <SkillsView
                key={`${store.skillsFilter?.projectPath ?? store.selectedProject ?? "home"}:${store.skillsFilter?.agent ?? "all"}`}
                projectPath={store.skillsFilter?.projectPath ?? store.selectedProject}
                initialAgent={store.skillsFilter?.agent ?? null}
              />
            ) : (
              <NewSessionView onCreated={onCreated} useWorktree={useWorktree} onUseWorktreeChange={setUseWorktree} />
            )}
          </div>
          {checkoutEditorId && hasCheckoutEditors ? <EditorSplit sessionId={checkoutEditorId} active /> : null}
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
          workspace={workspace?.managed && !workspace.isMain ? { projectPath: project.path, name: workspace.name } : undefined}
        />
      )}
    </>
  );
}
