import { memo, useCallback, useEffect, useRef, useState } from "react";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { ProjectRail } from "./ProjectRail";
import { StarReminder } from "@/components/ui/StarReminder";

/** How narrow and how wide the sidebar can be dragged. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 560;
export const SIDEBAR_DEFAULT = 268;
export const MIN_MAIN_WIDTH = 320;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 40;

function readRightPanelWidth(): number {
  if (typeof document === "undefined") return 0;
  const panel = document.querySelector<HTMLElement>("[data-right-panel]");
  if (!panel) return 0;
  const rectWidth = panel.getBoundingClientRect().width;
  if (rectWidth > 0) return Math.round(rectWidth);
  const cssWidth = Number.parseInt(document.documentElement.style.getPropertyValue("--panel-w"), 10);
  return Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 240;
}

export function sidebarBounds(viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth, rightPanelWidth = readRightPanelWidth()) {
  if (viewportWidth <= 0) return { min: SIDEBAR_MIN, max: SIDEBAR_MAX };
  const reservedRight = rightPanelWidth > 0 ? Math.min(rightPanelWidth, Math.max(240, viewportWidth - MIN_MAIN_WIDTH - SIDEBAR_MIN)) : 0;
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(viewportWidth - MIN_MAIN_WIDTH - reservedRight)));
  return { min: SIDEBAR_MIN, max };
}

export function clampSidebarWidth(w: number, viewportWidth?: number, rightPanelWidth?: number) {
  const { min, max } = sidebarBounds(viewportWidth, rightPanelWidth);
  return Math.max(min, Math.min(max, Math.round(w)));
}

/**
 * One navigation surface. Its right edge drags to a width that is kept
 * between launches; the width is applied as a CSS variable so the main slot
 * follows it without a re-render per pixel.
 */
export const Sidebar = memo(function Sidebar({
  onToggle,
  onOpenSettings,
  onOpenAccount,
  onOpenHome,
  onNewSession,
  onOpenIssues,
  onOpenAgents,
  onOpenAutomations,
  onOpenSkills,
  onSearch,
}: {
  onToggle: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onNewSession: () => void;
  onOpenIssues: () => void;
  onOpenAgents: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void;
  onSearch: () => void;
}) {
  const { sidebarWidth } = usePrefs();
  const dragging = useRef<{ x: number; w: number } | null>(null);
  const [viewportTick, setViewportTick] = useState(0);

  const bounds = sidebarBounds();
  const clampedWidth = clampSidebarWidth(sidebarWidth);

  useEffect(() => {
    const sync = () => {
      document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(sidebarWidth)}px`);
      setViewportTick((n) => n + 1);
    };
    document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(sidebarWidth)}px`);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [sidebarWidth]);

  // Reference viewportTick so React re-evaluates bounds on window resize.
  void viewportTick;

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = { x: e.clientX, w: clampSidebarWidth(sidebarWidth) };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [sidebarWidth],
  );
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(d.w + (e.clientX - d.x))}px`);
  }, []);
  const onUp = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    setPrefs({ sidebarWidth: clampSidebarWidth(d.w + (e.clientX - d.x)) });
  }, []);
  const onCancel = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = null;
    document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(sidebarWidth)}px`);
  }, [sidebarWidth]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const { min, max } = sidebarBounds();
    const current = clampSidebarWidth(sidebarWidth);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = clampSidebarWidth(current + step);
    else if (e.key === "ArrowLeft") next = clampSidebarWidth(current - step);
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "Enter") next = clampSidebarWidth(SIDEBAR_DEFAULT);
    if (next === null) return;
    e.preventDefault();
    document.documentElement.style.setProperty("--sidebar-w", `${next}px`);
    setPrefs({ sidebarWidth: next });
  }, [sidebarWidth]);

  return (
    <aside data-sidebar="" className="relative flex h-full min-h-0 w-(--sidebar-w) shrink-0 flex-col overflow-clip">
      <div className="min-h-0 flex-1">
        <ProjectRail
          onHide={onToggle}
          onOpenSettings={onOpenSettings}
          onOpenAccount={onOpenAccount}
          onOpenHome={onOpenHome}
          onNewSession={onNewSession}
          onOpenIssues={onOpenIssues}
          onOpenAgents={onOpenAgents}
          onOpenAutomations={onOpenAutomations}
          onOpenSkills={onOpenSkills}
          onSearch={onSearch}
        />
      </div>
      {/* Sidebar space never reduces the height available for input or approvals. */}
      <StarReminder />
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={clampedWidth}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setPrefs({ sidebarWidth: clampSidebarWidth(SIDEBAR_DEFAULT) })}
        className="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/50 focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="sidebar-resize"
      />
    </aside>
  );
});
