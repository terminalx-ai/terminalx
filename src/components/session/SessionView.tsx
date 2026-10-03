import { useEffect, useLayoutEffect, useState } from "react";
import { CalendarClock, CircleDot, Cloud, GitBranch, MessageSquare, MessageSquarePlus, PanelLeft, PanelRight, Terminal } from "lucide-react";
import { toggleTabView, useTabViews } from "@/lib/tabViews";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { useShortcut } from "@/lib/hotkeys";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { openAutomations, renameWorkspace, selectSession, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import type { SessionEntry } from "@/types/session";
import { ContinuationDialog } from "./ContinuationDialog";
import { TabView } from "./TabView";
import { TabActions } from "./TabStrip";
import { tabPanelId } from "@/lib/sessionTabs";
import { activateLatestTerminal, selectSessionTab, useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import { TerminalView } from "@/components/terminal/TerminalView";
import { BrowserView } from "@/components/browser/BrowserView";
import { bootBrowser, pagesFor, useBrowser } from "@/lib/browser";
import { setLastFocused, useEditors } from "@/lib/editors";
import { EditorSplit } from "@/components/editor/EditorSplit";
import { QuickOpen } from "@/components/editor/QuickOpen";
import { ProjectSearch } from "@/components/editor/ProjectSearch";
import { RightPanel } from "@/components/layout/RightPanel";
import { useTabLog } from "@/lib/agentEvents";
import type { TabEntry } from "@/types/session";
import { WorkspaceNameEditor } from "./WorkspaceNameEditor";
import { workspaceName } from "@/lib/dashboard";
import { localSessionBackend } from "@/lib/sessionBackend";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cloudAgentLabel } from "@/lib/cloudRowState";
import { CloudTerminalPane } from "@/components/cloud/CloudTerminalPane";
import { AccessChip, NotSharedNotice, PresenceAvatars } from "@/components/cloud/CloudCollab";
import { presenceTab } from "@/lib/cloudCollab";
import { resolveSessionTab, setVisibleSessionTab } from "@/lib/visibleTab";
import { WorkspaceActionItems, WorkspaceLifecycleDialog, useLifecycleRun, type LifecycleRequest } from "@/components/cloud/WorkspaceActions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { findCloudWorkspace, useCloudCatalog } from "@/lib/cloudCatalog";
import { CloudDiagnosticsDialog, CloudDiagnosticsMenuItem, offersCloudDiagnostics } from "@/components/cloud/CloudDiagnosticsDialog";
import { useAccount } from "@/lib/account";

function managedWorkspaceFor(session: SessionEntry) {
  if (!session.worktreeName || session.worktreeRemoved) return undefined;
  return { projectPath: session.projectPath, name: session.worktreeName };
}

/** The right panel reads the active tab's log for the changes range. */
function PanelHost({ session, tab }: { session: SessionEntry; tab: TabEntry }) {
  const project = useSessionStore().projects.find((p) => p.path === session.projectPath);
  const log = useTabLog(session.id, tab.id);
  const live = tab.status === "in_progress" || tab.status === "waiting";
  const workspace = managedWorkspaceFor(session);
  return (
    <RightPanel
      cwd={session.cwd}
      isGit={project?.kind !== "folder"}
      branch={session.branch ?? null}
      baseRef={session.baseRef}
      events={log.events}
      version={log.version}
      live={live}
      sessionId={session.id}
      mentionTabId={session.activeTab ?? session.tabs[0]?.id ?? null}
      statusKey={session.tabs.map((item) => item.status).join(",")}
      settleSessionId={workspace ? session.id : undefined}
      workspace={workspace}
    />
  );
}

/**
 * A cloud session's right panel: Changes, Repo, PR and Files through the
 * workspace's runtime, with a repository picker when it has several. Until
 * the workspace is connected there is nothing to read, and nothing here
 * connects or wakes it.
 */
function CloudPanelHost({ session, cloud, tab }: { session: SessionEntry; cloud: CloudSessionModel; tab?: TabEntry }) {
  const log = useTabLog(cloud.backend.logSessionId, tab?.id ?? "");
  const live = tab?.status === "in_progress" || tab?.status === "waiting";
  if (!cloud.fileSource) {
    return (
      <aside className="flex h-full w-(--panel-w) shrink-0 flex-col border-l border-hairline" data-testid="cloud-panel-offline">
        <div data-tauri-drag-region="deep" className="h-(--titlebar-h) shrink-0" />
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {cloud.locked
            ? "Changes, Files and Git are only shown to people this workspace is shared with."
            : cloud.asleep
              ? "The workspace is stopped. Changes, Files and Git appear once it runs again; sending a message wakes it."
              : "Changes, Files and Git appear once the workspace is connected."}
        </div>
      </aside>
    );
  }
  return (
    <RightPanel
      key={cloud.repository ?? "none"}
      cwd={cloud.root}
      isGit={!!cloud.gitSource}
      branch={undefined}
      events={tab ? log.events : undefined}
      version={tab ? log.version : undefined}
      live={live}
      workingTree={!tab}
      sessionId={session.id}
      mentionTabId={session.activeTab ?? session.tabs[0]?.id ?? null}
      statusKey={session.tabs.map((item) => item.status).join(",")}
      rootName={cloud.workspaceName}
      gitSource={cloud.gitSource}
      fileSource={cloud.fileSource}
      repositories={cloud.repositories && cloud.repositories.length > 1 ? { list: cloud.repositories.map((repo) => repo.repo), selected: cloud.repository, onSelect: cloud.selectRepository } : undefined}
      readOnlyReason={cloud.manage ? null : (cloud.backend.readOnlyReason ?? "View only: commits, pushes and file edits need manage access to this workspace.")}
    />
  );
}

/**
 * A cloud session's header in a narrow window (about 960 px with the side
 * panel open) gives way in order, so the title stays readable: it keeps about
 * its first 12 characters while everything else has given all it can.
 *
 * 1. The branch and location chips shrink to their icons (`HEADER_CHIP_YIELDS`):
 *    the label truncates, and with no room left for even an ellipsis it wraps
 *    out of sight. The chip is one line high, so the wrapped label is clipped,
 *    and its tooltip still says what it is.
 * 2. The project name shrinks away.
 * 3. Only then the title truncates.
 * 4. In a header too narrow for all of that (`HEADER_TIGHT`), the project and
 *    the branch chip are left out: the sidebar row shows both.
 *
 * The connection and role chips never shrink. The shrink factors do the
 * ordering: a larger one takes (nearly) all the squeeze until it is at its
 * minimum.
 */
const HEADER_CHIP_YIELDS = "h-5 min-w-[24px] shrink-[1000] flex-wrap content-start gap-x-1 whitespace-nowrap py-0 leading-5";
/** The chip's icon fills its one line, so a wrapped label starts below the chip and none of it shows. */
const HEADER_CHIP_ICON = "my-1 size-3 shrink-0";
const HEADER_CHIP_LABEL = "min-w-[2ch] grow basis-0";
const HEADER_PROJECT_YIELDS = "min-w-0 shrink-[40]";
const HEADER_TIGHT = "@max-[360px]/session-header:hidden";

/** What a presence tab id names in this session: an agent tab's title or a terminal. */
function tabLabelOf(cloud: CloudSessionModel, tabId: string): string | null {
  const tab = cloud.session.tabs.find((candidate) => candidate.id === tabId);
  if (tab) return tab.title?.trim() || cloudAgentLabel(tab.harness);
  const terminal = cloud.terminals.find((candidate) => candidate.ptyId === tabId || candidate.id === tabId);
  return terminal ? `Terminal ${terminal.number}` : null;
}

/** Where a cloud session runs, and whether this window is attached to it. The location chip holds the workspace's lifecycle actions. */
function CloudLocation({ cloud }: { cloud: CloudSessionModel }) {
  const { location, connection } = cloud;
  const catalog = useCloudCatalog();
  const item = findCloudWorkspace(catalog, cloud.orgId, cloud.workspaceId);
  const menu = useRowMenu();
  const [request, setRequest] = useState<LifecycleRequest | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const { status } = useAccount();
  const [error, run] = useLifecycleRun();
  const title = `Runs in the cloud workspace ${cloud.workspaceName} (${location.provider}, ${location.org}), not on this computer.`;
  const chipClass = cn("ml-1 flex max-w-[30%] items-center overflow-hidden rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground", HEADER_CHIP_YIELDS);
  const chip = (
    <>
      <Cloud className={HEADER_CHIP_ICON} />
      <span className={cn("truncate", HEADER_CHIP_LABEL)}>Cloud · {location.provider} · {location.org}</span>
    </>
  );
  const diagnosticsOffered = offersCloudDiagnostics(status, cloud.orgId);
  return (
    <>
      {item || diagnosticsOffered ? (
        <DropdownMenu {...menu.root}>
          <DropdownMenuTrigger asChild {...menu.trigger}>
            <button
              type="button"
              className={cn(chipClass, "outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40")}
              data-testid="session-location"
              title={title}
              aria-label={`Cloud workspace ${cloud.workspaceName}: actions`}
            >
              {chip}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[17rem]">
            <DropdownMenuLabel className="truncate">Workspace · {cloud.workspaceName}</DropdownMenuLabel>
            {item && <WorkspaceActionItems item={item} onLifecycle={setRequest} run={run} archived={item.workspace.state === "archived"} />}
            {diagnosticsOffered && (
              <>
                {item && <DropdownMenuSeparator />}
                <CloudDiagnosticsMenuItem onSelect={() => setDiagnostics(true)} />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // Not in this person's workspace list (no longer shared with them): there is nothing to act on, so the chip only says where it ran.
        <span className={chipClass} data-testid="session-location" title={title}>
          {chip}
        </span>
      )}
      {error && (
        <span className="ml-1 truncate text-[11px] text-destructive" role="alert">
          {error}
        </span>
      )}
      {request && <WorkspaceLifecycleDialog request={request} onClose={() => setRequest(null)} />}
      {diagnostics && <CloudDiagnosticsDialog request={{ orgId: cloud.orgId, workspaceId: cloud.workspaceId }} onClose={() => setDiagnostics(false)} />}
      {/* One connection chip (is it live) and one role chip (what this person may do); a locked session has no connection to report. */}
      {!cloud.locked && (
        <span
          className={cn(
            "ml-1 flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] hairline",
            connection.tone === "live" ? "text-foreground" : "text-muted-foreground",
          )}
          data-testid="session-connection"
          role="status"
        >
          <span className={cn("size-1.5 rounded-full", connection.tone === "live" ? "bg-success" : connection.tone === "pending" ? "bg-warning" : "bg-faint")} aria-hidden />
          {connection.label}
        </span>
      )}
      {/* While the list and the runtime disagree about a new share, the pane says so; no chip claims either. */}
      {cloud.locked !== "checking" && cloud.locked !== "pending" && <AccessChip you={cloud.collab.you} viewOnly={cloud.connected && !cloud.manage} className="ml-1" />}
      {cloud.collab.live && <PresenceAvatars collabKey={cloud.collab.key} you={cloud.collab.you} tabLabel={(tabId) => tabLabelOf(cloud, tabId)} />}
    </>
  );
}

/**
 * One session: a header naming the place, the selected sidebar tab's
 * full-height body, and the right panel. A local session runs on this
 * computer; a cloud one (`cloud`) in a workspace VM, through its backend.
 */
export function SessionView({
  session,
  sidebarOpen,
  onToggleSidebar,
  cloud,
}: {
  session: SessionEntry;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** A cloud session: its backend, terminals, sources and location. */
  cloud?: CloudSessionModel;
}) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const backend = cloud?.backend ?? localSessionBackend(session.id);
  const local = backend.caps.local;
  const project = store.projects.find((p) => p.path === session.projectPath);
  const terminals = useTerminals();
  const shellPanes = local ? terminals.panes.filter((pane) => pane.sessionId === session.id && !pane.hidden) : [];
  const cloudTerminals = cloud?.terminals ?? [];
  const browserState = useBrowser();
  const browserPages = local ? pagesFor(browserState.pages, session.cwd) : [];
  useEffect(() => {
    if (local) void bootBrowser();
  }, [local]);
  const requested = terminals.selected[session.id];
  const terminalIds = local ? shellPanes.map((pane) => pane.id) : cloudTerminals.map((terminal) => terminal.id);
  const selected: SelectedSessionTab | null = resolveSessionTab({
    requested,
    agentIds: session.tabs.map((tab) => tab.id),
    activeTab: session.activeTab,
    terminalIds,
    browserIds: browserPages.map((page) => page.id),
  });
  // The sidebar marks the row of the tab that is on screen.
  const selectedKind = selected?.kind ?? null;
  const selectedId = selected?.id ?? null;
  useLayoutEffect(() => {
    setVisibleSessionTab(session.id, selectedKind && selectedId ? { kind: selectedKind, id: selectedId } : null);
    return () => setVisibleSessionTab(session.id, null);
  }, [session.id, selectedKind, selectedId]);
  const activeTab = selected?.kind === "agent" ? session.tabs.find((tab) => tab.id === selected.id) : undefined;
  const activeShell = selected?.kind === "terminal" ? shellPanes.find((pane) => pane.id === selected.id) : undefined;
  const tabViews = useTabViews();
  const activeInTerminal = !!activeTab && tabViews.views[activeTab.id] === "terminal";
  const switching = !!activeTab && !!tabViews.switching[activeTab.id];
  const workspaceLabel = session.worktreeRemoved ? workspaceName(session) : session.branch;
  const workspaceTitle = session.removedWorkspace?.path ?? session.cwd;
  const [continuationSource, setContinuationSource] = useState<TabEntry | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const workspace = managedWorkspaceFor(session);
  useShortcut("session.toggleTerminalView", () => {
    if (activeTab && local) void toggleTabView(session, activeTab);
  });
  const ed = useEditors();
  const hasEditors = ed.editors.some((e) => e.sessionId === session.id);
  // Agents change files when their status changes; the explorer re-reads git then.
  const statusKey = session.tabs.map((t) => t.status).join(",");

  // A local session with no agent opens a shell. A cloud one never opens
  // anything by itself: that could wake a stopped workspace.
  useEffect(() => {
    if (!local || session.tabs.length) return;
    if (!getPrefs().panelOpen) setPrefs({ panelOpen: true });
    void activateLatestTerminal(session.id, session.cwd).catch((e) => console.error("terminal open failed", e));
  }, [local, session.id, session.cwd, session.tabs.length]);

  // PRO-30 presence: what this person looks at in a shared workspace.
  const presenceKey = cloud?.collab.live ? cloud.collab.key : null;
  const presenceTarget = selected?.kind === "agent" ? selected.id : selected?.kind === "terminal" ? (cloudTerminals.find((terminal) => terminal.id === selected.id)?.ptyId ?? null) : null;
  useEffect(() => {
    if (!presenceKey) return;
    presenceTab(presenceKey, presenceTarget);
  }, [presenceKey, presenceTarget]);

  useShortcut("session.latestShell", () => {
    if (local) void activateLatestTerminal(session.id, session.cwd);
    else if (cloudTerminals.length) selectSessionTab(session.id, { kind: "terminal", id: cloudTerminals[cloudTerminals.length - 1].id });
  });
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className={cn("flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2", cloud && "@container/session-header")}
          style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && (
            <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          {/* A cloud header in a narrow window gives way in order (see HEADER_CHIP_YIELDS), and clips rather than run under the buttons on the right. */}
          <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 px-1 text-sm", cloud && "overflow-hidden")} data-testid="session-breadcrumb">
            {/* A cloud session that goes by its project's name (untitled, or locked with nothing else to name) has one title, not the same one twice. */}
            {!(cloud && cloud.projectName === session.title) && (
              <>
                <span className={cn("max-w-[30%] truncate text-muted-foreground", cloud && HEADER_PROJECT_YIELDS, cloud && HEADER_TIGHT)} title={cloud ? cloud.projectName : project?.name} data-testid="session-project">
                  {cloud ? cloud.projectName : (project?.name ?? "project")}
                </span>
                <span className={cn("text-faint", cloud && HEADER_TIGHT)}>/</span>
              </>
            )}
            <span className="truncate text-foreground" title={session.title} data-testid="session-title">
              {session.title}
            </span>
            {session.issue && (
              <WithTooltip label={session.issue.title}>
                <button
                  type="button"
                  onClick={() => void openUrl(session.issue!.url)}
                  className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CircleDot className="size-3" />
                  {session.issue.identifier}
                </button>
              </WithTooltip>
            )}
            {session.automation && (
              <WithTooltip label={`Open ${session.automation.name} in Automations`}>
                <button
                  type="button"
                  onClick={openAutomations}
                  className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CalendarClock className="size-3" />
                  {session.automation.name} #{session.automation.runNumber}
                </button>
              </WithTooltip>
            )}
            {workspaceLabel && (
              <span
                className={cn("ml-1 flex max-w-[35%] items-center overflow-hidden rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground", cloud ? cn(HEADER_CHIP_YIELDS, HEADER_TIGHT) : "min-w-0 gap-1")}
                title={workspaceTitle}
                data-testid="session-branch"
              >
                <GitBranch className={cloud ? HEADER_CHIP_ICON : "size-3 shrink-0"} />
                {local && session.worktreeName && !session.worktreeRemoved ? (
                  <WorkspaceNameEditor
                    value={session.worktreeName}
                    onCommit={async (requested) => {
                      const renamed = await renameWorkspace(session.projectPath, session.cwd, requested);
                      return renamed.name;
                    }}
                    onError={setRenameError}
                    className="max-w-52 text-muted-foreground hover:text-foreground"
                  />
                ) : (
                  <span className={cn("truncate", cloud && HEADER_CHIP_LABEL)}>{workspaceLabel}</span>
                )}
                {session.worktreeRemoved && <span className="text-faint">· workspace removed</span>}
              </span>
            )}
            {cloud && <CloudLocation cloud={cloud} />}
            {renameError && (
              <span role="alert" className="ml-1 max-w-64 truncate text-[11px] text-destructive" title={renameError}>
                {renameError}
              </span>
            )}
          </div>

          <div className="ml-auto flex max-w-[70%] shrink-0 items-center gap-0.5">
            {/* Keyed by session: a menu left open never carries over to another session. */}
            {!cloud?.locked && <TabActions key={session.id} session={session} selected={selected} cloud={cloud} />}
            {activeTab && local && (
              <WithTooltip label="Continue in New Session…">
                <Button variant="ghost" size="icon-sm" aria-label="Continue in New Session…" onClick={() => setContinuationSource(activeTab)}>
                  <MessageSquarePlus />
                </Button>
              </WithTooltip>
            )}
            {activeTab && local && (
              <WithTooltip label={activeInTerminal ? "Back to chat" : "Show terminal view"} shortcut="session.toggleTerminalView">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={activeInTerminal ? "Back to chat" : "Show terminal view"}
                  aria-pressed={activeInTerminal}
                  disabled={switching}
                  onClick={() => void toggleTabView(session, activeTab)}
                  className={cn(activeInTerminal && "bg-veil-strong text-foreground")}
                >
                  {activeInTerminal ? <MessageSquare /> : <Terminal />}
                </Button>
              </WithTooltip>
            )}
            <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} shortcut="app.togglePanel">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle panel"
                onClick={() => setPrefs({ panelOpen: !prefs.panelOpen })}
              >
                <PanelRight />
              </Button>
            </WithTooltip>
          </div>
        </header>

        {continuationSource && <ContinuationDialog session={session} source={continuationSource} onClose={() => setContinuationSource(null)} />}
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="@container/editor-host relative flex min-h-0 flex-1">
            <div
              className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
              onPointerDownCapture={() => setLastFocused("chat")}
              onFocusCapture={() => setLastFocused("chat")}
            >
              {session.tabs.map((t) => (
                <div
                  key={t.id}
                  id={tabPanelId({ kind: "agent", id: t.id })}
                  role="tabpanel"
                  aria-labelledby={`session-agent-tab-${encodeURIComponent(t.id)}`}
                  aria-hidden={selected?.kind !== "agent" || t.id !== selected.id}
                  className={cn("flex min-h-0 flex-1 flex-col", (selected?.kind !== "agent" || t.id !== selected.id) && "hidden")}
                >
                  <TabView
                    session={session}
                    tab={t}
                    continuationOpen={!!continuationSource}
                    active={selected?.kind === "agent" && t.id === selected.id}
                    backend={cloud ? backend : undefined}
                    gitSource={cloud?.gitSource}
                  />
                </div>
              ))}
              {shellPanes.map((pane) => (
                <div
                  key={pane.id}
                  id={tabPanelId({ kind: "terminal", id: pane.id })}
                  role="tabpanel"
                  aria-labelledby={`session-terminal-tab-${encodeURIComponent(pane.id)}`}
                  aria-hidden={selected?.kind !== "terminal" || pane.id !== selected.id}
                  className={cn("absolute inset-0", (selected?.kind !== "terminal" || pane.id !== selected.id) && "invisible")}
                >
                  <TerminalView id={pane.id} visible={pane.id === activeShell?.id} />
                  {pane.exited && (
                    <div className="absolute bottom-2 left-3 rounded-md bg-popover px-2 py-1 text-[11px] text-muted-foreground hairline">
                      Process exited{pane.exitCode != null ? ` (${pane.exitCode})` : ""}.
                    </div>
                  )}
                </div>
              ))}
              {cloud && cloud.client && cloudTerminals.map((terminal) => (
                <div
                  key={terminal.id}
                  id={tabPanelId({ kind: "terminal", id: terminal.id })}
                  role="tabpanel"
                  aria-labelledby={`session-terminal-tab-${encodeURIComponent(terminal.id)}`}
                  aria-hidden={selected?.kind !== "terminal" || terminal.id !== selected.id}
                  className={cn("absolute inset-0 flex flex-col", (selected?.kind !== "terminal" || terminal.id !== selected.id) && "invisible")}
                >
                  {selected?.kind === "terminal" && terminal.id === selected.id && (
                    <CloudTerminalPane
                      workspace={cloud.workspaceKey}
                      terminal={terminal}
                      client={cloud.client!}
                      connected={cloud.connected}
                      manage={cloud.manage}
                      mayControl={cloud.mayControlTerminals}
                      you={cloud.collab.live ? cloud.collab.you : null}
                      base={cloud.terminalBase}
                    />
                  )}
                </div>
              ))}
              {browserPages.map((page) => (
                <div
                  key={page.id}
                  id={tabPanelId({ kind: "browser", id: page.id })}
                  role="tabpanel"
                  aria-labelledby={`session-browser-tab-${encodeURIComponent(page.id)}`}
                  aria-hidden={selected?.kind !== "browser" || page.id !== selected.id}
                  className={cn("absolute inset-0", (selected?.kind !== "browser" || page.id !== selected.id) && "invisible")}
                >
                  <BrowserView session={session} page={page} active={selected?.kind === "browser" && page.id === selected.id} />
                </div>
              ))}
              {!session.tabs.length && !shellPanes.length && !browserPages.length && !cloudTerminals.length && (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
                  {cloud?.locked ? (
                    // No access (never shared, or removed): the lock pane replaces the whole session body.
                    <NotSharedNotice kind={cloud.locked} onBack={() => selectSession(null)} onRecheck={cloud.recheckAccess} />
                  ) : cloud ? (
                    // One state at a time: stopped, loading, or empty (with what this person can do about it).
                    cloud.asleep ? (
                      <>
                        <span>Workspace stopped</span>
                        <span className="text-xs text-faint">
                          {cloud.backend.readOnlyReason ? "Its saved conversations appear here; nothing runs while it is stopped." : "Its saved conversations appear here; nothing runs until you send a message."}
                        </span>
                      </>
                    ) : !cloud.connected ? (
                      <span data-testid="cloud-session-loading">Loading the session…</span>
                    ) : (
                      <>
                        <span>No tabs in this session</span>
                        <span className="text-xs text-faint">
                          {cloud.manage ? "Add an agent tab or a terminal on the VM." : "A workspace admin can add an agent tab or a terminal."}
                        </span>
                      </>
                    )
                  ) : (
                    <>
                      <span>Workspace open</span>
                      <span className="text-xs text-faint">Open a new terminal or add an agent tab.</span>
                    </>
                  )}
                </div>
              )}
            </div>
            {hasEditors && <EditorSplit sessionId={session.id} active />}
          </div>
        </section>
      </div>

      {prefs.panelOpen && cloud && <CloudPanelHost session={session} cloud={cloud} tab={activeTab} />}
      {prefs.panelOpen && !cloud &&
        (activeTab ? (
          <PanelHost session={session} tab={activeTab} />
        ) : (
          <RightPanel
            cwd={session.cwd}
            isGit={project?.kind !== "folder"}
            branch={session.branch ?? null}
            workingTree
            sessionId={session.id}
            statusKey={statusKey}
            rootName={project?.name ?? "project"}
            settleSessionId={workspace ? session.id : undefined}
            workspace={workspace}
          />
        ))}
      {cloud ? (
        cloud.fileSource && (
          <>
            <QuickOpen sessionId={session.id} root={session.cwd} source={cloud.fileSource} />
            <ProjectSearch sessionId={session.id} root={session.cwd} source={cloud.fileSource} />
          </>
        )
      ) : (
        <>
          <QuickOpen sessionId={session.id} root={session.cwd} />
          <ProjectSearch sessionId={session.id} root={session.cwd} />
        </>
      )}
    </div>
  );
}
