import { LocalShareButton } from "./ShareSessionDialog";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClock, CircleDot, Cloud, FolderOpen, GitBranch, Globe, MessageSquare, MessageSquarePlus, PanelLeft, PanelRight, Terminal } from "@/icons";
import { describeGithubIdentity, refreshGithubIdentity, useGithubIdentity } from "@/lib/githubIdentity";
import { toggleTabView, useTabViews } from "@/lib/tabViews";
import { followedSelection, isTerminalTab, tabViewIn } from "@/lib/tabFront";
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
import { tabNodeId, tabPanelId } from "@/lib/sessionTabs";
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
import { localSessionBackend, terminalViewOf } from "@/lib/sessionBackend";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cloudAgentLabel } from "@/lib/cloudRowState";
import { CloudTerminalPane } from "@/components/cloud/CloudTerminalPane";
import { AccessChip, NotSharedNotice, PresenceAvatars } from "@/components/cloud/CloudCollab";
import { CloudResourceNotice } from "@/components/cloud/CloudResourceNotice";
import { presenceTab } from "@/lib/cloudCollab";
import { resolveSessionTab, setVisibleSessionTab } from "@/lib/visibleTab";
import { WorkspaceActionItems, WorkspaceLifecycleDialog, useLifecycleRun, type LifecycleRequest } from "@/components/cloud/WorkspaceActions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { lastSavedText } from "@/lib/cloudLifecycle";
import { findCloudWorkspace, useCloudCatalog } from "@/lib/cloudCatalog";
import { CloudDiagnosticsDialog, CloudDiagnosticsMenuItem, offersCloudDiagnostics } from "@/components/cloud/CloudDiagnosticsDialog";
import { CloudMirrorChip, CloudMirrorDialog, CloudMirrorMenuItem } from "@/components/cloud/CloudMirrorDialog";
import { CloudPortsView } from "@/components/cloud/CloudPorts";
import { showPanelTab } from "@/lib/panelTab";
import { useAccount } from "@/lib/account";
import { isQuickChat, quickChatPlace, sessionProjectName, useSessionIsGit } from "@/lib/quickChats";
import { WorkspaceTabStrip, stripTabId } from "./WorkspaceTabStrip";
import { localRemovableWorkspace } from "@/lib/workspaceRemoval";
import { PipelineStatus } from "@/components/issues/IssuePipelinePanel";
import { pipelineForSession, useIssuePipelines } from "@/lib/issuePipeline";

/** Why a quick chat's panel has no Changes, Repo or PR. */
const NO_REPOSITORY = "No repository here: Changes, Repo and PR need one. Point this chat at a repository, or move it to a project, to use them.";

/**
 * What a window draws around a session. The session itself (its tabs, their
 * bodies, the actions on them) is the same wherever it is shown; a shell says
 * which of the surrounding chrome it has room for.
 */
export interface SessionChrome {
  /**
   * One narrow column: no sidebar toggle, no project breadcrumb and no right
   * panel. `leading` then stands where the breadcrumb was.
   */
  compact?: boolean;
  /** The session's tabs in a row under the header, for a window with no sidebar to list them. */
  tabStrip?: boolean;
  /** At the left of the header, in place of the breadcrumb (a compact window's session switcher). */
  leading?: ReactNode;
  /** At the right of the header, after the session's own actions. */
  trailing?: ReactNode;
}

function managedWorkspaceFor(session: SessionEntry) {
  if (!session.worktreeName || session.worktreeRemoved) return undefined;
  return { projectPath: session.projectPath, name: session.worktreeName };
}

/** The right panel reads the active tab's log for the changes range. */
function PanelHost({ session, tab }: { session: SessionEntry; tab: TabEntry }) {
  const isGit = useSessionIsGit(session);
  const log = useTabLog(session.id, tab.id);
  const live = tab.status === "in_progress" || tab.status === "waiting";
  const workspace = managedWorkspaceFor(session);
  return (
    <RightPanel
      cwd={session.cwd}
      isGit={isGit}
      gitNote={isQuickChat(session) && !isGit ? NO_REPOSITORY : undefined}
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
  // PRO-28: only for someone who may use previews; it never connects or wakes the workspace.
  const ports = cloud.ports.offered
    ? (active: boolean) => (
        <CloudPortsView workspaceKey={cloud.workspaceKey} client={cloud.client} state={cloud.ports.state} connectionId={cloud.ports.connectionId} mayOpen active={active} />
      )
    : null;
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
        {/* Where previews stand while there is no connection: restarting, stopped, or closed with it. */}
        {ports && (
          <section className="shrink-0 border-t border-hairline" aria-label="Ports" data-testid="cloud-panel-offline-ports">
            <h2 className="flex items-center gap-1 px-3 pt-2 text-[11px] font-medium text-muted-foreground">
              <Globe className="size-3" /> Ports
            </h2>
            {ports(false)}
          </section>
        )}
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
      ports={ports ? () => ports(true) : undefined}
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
 * 5. In that same narrow header the terminal-view switch (PRO-86) must not
 *    cost the title its first 12 characters. A switch that is only a disabled
 *    placeholder ("not available here") is left out. A switch that works
 *    stays, and the location chip is left out instead: the sidebar row says
 *    where the session runs and has the same workspace menu.
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

/** GitHub's mark (the Octicons `mark-github` outline, MIT), since the icon set carries no brand marks. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * A local session's header with the tab strip in it (the main window, unless
 * the strip is turned off in Settings). The title bar then holds, from the
 * left: the session's name and its chips, the workspace's tabs, the "+", and
 * the session's actions at the right. What is left between the "+" and the
 * actions is empty, and is where the window is dragged from.
 *
 * The name, the chips and the tabs are laid out as one row (the breadcrumb
 * has no box of its own here), so each gives way in its turn and none runs
 * under another. The actions at the right never shrink and are never
 * covered. As the header narrows:
 *
 * 1. The tabs narrow evenly, to a width their titles still read at.
 * 2. The pipeline, automation, folder and branch chips shrink to their
 *    icons (the pipeline's to the dot that says where it stands), the way
 *    a cloud header's do (`STRIP_CHIP_YIELDS`: a label with no room left
 *    for even an ellipsis is out of sight, never a stray letter). Then the
 *    session's name shrinks to about its first ten characters
 *    (`STRIP_TITLE_YIELDS`); its full "project / session" is on its hover.
 *    The issue chip keeps its place.
 * 3. The tabs narrow further, down to an icon and a few characters each.
 * 4. The row of tabs scrolls, with a menu at its end that lists every tab,
 *    until two tabs are left in view.
 *
 * Past that nothing can shrink, so what is drawn depends on the header's
 * width, least needed first:
 *
 * 5. Narrower than `STRIP_NARROW`: the branch, folder and base chips are
 *    left out (the sidebar's workspace row shows them), and one tab stays in
 *    view beside the menu.
 * 6. Narrower than `STRIP_TIGHT`: the session's name is left out (the
 *    sidebar and each tab's hover have it), and Share keeps only its icon.
 * 7. Narrower than `STRIP_MENU`: the row of tabs is the menu alone, and the
 *    issue chip keeps only its icon.
 */
const STRIP_CHIP_YIELDS = cn(HEADER_CHIP_YIELDS, "shrink-[10000] overflow-hidden");
const STRIP_TITLE_YIELDS = "shrink-[200]";
const STRIP_NARROW = "@max-[650px]/session-header:hidden";
const STRIP_TIGHT = "@max-[540px]/session-header:hidden";
const STRIP_MENU = "@max-[415px]/session-header:hidden";
/** How many tabs the strip keeps in view at their narrowest, and its giving way to its menu in the narrowest header. */
const STRIP_FLOOR =
  "[--tab-floor:2] @max-[650px]/session-header:[--tab-floor:1] @max-[415px]/session-header:min-w-0! @max-[415px]/session-header:grow-0! @max-[415px]/session-header:basis-auto! @max-[415px]/session-header:[&>[role=tablist]]:hidden";

/** What a presence tab id names in this session: an agent tab's title or a terminal. */
function tabLabelOf(cloud: CloudSessionModel, tabId: string): string | null {
  const tab = cloud.session.tabs.find((candidate) => candidate.id === tabId);
  if (tab) return tab.title?.trim() || cloudAgentLabel(tab.harness);
  const terminal = cloud.terminals.find((candidate) => candidate.ptyId === tabId || candidate.id === tabId);
  return terminal ? `Terminal ${terminal.number}` : null;
}

/** When a stopped workspace was last saved, as its stop reported it (PRO-33). */
function CloudLastSaved({ cloud }: { cloud: CloudSessionModel }) {
  const item = findCloudWorkspace(useCloudCatalog(), cloud.orgId, cloud.workspaceId);
  const saved = item ? lastSavedText(item) : null;
  return saved ? (
    <span className="max-w-md px-6 text-center text-xs text-faint" data-testid="cloud-last-saved">
      {saved}
    </span>
  ) : null;
}

/** Where a cloud session runs, and whether this window is attached to it. The location chip holds the workspace's lifecycle actions. */
function CloudLocation({
  cloud,
  yields = false,
  onShowPorts,
}: {
  cloud: CloudSessionModel;
  /** Left out of a tight header (see the order above). */
  yields?: boolean;
  /** Opens the side panel's Ports tab; absent for anyone who may not use previews, and in a window with no panel. */
  onShowPorts?: () => void;
}) {
  const { location, connection } = cloud;
  const catalog = useCloudCatalog();
  const item = findCloudWorkspace(catalog, cloud.orgId, cloud.workspaceId);
  const menu = useRowMenu();
  const [request, setRequest] = useState<LifecycleRequest | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [mirror, setMirror] = useState(false);
  const { status } = useAccount();
  const [error, run] = useLifecycleRun();
  const title = `Runs in the cloud workspace ${cloud.workspaceName} (${location.provider}, ${location.org}), not on this computer.`;
  const chipClass = cn("ml-1 flex max-w-[30%] items-center overflow-hidden rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground", HEADER_CHIP_YIELDS, yields && HEADER_TIGHT);
  const chip = (
    <>
      <Cloud className={HEADER_CHIP_ICON} />
      <span className={cn("truncate", HEADER_CHIP_LABEL)}>Cloud · {location.provider} · {location.org}</span>
    </>
  );
  const diagnosticsOffered = offersCloudDiagnostics(status, cloud.orgId);
  return (
    <>
      {item || diagnosticsOffered || onShowPorts ? (
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
            {/* For anyone who can read the workspace's files; a locked session has none to copy. */}
            {item && !cloud.locked && (
              <>
                <DropdownMenuSeparator />
                <CloudMirrorMenuItem onSelect={() => setMirror(true)} />
              </>
            )}
            {onShowPorts && (
              <>
                {item && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={onShowPorts}>
                  <Globe /> Ports and previews
                </DropdownMenuItem>
              </>
            )}
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
      {mirror && <CloudMirrorDialog request={{ orgId: cloud.orgId, workspaceId: cloud.workspaceId, workspaceName: cloud.workspaceName }} onClose={() => setMirror(false)} />}
      {!cloud.locked && <CloudMirrorChip orgId={cloud.orgId} workspaceId={cloud.workspaceId} onOpen={() => setMirror(true)} />}
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
  chrome,
}: {
  session: SessionEntry;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** A cloud session: its backend, terminals, sources and location. */
  cloud?: CloudSessionModel;
  /** What this window draws around the session; the main window's full chrome when absent. */
  chrome?: SessionChrome;
}) {
  const compact = !!chrome?.compact;
  // PRO-28: the side panel's Ports tab, from the header's menus; a compact window has no panel.
  const showPorts = cloud?.ports.offered && !compact ? () => showPanelTab("ports") : undefined;
  const isGit = useSessionIsGit(session);
  const quick = isQuickChat(session);
  const pipelineRole = pipelineForSession(useIssuePipelines(), session.id);
  const prefs = usePrefs();
  const store = useSessionStore();
  const backend = cloud?.backend ?? localSessionBackend(session.id);
  const local = backend.caps.local;
  // The workspace's tabs in the title bar: the main window's local sessions, unless the reader turned the strip off.
  const strip = local && !cloud && !compact && prefs.tabStrip;
  // A window with no room in its title bar (the floating one) draws the same tabs in a row under it.
  const stripRow = !!chrome?.tabStrip && !cloud && !strip;
  // A tab's panel is named by the tab that shows it: the strip's while there is one, else the sidebar's row.
  const labelledBy = strip || stripRow ? stripTabId : tabNodeId;
  // What the chat's Delete workspace acts on; a cloud session's is its runtime's.
  const localWorkspace = cloud ? undefined : localRemovableWorkspace(session);
  const project = store.projects.find((p) => p.path === session.projectPath);
  // The GitHub account the folder is connected to: a chat's is its linked repo's; a plain folder has none; a cloud session's is not this computer's to say.
  const githubIdentity = useGithubIdentity(cloud || !isGit ? null : (session.link?.path ?? session.cwd));
  const terminals = useTerminals();
  // A shell an agent was started in is that agent's tab (#437), drawn by its tab view and not as a shell beside it.
  const shellPanes = local ? terminals.panes.filter((pane) => pane.sessionId === session.id && !pane.hidden && !session.tabs.some((tab) => tab.pane === pane.id)) : [];
  const cloudTerminals = cloud?.terminals ?? [];
  const browserState = useBrowser();
  const browserPages = local ? pagesFor(browserState.pages, session.cwd) : [];
  useEffect(() => {
    if (local) void bootBrowser();
  }, [local]);
  const requested = followedSelection(session, terminals.selected[session.id]);
  const terminalIds = local ? shellPanes.map((pane) => pane.id) : cloudTerminals.map((terminal) => terminal.id);
  // A cloud session's active tab is the runtime's, shared by everyone in it: it moves to a new tab
  // when anyone adds one. It decides what this view opens on, once: from then the view stays on
  // the tab it shows until this person picks another (or that tab closes), so a tab someone else
  // adds never takes the view. Until the runtime's active tab is known and listed, the tab shown
  // is a guess that it may still correct.
  const shownTab = useRef<{ sessionId: string; tab: SelectedSessionTab } | null>(null);
  const kept = cloud && shownTab.current?.sessionId === session.id ? shownTab.current.tab : null;
  const agentIds = session.tabs.map((tab) => tab.id);
  const selected: SelectedSessionTab | null = resolveSessionTab({
    requested,
    current: kept,
    agentIds,
    activeTab: session.activeTab,
    terminalIds,
    browserIds: browserPages.map((page) => page.id),
  });
  const opened = !!kept || (!!session.activeTab && agentIds.includes(session.activeTab));
  shownTab.current = cloud && selected && opened ? { sessionId: session.id, tab: selected } : null;
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
  // The chat or terminal switch: every local tab has it; a cloud tab while its runtime serves the agent's terminal (PRO-86).
  const terminalOffer = activeTab && !cloud?.locked ? terminalViewOf(backend, activeTab) : null;
  const activeInTerminal = !!activeTab && !!terminalOffer?.available && tabViewIn(tabViews.views, activeTab) === "terminal";
  // A tab that is a terminal (#437) has no live chat to go back to: its other face is the conversation it last held, when it held one.
  const activeIsTerminal = !!activeTab && local && isTerminalTab(activeTab);
  const terminalHasConversation = !!activeTab && (!!activeTab.providerSessionId || !!activeTab.history?.length);
  const viewSwitch = activeIsTerminal
    ? { toChat: "Show the last conversation", toTerminal: "Back to the terminal" }
    : { toChat: "Back to chat", toTerminal: "Show terminal view" };
  const switching = !!activeTab && !!tabViews.switching[activeTab.id];
  const workspaceLabel = session.worktreeRemoved ? workspaceName(session) : session.branch;
  const workspaceTitle = session.removedWorkspace?.path ?? session.cwd;
  const baseNote = session.worktreeBase && !session.worktreeBase.warning ? `Base ${session.worktreeBase.commit.slice(0, 7)}${session.worktreeBase.fetched ? " · fetched at creation" : ""}` : null;
  const [continuationSource, setContinuationSource] = useState<TabEntry | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const workspace = managedWorkspaceFor(session);
  // One action for local and cloud tabs, so a remapped shortcut switches either.
  useShortcut("session.toggleTerminalView", () => {
    if (activeTab && terminalOffer?.available) void toggleTabView(session, activeTab, { remote: !local });
  });
  const ed = useEditors();
  const hasEditors = ed.editors.some((e) => e.sessionId === session.id);
  // Agents change files when their status changes; the explorer re-reads git then.
  const statusKey = session.tabs.map((t) => t.status).join(",");

  // A local session with no agent opens a shell. A cloud one never opens
  // anything by itself: that could wake a stopped workspace.
  //
  // That is for a session opened with no agent, and for one whose last tab
  // of any kind just closed. When its last agent tab closes while a shell or
  // a page is on screen, the reader is somewhere: the view is not taken from
  // them, and no shell they did not ask for is opened behind it.
  const shownKind = useRef(selectedKind);
  shownKind.current = selectedKind;
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    const opening = openedOn.current !== session.id;
    openedOn.current = session.id;
    if (!local || session.tabs.length) return;
    if (!opening && shownKind.current) return;
    // A compact window has no panel to open.
    if (!compact && !getPrefs().panelOpen) setPrefs({ panelOpen: true });
    void activateLatestTerminal(session.id, session.cwd).catch((e) => console.error("terminal open failed", e));
  }, [local, compact, session.id, session.cwd, session.tabs.length]);

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
          className={cn("flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2", (cloud || strip) && "@container/session-header")}
          style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && !compact && (
            <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          {compact ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 text-sm" data-testid="session-compact-leading">{chrome?.leading}</div>
          ) : (
          /* A cloud header in a narrow window gives way in order (see HEADER_CHIP_YIELDS), and clips rather than run under the buttons on the right. */
          /* Beside the tabs its parts are items of the header's own row (it has no box), so each gives way in its turn and none runs under a tab. */
          <div className={cn("text-sm", strip ? "contents" : "flex min-w-0 flex-1 items-center gap-1.5 px-1", cloud && "overflow-hidden")} data-testid="session-breadcrumb">
            {/* The GitHub account the folder is connected to, first: the mark alone, the account on hover; a click asks GitHub again. */}
            {githubIdentity?.login && (
              <WithTooltip label={`Connected to GitHub as ${githubIdentity.login}. ${describeGithubIdentity(githubIdentity)}`}>
                <button
                  type="button"
                  onClick={() => void refreshGithubIdentity(session.link?.path ?? session.cwd)}
                  aria-label={`Connected to GitHub as ${githubIdentity.login}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-veil-raised hover:text-foreground"
                  data-testid="session-github-account"
                >
                  <GithubMark className="size-3.5" />
                </button>
              </WithTooltip>
            )}
            {/* A cloud session that goes by its project's name (untitled, or locked with nothing else to name) has one title, not the same one twice. */}
            {/* With the tabs in the title bar the project is on the title's hover, not beside it. */}
            {!strip && !(cloud && cloud.projectName === session.title) && (
              <>
                <span className={cn("max-w-[30%] truncate text-muted-foreground", cloud && HEADER_PROJECT_YIELDS, cloud && HEADER_TIGHT)} title={cloud ? cloud.projectName : quick ? "A quick chat: it has no project" : project?.name} data-testid="session-project">
                  {cloud ? cloud.projectName : quick ? sessionProjectName(session, project) : (project?.name ?? "project")}
                </span>
                <span className={cn("text-faint", cloud && HEADER_TIGHT)}>/</span>
              </>
            )}
            {local && workspaceLabel ? (
              /* A local chat is placed by its branch, not named by its title (the sidebar names it): "terminalx / main". */
              <span
                className={cn("flex min-w-0 items-center gap-1 text-foreground", strip && cn("ml-1 max-w-56", STRIP_TITLE_YIELDS, STRIP_TIGHT))}
                title={[session.title, workspaceTitle, baseNote].filter(Boolean).join("\n")}
                data-testid="session-branch"
              >
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                {session.worktreeName && !session.worktreeRemoved ? (
                  <WorkspaceNameEditor
                    value={session.worktreeName}
                    onCommit={async (requested) => {
                      const renamed = await renameWorkspace(session.projectPath, session.cwd, requested);
                      return renamed.name;
                    }}
                    onError={setRenameError}
                    className="max-w-52"
                  />
                ) : (
                  <span className="truncate">{workspaceLabel}</span>
                )}
                {session.worktreeRemoved && <span className="shrink-0 text-[11px] text-faint">· workspace removed</span>}
              </span>
            ) : (
              <span
                className={cn("truncate text-foreground", strip && cn("ml-1 max-w-56", STRIP_TITLE_YIELDS, STRIP_TIGHT))}
                // Beside the tabs the name keeps about its first ten characters, or all of a shorter one.
                style={strip ? { minWidth: `${Math.min(session.title.length, 10)}ch` } : undefined}
                title={strip ? [`${quick ? sessionProjectName(session, project) : (project?.name ?? "project")} / ${session.title}`, workspaceTitle, baseNote].filter(Boolean).join("\n") : session.title}
                data-testid="session-title"
              >
                {session.title}
              </span>
            )}
            {session.issue && (
              <WithTooltip label={session.issue.title}>
                <button
                  type="button"
                  onClick={() => void openUrl(session.issue!.url)}
                  className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CircleDot className="size-3" />
                  <span className={cn(strip && STRIP_MENU)}>{session.issue.identifier}</span>
                </button>
              </WithTooltip>
            )}
            {pipelineRole && (
              // The issue pipeline this session is part of, as its author or its reviewer.
              <WithTooltip label={`${pipelineRole.role === "reviewer" ? "Reviewing" : "Working on"} ${pipelineRole.pipeline.issue.identifier} · ${pipelineRole.pipeline.note ?? pipelineRole.pipeline.issue.title}`}>
                <button
                  type="button"
                  onClick={() => (pipelineRole.pipeline.pr ? void openUrl(pipelineRole.pipeline.pr.url) : void openUrl(pipelineRole.pipeline.issue.url))}
                  className={cn(
                    "ml-1 flex items-center rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground",
                    // Beside the tabs it gives way like the other chips, down to the dot that says where the pipeline stands.
                    strip ? cn("max-w-48", STRIP_CHIP_YIELDS, "gap-x-1.5") : "shrink-0 gap-1.5",
                  )}
                  data-testid="session-pipeline"
                >
                  {strip ? (
                    // The status laid out as the chip's own icon and label: the dot leads and stays, and the words are one label that is cut, then gone.
                    <PipelineStatus
                      pipeline={pipelineRole.pipeline}
                      className="contents"
                      dotClassName="my-[7px]"
                      labelClassName={cn("truncate", HEADER_CHIP_LABEL)}
                      lead={pipelineRole.role === "reviewer" ? <span className="font-normal text-muted-foreground">Reviewer · </span> : null}
                    />
                  ) : (
                    <>
                      {pipelineRole.role === "reviewer" && <span>Reviewer ·</span>}
                      <PipelineStatus pipeline={pipelineRole.pipeline} />
                    </>
                  )}
                </button>
              </WithTooltip>
            )}
            {session.automation && (
              <WithTooltip label={`Open ${session.automation.name} in Automations`}>
                <button
                  type="button"
                  onClick={openAutomations}
                  className={cn("ml-1 flex items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground", strip ? cn("max-w-40", STRIP_CHIP_YIELDS) : "shrink-0")}
                  data-testid="session-automation"
                >
                  <CalendarClock className={strip ? HEADER_CHIP_ICON : "size-3 shrink-0"} />
                  <span className={cn(strip && cn("truncate", HEADER_CHIP_LABEL))}>{session.automation.name} #{session.automation.runNumber}</span>
                </button>
              </WithTooltip>
            )}
            {quick && (
              // Where a quick chat runs: it has no project to say so.
              <span className={cn("ml-1 flex min-w-0 items-center gap-1 overflow-hidden rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground", strip ? cn("max-w-40", STRIP_CHIP_YIELDS, STRIP_NARROW) : "max-w-[35%]")} title={session.cwd} data-testid="session-quick-place">
                <FolderOpen className={strip ? HEADER_CHIP_ICON : "size-3 shrink-0"} />
                <span className={cn("truncate", strip && HEADER_CHIP_LABEL)}>{quickChatPlace(session)}</span>
              </span>
            )}
            {/* A cloud session's branch is a chip after its title; a local one's is the crumb above. */}
            {!local && workspaceLabel && (
              <span
                className={cn(
                  "ml-1 flex items-center overflow-hidden rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground",
                  strip ? "max-w-48" : "max-w-[35%]",
                  cloud ? cn(HEADER_CHIP_YIELDS, HEADER_TIGHT) : strip ? cn(STRIP_CHIP_YIELDS, STRIP_NARROW) : "min-w-0 gap-1",
                )}
                title={workspaceTitle}
                data-testid="session-branch"
              >
                <GitBranch className={cloud || strip ? HEADER_CHIP_ICON : "size-3 shrink-0"} />
                {local && session.worktreeName && !session.worktreeRemoved ? (
                  <WorkspaceNameEditor
                    value={session.worktreeName}
                    onCommit={async (requested) => {
                      const renamed = await renameWorkspace(session.projectPath, session.cwd, requested);
                      return renamed.name;
                    }}
                    onError={setRenameError}
                    className={cn("text-muted-foreground hover:text-foreground", strip ? cn("truncate text-left", HEADER_CHIP_LABEL) : "max-w-52")}
                  />
                ) : (
                  <span className={cn("truncate", (cloud || strip) && HEADER_CHIP_LABEL)}>{workspaceLabel}</span>
                )}
                {session.worktreeRemoved && <span className="text-faint">· workspace removed</span>}
              </span>
            )}
            {/* Beside the tabs only a base that may be out of date is said aloud; an ordinary one is on the title's hover. */}
            {session.worktreeBase && (!strip || session.worktreeBase.warning) && (
              <span
                role={session.worktreeBase.warning ? "status" : undefined}
                className={cn("truncate text-[11px] text-muted-foreground", strip && cn("min-w-0 shrink-[10000]", STRIP_NARROW))}
                title={session.worktreeBase.warning ?? `Base commit: ${session.worktreeBase.commit}`}
              >
                {session.worktreeBase.warning
                  ? "Base may be out of date"
                  : `Base ${session.worktreeBase.commit.slice(0, 7)}${session.worktreeBase.fetched ? " · fetched at creation" : ""}`}
              </span>
            )}
            {cloud && <CloudLocation cloud={cloud} yields={!!terminalOffer?.available} onShowPorts={showPorts} />}
            {renameError && (
              <span role="alert" className={cn("ml-1 max-w-64 truncate text-[11px] text-destructive", strip && "min-w-0 shrink-[10000]")} title={renameError}>
                {renameError}
              </span>
            )}
          </div>
          )}

          {strip && (
            <>
              <WorkspaceTabStrip session={session} selected={selected} placement="titlebar" readOnlyReason={backend.readOnlyReason} className={STRIP_FLOOR} />
              {/* The "+" ends the row of tabs, as in a browser. Keyed by session: a menu left open never carries over to another session. */}
              <TabActions key={session.id} session={session} selected={selected} />
              {/* Empty title bar: what is left here is where the window is dragged from. */}
              <div aria-hidden className="min-w-6 flex-[0.001_1_0%] self-stretch @max-[415px]/session-header:min-w-2" data-testid="session-header-handle" />
            </>
          )}
          <div className={cn("flex shrink-0 items-center gap-0.5", !strip && "ml-auto", !compact && !strip && "max-w-[70%]")}>
            {/* The compact (floating) window has no share dialog to open. */}
            {local && !compact && <LocalShareButton sessionId={session.id} labelClassName={strip ? STRIP_TIGHT : undefined} />}
            {/* Keyed by session: a menu left open never carries over to another session. */}
            {!strip && !cloud?.locked && <TabActions key={session.id} session={session} selected={selected} cloud={cloud} onShowPorts={showPorts} />}
            {activeTab && local && (
              <WithTooltip label="Continue in New Session…">
                <Button variant="ghost" size="icon-sm" aria-label="Continue in New Session…" onClick={() => setContinuationSource(activeTab)}>
                  <MessageSquarePlus />
                </Button>
              </WithTooltip>
            )}
            {activeTab && terminalOffer?.available && (!activeIsTerminal || terminalHasConversation) && (
              <WithTooltip label={activeInTerminal ? viewSwitch.toChat : viewSwitch.toTerminal} shortcut="session.toggleTerminalView">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={activeInTerminal ? viewSwitch.toChat : viewSwitch.toTerminal}
                  aria-pressed={activeInTerminal}
                  disabled={switching}
                  onClick={() => void toggleTabView(session, activeTab, { remote: !local })}
                  className={cn(activeInTerminal && "bg-veil-strong text-foreground")}
                >
                  {activeInTerminal ? <MessageSquare /> : <Terminal />}
                </Button>
              </WithTooltip>
            )}
            {activeTab && terminalOffer && !terminalOffer.available && (
              // Not offered here (an older runtime, or an agent with no terminal): the switch stays in its place, off, and says why.
              <WithTooltip label={terminalOffer.reason ?? undefined}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Terminal view is not available"
                  aria-disabled
                  title={terminalOffer.reason ?? undefined}
                  data-testid="terminal-view-unavailable"
                  className={cn("cursor-not-allowed opacity-40 hover:bg-transparent", cloud && HEADER_TIGHT)}
                  onClick={(event) => event.preventDefault()}
                >
                  <Terminal />
                </Button>
              </WithTooltip>
            )}
            {!compact && (
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
            )}
            {chrome?.trailing}
          </div>
        </header>
        {stripRow && <WorkspaceTabStrip session={session} selected={selected} placement="row" hideSingle className="border-b border-hairline px-1.5" />}
        {cloud && !cloud.locked && <CloudResourceNotice workspaceKey={cloud.workspaceKey} turn={session.tabs.some((t) => t.status === "in_progress")} manage={cloud.manage} />}

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
                  aria-labelledby={labelledBy({ kind: "agent", id: t.id })}
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
                    workspace={cloud ? cloud.removableWorkspace : localWorkspace}
                  />
                </div>
              ))}
              {shellPanes.map((pane) => (
                <div
                  key={pane.id}
                  id={tabPanelId({ kind: "terminal", id: pane.id })}
                  role="tabpanel"
                  aria-labelledby={labelledBy({ kind: "terminal", id: pane.id })}
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
                  aria-labelledby={labelledBy({ kind: "browser", id: page.id })}
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
                        <CloudLastSaved cloud={cloud} />
                      </>
                    ) : !cloud.connected ? (
                      <span data-testid="cloud-session-loading">Loading the session…</span>
                    ) : (
                      <>
                        <span>No tabs in this session</span>
                        <span className="text-xs text-faint">
                          {cloud.manage ? "Add an agent tab or a terminal on the VM." : "Only this workspace's creator or an organization owner or admin can add an agent tab or a terminal."}
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

      {!compact && prefs.panelOpen && cloud && <CloudPanelHost session={session} cloud={cloud} tab={activeTab} />}
      {!compact && prefs.panelOpen && !cloud &&
        (activeTab ? (
          <PanelHost session={session} tab={activeTab} />
        ) : (
          <RightPanel
            cwd={session.cwd}
            isGit={isGit}
            gitNote={quick && !isGit ? NO_REPOSITORY : undefined}
            branch={session.branch ?? null}
            workingTree
            sessionId={session.id}
            statusKey={statusKey}
            rootName={quick ? quickChatPlace(session) : (project?.name ?? "project")}
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
