import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { ChangesPanel } from "@/components/changes/ChangesPanel";
import { RepoPanel } from "@/components/changes/RepoPanel";
import { PrPanel } from "@/components/changes/PrPanel";
import { FileTree } from "@/components/files/FileTree";
import { openSettle } from "@/lib/dialogs";
import { api } from "@/lib/api";
import type { AgentEvent } from "@/types/events";
import type { WorkStatus } from "@/types/session";

export type PanelTab = "changes" | "repo" | "pr" | "files";
const TABS: { id: PanelTab; label: string; chord: string }[] = [
  { id: "changes", label: "Changes", chord: "mod+alt+1" },
  { id: "repo", label: "Repo", chord: "mod+alt+2" },
  { id: "pr", label: "PR", chord: "mod+alt+3" },
  { id: "files", label: "Files", chord: "mod+alt+4" },
];

/**
 * One frame with tabs, not one panel per view. Bodies hide rather than
 * unmount so scroll position and picked files survive the flip, and the
 * `active` prop keeps a hidden body from refetching.
 */
export function RightPanel({
  cwd,
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
}: {
  cwd: string;
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
}) {
  const prefs = usePrefs();
  const [tab, setTab] = useState<PanelTab>("changes");
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const dragging = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (branch !== undefined && !labelMode) return;
    let cancelled = false;
    api
      .workStatus(cwd)
      .then((next) => !cancelled && setStatus(next))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [cwd, branch, labelMode, refreshTick]);

  const resolvedBranch = branch === undefined ? (status?.branch ?? null) : branch;
  const targetLabel = labelMode === "base" ? `base: ${status?.defaultBranch ?? "default"}` : labelMode === "branch" ? (resolvedBranch ?? "current branch") : null;

  useHotkey(TABS[0].chord, () => setTab("changes"));
  useHotkey(TABS[1].chord, () => setTab("repo"));
  useHotkey(TABS[2].chord, () => setTab("pr"));
  useHotkey(TABS[3].chord, () => setTab("files"));

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
        {TABS.map((t) => (
          <WithTooltip key={t.id} label={t.label} keys={keycaps(t.chord)}>
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
      <div className="min-h-0 flex-1">
        <div className={cn("h-full", tab !== "changes" && "hidden")}>
          <ChangesPanel
            key={refreshTick}
            cwd={cwd}
            events={events}
            version={version}
            baseRef={baseRef}
            active={tab === "changes"}
            live={live}
            workingTree={workingTree}
          />
        </div>
        <div className={cn("h-full", tab !== "repo" && "hidden")}>
          <RepoPanel key={refreshTick} cwd={cwd} active={tab === "repo"} />
        </div>
        <div className={cn("h-full", tab !== "pr" && "hidden")}>
          <PrPanel
            key={refreshTick}
            cwd={cwd}
            branch={resolvedBranch}
            active={tab === "pr"}
            busy={live}
            onSettle={settleSessionId ? () => openSettle(settleSessionId) : undefined}
          />
        </div>
        <div className={cn("h-full", tab !== "files" && "hidden")}>
          <FileTree
            key={refreshTick}
            sessionId={sessionId ?? `checkout:${cwd}`}
            root={cwd}
            rootName={rootName}
            active={tab === "files"}
            mentionTabId={mentionTabId}
            statusKey={statusKey}
          />
        </div>
      </div>
    </aside>
  );
}
