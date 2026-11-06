import { useState } from "react";
import { useCloudProjectChoices } from "@/components/session/CloudNewSession";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { canonicalProject, sidebarProjectOf } from "@/lib/sidebarView";
import { Archive, Check, CircleDot, FolderPlus, FolderTree, LayoutList, PanelLeft, Plus, Search, SquarePen } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/menu";
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
  const grouped = usePrefs().sidebarLayout === "simple";
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
  const prefs = usePrefs();
  const statusGrouped = prefs.sidebarLayout === "status";
  const { showArchived } = useSessionStore();
  const menu = useRowMenu();
  const showing = SIDEBAR_FILTERS.find((entry) => entry.id === filter.filter)!.label;
  const label = filter.filter !== "all" ? `View: showing ${showing}` : prefs.sidebarProject ? "View: filtered by project" : showArchived ? "View: showing archived" : "View";
  const tooltip = filter.filter !== "all" ? `Showing: ${showing}` : prefs.sidebarProject ? "Filtered by project" : showArchived ? "Showing archived" : statusGrouped ? "Grouped by status" : grouped ? "Grouped by project" : "One list of chats";
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
            {statusGrouped ? <CircleDot /> : grouped ? <FolderTree /> : <LayoutList />}
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem role="menuitemradio" aria-checked={grouped} onSelect={() => setPrefs({ sidebarLayout: "simple" })}>
          <FolderTree /> Group by project
          {grouped && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemradio" aria-checked={!grouped && !statusGrouped} onSelect={() => setPrefs({ sidebarLayout: "list" })}>
          <LayoutList /> One list of chats
          {!grouped && !statusGrouped && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemradio" aria-checked={statusGrouped} onSelect={() => setPrefs({ sidebarLayout: "status" })}>
          <CircleDot /> Group by status
          {statusGrouped && <Check className="ml-auto" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Sort by: {prefs.sidebarSort === "created" ? "Created" : "Updated"}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {(["updated", "created"] as const).map((sort) => <DropdownMenuItem key={sort} role="menuitemradio" aria-checked={prefs.sidebarSort === sort} onSelect={() => setPrefs({ sidebarSort: sort })}>
              {sort === prefs.sidebarSort ? <Check /> : <span className="size-4" />}{sort === "created" ? "Created" : "Updated"}
            </DropdownMenuItem>)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <ProjectFilterMenu />
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

/** Project names and paths are searchable; looking at cloud projects never starts them. */
function ProjectFilterMenu() {
  const [query, setQuery] = useState("");
  const { sidebarProject } = usePrefs();
  const store = useSessionStore();
  const cloud = useCloudProjectChoices();
  const { visibleIds } = useOrganizationVisibility();
  const choices = new Map<string, string>();
  for (const project of store.projects) {
    if (canonicalProject(project.path) !== (store.chatsPath && canonicalProject(store.chatsPath))) choices.set(canonicalProject(project.path), project.name);
  }
  for (const session of store.sessions) {
    const path = sidebarProjectOf(session, store.chatsPath);
    if (path && !choices.has(path)) choices.set(path, path.split("/").pop() || path);
  }
  for (const org of cloud) if (visibleIds.has(org.orgId)) {
    for (const project of org.projects) choices.set(project.key, `${project.fullName} · ${org.orgName}`);
  }
  if (sidebarProject && !choices.has(sidebarProject)) choices.set(sidebarProject, sidebarProject.split("/").pop() || sidebarProject);
  const matching = [...choices].filter(([path, name]) => `${name} ${path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => a[1].localeCompare(b[1]));
  return <DropdownMenuSub onOpenChange={() => setQuery("")}>
    <DropdownMenuSubTrigger><Search /> Filter by project{sidebarProject && <Check className="ml-auto" />}</DropdownMenuSubTrigger>
    <DropdownMenuSubContent className="w-64">
      <input aria-label="Search projects" placeholder="Search projects…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        // Let Escape, Tab and vertical arrows reach Radix; typing must stay in the search field.
        if (!["Escape", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) event.stopPropagation();
      }} className="mb-1 w-full rounded-md bg-well px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" />
      <DropdownMenuItem role="menuitemradio" aria-checked={!sidebarProject} onSelect={() => setPrefs({ sidebarProject: null })}>
        {!sidebarProject ? <Check /> : <span className="size-4" />}All projects
      </DropdownMenuItem>
      <div className="max-h-64 overflow-y-auto">
        {matching.map(([path, name]) => <DropdownMenuItem key={path} role="menuitemradio" aria-checked={sidebarProject === path} onSelect={() => setPrefs({ sidebarProject: path })} title={path}>
          {sidebarProject === path ? <Check /> : <span className="size-4" />}<span className="truncate">{name}</span>
        </DropdownMenuItem>)}
        {!matching.length && <p className="px-2 py-2 text-xs text-muted-foreground">No matching projects.</p>}
      </div>
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
}
