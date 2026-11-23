import { selectSidebarSort, useSidebarOrder } from "@/lib/sidebarOrder";
import { useRef, useState, type PointerEvent } from "react";
import { useCloudProjectChoices } from "@/components/session/CloudNewSession";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { canonicalProject, sidebarProjectOf } from "@/lib/sidebarView";
import { Check, ChevronDown, CircleDot, Folder, Layers, ListFilter, PanelLeft } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { cn } from "@/lib/cn";
import { SIDEBAR_FILTERS, setSidebarFilter, useSidebarFilter } from "@/lib/sidebarFilter";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { setShowArchived, useSessionStore } from "@/lib/sessions";
import { TITLEBAR_INSET } from "./AppShell";

/**
 * The sidebar's titlebar, the same in every layout: after the window's own controls, Hide sidebar. New session and
 * Search are destinations under it, and the View menu heads the session list (02.01).
 */
export function SidebarTitlebar({ onHide }: { onHide: () => void }) {
  return (
    <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 pr-2" style={{ paddingLeft: TITLEBAR_INSET }} data-testid="sidebar-titlebar">
      <WithTooltip label="Hide sidebar" shortcut="app.toggleSidebar">
        <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={onHide} className="text-faint hover:text-foreground">
          <PanelLeft />
        </Button>
      </WithTooltip>
    </div>
  );
}

/**
 * How the list is drawn and what it shows, as 02.18 lays it out: GROUP BY Project, Status or Sections (sections, then
 * one list); SORT BY Updated or Created; Filter by project; Custom order and Show archived as checkboxes; then which
 * sessions show. While a filter narrows the list, or the archived conversations are shown, the button looks
 * pressed and says so. The filter covers local and cloud sessions alike (`useSidebarFilter`) and opens on a click,
 * an accessibility press and the keyboard (`useRowMenu`). Show archived (#718) lists each project's archived
 * conversations, and the chats', under a fold of their own.
 */
export function ViewMenu() {
  const filter = useSidebarFilter();
  const prefs = usePrefs();
  const layout = prefs.sidebarLayout;
  const { showArchived } = useSessionStore();
  const order = useSidebarOrder();
  const sort = prefs.sidebarSort === "created" ? "created" : "updated";
  const menu = useRowMenu();
  const showing = SIDEBAR_FILTERS.find((entry) => entry.id === filter.filter)!.label;
  const label = filter.filter !== "all" ? `View: showing ${showing}` : prefs.sidebarProject ? "View: filtered by project" : showArchived ? "View: showing archived" : "View";
  const groups = [
    { id: "simple", label: "Project", icon: <Folder /> },
    { id: "status", label: "Status", icon: <CircleDot /> },
    { id: "list", label: "Sections", icon: <Layers /> },
  ] as const;
  const busy = !order.loaded || order.pending;
  const check = (on: boolean) => <span aria-hidden className={cn("ml-auto grid size-3.5 shrink-0 place-items-center rounded-[4px] border border-border", on && "border-transparent bg-foreground text-background")}>{on && <Check className="size-3" />}</span>;
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <Button
          variant="ghost"
          size="xs"
          aria-label={label}
          className={cn("h-6 gap-1 px-1.5 text-[12px] font-normal normal-case tracking-normal", filter.active || showArchived ? "bg-veil-raised text-foreground" : "text-faint hover:text-foreground")}
          data-testid="sidebar-filter"
          data-filter={filter.filter}
        >
          <ListFilter className="size-3.5" /> View <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-[.08em] text-faint">Group by</DropdownMenuLabel>
        {groups.map((group) => (
          <DropdownMenuItem key={group.id} role="menuitemradio" aria-checked={layout === group.id} onSelect={() => setPrefs({ sidebarLayout: group.id })}>
            {group.icon} {group.label}
            {layout === group.id && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-[.08em] text-faint">Sort by</DropdownMenuLabel>
        {(["updated", "created"] as const).map((choice) => (
          <DropdownMenuItem key={choice} role="menuitemradio" aria-checked={!order.custom && sort === choice} disabled={busy} onSelect={() => void selectSidebarSort(choice)}>
            {choice === "updated" ? "Updated" : "Created"}
            {!order.custom && sort === choice && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <ProjectFilterMenu />
        <DropdownMenuItem role="menuitemcheckbox" aria-checked={order.custom} disabled={busy} onSelect={() => void selectSidebarSort(order.custom ? sort : "custom")}>
          Custom order{check(order.custom)}
        </DropdownMenuItem>
        <DropdownMenuItem role="menuitemcheckbox" aria-checked={showArchived} onSelect={() => setShowArchived(!showArchived)}>
          Show archived{check(showArchived)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-[.08em] text-faint">Show</DropdownMenuLabel>
        {SIDEBAR_FILTERS.map((entry) => (
          <DropdownMenuItem key={entry.id} role="menuitemradio" aria-checked={filter.filter === entry.id} onSelect={() => setSidebarFilter(entry.id)}>
            {entry.label}
            {filter.filter === entry.id && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Project names and paths are searchable; looking at cloud projects never starts them. */
function ProjectFilterMenu() {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { sidebarProject } = usePrefs();
  const store = useSessionStore();
  const cloud = useCloudProjectChoices();
  const { visibleIds } = useOrganizationVisibility();
  const choices = new Map<string, string>();
  for (const project of store.projects) {
    if (canonicalProject(project.path) !== (store.chatsPath && canonicalProject(store.chatsPath))) choices.set(canonicalProject(project.path), project.name);
  }
  for (const session of store.sessions) {
    const path = sidebarProjectOf(session, store.chatsPath, store);
    if (path && !choices.has(path)) choices.set(path, path.split("/").pop() || path);
  }
  for (const org of cloud) if (visibleIds.has(org.orgId)) {
    for (const project of org.projects) choices.set(project.key, `${project.fullName} · ${org.orgName}`);
  }
  if (sidebarProject && !choices.has(sidebarProject)) choices.set(sidebarProject, sidebarProject.split("/").pop() || sidebarProject);
  const matching = [...choices].filter(([path, name]) => `${name} ${path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => a[1].localeCompare(b[1]));
  const keepSearchFocus = (event: PointerEvent) => {
    // A pointer leaving a formerly hovered result also moves Radix focus.
    // Protect both leave and move while typing; clicking a result still selects it.
    if (query && document.activeElement === search.current) event.preventDefault();
  };
  return <DropdownMenuSub onOpenChange={(open) => {
    setQuery("");
    // Radix's submenu autofocus runs during mount; focus the editable field afterwards.
    if (open) window.setTimeout(() => search.current?.focus(), 0);
  }}>
    <DropdownMenuSubTrigger><ListFilter /> Filter by project<span className="min-w-0 flex-1 truncate pl-2 text-right text-[12px] text-muted-foreground">{sidebarProject ? choices.get(sidebarProject) ?? "1 project" : "All"}</span></DropdownMenuSubTrigger>
    <DropdownMenuSubContent ref={content} className="w-64" onPointerMoveCapture={keepSearchFocus} onKeyDown={(event) => {
      if (event.key === "ArrowUp" && event.target === content.current?.querySelector('[role="menuitemradio"]')) {
        event.preventDefault(); search.current?.focus();
      }
    }}>
      <input ref={search} aria-label="Search projects" placeholder="Search projects…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Escape") return;
        event.stopPropagation();
        if (event.key === "ArrowDown" || event.key === "Tab") {
          event.preventDefault();
          const items = content.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
          items?.[event.shiftKey ? items.length - 1 : 0]?.focus();
        }
      }} className="mb-1 w-full rounded-md bg-well px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" />
      <DropdownMenuItem role="menuitemradio" aria-checked={!sidebarProject} onPointerLeave={keepSearchFocus} onSelect={() => setPrefs({ sidebarProject: null })}>
        {!sidebarProject ? <Check /> : <span className="size-4" />}All projects
      </DropdownMenuItem>
      <div className="max-h-64 overflow-y-auto">
        {matching.map(([path, name]) => <DropdownMenuItem key={path} role="menuitemradio" aria-checked={sidebarProject === path} onPointerLeave={keepSearchFocus} onSelect={() => setPrefs({ sidebarProject: path })} title={path}>
          {sidebarProject === path ? <Check /> : <span className="size-4" />}<span className="truncate">{name}</span>
        </DropdownMenuItem>)}
        {!matching.length && <p className="px-2 py-2 text-xs text-muted-foreground">No matching projects.</p>}
      </div>
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
}
