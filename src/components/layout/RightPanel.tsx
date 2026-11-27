import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useShortcut } from "@/lib/hotkeys";
import type { ShortcutId } from "@/lib/shortcuts";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { ChangesPanel } from "@/components/changes/ChangesPanel";
import { BranchTab } from "@/components/changes/BranchTab";
import { FileTree } from "@/components/files/FileTree";
import { TerminalDock } from "@/components/terminal/TerminalDock";
import { ComputerPanel } from "@/components/computer/ComputerPanel";
import { BrowserPanel } from "@/components/browser/BrowserPanel";
import { openWorkspaceDelete, openWorkspaceRemove } from "@/lib/dialogs";
import { api, type PullRequest } from "@/lib/api";
import { localGitSource, type GitSource } from "@/lib/gitSource";
import { noteChangesCount, useChangesCount, useChecksMark } from "@/lib/panelMarks";
import { openFile } from "@/lib/editors";
import { pathInFileRoot, type FileSource } from "@/lib/workspaceFiles";
import type { RemovableWorkspace } from "@/lib/workspaceRemoval";
import type { AgentEvent } from "@/types/events";
import type { WorkStatus } from "@/types/session";
import { onPanelTab, rememberPanelTab, rememberedPanelTab, takePanelTab, type PanelTab } from "@/lib/panelTab";
import { onPrLinksChanged } from "@/lib/prLinks";
import { WindowControls } from "./WindowControls";
import { ArtifactsTab } from "@/components/teamArtifacts/ArtifactsTab";
import { useAccount } from "@/lib/account";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { teamArtifactOrg } from "@/lib/teamArtifacts";

export type { PanelTab };
const TABS: { id: PanelTab; label: string; shortcut?: ShortcutId }[] = [
  // A session's team templates (PRO-158, 06.04), while the organization has team artifacts.
  { id: "artifacts", label: "Artifacts" },
  // Changes (committing and history) and Checks (the pull request, its checks and the branch's next step) are tabs
  // of their own (PRO-394, design 05.02). Checks keeps the "branch" id, so every link and shortcut to it still lands.
  { id: "changes", label: "Changes", shortcut: "panel.changes" },
  { id: "branch", label: "Checks", shortcut: "panel.repository" },
  { id: "files", label: "Files", shortcut: "panel.files" },
  { id: "browser", label: "Browser" },
  { id: "ports", label: "Ports" },
  { id: "computer", label: "Computer" },
];

/**
 * One frame with tabs, not one panel per view. Bodies hide rather than
 * unmount so scroll position and picked files survive the flip, and the
 * `active` prop keeps a hidden body from refetching.
 */
export function RightPanel({
  cwd,
  isGit = true,
  gitNote,
  branch,
  baseRef,
  from,
  events = [],
  version = 0,
  live = false,
  workingTree = false,
  sessionId,
  mentionTabId,
  computerTab,
  onFixErrors,
  fixBusy,
  statusKey = "",
  rootName,
  labelMode,
  settleSessionId,
  workspace,
  machineWorkspace,
  gitSource,
  fileSource,
  repositories,
  readOnlyReason,
  ports,
  portsCount = 0,
  terminals = false,
  computer = false,
  browser = false,
  dock,
}: {
  cwd: string;
  isGit?: boolean;
  /** Why there is no Branch or Changes, shown above Files when `isGit` is false and the reason is worth saying. */
  gitNote?: string;
  /** Undefined asks the panel to resolve the checkout branch itself. */
  branch?: string | null;
  baseRef?: string | null;
  /** The ref the session's worktree was made from: the Branch tab reads the branch against it. */
  from?: string | null;
  events?: AgentEvent[];
  version?: number;
  live?: boolean;
  workingTree?: boolean;
  sessionId?: string;
  mentionTabId?: string | null;
  /** The tab on screen and its conversation, whose desktop the Computer tab attaches. */
  computerTab?: { tabId: string; conversation: string | null };
  onFixErrors?: (pr: PullRequest) => Promise<unknown>;
  fixBusy?: boolean;
  statusKey?: string;
  rootName?: string;
  labelMode?: "base" | "branch";
  settleSessionId?: string;
  /** Present only for a managed, non-main workspace. */
  workspace?: { projectPath: string; name: string };
  machineWorkspace?: RemovableWorkspace;
  /** Where Branch and Changes read Git; the local checkout at `cwd` when absent. */
  gitSource?: GitSource;
  /** Where Files reads; the local checkout at `cwd` when absent. */
  fileSource?: FileSource;
  /** A cloud workspace with several repositories: which one Branch and Changes show. */
  repositories?: { list: string[]; selected: string | null; onSelect: (repo: string | null) => void };
  /** Shown above the panels when this attachment may read but not change the workspace. */
  readOnlyReason?: string | null;
  /** A cloud workspace's Ports tab (PRO-28), drawn only while it is the tab shown; absent for anyone who may not use previews. */
  ports?: () => ReactNode;
  /** Ports forwarded to this Mac now, shown on the tab ("Ports 3", 14.11); none shown at 0. */
  portsCount?: number;
  /** A local session's panel: shells in its folder, docked below the tabs. */
  terminals?: boolean;
  /** A local session's panel: the Computer tab, a desktop to watch and that agents can use. */
  computer?: boolean;
  /** A local session's panel: the Browser tab, the workspace's pages beside the chat, shared with the agent. */
  browser?: boolean;
  /** Terminals that are not this computer's, docked below the tabs instead (a machine session's, PRO-347). */
  dock?: ReactNode;
}) {
  const prefs = usePrefs();
  // A session's panel reopens on the tab it last showed (PRO-130), after a switch to another session or a relaunch.
  // Null until a tab is picked: the first one depends on the Git source, which a cloud session learns after drawing.
  // The panel stays mounted from one session to the next, so the pick is kept with the session it was made in.
  const [choice, setChoice] = useState<{ sessionId: string | undefined; tab: PanelTab | null }>(() => ({
    sessionId,
    tab: takePanelTab() ?? (sessionId ? rememberedPanelTab(sessionId) : null),
  }));
  const picked = choice.sessionId === sessionId ? choice.tab : sessionId ? rememberedPanelTab(sessionId) : null;
  const current = useRef(sessionId);
  current.current = sessionId;
  const setTab = useCallback((tab: PanelTab) => setChoice({ sessionId: current.current, tab }), []);
  useEffect(() => {
    if (sessionId && picked) rememberPanelTab(sessionId, picked);
  }, [sessionId, picked]);
  // A menu elsewhere asked for a tab (the session's "Ports and previews").
  useEffect(
    () =>
      onPanelTab((asked) => {
        takePanelTab();
        setTab(asked);
      }),
    [setTab],
  );
  const [focusPr, setFocusPr] = useState(0);
  // A pull request just linked to this session (PRO-294): scroll to it in the Branch tab.
  useEffect(() => sessionId ? onPrLinksChanged((changed) => { if (changed === sessionId) setFocusPr((n) => n + 1); }) : undefined, [sessionId]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const fallback: PanelTab = isGit ? "changes" : "files";
  // The branch picture reads this computer's checkout; a cloud workspace's Branch tab is its pull request alone, and its panel opens on Changes.
  const branchPicture = !gitSource?.cloud;
  const selectedTab: PanelTab = picked ?? (branchPicture ? "branch" : "changes");
  const { status: account } = useAccount();
  const privacy = useDataPrivacy();
  const artifactsOrg = privacy.enabled || readOnlyReason ? null : teamArtifactOrg(account);
  const tab: PanelTab =
    selectedTab === "artifacts"
      ? artifactsOrg
        ? "artifacts"
        : fallback
      : selectedTab === "ports"
      ? ports
        ? "ports"
        : fallback
      : selectedTab === "computer"
        ? computer
          ? "computer"
          : fallback
        : selectedTab === "browser"
          ? browser && sessionId
            ? "browser"
            : fallback
        : isGit
          ? selectedTab
          : "files";
  const dragging = useRef<{ x: number; w: number } | null>(null);
  // What the tab row says of the tabs not shown: Checks' red dot, the number of files in Changes (PRO-394).
  const checksMark = useChecksMark(sessionId);
  const changesSource = isGit ? (gitSource ?? localGitSource(cwd)) : null;
  const changesCount = useChangesCount(changesSource?.key);
  useEffect(() => {
    // A cloud workspace's Changes view counts itself once read; a local branch is counted here, after each turn.
    if (!changesSource || changesSource.cloud) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      changesSource.reviewRange(null, false)
        .then((range) => changesSource.changesBetween(range.base, range.head, false))
        .then((files) => { if (!cancelled) noteChangesCount(changesSource.key, files.length); })
        .catch(() => { /* The count is left unsaid; the Changes view says what went wrong. */ });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [changesSource, refreshTick, statusKey]);

  useEffect(() => {
    if (!isGit || (branch !== undefined && !labelMode)) return;
    let cancelled = false;
    (gitSource ? gitSource.workStatus() : api.workStatus(cwd))
      .then((next) => !cancelled && setStatus(next))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [cwd, gitSource, branch, labelMode, refreshTick, isGit]);

  // Git paths are relative to the selected repository, which can differ from the Files root.
  const [gitWorkspace, gitRepository] = gitSource?.cloud ? gitSource.key.split("|") : [];
  const fileBase = fileSource?.key === gitWorkspace ? "" : gitWorkspace && fileSource?.key.startsWith(`${gitWorkspace}/`) ? fileSource.key.slice(gitWorkspace.length + 1) : null;
  const repository = gitRepository === "." ? "" : gitRepository;

  const resolvedBranch = branch === undefined ? (status?.branch ?? null) : branch;
  const targetLabel = !isGit ? "Folder" : tab === "changes" && labelMode === "base" ? null : labelMode === "base" ? `base: ${status?.defaultBranch ?? "default"}` : labelMode === "branch" ? (resolvedBranch ?? "current branch") : null;

  useShortcut("panel.changes", () => setTab("changes"));
  useShortcut("panel.repository", () => setTab("branch"));
  useShortcut("panel.pullRequests", () => {
    setTab("branch");
    setFocusPr((n) => n + 1);
  });
  useShortcut("panel.files", () => setTab("files"));

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = { x: e.clientX, w: prefs.panelWidth };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [prefs.panelWidth],
  );
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    const w = Math.max(300, Math.min(760, d.w - (e.clientX - d.x)));
    document.documentElement.style.setProperty("--panel-w", `${w}px`);
  }, []);
  const onUp = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    const w = Math.max(300, Math.min(760, d.w - (e.clientX - d.x)));
    setPrefs({ panelWidth: w });
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--panel-w", `${prefs.panelWidth}px`);
  }, [prefs.panelWidth]);

  return (
    <aside className="relative flex h-full w-(--panel-w) shrink-0 flex-col border-l border-hairline">
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-ring/30"
      />
      <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-0.5 border-b border-hairline px-2">
        {TABS.filter((t) => (t.id === "artifacts" ? !!artifactsOrg : t.id === "ports" ? !!ports : t.id === "computer" ? computer : t.id === "browser" ? browser && !!sessionId : isGit || t.id === "files")).map((t) => (
          <WithTooltip key={t.id} label={t.id === "branch" && checksMark === "failed" ? "Checks · failing" : t.label} shortcut={t.shortcut}>
            <button
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={cn(
                // Tabs as the design's pills (05.02): the open one filled.
                "flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] whitespace-nowrap transition-colors",
                tab === t.id ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.id === "ports" && portsCount > 0 && (
                <span className="ml-1 font-normal tabular-nums text-faint" data-testid="panel-ports-count">
                  {portsCount}
                </span>
              )}
              {t.id === "changes" && changesCount != null && changesCount > 0 && <span className="ml-1 font-mono text-xs text-faint" data-testid="panel-changes-count">{changesCount}</span>}
              {t.id === "branch" && checksMark === "failed" && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-destructive" role="img" aria-label="failing" data-testid="panel-checks-failing" />}
            </button>
          </WithTooltip>
        ))}
        {targetLabel && (
          <span className="ml-auto min-w-0 truncate px-1 font-mono text-[10px] text-faint" title={targetLabel}>
            {targetLabel}
          </span>
        )}
        <WithTooltip label="Refresh">
          <Button variant="ghost" size="icon-xs" aria-label="Refresh" className={targetLabel ? undefined : "ml-auto"} onClick={() => setRefreshTick((t) => t + 1)}>
            <RefreshCw />
          </Button>
        </WithTooltip>
        <WindowControls />
      </div>
      {repositories && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 py-1">
          <select
            aria-label="Repository"
            value={repositories.selected ?? ""}
            onChange={(event) => repositories.onSelect(event.target.value || null)}
            className="h-6 min-w-0 flex-1 rounded-md border border-hairline bg-transparent px-1 font-mono text-[11px] outline-none focus:border-ring"
          >
            {!repositories.selected && <option value="">Choose a repository…</option>}
            {repositories.list.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </div>
      )}
      {!isGit && gitNote && (
        <p className="shrink-0 border-b border-hairline px-3 py-1.5 text-[11px] text-muted-foreground" role="note" data-testid="panel-no-repository">
          {gitNote}
        </p>
      )}
      {readOnlyReason && (
        <p className="shrink-0 border-b border-hairline px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="panel-read-only">
          {readOnlyReason}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {isGit && (
          <>
            <div className={cn("h-full", tab !== "branch" && "hidden")}>
              <BranchTab
                key={`${sessionId ?? ""}:${refreshTick}`}
                focusPr={focusPr}
                branch={branchPicture ? { cwd, active: tab === "branch", version, sessionId, from } : null}
                pr={{
                  sessionId,
                  onFixErrors,
                  fixBusy,
                  cwd,
                  source: gitSource,
                  branch: resolvedBranch,
                  active: tab === "branch",
                  busy: live,
                  machineWorkspace,
                  onSettle:
                    settleSessionId && workspace
                      ? () => openWorkspaceRemove({ projectPath: workspace.projectPath, path: cwd, name: workspace.name, mode: "settle", sessionId: settleSessionId })
                      : undefined,
                  workspace: workspace
                    ? {
                        projectPath: workspace.projectPath,
                        onDelete: () => openWorkspaceDelete(workspace.projectPath, cwd, workspace.name),
                      }
                    : undefined,
                }}
              />
            </div>
            <div className={cn("h-full", tab !== "changes" && "hidden")}>
              <ChangesPanel
                reviewTabId={readOnlyReason ? null : mentionTabId}
                sessionId={sessionId}
                key={refreshTick}
                cwd={cwd}
                source={gitSource}
                openFileAction={fileSource && fileBase !== null && repository !== undefined ? (path) => {
                  const relative = pathInFileRoot(fileBase, repository ? `${repository}/${path}` : path);
                  return relative ? () => openFile(sessionId ?? `checkout:${cwd}`, cwd, relative, undefined, cwd, fileSource.key) : undefined;
                } : undefined}
                events={events}
                version={version}
                baseRef={baseRef}
                active={tab === "changes"}
                live={live}
                workingTree={workingTree}
              />
            </div>
          </>
        )}
        {/* Only while shown: it reads the organization's templates on a timer. */}
        {artifactsOrg && tab === "artifacts" && <ArtifactsTab orgId={artifactsOrg} tabId={mentionTabId ?? null} />}
        {/* Only while shown: it reads the workspace's ports on a timer. */}
        {ports && tab === "ports" && (
          <div className="flex h-full flex-col" data-testid="panel-ports">
            {ports()}
          </div>
        )}
        {/* Only while shown: it holds a live connection to the desktop. */}
        {computer && tab === "computer" && <ComputerPanel active context={sessionId && computerTab ? { sessionId, ...computerTab } : undefined} />}
        {/* Only while shown: it streams the page. */}
        {browser && sessionId && tab === "browser" && <BrowserPanel sessionId={sessionId} cwd={cwd} active />}
        <div className={cn("h-full", tab !== "files" && "hidden")}>
          <FileTree
            key={refreshTick}
            sessionId={sessionId ?? `checkout:${cwd}`}
            root={cwd}
            isGit={isGit}
            rootName={rootName}
            active={tab === "files"}
            mentionTabId={mentionTabId}
            statusKey={statusKey}
            source={fileSource}
          />
        </div>
      </div>
      {terminals && sessionId && <TerminalDock sessionId={sessionId} cwd={cwd} />}
      {dock}
    </aside>
  );
}
