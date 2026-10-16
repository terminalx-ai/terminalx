import { FolderPlus, FolderTree, LayoutList, PanelLeft, Plus, Search, SquarePen } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { startSessionIn } from "@/lib/sessions";
import type { Project } from "@/types/session";
import { ProjectGlyph } from "./ProjectRail";
import { TITLEBAR_INSET } from "./AppShell";

/**
 * The sidebar's titlebar, the same in both layouts: after the window's own
 * controls, Hide sidebar; at the right, the switch between conversations
 * grouped by project and one flat list, then Search and New chat, all plain
 * icon buttons like the one that hides the sidebar.
 */
export function SidebarTitlebar({
  onHide,
  onSearch,
  onNewChat,
  onAddProject,
  projects,
}: {
  onHide: () => void;
  onSearch: () => void;
  onNewChat: () => void;
  onAddProject: () => void;
  /** The projects a new chat may start in, as the menu lists them. */
  projects: Project[];
}) {
  const grouped = usePrefs().sidebarLayout !== "list";
  return (
    <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 pr-2" style={{ paddingLeft: TITLEBAR_INSET }} data-testid="sidebar-titlebar">
      <WithTooltip label="Hide sidebar" shortcut="app.toggleSidebar">
        <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={onHide} className="text-faint hover:text-foreground">
          <PanelLeft />
        </Button>
      </WithTooltip>
      <div className="flex-1" />
      <WithTooltip label={grouped ? "Grouped by project. Click for one list of chats" : "One list of chats. Click to group by project"}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Group by project"
          aria-pressed={grouped}
          onClick={() => setPrefs({ sidebarLayout: grouped ? "list" : "simple" })}
          className={cn(grouped ? "bg-veil-raised text-foreground" : "text-faint hover:text-foreground")}
        >
          {grouped ? <FolderTree /> : <LayoutList />}
        </Button>
      </WithTooltip>
      <WithTooltip label="Search" shortcut="app.commandPalette">
        <Button variant="ghost" size="icon-sm" className="text-faint hover:text-foreground" aria-label="Search" onClick={onSearch}>
          <Search />
        </Button>
      </WithTooltip>
      <DropdownMenu>
        <WithTooltip label="New chat">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-faint hover:text-foreground" aria-label="New chat">
              <Plus />
            </Button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={onNewChat}>
            <SquarePen /> New chat
          </DropdownMenuItem>
          {projects.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>In a project</DropdownMenuLabel>
              {projects.map((project) => (
                <DropdownMenuItem key={project.path} onSelect={() => startSessionIn(project.path, null)}>
                  <ProjectGlyph project={project} /> <span className="truncate">{project.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onAddProject}>
            <FolderPlus /> Add a project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
