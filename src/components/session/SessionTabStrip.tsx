import { useMemo } from "react";
import { Globe, TerminalSquare, X } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { pagesFor, useBrowser } from "@/lib/browser";
import { cn } from "@/lib/cn";
import { activatePeer, browserPageLabel, closePeer, peerOrder, tabNodeId, tabPanelId, type PeerTab } from "@/lib/sessionTabs";
import { useSessionStore } from "@/lib/sessions";
import { useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import { TAB_STATUS_LABEL, type SessionEntry, type TabStatus } from "@/types/session";

const STATUS_DOT: Partial<Record<TabStatus, string>> = {
  waiting: "bg-warning",
  completed: "bg-add",
  in_progress: "bg-info animate-pulse-soft",
};

/**
 * A session's tabs in one row: agents, shells and browser pages, in the
 * order they were opened.
 *
 * The main window lists a session's tabs in the sidebar. A window with no
 * sidebar (the floating one) draws this instead; the tabs, their order, and
 * what selecting and closing one does are the same (`@/lib/sessionTabs`).
 */
export function SessionTabStrip({ session, selected }: { session: SessionEntry; selected: SelectedSessionTab | null }) {
  const { panes } = useTerminals();
  const browser = useBrowser();
  const harnesses = useSessionStore().harnesses;
  const tabs = useMemo(() => peerOrder(session, panes, pagesFor(browser.pages, session.cwd)), [session, panes, browser.pages]);
  // One tab needs no strip: there is nothing to switch between.
  if (tabs.length < 2) return null;
  const labelOf = (tab: PeerTab): string => {
    if (tab.kind === "agent") return tab.tab.title?.trim() || harnesses.find((harness) => harness.id === tab.tab.harness)?.name || tab.tab.harness;
    if (tab.kind === "terminal") return tab.pane.title;
    return browserPageLabel(tab.page);
  };
  return (
    <div role="tablist" aria-label="Session tabs" data-testid="session-tab-strip" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-hairline px-2 py-1">
      {tabs.map((tab) => {
        const active = tab.kind === selected?.kind && tab.id === selected.id;
        const label = labelOf(tab);
        const status = tab.kind === "agent" ? tab.tab.status : null;
        return (
          <div key={`${tab.kind}:${tab.id}`} className={cn("group/tab flex min-w-0 max-w-44 shrink-0 items-center rounded-md", active ? "bg-veil-strong text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground")}>
            <button
              type="button"
              role="tab"
              id={tabNodeId(tab)}
              aria-selected={active}
              aria-controls={tabPanelId(tab)}
              title={status && status !== "idle" ? `${label} · ${TAB_STATUS_LABEL[status]}` : label}
              onClick={() => activatePeer(session.id, tab)}
              className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {tab.kind === "agent" ? <AgentMark id={tab.tab.harness} className="size-3.5 shrink-0" decorative /> : tab.kind === "terminal" ? <TerminalSquare className="size-3.5 shrink-0" /> : <Globe className="size-3.5 shrink-0" />}
              <span className="truncate">{label}</span>
              {status && STATUS_DOT[status] && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} aria-label={TAB_STATUS_LABEL[status]} />}
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => void closePeer(session.id, tab, tabs, selected)}
              className={cn("mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-veil-strong focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40", active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70")}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
