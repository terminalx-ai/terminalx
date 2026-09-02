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
 * their sessions. Focus follows the selected session's project, or the last
 * project used, so the column is never empty while a project exists.
 */
export function Sidebar({
  onToggle,
  onOpenSettings,
  onOpenIssues,
  onSearch,
}: {
  onToggle: () => void;
  onOpenSettings: () => void;
  onOpenIssues: () => void;
  onSearch: () => void;
}) {
  const store = useSessionStore();
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId);
  const focus = store.selectedProject ?? selected?.projectPath ?? store.lastProject ?? store.projects[0]?.path ?? null;

  useEffect(() => {
    if (selected && store.selectedProject !== selected.projectPath) selectProjectInSidebar(selected.projectPath);
  }, [selected, store.selectedProject]);

  useEffect(() => {
    if (!store.selectedProject && focus) selectProjectInSidebar(focus);
  }, [focus, store.selectedProject]);

  return (
    <aside className="relative flex h-full shrink-0">
      <ProjectRail onOpenSettings={onOpenSettings} onOpenIssues={onOpenIssues} onSearch={onSearch} />
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
