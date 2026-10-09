import { useEffect, useMemo, useState } from "react";
import { MessageCirclePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { showFloatingWindow } from "@/lib/floating";
import { useMobileDrivenTabs } from "@/lib/mobileDriver";
import { QUICK_CHATS_LABEL, quickChatsOf } from "@/lib/quickChats";
import { useSessionStore } from "@/lib/sessions";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { useTabViews } from "@/lib/tabViews";
import { TreeToggle } from "./SidebarRows";
import { SessionNode } from "./SidebarTree";
import { useSectionCollapsed } from "./cloud/CloudSections";

/**
 * Quick chats in the sidebar: the sessions that have no project, in a section
 * of their own so they can be found, opened, renamed and deleted like any
 * other. A quick chat has no workspace level, so its rows sit directly under
 * the section. The section is not drawn while there are none.
 */
export function QuickChatsSection() {
  const store = useSessionStore();
  const filter = useSidebarFilter();
  const [collapsed, toggle] = useSectionCollapsed("quick");
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set());
  const tabViews = useTabViews();
  const mobileDriven = useMobileDrivenTabs();
  const harnessNames = useMemo(() => new Map(store.harnesses.map((harness) => [harness.id, harness.name])), [store.harnesses]);
  const selectedId = store.selectedSessionId;

  const all = useMemo(() => quickChatsOf(store.sessions, { archived: true }), [store.sessions]);
  const chats = all
    // The archive toggle shows one or the other, as it does for a project's sessions; the one on screen is always listed.
    .filter((session) => session.archived === store.showArchived || session.id === selectedId)
    .filter((session) => !filter.active || filter.shows(session.id) || session.id === selectedId);

  // A chat opened from a notice, the palette or the other window is revealed with its tabs.
  useEffect(() => {
    if (!selectedId || !all.some((session) => session.id === selectedId)) return;
    setExpandedSessions((current) => (current.has(selectedId) ? current : new Set(current).add(selectedId)));
  }, [selectedId, all, store.navigationVersion]);

  if (all.length === 0 || chats.length === 0) return null;
  // A filter shows what it found, and the chat on screen is never hidden behind a collapsed header.
  const open = !collapsed || filter.active || chats.some((session) => session.id === selectedId);
  return (
    <div role="treeitem" aria-label={`${QUICK_CHATS_LABEL} section`} aria-expanded={open} className="mt-3 min-w-0" data-testid="quick-chats-section">
      <div data-tree-row className="flex h-7 min-w-0 items-center justify-between">
        <span className="flex min-w-0 items-center gap-1">
          <TreeToggle expanded={open} label={QUICK_CHATS_LABEL} onToggle={toggle} />
          <button
            type="button"
            onClick={toggle}
            className="truncate rounded-sm text-[11px] font-medium uppercase tracking-wide text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            title="Chats with no project. Each runs in a scratch folder of its own."
          >
            {QUICK_CHATS_LABEL}
          </button>
        </span>
        <WithTooltip label="New quick chat in the floating window">
          <Button variant="ghost" size="icon-xs" aria-label="New quick chat" onClick={() => void showFloatingWindow("")}>
            <MessageCirclePlus />
          </Button>
        </WithTooltip>
      </div>
      {open && (
        <div role="group" className="pb-1">
          {chats.map((session) => (
            <SessionNode
              key={session.id}
              session={session}
              selected={session.id === selectedId}
              expanded={expandedSessions.has(session.id)}
              onToggle={() =>
                setExpandedSessions((current) => {
                  const next = new Set(current);
                  if (next.has(session.id)) next.delete(session.id);
                  else next.add(session.id);
                  return next;
                })
              }
              tabViews={tabViews.views}
              mobileDriven={mobileDriven}
              harnessNames={harnessNames}
            />
          ))}
        </div>
      )}
    </div>
  );
}
