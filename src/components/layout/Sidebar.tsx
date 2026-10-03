import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { ProjectRail } from "./ProjectRail";

/**
 * One navigation surface. Projects own expandable workspaces, sessions and
 * agent tabs, so every destination and its context stays in one tree.
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
  return (
    <aside className="relative flex h-full min-h-0 w-(--sidebar-w) shrink-0 overflow-clip">
      <ProjectRail
        onOpenSettings={onOpenSettings}
        onOpenAccount={onOpenAccount}
        onOpenIssues={onOpenIssues}
        onOpenAgents={onOpenAgents}
        onOpenStats={onOpenStats}
        onOpenAutomations={onOpenAutomations}
        onOpenSkills={onOpenSkills}
        onSearch={onSearch}
      />
      <div className="absolute right-2 top-1.5 z-10">
        <WithTooltip label="Hide sidebar" shortcut="app.toggleSidebar">
          <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={onToggle} className="text-faint hover:text-foreground">
            <PanelLeft />
          </Button>
        </WithTooltip>
      </div>
    </aside>
  );
}
