import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useShortcut } from "@/lib/hotkeys";
import { openPeer, tabNodeId, tabPanelId, useTabRow, type PeerTab } from "@/lib/sessionTabs";
import { moveTabToPane, otherPane } from "@/lib/tabActions";
import { paneRatio, panesOf, saveTabLayout, selectPaneTab, tabKey } from "@/lib/tabLayouts";
import { tabViewIn } from "@/lib/tabFront";
import { useTabViews } from "@/lib/tabViews";
import { localRemovableWorkspace } from "@/lib/workspaceRemoval";
import type { SelectedSessionTab } from "@/lib/terminal";
import type { SessionEntry } from "@/types/session";
import { BrowserView } from "@/components/browser/BrowserView";
import { ReviewTab } from "@/components/editor/EditorSplit";
import { EnvironmentNotice } from "@/components/terminal/EnvironmentNotice";
import { TerminalView } from "@/components/terminal/TerminalView";
import { EmptySession } from "./EmptySession";
import { TabView } from "./TabView";
import { TabActions } from "./TabStrip";
import { WorkspaceTabStrip, stripTabId } from "./WorkspaceTabStrip";

/** Stable, keyed tab bodies share a grid: moving a tab never remounts its chat,
 * composer or xterm. Both visible terminals observe their own changing boxes. */
export function WorkspacePanes({ session, selected, strip, selectionRequested, continuationOpen }: {
  session: SessionEntry;
  selected: SelectedSessionTab | null;
  strip: boolean;
  selectionRequested: boolean;
  continuationOpen: boolean;
}) {
  const row = useTabRow(session);
  const keys = row.tabs.map((tab) => tab.key);
  const selectedKey = selected ? tabKey(selected.kind, selected.id) : null;
  const panes = panesOf(row.layout, keys, selectedKey);
  const split = panes.length === 2;
  const focused = panes.find((pane) => pane.tabs.includes(selectedKey ?? "")) ?? panes.find((pane) => pane.id === row.layout.focusedPane) ?? panes[0];
  const root = useRef<HTMLDivElement>(null);
  const [dragTarget, setDragTarget] = useState<"left" | "right" | null>(null);
  const target = useRef<typeof dragTarget>(null);
  const [resizing, setResizing] = useState<number | null>(null);
  const ratio = resizing ?? paneRatio(row.layout);
  const views = useTabViews();
  const latest = useRef({ row, keys, selectedKey });
  latest.current = { row, keys, selectedKey };

  // Selections can come from the sidebar, new-tab commands, or the CLI as well
  // as the strips. Keep the other pane's active tab when following one.
  useLayoutEffect(() => {
    const { row, keys, selectedKey } = latest.current;
    if (selectionRequested && selectedKey && row.layout.panes?.length) saveTabLayout(row.workspace, selectPaneTab(row.layout, keys, selectedKey));
  }, [session.id, selectedKey, selectionRequested]);

  useEffect(() => { setResizing(null); }, [row.workspace]);

  const focusPane = (id: "left" | "right") => {
    const pane = panes.find((pane) => pane.id === id);
    const tab = row.tabs.find((tab) => tab.key === pane?.active);
    if (tab && tab.key !== selectedKey) openPeer(session.id, tab);
  };
  useShortcut("session.focusOtherPane", () => {
    const other = panes.find((pane) => pane.id !== focused.id);
    if (other) focusPane(other.id);
  });
  useShortcut("session.moveTabToOtherPane", () => {
    const tab = row.tabs.find((tab) => tab.key === selectedKey);
    if (tab) moveTabToPane(row, tab, otherPane(row, tab), selected);
  });

  const paneDrag = {
    move(tab: PeerTab, x: number, y: number) {
      const box = root.current?.getBoundingClientRect();
      let next: typeof dragTarget = null;
      if (box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        const source = panes.find((pane) => pane.tabs.includes(tab.key));
        if (!split && keys.length > 1 && x >= box.right - Math.min(64, box.width / 4)) next = "right";
        else if (split) {
          const at = x < box.left + box.width * ratio ? panes[0].id : panes[1].id;
          if (at !== source?.id) next = at;
        }
      }
      target.current = next;
      setDragTarget(next);
      return next !== null;
    },
    drop(tab: PeerTab) {
      if (!target.current) return false;
      moveTabToPane(latest.current.row, tab, target.current, selected);
      return true;
    },
    cancel() { target.current = null; setDragTarget(null); },
  };
  const saveRatio = (value: number) => saveTabLayout(row.workspace, { ...row.layout, splitRatio: Math.max(0.2, Math.min(0.8, value)) });
  const pointerRatio = (x: number) => {
    const box = root.current!.getBoundingClientRect();
    return Math.max(0.2, Math.min(0.8, (x - box.left) / box.width));
  };
  const showStrip = strip || split;
  return (
    <div ref={root} data-testid="workspace-panes" className="relative grid min-h-0 min-w-0 flex-1 overflow-hidden"
      style={{ gridTemplateColumns: split ? `minmax(0, ${ratio}fr) 5px minmax(0, ${1 - ratio}fr)` : "minmax(0, 1fr)", gridTemplateRows: showStrip ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
      {showStrip && panes.map((pane, index) => (
        <div key={`strip-${pane.id}`} data-pane-id={pane.id} data-pane-focused={pane.id === focused.id} style={{ gridColumn: index * 2 + 1, gridRow: 1 }} className={cn("min-w-0", split && pane.id === focused.id && "bg-veil-raised")}>
          <WorkspaceTabStrip session={session} selected={row.tabs.find((tab) => tab.key === (split ? pane.active : selectedKey)) ?? null}
            paneRow={{ ...row, tabs: row.tabs.filter((tab) => pane.tabs.includes(tab.key)) }} paneDrag={paneDrag}
            trailing={strip && index === 0 ? <TabActions session={session} selected={selected} /> : undefined} />
        </div>
      ))}
      {split && <div role="separator" aria-label="Resize tab panes" aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
        className="z-20 cursor-col-resize touch-none bg-hairline hover:bg-ring/40 focus-visible:bg-ring/40 outline-none" style={{ gridColumn: 2, gridRow: "1 / -1" }}
        onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setResizing(ratio); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setResizing(pointerRatio(event.clientX)); }}
        onPointerUp={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; saveRatio(pointerRatio(event.clientX)); event.currentTarget.releasePointerCapture(event.pointerId); setResizing(null); }}
        onPointerCancel={() => setResizing(null)} onLostPointerCapture={() => setResizing(null)}
        onKeyDown={(event) => {
          const value = event.key === "ArrowLeft" ? ratio - 0.05 : event.key === "ArrowRight" ? ratio + 0.05 : event.key === "Home" ? 0.2 : event.key === "End" ? 0.8 : null;
          if (value !== null) { event.preventDefault(); saveRatio(value); }
        }} onDoubleClick={() => saveRatio(0.5)} />}
      {row.tabs.map((tab) => {
        const index = Math.max(0, panes.findIndex((pane) => pane.tabs.includes(tab.key)));
        const pane = panes[index];
        const active = tab.key === (split ? pane.active : selectedKey);
        const owner = row.sessions.find((owner) => owner.id === tab.sessionId) ?? session;
        // Single-pane empty sessions keep their own empty page, even when siblings have tabs.
        return <div key={tab.key} id={tabPanelId(tab)} role="tabpanel" aria-labelledby={(showStrip ? stripTabId : tabNodeId)(tab)} aria-hidden={!active}
          data-pane-id={pane.id} className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", !active && "invisible pointer-events-none")}
          style={{ gridColumn: index * 2 + 1, gridRow: showStrip ? 2 : 1 }}
          onPointerDownCapture={() => { if (active) focusPane(pane.id); }} onFocusCapture={() => { if (active) focusPane(pane.id); }}>
          {tab.kind === "agent" ? <>
            <EnvironmentNotice id={tab.tab.pane ?? `tab:${tab.id}`} active={active && tabViewIn(views.views, tab.tab) !== "terminal"} />
            <TabView session={owner} tab={tab.tab} active={active} focused={active && pane.id === focused.id} continuationOpen={continuationOpen} workspace={localRemovableWorkspace(owner)} />
          </> : tab.kind === "terminal" ? <>
            <TerminalView id={tab.id} visible={active} focused={active && pane.id === focused.id} />
            {tab.pane.exited && <div className="absolute bottom-2 left-3 rounded-md bg-popover px-2 py-1 text-[11px] text-muted-foreground hairline">Process exited{tab.pane.exitCode != null ? ` (${tab.pane.exitCode})` : ""}.</div>}
          </> : tab.kind === "review" ? <ReviewTab entry={tab.editor} visible={active} focused={active && pane.id === focused.id} embedded />
          : <BrowserView session={session} page={tab.page} active={active} />}
        </div>;
      })}
      {!selected && !split && <div className="flex min-h-0 flex-col" style={{ gridColumn: 1, gridRow: showStrip ? 2 : 1 }}><EmptySession session={session} /></div>}
      {dragTarget && <div data-testid="pane-drop-preview" className="pointer-events-none absolute inset-y-0 z-30 flex items-center justify-center border-2 border-ring bg-ring/10 text-sm font-medium"
        style={dragTarget === "right" ? { right: 0, width: split ? `${(1 - ratio) * 100}%` : "50%" } : { left: 0, width: `${ratio * 100}%` }}>{split ? "Move to pane" : "Split right"}</div>}
    </div>
  );
}
