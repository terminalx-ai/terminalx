import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useShortcut } from "@/lib/hotkeys";
import type { ShortcutId } from "@/lib/shortcuts";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { ChangesPanel } from "@/components/changes/ChangesPanel";
import { RepoPanel, type RepoView } from "@/components/changes/RepoPanel";
import { PrPanel } from "@/components/changes/PrPanel";
import { FileTree } from "@/components/files/FileTree";
import { openWorkspaceDelete, openWorkspaceRemove } from "@/lib/dialogs";
import { api } from "@/lib/api";
import type { GitSource } from "@/lib/gitSource";
import type { FileSource } from "@/lib/workspaceFiles";
import type { AgentEvent } from "@/types/events";
import type { WorkStatus } from "@/types/session";

export type PanelTab = "changes" | "repo" | "pr" | "files";
const TABS: { id: PanelTab; label: string; shortcut: ShortcutId }[] = [
  { id: "changes", label: "Changes", shortcut: "panel.changes" },
  { id: "repo", label: "Repo", shortcut: "panel.repository" },
  { id: "pr", label: "PR", shortcut: "panel.pullRequests" },
  { id: "files", label: "Files", shortcut: "panel.files" },
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
  events = [],
  version = 0,
  live = false,
  workingTree = false,
  sessionId,
  mentionTabId,
  statusKey = "",
  rootName,
  labelMode,
  settleSessionId,
  workspace,
  gitSource,
  fileSource,
  repositories,
  readOnlyReason,
}: {
  cwd: string;
  isGit?: boolean;
  /** Why there is no Changes, Repo or PR, shown above Files when `isGit` is false and the reason is worth saying. */
  gitNote?: string;
  /** Undefined asks the panel to resolve the checkout branch itself. */
  branch?: string | null;
  baseRef?: string | null;
  events?: AgentEvent[];
  version?: number;
  live?: boolean;
  workingTree?: boolean;
  sessionId?: string;
  mentionTabId?: string | null;
  statusKey?: string;
  rootName?: string;
  labelMode?: "base" | "branch";
  settleSessionId?: string;
  /** Present only for a managed, non-main workspace. */
  workspace?: { projectPath: string; name: string };
  /** Where Changes, Repo and PR read Git; the local checkout at `cwd` when absent. */
  gitSource?: GitSource;
  /** Where Files reads; the local checkout at `cwd` when absent. */
  fileSource?: FileSource;
  /** A cloud workspace with several repositories: which one Changes, Repo and PR show. */
  repositories?: { list: string[]; selected: string | null; onSelect: (repo: string | null) => void };
  /** Shown above the panels when this attachment may read but not change the workspace. */
  readOnlyReason?: string | null;
}) {
  const prefs = usePrefs();
  const [selectedTab, setTab] = useState<PanelTab>("changes");
  const [repoView, setRepoView] = useState<RepoView>("uncommitted");
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const tab = isGit ? selectedTab : "files";
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
  const targetLabel = !isGit ? "Folder" : labelMode === "base" ? `base: ${status?.defaultBranch ?? "default"}` : labelMode === "branch" ? (resolvedBranch ?? "current branch") : null;

  useShortcut(TABS[0].shortcut, () => setTab("changes"));
  useShortcut(TABS[1].shortcut, () => setTab("repo"));
  useShortcut(TABS[2].shortcut, () => setTab("pr"));
  useShortcut(TABS[3].shortcut, () => setTab("files"));

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
      <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-0.5 px-2">
        {TABS.filter((t) => isGit || t.id === "files").map((t) => (
          <WithTooltip key={t.id} label={t.label} shortcut={t.shortcut}>
            <button
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                tab === t.id ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:text-foreground",
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
            <div className={cn("h-full", tab !== "changes" && "hidden")}>
              <ChangesPanel
                key={refreshTick}
                cwd={cwd}
                source={gitSource}
                events={events}
                version={version}
                baseRef={baseRef}
                active={tab === "changes"}
                live={live}
                workingTree={workingTree}
                onViewUncommitted={() => {
                  setRepoView("uncommitted");
                  setTab("repo");
                }}
              />
            </div>
            <div className={cn("h-full", tab !== "repo" && "hidden")}>
              <RepoPanel key={refreshTick} cwd={cwd} source={gitSource} active={tab === "repo"} view={repoView} onViewChange={setRepoView} />
            </div>
            <div className={cn("h-full", tab !== "pr" && "hidden")}>
              <PrPanel
                key={refreshTick}
                cwd={cwd}
                source={gitSource}
                branch={resolvedBranch}
                active={tab === "pr"}
                busy={live}
                onSettle={
                  settleSessionId && workspace
                    ? () => openWorkspaceRemove({ projectPath: workspace.projectPath, path: cwd, name: workspace.name, mode: "settle", sessionId: settleSessionId })
                    : undefined
                }
                workspace={
                  workspace
                    ? {
                        projectPath: workspace.projectPath,
                        onDelete: () => openWorkspaceDelete(workspace.projectPath, cwd, workspace.name),
                      }
                    : undefined
                }
              />
            </div>
          </>
        )}
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
    </aside>
  );
}
