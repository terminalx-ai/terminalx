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
import type { GitSource } from "@/lib/gitSource";
import type { FileSource } from "@/lib/workspaceFiles";
import type { AgentEvent } from "@/types/events";
import type { WorkStatus } from "@/types/session";
import { onPanelTab, rememberPanelTab, rememberedPanelTab, takePanelTab, type PanelTab } from "@/lib/panelTab";

export type { PanelTab };
const TABS: { id: PanelTab; label: string; shortcut?: ShortcutId }[] = [
  // Branch holds Overview (the pull request, the next step) and Changes (committing and history) as its two views.
  { id: "branch", label: "Branch", shortcut: "panel.repository" },
  { id: "files", label: "Files", shortcut: "panel.files" },
  { id: "browser", label: "Browser" },
  { id: "ports", label: "Ports" },
  { id: "computer", label: "Computer" },
];

/** Branch's two views: where it stands, and what is in it. */
const BRANCH_VIEWS: { id: "branch" | "changes"; label: string; shortcut: ShortcutId }[] = [
  { id: "branch", label: "Overview", shortcut: "panel.repository" },
  { id: "changes", label: "Changes", shortcut: "panel.changes" },
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
  onFixErrors,
  fixBusy,
  statusKey = "",
  rootName,
  labelMode,
  settleSessionId,
  workspace,
  gitSource,
  fileSource,
  repositories,
  readOnlyReason,
  ports,
  terminals = false,
  computer = false,
  browser = false,
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
  onFixErrors?: (pr: PullRequest) => Promise<unknown>;
  fixBusy?: boolean;
  statusKey?: string;
  rootName?: string;
  labelMode?: "base" | "branch";
  settleSessionId?: string;
  /** Present only for a managed, non-main workspace. */
  workspace?: { projectPath: string; name: string };
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
  /** A local session's panel: shells in its folder, docked below the tabs. */
  terminals?: boolean;
  /** A local session's panel: the Computer tab, a desktop to watch and that agents can use. */
  computer?: boolean;
  /** A local session's panel: the Browser tab, the workspace's pages beside the chat, shared with the agent. */
  browser?: boolean;
}) {
  const prefs = usePrefs();
  // A cloud session's panel (the one with Ports) reopens on the tab it last showed.
  const remembers = !!ports && !!sessionId;
  // Null until a tab is picked: the first one depends on the Git source, which a cloud session learns after drawing.
  const [picked, setTab] = useState<PanelTab | null>(() => takePanelTab() ?? (remembers ? rememberedPanelTab(sessionId!) : null));
  useEffect(() => {
    if (remembers && picked) rememberPanelTab(sessionId!, picked);
  }, [remembers, sessionId, picked]);
  // A menu elsewhere asked for a tab (the session's "Ports and previews").
  useEffect(
    () =>
      onPanelTab((asked) => {
        takePanelTab();
        setTab(asked);
      }),
    [],
  );
  const [focusPr, setFocusPr] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const fallback: PanelTab = isGit ? "changes" : "files";
  // The branch picture reads this computer's checkout; a cloud workspace's Branch tab is its pull request alone, and its panel opens on Changes.
  const branchPicture = !gitSource?.cloud;
  const selectedTab: PanelTab = picked ?? (branchPicture ? "branch" : "changes");
  const tab: PanelTab =
    selectedTab === "ports"
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
  // Branch's two views keep their own tab ids, so every link and shortcut to "changes" lands on that view.
  const onBranch = tab === "branch" || tab === "changes";
  // The view Branch reopens on: the one last shown.
  const [branchView, setBranchView] = useState<"branch" | "changes">(tab === "changes" ? "changes" : "branch");
  useEffect(() => {
    if (onBranch) setBranchView(tab);
  }, [onBranch, tab]);
  const dragging = useRef<{ x: number; w: number } | null>(null);

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
        {TABS.filter((t) => (t.id === "ports" ? !!ports : t.id === "computer" ? computer : t.id === "browser" ? browser && !!sessionId : isGit || t.id === "files")).map((t) => (
          <WithTooltip key={t.id} label={t.label} shortcut={t.shortcut}>
            <button
              type="button"
              onClick={() => setTab(t.id === "branch" ? branchView : t.id)}
              className={cn(
                // Tabs, like the chat's: the open one is underlined on the hairline below.
                "relative flex h-full items-center px-2 text-xs font-medium transition-colors",
                (t.id === "branch" ? onBranch : tab === t.id)
                  ? "text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
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
      </div>
      {isGit && onBranch && (
        // Branch's two views, drawn like the Browser's and Computer's second row and level with the chat's tabs: those
        // are 36px tall with a 1px rule under them, so this row is 37px with its rule inside.
        <div role="tablist" aria-label="Branch" className="flex h-[37px] shrink-0 items-stretch gap-1 border-b border-hairline px-2 text-xs" data-testid="branch-views">
          {BRANCH_VIEWS.map((view) => (
            <WithTooltip key={view.id} label={view.label} shortcut={view.shortcut}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === view.id}
                onClick={() => setTab(view.id)}
                className={cn(
                  "relative flex items-center px-2 transition-colors",
                  tab === view.id
                    ? "text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {view.label}
              </button>
            </WithTooltip>
          ))}
        </div>
      )}
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
        {/* Only while shown: it reads the workspace's ports on a timer. */}
        {ports && tab === "ports" && (
          <div className="flex h-full flex-col" data-testid="panel-ports">
            {ports()}
          </div>
        )}
        {/* Only while shown: it holds a live connection to the desktop. */}
        {computer && tab === "computer" && <ComputerPanel active />}
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
    </aside>
  );
}
