import { useCallback, useEffect, useRef } from "react";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { ProjectRail } from "./ProjectRail";

/** How narrow and how wide the sidebar can be dragged. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 560;

const clamp = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));

/**
 * One navigation surface. Its right edge drags to a width that is kept
 * between launches; the width is applied as a CSS variable so the main slot
 * follows it without a re-render per pixel.
 */
export function Sidebar({
  onToggle,
  onOpenSettings,
  onOpenAccount,
  onOpenIssues,
  onOpenAgents,
  onOpenStats,
  onOpenAutomations,
  onOpenSkills,
  onSearch,
}: {
  onToggle: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  onOpenIssues: () => void;
  onOpenAgents: () => void;
  onOpenStats: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void;
  onSearch: () => void;
}) {
  const { sidebarWidth } = usePrefs();
  const dragging = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${clamp(sidebarWidth)}px`);
  }, [sidebarWidth]);

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = { x: e.clientX, w: clamp(sidebarWidth) };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [sidebarWidth],
  );
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    document.documentElement.style.setProperty("--sidebar-w", `${clamp(d.w + (e.clientX - d.x))}px`);
  }, []);
  const onUp = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    setPrefs({ sidebarWidth: clamp(d.w + (e.clientX - d.x)) });
  }, []);

  return (
    <aside className="relative flex h-full min-h-0 w-(--sidebar-w) shrink-0 overflow-clip">
      <ProjectRail
        onHide={onToggle}
        onOpenSettings={onOpenSettings}
        onOpenAccount={onOpenAccount}
        onOpenIssues={onOpenIssues}
        onOpenAgents={onOpenAgents}
        onOpenStats={onOpenStats}
        onOpenAutomations={onOpenAutomations}
        onOpenSkills={onOpenSkills}
        onSearch={onSearch}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={clamp(sidebarWidth)}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => setPrefs({ sidebarWidth: 268 })}
        className="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-ring/30"
        data-testid="sidebar-resize"
      />
    </aside>
  );
}
