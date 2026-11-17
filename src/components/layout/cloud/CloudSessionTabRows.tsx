import { AgentTabRow } from "@/components/layout/SidebarRows";
import { tabNodeId, tabPanelId } from "@/lib/sessionTabIds";
import type { CloudSessionTabRowsProps } from "@/lib/cloudSessionTabs";

/**
 * The tab rows drawn under a cloud session's row, one per agent tab (#1172).
 *
 * The design boards do not draw cloud tab rows, so these are built from the
 * local tab rows' parts (`AgentTabRow`, with its status stripe and agent mark)
 * and add no row markup of their own. A cloud tab is not closed from the
 * sidebar, so no row has a close button.
 */
export function CloudSessionTabRows({ sessionTitle, tabs, sessionSelected, onOpen }: CloudSessionTabRowsProps) {
  if (tabs.length === 0) return null;
  return (
    <div
      role="tree"
      aria-label={`Tabs of ${sessionTitle}`}
      data-testid="cloud-session-tabs"
      className="flex flex-col pl-[calc(1.5rem+var(--indent,0px))] pr-1"
    >
      {tabs.map((tab) => (
        <AgentTabRow
          key={tab.tabId}
          nodeId={tabNodeId({ kind: "agent", id: tab.tabId })}
          panelId={tabPanelId({ kind: "agent", id: tab.tabId })}
          harness={tab.harness}
          label={tab.label}
          status={tab.status}
          mobileDriven={false}
          terminalView={false}
          selected={sessionSelected && tab.front}
          onOpen={() => onOpen(tab.tabId)}
          data-testid="cloud-session-tab-row"
          data-tab={tab.tabId}
        />
      ))}
    </div>
  );
}
