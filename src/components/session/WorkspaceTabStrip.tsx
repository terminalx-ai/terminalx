import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, Globe, Lock, Terminal, TerminalSquare, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { StatusStripe } from "@/components/layout/SidebarRows";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger, WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { getTabLog } from "@/lib/agentEvents";
import { cn } from "@/lib/cn";
import { registerHotkey } from "@/lib/hotkeys";
import { useMobileDrivenTabs } from "@/lib/mobileDriver";
import { recoveryFromEvents } from "@/lib/recovery";
import { useSessionStore } from "@/lib/sessions";
import { closePeer, isShellPeer, openPeer, peerAgent, peerKind, peerLabel, peerShell, peerStateWords, peerStatus, tabNodeId, tabPanelId, useTabRow, type PeerTab, type TabRow } from "@/lib/sessionTabs";
import { tabViewIn } from "@/lib/tabFront";
import { landingIndex, moveTab } from "@/lib/tabActions";
import { useTabViews } from "@/lib/tabViews";
import type { SelectedSessionTab } from "@/lib/terminal";
import { TAB_STATUS_LABEL, type SessionEntry, type TabStatus } from "@/types/session";
import { TabMenuItems } from "./TabMenu";

/** The id of a tab in the strip: what its panel is labelled by while the strip is shown. */
export function stripTabId(tab: SelectedSessionTab): string {
  return `strip-${tabNodeId(tab)}`;
}

/** How far the pointer travels with the button down before a press on a tab is a drag, not a click. */
const DRAG_THRESHOLD = 5;

/** The narrowest a tab gets before the row scrolls: its icon and a few characters. */
const TAB_MIN_REM = 4.75;
/** A width a tab's title still reads at. In the title bar the tabs narrow to this before the chips beside them give way. */
const TAB_EASY_REM = 7.5;
/** A tab's width when there is room for it. */
const TAB_MAX_REM = 11;
const PINNED_REM = 2;

const STATUS_DOT: Partial<Record<TabStatus, string>> = {
  waiting: "bg-warning",
  completed: "bg-add",
  in_progress: "bg-info animate-pulse-soft",
};

/** What a tab is now, at a glance: the mark of the agent in it, a terminal, a page. */
export function TabIcon({ tab, className = "size-3.5 shrink-0" }: { tab: PeerTab; className?: string }) {
  const agent = peerAgent(tab);
  if (agent) return <AgentMark id={agent} className={className} decorative />;
  return tab.kind === "browser" ? <Globe className={className} /> : <TerminalSquare className={className} />;
}

/**
 * Where a dragged tab lands for a pointer at `x`: the index it ends up at
 * once it is taken out of place `from` and put back, among tabs whose boxes
 * are `rects` (in row order).
 */
export function dropIndex(rects: readonly { left: number; width: number }[], from: number, x: number): number {
  let slot = rects.findIndex((rect) => x < rect.left + rect.width / 2);
  if (slot < 0) slot = rects.length;
  return Math.max(0, Math.min(slot > from ? slot - 1 : slot, rects.length - 1));
}

interface Drag {
  key: string;
  /** Where the tab will land, and where the line that says so is drawn (in the row's own coordinates). */
  to: number;
  x: number | null;
}

/**
 * The workspace's tabs as a browser-style row: one tab per agent, terminal
 * and browser page of the open workspace, whichever of its sessions each
 * belongs to. In the main window it sits in the title bar; a window with no
 * room there draws it as a row of its own.
 *
 * It is one view of the list the sidebar draws (`@/lib/sessionTabs`): the
 * same tabs in the same order with the same selection. Tabs share the width
 * and shrink evenly to a minimum, then the row scrolls and a menu at its end
 * lists every tab by its full title. A tab can be dragged to a new place.
 *
 * The row is a tab list for the keyboard: the arrows, Home and End move
 * between tabs, Return or Space opens the one with the focus.
 */
export function WorkspaceTabStrip({
  session,
  selected,
  readOnlyReason,
  placement,
  hideSingle = false,
  className,
}: {
  session: SessionEntry;
  /**
   * `titlebar`: between the session's name and its actions, taking what room
   * there is (see `STRIP_NARROW` in SessionView for what gives way to what).
   * `row`: a row of its own, the window's whole width.
   */
  placement: "titlebar" | "row";
  /** The tab on screen in `session`. */
  selected: SelectedSessionTab | null;
  /** Why this person may not change the tabs (a viewer of a shared session); the tabs still show. */
  readOnlyReason?: string | null;
  /** Draw nothing for a single tab: there is nothing to switch between. */
  hideSingle?: boolean;
  className?: string;
}) {
  const row = useTabRow(session);
  const store = useSessionStore();
  const tabViews = useTabViews();
  const mobileDriven = useMobileDrivenTabs();
  const scroller = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  /** Which ends of the row have tabs scrolled out of view: those ends fade, so a cut-off tab reads as "more this way". */
  const [more, setMore] = useState({ before: false, after: false });
  const [drag, setDrag] = useState<Drag | null>(null);
  /** A drag ends in a click on the tab under the pointer; that one is not a request to open it. */
  const dragged = useRef(false);
  /** Puts a tab in the hand back; set while one is held. */
  const dropHeld = useRef<(() => void) | null>(null);
  const latest = useRef(row);
  latest.current = row;
  // A row that goes away mid-drag (its session was switched) lets go of the window's pointer and of Escape.
  useEffect(() => () => dropHeld.current?.(), []);

  const harnessName = (id: string) => store.harnesses.find((harness) => harness.id === id)?.name;
  const { tabs } = row;
  const active = tabs.find((tab) => tab.kind === selected?.kind && tab.id === selected.id) ?? null;
  const activeKey = active?.key ?? null;
  const keys = tabs.map((tab) => tab.key).join("\n");

  // The row scrolls once its tabs are at their narrowest and still do not fit.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // A header with no room for the row at all draws none (see `STRIP_MENU` in SessionView): then the menu is the row.
    const measure = () => {
      setOverflowing(getComputedStyle(element).display === "none" || element.scrollWidth > element.clientWidth + 1);
      const before = element.scrollLeft > 1;
      const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setMore((was) => (was.before === before && was.after === after ? was : { before, after }));
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [keys]);

  // The tab on screen is always in view, wherever the row was scrolled to.
  useLayoutEffect(() => {
    if (!activeKey) return;
    const element = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-tab-key]") ?? [])].find((node) => node.dataset.tabKey === activeKey);
    element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey, keys, overflowing]);

  if (hideSingle && tabs.length < 2) return null;

  const tabElements = () => [...(scroller.current?.querySelectorAll<HTMLElement>("[data-tab-key]") ?? [])];

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, tab: PeerTab) => {
    if (event.button !== 0 || readOnlyReason || (event.target as Element).closest("[data-tab-close]")) return;
    const startX = event.clientX;
    let moving = false;
    let to = -1;
    const place = (x: number) => {
      const now = latest.current;
      const current = now.tabs.find((candidate) => candidate.key === tab.key);
      const elements = tabElements();
      const from = elements.findIndex((element) => element.dataset.tabKey === tab.key);
      if (!current || from < 0) return;
      const rects = elements.map((element) => element.getBoundingClientRect());
      to = landingIndex(now, current, dropIndex(rects, from, x));
      const box = scroller.current!.getBoundingClientRect();
      // The line stands where the tab will go: at the far edge of the tab it passes.
      const edge = to === from ? null : to > from ? rects[to].right : rects[to].left;
      setDrag({ key: tab.key, to, x: edge == null ? null : edge - box.left + scroller.current!.scrollLeft });
    };
    let unbindEscape: (() => void) | null = null;
    const onMove = (move: PointerEvent) => {
      if (!moving && Math.abs(move.clientX - startX) < DRAG_THRESHOLD) return;
      if (!moving) {
        moving = true;
        // Escape puts the tab back; it is not a key for anything else while a tab is in the hand.
        unbindEscape = registerHotkey("escape", () => end(false, true), { global: true, priority: 1000 });
      }
      place(move.clientX);
    };
    /** `held`: the button is still down (Escape), so the click that ends the press is still to come. */
    const end = (commit: boolean, held = false) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      unbindEscape?.();
      dropHeld.current = null;
      setDrag(null);
      if (!moving) return;
      // The click that ends this press belongs to the drag, not to the tab under the pointer.
      const release = () => window.setTimeout(() => (dragged.current = false), 0);
      if (commit || held) dragged.current = true;
      if (commit) release();
      else if (held) window.addEventListener("pointerup", release, { once: true });
      const now = latest.current;
      const current = now.tabs.find((candidate) => candidate.key === tab.key);
      if (commit && current && to >= 0) moveTab(now, current, to);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    dropHeld.current = onCancel;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // A press that ends outside the window never reports its release.
    window.addEventListener("blur", onCancel);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(scroller.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = buttons.indexOf(event.target as HTMLElement);
    if (at < 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const to = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (to == null) return;
    event.preventDefault();
    buttons[(to + buttons.length) % buttons.length]?.focus();
  };

  const several = row.sessions.length > 1;
  const describe = (tab: PeerTab) => {
    const label = peerLabel(tab, row.layout, harnessName);
    // "Needs attention" is a turn that stopped on a problem; "waiting for an answer" is one that asked.
    const attention = tab.kind === "agent" && peerStatus(tab) === "waiting" && recoveryFromEvents(getTabLog(tab.sessionId, tab.id).events) != null;
    const state = peerStateWords(tab, attention);
    return { label, state, kind: peerKind(tab, harnessName), owner: several && tab.sessionId ? row.sessions.find((candidate) => candidate.id === tab.sessionId)?.title : undefined };
  };
  const fade = more.before || more.after ? `linear-gradient(to right, ${more.before ? "transparent, black 1.25rem" : "black"}, ${more.after ? "black calc(100% - 1.25rem), transparent" : "black"})` : null;
  const pinned = tabs.filter((tab) => tab.pinned).length;
  const free = tabs.length - pinned;
  // Gaps between tabs and the row's own padding, in rem.
  const chrome = (tabs.length + 1) * 0.125;
  // In the title bar the row starts from its tabs at a width their titles still read at and grows into the
  // room there is, up to their full width. So its neighbours give way before the tabs narrow further, and
  // only then does it scroll. It never gives up its last `--tab-floor` tabs.
  const sizing: CSSProperties =
    placement === "titlebar"
      ? {
          flex: `1 1 ${free * TAB_EASY_REM + pinned * PINNED_REM + chrome}rem`,
          maxWidth: `${free * TAB_MAX_REM + pinned * PINNED_REM + chrome}rem`,
          minWidth: `calc(min(${free}, var(--tab-floor, 3)) * ${TAB_MIN_REM}rem + ${pinned * PINNED_REM}rem)`,
        }
      : {};

  return (
    <div className={cn("flex min-w-0 items-center gap-0.5", placement === "row" && "w-full shrink-0", className)} style={sizing} data-testid="workspace-tab-strip">
      <div
        ref={scroller}
        role="tablist"
        aria-label="Workspace tabs"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onWheel={(event) => {
          // A wheel turned over the row scrolls it sideways.
          if (!event.deltaX && scroller.current) scroller.current.scrollLeft += event.deltaY;
        }}
        className="scrollbar-none relative flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-0.5 py-1"
        style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
        {tabs.map((tab, index) => {
          const { label, state, kind, owner } = describe(tab);
          const isActive = tab.key === activeKey;
          const status = peerStatus(tab);
          const exited = !!peerShell(tab)?.exited;
          return (
            <ContextMenu key={tab.key}>
              <ContextMenuTrigger asChild>
                <div
                  data-tab-key={tab.key}
                  data-tauri-drag-region="false"
                  data-pinned={tab.pinned || undefined}
                  data-dragging={drag?.key === tab.key || undefined}
                  onPointerDown={(event) => beginDrag(event, tab)}
                  onAuxClick={(event) => {
                    if (event.button !== 1 || readOnlyReason) return;
                    event.preventDefault();
                    void closePeer(session.id, tab, tabs, selected);
                  }}
                  className={cn(
                    "group/tab relative flex h-7 select-none items-center rounded-md",
                    tab.pinned ? "w-8 flex-none justify-center" : "shrink",
                    isActive ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
                    drag?.key === tab.key && "opacity-60",
                  )}
                  // The open tab's close button is always there, so it keeps that much more for its title.
                  style={tab.pinned ? undefined : { width: `${TAB_MAX_REM}rem`, minWidth: `${TAB_MIN_REM + (isActive ? 1 : 0)}rem` }}
                >
                  <Tooltip delayDuration={400}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="tab"
                        id={stripTabId(tab)}
                        aria-selected={isActive}
                        aria-controls={tabPanelId(tab)}
                        aria-label={label}
                        aria-description={[kind, state, tab.pinned ? "pinned" : null].filter(Boolean).join(", ")}
                        tabIndex={isActive || (!active && index === 0) ? 0 : -1}
                        onClick={() => {
                          if (dragged.current) return;
                          openPeer(session.id, tab);
                        }}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                          tab.pinned ? "justify-center px-0" : "px-2",
                        )}
                      >
                        {status ? <StatusStripe status={status} size="tab" /> : null}
                        <TabIcon tab={tab} />
                        {tab.pinned ? null : <span className={cn("min-w-0 flex-1 truncate text-left", exited && "text-faint line-through")}>{label}</span>}
                        {!tab.pinned && tab.kind === "agent" && mobileDriven.has(tab.id) ? <Lock className="size-3 shrink-0 text-warning" aria-label="Mobile is driving this terminal" /> : null}
                        {!tab.pinned && tab.kind === "agent" && !isShellPeer(tab) && tabViewIn(tabViews.views, tab.tab) === "terminal" ? <Terminal className="size-3 shrink-0 text-faint" aria-label="In terminal view" /> : null}
                        {!tab.pinned && tab.kind === "browser" && tab.page.active ? <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label="Active page for agents" /> : null}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-80 flex-col items-start gap-0.5">
                      <span className="break-words font-medium" data-testid="tab-tooltip-title">{label}</span>
                      <span className="text-muted-foreground">{state ? `${kind} · ${state}` : kind}</span>
                      {tab.kind === "browser" && tab.page.url ? <span className="max-w-full truncate text-faint">{tab.page.url}</span> : null}
                      {owner ? <span className="text-faint">Session: {owner}</span> : null}
                    </TooltipContent>
                  </Tooltip>
                  {!tab.pinned && !readOnlyReason ? (
                    <button
                      type="button"
                      data-tab-close
                      aria-label={`Close ${label}`}
                      onClick={() => void closePeer(session.id, tab, tabs, selected)}
                      // The open tab always has it. Another tab takes no room for it until it is pointed at or has the
                      // focus, so a narrow tab shows its title instead.
                      className={cn(
                        "mr-1 size-4 shrink-0 items-center justify-center rounded-sm opacity-70 outline-none hover:bg-veil-strong hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40",
                        isActive ? "flex" : "hidden group-focus-within/tab:flex group-hover/tab:flex",
                      )}
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="max-h-(--radix-context-menu-content-available-height) overflow-y-auto">
                <TabMenuItems row={row} tab={tab} selected={selected} readOnlyReason={readOnlyReason} />
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {drag?.x != null ? <span aria-hidden data-testid="tab-drop-indicator" className="pointer-events-none absolute bottom-1.5 top-1.5 w-0.5 -translate-x-1/2 rounded-full bg-ring" style={{ left: drag.x }} /> : null}
      </div>
      {overflowing ? <AllTabsMenu row={row} active={activeKey} describe={describe} /> : null}
    </div>
  );
}

/** Every tab of the workspace by its full title, for a row too crowded to read. */
function AllTabsMenu({ row, active, describe }: { row: TabRow; active: string | null; describe: (tab: PeerTab) => { label: string; state: string | null; kind: string; owner?: string } }) {
  const menu = useRowMenu();
  return (
    <DropdownMenu {...menu.root}>
      <WithTooltip label="All tabs">
        <DropdownMenuTrigger asChild {...menu.trigger}>
          <Button variant="ghost" size="sm" className="shrink-0 gap-0.5 px-1.5 tabular-nums" aria-label={`All tabs (${row.tabs.length})`} data-testid="all-tabs">
            {row.tabs.length}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
        <DropdownMenuLabel>Tabs in this workspace</DropdownMenuLabel>
        {row.tabs.map((tab) => {
          const { label, state, kind } = describe(tab);
          const status = peerStatus(tab);
          return (
            <DropdownMenuItem key={tab.key} onSelect={() => openPeer(row.session.id, tab)} aria-current={tab.key === active ? "true" : undefined} className={cn("items-start whitespace-normal", tab.key === active && "bg-veil-raised")}>
              <TabIcon tab={tab} className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block break-words">{label}</span>
                <span className="block text-[11px] text-faint">{state ? `${kind} · ${state}` : kind}</span>
              </span>
              {status && STATUS_DOT[status] ? <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} aria-label={TAB_STATUS_LABEL[status]} /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
