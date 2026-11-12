import { bootDataPrivacy } from "@/lib/dataPrivacy";
import { bootSelfUi } from "@/lib/selfUi";
import { SelfUiAccess } from "@/components/computer/SelfUiAccess";
import { SignInLinkDialog } from "@/components/account/PasteSignInLink";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { WorktreeCopyNotices } from "@/components/ui/WorktreeCopyNotices";
import { onOpenOrganizationSettings } from "@/lib/settingsLinks";
import { onProjectSettingsRequest } from "@/lib/projectAdded";
import { onOrchestratorSettingsRequest } from "@/lib/orchestration";
import { ProjectAddedNotice } from "@/components/ui/ProjectAddedNotice";
import { PanelLeft, PanelRight } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import type { SettingsTab } from "@/components/settings/SettingsPage";
import { Sidebar } from "@/components/layout/Sidebar";
import { NewSessionView } from "@/components/session/NewSessionView";
import { WelcomeTabActions } from "@/components/start/WelcomeTabActions";
import { WelcomeScreen } from "@/components/start/WelcomeScreen";
import { StartScreen } from "@/components/start/StartScreen";
import { ProjectStartDialogHost } from "@/components/start/ProjectStartDialogs";
import { IssuesView } from "@/components/issues/IssuesView";
import { ProjectOverview } from "@/components/project/ProjectOverview";
import { cn } from "@/lib/cn";
import { AgentDashboard } from "@/components/dashboard/AgentDashboard";
import { SkillsView } from "@/components/skills/SkillsView";
import { SessionView } from "@/components/session/SessionView";
import { CloudSessionHost } from "@/components/session/CloudSessionHost";
import { isCloudKey } from "@/types/target";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useShortcut } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { NewSessionDialog } from "@/components/session/NewSessionDialog";
import { UpdateNotice } from "./UpdateNotice";
import { checkForUpdate, startUpdateChecks } from "@/lib/updates";
import { archiveSession, getSessionStore, bootSessions, closeNewSession, openNewSession, openHome, openAgents, openAutomations, openIssues, openSkills, openStats, startIdleArchive, useSessionStore } from "@/lib/sessions";
import { applyEvent, subscribeAgentEvents } from "@/lib/agentEvents";
import { agent, type ImageInput } from "@/lib/api";
import { loadModels, onAgentSettingsRequest } from "@/lib/models";
import { startNotifications } from "@/lib/notify";
import { bootCloudWorkClaims } from "@/lib/cloudWorkClaims";
import { subscribeTabPty } from "@/lib/tabViews";
import { MergedCleanupNotices } from "@/components/ui/MergedCleanupNotices";
import { CloseUndoNotices } from "@/components/ui/CloseUndoNotices";
import { Toasts } from "@/components/ui/Toasts";
import { NotificationsOffCard } from "@/components/ui/NotificationsOffCard";
import { ShareSessionDialogHost } from "@/components/session/ShareSessionDialog";
import { GuestSessionHost } from "@/components/session/GuestSession";
import { CloudSchedulesDialogHost } from "@/components/cloud/CloudSchedulesDialog";
import { CloudShareDialogHost } from "@/components/cloud/CloudShareDialog";
import { NewCloudWorkspaceDialogHost } from "@/components/cloud/NewCloudWorkspaceDialog";
import { DEV_RUNTIME_KEY } from "@/lib/devRuntime";
import { BypassDialog } from "@/components/session/BypassDialog";
import { SessionDialogs } from "@/components/session/SessionDialogs";
import { bootFloating, showFloatingWindow } from "@/lib/floating";
import { bootMergedCleanup } from "@/lib/mergedCleanup";
import { WorkspaceRestoreDialog } from "@/components/session/WorkspaceRestoreDialog";
import { WorkspaceRemoveDialog } from "@/components/session/WorkspaceRemoveDialog";
import { WorktreeCleanupDialog } from "@/components/cleanup/WorktreeCleanupDialog";
import { CleanupIndicator } from "@/components/cleanup/CleanupIndicator";
import { bootStatus, useStatus } from "@/lib/status";
import { useRuntimeSwitch } from "@/lib/localRuntime";
import { AutomationsView } from "@/components/automations/AutomationsView";
import { bootAutomations } from "@/lib/automations";
import { bootIssuePipelines } from "@/lib/issuePipeline";
import { PanelPresence } from "./PanelPresence";
import { RightPanel } from "@/components/layout/RightPanel";
import { CommandPalette } from "@/components/command/CommandPalette";
import { bootAccount } from "@/lib/account";
import { bootCloudCatalog } from "@/lib/cloudCatalog";
import { bootCloudSelection } from "@/lib/cloudSelection";
import { bootCloudMirrors } from "@/lib/cloudMirror";
import { bootCloudSessions } from "@/lib/cloudSessions";
import { bootCloudPipelines } from "@/lib/cloudPipelines";
import { bootPairing } from "@/lib/pairing";
import { PairPhoneDialogHost } from "@/components/pairing/PairPhoneDialog";
import { ConnectedBar } from "@/components/pairing/ConnectedBar";
import { bootTerminalPerf } from "@/lib/terminalPerf";
import { bootCloudControl } from "@/lib/cloudControl";
import { useEditors } from "@/lib/editors";
import { EditorSplit } from "@/components/editor/EditorSplit";
import { onTemplateSettingsRequest, openLocalProject } from "@/lib/projectStart";
import { openUrl } from "@tauri-apps/plugin-opener";
import { REPO_URL, repoFile } from "@/lib/repo";
import { workspaceKey, branchSessionsAsTabs } from "@/lib/tabLayouts";
import { conversationBranch } from "@/lib/checkout";
import { stepAttentionSession, stepVisibleSession } from "@/lib/sessionNavigation";
import { ImageViewerHost } from "@/components/ui/ImageViewer";

const StatusBar = lazy(() => import("@/components/layout/StatusBar").then((module) => ({ default: module.StatusBar })));
const StatsUsageView = lazy(() => import("@/components/stats/StatsUsageView").then((module) => ({ default: module.StatsUsageView })));
const CloudWorkspaceMain = lazy(() => import("@/components/cloud/CloudWorkspaceMain").then((module) => ({ default: module.CloudWorkspaceMain })));
const DevRuntimeMain = lazy(() => import("@/components/cloud/DevRuntime").then((module) => ({ default: module.DevRuntimeMain })));
/** Where Settings opens when no section is asked for: Account (PRO-81). SettingsPage falls back to the same one. */
const GENERAL_SETTINGS_TAB: SettingsTab = "account";
const SettingsPage = lazy(() => import("@/components/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const statusBarFallback = <div aria-hidden className="h-[22px] shrink-0 border-t border-hairline bg-background/70" />;
const viewFallback = <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-faint">Loading view…</div>;

/**
 * The main slot: as tall as the window row it sits in and never taller. What
 * a view draws past it is clipped, not scrolled into: only a view's own
 * scroller (a transcript, a list) scrolls.
 */
const MAIN = "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip";

export const TITLEBAR_INSET = 78; // traffic-light clearance, px

/**
 * Main content between one navigation sidebar and the optional right panel.
 * The title bar is ours (overlay style), so every column draws its own strip of
 * height --titlebar-h and the whole strip is a deep drag region.
 */
export function AppShell() {
  const prefs = usePrefs();
  const status = useStatus();
  // A runtime the app is moving to shows in the status bar, even a hidden one (#766).
  const runtimeSwitch = useRuntimeSwitch();
  const store = useSessionStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(GENERAL_SETTINGS_TAB);
  // The repository Settings opens on, for a request that names one; every other way in names none.
  const [settingsProjectPath, setSettingsProjectPath] = useState<string | undefined>(undefined);
  // Every request for Settings, so asking again with it open still lands on the section asked for.
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A menu/palette selection navigates away from Settings just like the sidebar.
  useEffect(() => setSettingsOpen(false), [store.navigationVersion]);

  // An update is looked for in the background, so it is seen without going to Settings for it.
  useEffect(() => { void bootDataPrivacy().then(() => startUpdateChecks()); }, []);
  useEffect(() => {
    void subscribeAgentEvents();
    void subscribeTabPty();
    void bootSessions();
    // Conversations nobody has written in for the limit in Settings go to the archive (#718).
    startIdleArchive();
    void bootAutomations();
    void bootIssuePipelines();
    void bootSelfUi();
    void loadModels();
    startNotifications();
    void bootStatus();
    void bootDataPrivacy().then(() => {
      void bootAccount();
      bootCloudCatalog();
    });
    bootCloudSelection();
    // Live session lists and local mirrors (PRO-25) follow the connections other surfaces open,
    // from launch and whatever is on screen: hidden sidebar or Settings included (#498).
    bootCloudSessions();
    bootCloudPipelines();
    bootCloudMirrors();
    // The reader's cloud sessions say which issues they work on, as this Mac's do (#441).
    bootCloudWorkClaims();
    void bootPairing();
    void bootTerminalPerf();
    void bootCloudControl();
    void bootFloating();
    void bootMergedCleanup();
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
  // The general way in (the Settings button, the shortcut) names no section and opens Account,
  // whichever section was open last; an action that names one (Agent settings, the palette) gets it.
  // Also a click handler, which is handed the click's event: anything that is not a section's
  // name opens Account too, never a blank page.
  const openSettings = useCallback((tab?: unknown) => {
    setSettingsTab(typeof tab === "string" ? (tab as SettingsTab) : GENERAL_SETTINGS_TAB);
    setSettingsProjectPath(undefined);
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }, []);
  // A project's own settings, from the "Project added" notice: its Scripts, where the setup script lives.
  useEffect(() => onProjectSettingsRequest((projectPath) => {
    setSettingsTab("repositories.scripts");
    setSettingsProjectPath(projectPath);
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }), []);
  // A run's limits, from a session's Run view.
  useEffect(() => onOrchestratorSettingsRequest(() => {
    setSettingsTab("orchestrator");
    setSettingsProjectPath(undefined);
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }), []);
  // "Add your own templates in Settings › Projects", from Create a project.
  useEffect(() => onTemplateSettingsRequest(() => openSettings("projects.templates")), [openSettings]);
  // The empty model picker's way out: Settings › Agents, where the agent's sign-in is checked.
  useEffect(() => onAgentSettingsRequest(() => openSettings("agents")), [openSettings]);
  const openAccountSettings = useCallback(() => {
    setSettingsTab("account");
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }, []);
  // An organization's page (PRO-107): a message that names its Agent logins offers the way there, with the
  // organization it is about. The Organizations section opens that page, and the logins scroll themselves into view.
  const openOrganizationsSettings = useCallback((row: "organizations.overview" | "organizations.agentLogins") => {
    setSettingsTab(row);
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }, []);
  useEffect(() => onOpenOrganizationSettings(openOrganizationsSettings), [openOrganizationsSettings]);
  const openAgentSettings = useCallback(() => {
    setSettingsTab("agents");
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }, []);
  const openStorageSettings = useCallback(() => {
    setSettingsTab("storage");
    setSettingsOpen(true);
    setSettingsRequest((count) => count + 1);
  }, []);
  const newSession = useCallback(() => openNewSession(), []);
  const showHome = useCallback(() => {
    setSettingsOpen(false);
    openHome();
  }, []);
  const showIssues = useCallback(() => { setSettingsOpen(false); openIssues(); }, []);
  const showAgents = useCallback(() => { setSettingsOpen(false); openAgents(); }, []);
  const showStats = useCallback(() => openStats(), []);
  const showSkills = useCallback(() => openSkills(), []);
  const showAutomations = useCallback(() => { setSettingsOpen(false); openAutomations(); }, []);
  const showQuickChat = useCallback(() => void showFloatingWindow().catch((e) => console.error("floating window", e)), []);

  useShortcut("app.about", () => openSettings("about"));
  useShortcut("app.checkUpdates", () => { openSettings("about"); void checkForUpdate(); });
  useShortcut("app.shortcuts", () => openSettings("shortcuts"));
  useShortcut("app.addProject", () => { setSettingsOpen(false); void openLocalProject().catch((error) => console.error("add project", error)); });
  useShortcut("app.openRecent", () => setPaletteOpen(true));
  useShortcut("app.nextSession", () => { setSettingsOpen(false); stepVisibleSession(1); });
  useShortcut("app.nextAttention", () => { setSettingsOpen(false); stepAttentionSession(); });
  useShortcut("session.archive", () => {
    const id = getSessionStore().selectedSessionId;
    if (id && !isCloudKey(id)) void archiveSession(id, true).catch(() => {});
  });
  useShortcut("app.previousSession", () => { setSettingsOpen(false); stepVisibleSession(-1); });
  useShortcut("app.docs", () => { void openUrl(repoFile("README.md")).catch(console.error); });
  useShortcut("app.reportIssue", () => { void openUrl(`${REPO_URL}/issues/new`).catch(console.error); });
  useShortcut("app.toggleSidebar", toggleSidebar);
  useShortcut("app.togglePanel", togglePanel);
  useShortcut("app.settings", () => openSettings());
  useShortcut("app.newSession", newSession);
  useShortcut("app.startFrom", () => { setSettingsOpen(false); openNewSession(true); });
  useShortcut("app.home", showHome);
  useShortcut("app.issues", showIssues);
  useShortcut("app.agentDashboard", showAgents);
  useShortcut("app.stats", showStats);
  useShortcut("app.skills", showSkills);
  useShortcut("app.automations", showAutomations);
  useShortcut("app.quickChat", showQuickChat);
  useShortcut("app.commandPalette", () => setPaletteOpen(true), { global: true });

  const sidebarOpen = prefs.sidebarOpen;
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId) ?? null;
  // A cloud workspace in the main slot (PRO-23).
  const cloudWorkspace = store.selectedCloudWorkspace ?? null;
  // A cloud session (`cloud:…`) renders in the same slot, with the sidebar kept.
  const cloudKey = isCloudKey(store.selectedSessionId) ? store.selectedSessionId : null;
  // "New session" from a session: a dialog over it, which goes back to it when closed.
  const opening = store.view === "new" && !store.selectedSessionId ? store.newSessionReturn : null;
  const behind = opening?.sessionId ? (store.sessions.find((s) => s.id === opening.sessionId && !s.archived) ?? null) : null;

  return (
    <div data-app-shell className="flex h-full w-full flex-col">
      <SelfUiAccess />
      {/* Merged-workspace notices, top right under the tabs: a stack of them in the bottom corner covered the composer
          and its send button. Toasts and close-undo notices, which answer what was just done there, stay below. */}
      <div className="pointer-events-none fixed top-22 right-4 z-(--z-toast) flex max-h-[calc(100dvh-8rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {/* It stays until notifications are allowed, so it is up here with the other notices that wait (PRO-327). */}
        <NotificationsOffCard />
        <MergedCleanupNotices />
      </div>
      <div className="pointer-events-none fixed bottom-8 right-4 z-(--z-toast) flex max-h-[calc(100dvh-3rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <CloseUndoNotices />
        <Toasts />
        <ProjectAddedNotice />
        <WorktreeCopyNotices />
        {/* Last, so it keeps the corner and the toasts stack above it. */}
        <CleanupIndicator onOpenStorage={openStorageSettings} />
      </div>
      <BypassDialog />
      <ImageViewerHost />
      <SessionDialogs />
      <CloudShareDialogHost />
      <CloudSchedulesDialogHost />
      <ShareSessionDialogHost />
      <SignInLinkDialog />
      <GuestSessionHost />
      <NewCloudWorkspaceDialogHost />
      <WorkspaceRemoveDialog />
      <WorkspaceRestoreDialog />
      <WorktreeCleanupDialog />
      <ProjectStartDialogHost />
      <PairPhoneDialogHost />
      <ConnectedBar />
      <div className="flex min-h-0 flex-1">
        {settingsOpen ? (
          <Suspense fallback={viewFallback}>
            <SettingsPage
              initialTab={settingsTab}
              initialProjectPath={settingsProjectPath}
              openRequest={settingsRequest}
              onBack={() => setSettingsOpen(false)}
              onOpenSkills={() => {
                setSettingsOpen(false);
                showSkills();
              }}
              onOpenUsage={() => {
                setSettingsOpen(false);
                showStats();
              }}
            />
          </Suspense>
        ) : (
          <>
            <PanelPresence side="left" open={sidebarOpen}>
            {sidebarOpen && (
              <Sidebar
                onToggle={toggleSidebar}
                onOpenSettings={openSettings}
                onOpenAccount={openAccountSettings}
                onOpenHome={showHome}
                onOpenIssues={showIssues}
                onOpenAgents={showAgents}
                onOpenStats={showStats}
                onOpenAutomations={showAutomations}
                onOpenSkills={showSkills}
                onSearch={() => setPaletteOpen(true)}
              />
            )}
            </PanelPresence>

            {cloudKey ? (
              <main className={MAIN}>
                <ErrorBoundary key={cloudKey} label="the session">
                  <CloudSessionHost sessionKey={cloudKey} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
                </ErrorBoundary>
              </main>
            ) : selected ? (
              <main className={MAIN}>
                <ErrorBoundary key={branchSessionsAsTabs(prefs) ? `${workspaceKey(selected, store.chatsPath)}:${conversationBranch(selected, store.chatsPath, store.workspaces)}` : selected.id} label="the session">
                  <SessionView session={selected} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
                </ErrorBoundary>
              </main> ) : behind ? (
              <main className={MAIN}>
                <ErrorBoundary key={behind.id} label="the session">
                  <SessionView session={behind} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
                </ErrorBoundary>
                <NewSessionDialog onClose={closeNewSession} onCreated={onCreated} />
              </main>
            ) : cloudWorkspace ? (
              <ErrorBoundary key={cloudWorkspace} label="the cloud workspace">
                <Suspense fallback={viewFallback}>
                  {cloudWorkspace === DEV_RUNTIME_KEY ? (
                    <DevRuntimeMain sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
                  ) : (
                    <CloudWorkspaceMain workspaceKey={cloudWorkspace} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
                  )}
                </Suspense>
              </ErrorBoundary>
            ) : (
              <UnselectedWorkspace
                key={opening ? `${opening.view}:new` : store.view}
                underDialog={opening && !behind ? opening.view : undefined}
                sidebarOpen={sidebarOpen}
                onToggleSidebar={toggleSidebar}
                onTogglePanel={togglePanel}
                onOpenSettings={openSettings}
                onCreated={onCreated}
              />
            )}
          </>
        )}
      </div>

      {status.settings.visible || runtimeSwitch ? (
        <ErrorBoundary label="the status bar" fallback={null}>
          <Suspense fallback={statusBarFallback}>
            <StatusBar onOpenAgentSettings={openAgentSettings} onOpenUsageDetails={showStats} />
          </Suspense>
        </ErrorBoundary>
      ) : null}

      {paletteOpen ? <CommandPalette open onOpenChange={setPaletteOpen} onOpenSettings={openSettings} onCreated={onCreated} /> : null}
      <UpdateNotice />
    </div>
  );
}

/** A pre-session checkout has the same full-height panel frame as a session. */
function UnselectedWorkspace({
  underDialog,
  sidebarOpen,
  onToggleSidebar,
  onTogglePanel,
  onOpenSettings,
  onCreated,
}: {
  /** The view the new-session dialog was opened over: drawn behind it in place of the form's own page. */
  underDialog?: ReturnType<typeof useSessionStore>["view"];
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onCreated: (sessionId: string, tabId: string, text: string, images?: ImageInput[]) => void;
}) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const view = underDialog ?? store.view;
  const editors = useEditors();
  const [useWorktree, setUseWorktree] = useState(prefs.useWorktree);
  const [issueProjectPath, setIssueProjectPath] = useState<string | null>(null);

  const preset = store.newSessionPreset;
  const wanted = preset?.projectPath ?? store.selectedProject ?? prefs.lastProject ?? store.lastProject;
  const newProject = store.projects.find((project) => project.path === wanted) ?? (preset ? null : store.projects[0]) ?? null;
  const issueProject = store.projects.find((project) => project.path === issueProjectPath) ?? null;
  const project = view === "new" ? (store.newSessionChat ? null : newProject) : view === "issues" ? issueProject : null;
  const cwd = view === "new" ? (preset?.cwd ?? project?.path ?? null) : project?.path ?? null;
  const workspace = cwd && project ? (store.workspaces[project.path] ?? []).find((item) => item.path === cwd) : null;
  // A cloud or project-less draft has no local checkout to show.
  const panelAvailable = !!cwd && !!project && !(view === "new" && (store.cloudSessionPreset || store.newSessionChat));
  const checkoutEditorId = cwd ? `checkout:${cwd}` : null;
  const hasCheckoutEditors = !!checkoutEditorId && editors.editors.some((editor) => editor.sessionId === checkoutEditorId);
  const labelMode = preset?.cwd && view === "new" ? "branch" : useWorktree ? "base" : "branch";
  // Home always offers the welcome actions, including after a project has been added.
  // With no local project there is nothing to start a session in: the start screen offers the ways to get one.
  // Not before the projects are read, or over a cloud or project-less draft.
  const startScreen = view === "home" || ((view === "new" || view === "welcome") && store.loaded && store.projects.length === 0 && !store.cloudSessionPreset && !(view === "new" && store.newSessionChat));

  return (
    <>
      {/* The project overview is one dark surface, top bar included, like the chat. */}
      <main className={cn(MAIN, view === "project" && "bg-chat")}>
        <header
          data-tauri-drag-region="deep"
          className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2"
          style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && (
            <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          {/* The dashboard draws its own title, so the strip stays quiet for it. */}
          <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">
            {view === "issues"
              ? "Issues"
              : view === "agents" || view === "skills" || view === "stats" || view === "project"
                ? ""
                : view === "automations"
                  ? "Automations"
                  : startScreen || view === "welcome"
                    ? ""
                    : "New session"}
          </span>
          {panelAvailable && (
            <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} shortcut="app.togglePanel">
              <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" onClick={onTogglePanel}>
                <PanelRight />
              </Button>
            </WithTooltip>
          )}
        </header>
        <section className="@container/editor-host relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {view === "welcome" && <WelcomeTabActions />}
            {view === "issues" ? (
              <IssuesView
                onCreated={onCreated}
                useWorktree={useWorktree}
                onUseWorktreeChange={setUseWorktree}
                onTargetProjectChange={setIssueProjectPath}
              />
            ) : view === "project" && store.selectedProject ? (
              <ProjectOverview key={store.selectedProject} path={store.selectedProject} />
            ) : view === "agents" ? (
              <AgentDashboard />
            ) : view === "stats" ? (
              <Suspense fallback={viewFallback}>
                <StatsUsageView />
              </Suspense>
            ) : view === "automations" ? (
              <AutomationsView initialAutomationId={store.selectedAutomationId} />
            ) : view === "skills" ? (
              <SkillsView
                key={`${store.skillsFilter?.projectPath ?? store.selectedProject ?? "home"}:${store.skillsFilter?.agent ?? "all"}`}
                projectPath={store.skillsFilter?.projectPath ?? store.selectedProject}
                initialAgent={store.skillsFilter?.agent ?? null}
              />
            ) : startScreen ? (
              <StartScreen onOpenSettings={onOpenSettings} />
            ) : view === "welcome" ? (
              <WelcomeScreen />
            ) : (
              <NewSessionView onCreated={onCreated} useWorktree={useWorktree} onUseWorktreeChange={setUseWorktree} />
            )}
          </div>
          {checkoutEditorId && hasCheckoutEditors ? <EditorSplit sessionId={checkoutEditorId} active /> : null}
        </section>
      </main>
      <PanelPresence side="right" open={!!(prefs.panelOpen && panelAvailable && cwd && project)}>
      {prefs.panelOpen && panelAvailable && cwd && project && (
        <RightPanel
          key={cwd}
          cwd={cwd}
          isGit={project.kind !== "folder"}
          branch={workspace?.branch}
          workingTree
          rootName={project.name}
          labelMode={labelMode}
          workspace={workspace?.managed && !workspace.isMain ? { projectPath: project.path, name: workspace.name } : undefined}
        />
      )}
      </PanelPresence>
      {underDialog && <NewSessionDialog onClose={closeNewSession} onCreated={onCreated} />}
    </>
  );
}
