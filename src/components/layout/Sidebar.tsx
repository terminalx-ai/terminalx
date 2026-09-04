import { useEffect } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { keycaps } from "@/lib/hotkeys";
import { selectProjectInSidebar, startSessionIn, useSessionStore } from "@/lib/sessions";
import { ProjectRail } from "./ProjectRail";
import { WorkspaceColumn } from "./WorkspaceColumn";

/**
 * Two columns: the project rail, and the focused project's workspaces with
 * their sessions. Selecting a session focuses its project in the session
 * store; otherwise the last project keeps the column populated.
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
  const store = useSessionStore();
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId);
  const focus = store.selectedProject ?? selected?.projectPath ?? store.lastProject ?? store.projects[0]?.path ?? null;

  useEffect(() => {
    if (!store.selectedProject && focus) selectProjectInSidebar(focus);
  }, [focus, store.selectedProject]);

  return (
    <aside className="relative flex h-full shrink-0">
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
      {focus ? (
        <WorkspaceColumn projectPath={focus} onNewSession={() => startSessionIn(focus, null)} />
      ) : (
        <div className="flex h-full w-(--column-w) shrink-0 flex-col border-r border-hairline">
          <div data-tauri-drag-region="deep" className="h-(--titlebar-h) shrink-0" />
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Pick or add a project to see its workspaces.</div>
        </div>
      )}
      <div className="absolute left-[calc(var(--rail-w)-34px)] top-1.5 z-10">
        <WithTooltip label="Hide sidebar" keys={keycaps("mod+b")}>
          <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={onToggle} className="text-faint hover:text-foreground">
            <PanelLeft />
          </Button>
        </WithTooltip>
      </div>
    </aside>
  );
}
