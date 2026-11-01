import { Archive, Check, FolderPlus, FolderTree, LayoutList, PanelLeft, Plus, Search, SquarePen } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { cn } from "@/lib/cn";
import { SIDEBAR_FILTERS, setSidebarFilter, useSidebarFilter } from "@/lib/sidebarFilter";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { setShowArchived, startSessionIn, useSessionStore } from "@/lib/sessions";
import type { Project } from "@/types/session";
import { ProjectGlyph } from "./ProjectRail";
import { TITLEBAR_INSET } from "./AppShell";

/**
 * The sidebar's titlebar, the same in both layouts: after the window's own
 * controls, Hide sidebar; at the right, the View menu (conversations grouped
 * by project or one flat list, which sessions show: all, Unread or Needs
 * you, and whether the archived ones are listed too), then Search and New
 * chat, all plain icon buttons like the one that hides the sidebar.
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
      <ViewMenu grouped={grouped} />
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

/**
 * How the list is drawn and what it shows. The icon is the layout's; while a
 * filter narrows the list, or the archived conversations are shown, the
 * button looks pressed and says so. The filter covers local and cloud
 * sessions alike (`useSidebarFilter`) and opens on a click, an accessibility
 * press and the keyboard (`useRowMenu`). Show archived (#718) lists each
 * project's archived conversations, and the chats', under a fold of their own.
 */
function ViewMenu({ grouped }: { grouped: boolean }) {
  const filter = useSidebarFilter();
  const { showArchived } = useSessionStore();
  const menu = useRowMenu();
  const showing = SIDEBAR_FILTERS.find((entry) => entry.id === filter.filter)!.label;
  const label = filter.active ? `View: showing ${showing}` : showArchived ? "View: showing archived" : "View";
  const tooltip = filter.active ? `Showing: ${showing}` : showArchived ? "Showing archived" : grouped ? "Grouped by project" : "One list of chats";
  return (
    <DropdownMenu {...menu.root}>
      <WithTooltip label={tooltip}>
        <DropdownMenuTrigger asChild {...menu.trigger}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className={cn(filter.active || showArchived ? "bg-veil-raised text-foreground" : "text-faint hover:text-foreground")}
            data-testid="sidebar-filter"
            data-filter={filter.filter}
          >
            {grouped ? <FolderTree /> : <LayoutList />}
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem role="menuitemradio" aria-checked={grouped} onSelect={() => setPrefs({ sidebarLayout: "simple" })}>
          <FolderTree /> Group by project
          {grouped && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemradio" aria-checked={!grouped} onSelect={() => setPrefs({ sidebarLayout: "list" })}>
          <LayoutList /> One list of chats
          {!grouped && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        {SIDEBAR_FILTERS.map((entry) => (
          <DropdownMenuItem key={entry.id} role="menuitemradio" aria-checked={filter.filter === entry.id} onSelect={() => setSidebarFilter(entry.id)}>
            {filter.filter === entry.id ? <Check /> : <span aria-hidden className="size-4 shrink-0" />}
            {entry.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem role="menuitemcheckbox" aria-checked={showArchived} onSelect={() => setShowArchived(!showArchived)}>
          {showArchived ? <Check /> : <Archive />} Show archived
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
