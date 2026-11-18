import { useState, type ReactNode } from "react";
import { closestCenter, pointerWithin, DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowDown, ArrowUp, ChevronDown, Check, Ellipsis, Folder, FolderPlus, GripVertical, Pencil, Plus, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { RowActions, actionRow } from "./RowActions";
import { SectionNameInput } from "./CloudSectionNameInput";
import { WorkspaceRows, CloudProjectGroup } from "./cloud/CloudProjectRows";
import { WorkspaceFollowingSection } from "./WorkspaceFollowingSection";
import { cn } from "@/lib/cn";
import { useAccount } from "@/lib/account";
import { useCloudDashboard } from "@/lib/cloudDashboard";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { CLOUD_SECTION_SORTS, createCloudSection, createCloudSectionForWorkspace, deleteCloudSection, holdMenuFocus, isBuiltInSection, isCloudSectionDraft, keepFocusForNameField, moveCloudSection, moveWorkspaceToSection, MY_WORKSPACES, renameCloudSection, sectionWorkspaceIds, SHARED_WORKSPACES, sortSectionWorkspaces, takeRenameRequest, useCloudSidebarSections, updateCloudSection, workspaceBuiltIn } from "@/lib/cloudSidebarSections";
import type { CloudSidebarSection } from "@/lib/prefs";
import type { CloudProject, CloudWorkspaceNode } from "@/types/target";
import type { LifecycleRequest } from "@/components/cloud/WorkspaceActions";
import { useSidebarFilter } from "@/lib/sidebarFilter";

type Lifecycle = (request: LifecycleRequest) => void;
const ICONS = ["📁", "🚀", "⭐", "🔧", "📦", "🌱", "🎯", "💼"];

/** Include empty and collapsed section zones in keyboard navigation. */
const sectionCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.code)) return;
  event.preventDefault();
  const down = event.code === "ArrowDown" || event.code === "ArrowRight";
  const candidates = context.droppableContainers.getEnabled().filter((entry) => String(entry.id).startsWith("zone:")).map((entry) => ({ entry, rect: context.droppableRects.get(entry.id) })).filter((row) => row.rect);
  const current = context.over?.data.current?.section ?? context.active?.data.current?.section;
  const index = candidates.findIndex(({ entry }) => entry.data.current?.section === current);
  const next = candidates[index + (down ? 1 : -1)];
  if (!next?.rect || !context.collisionRect) return;
  return { x: currentCoordinates.x + next.rect.left + next.rect.width / 2 - context.collisionRect.left - context.collisionRect.width / 2, y: currentCoordinates.y + next.rect.top + next.rect.height / 2 - context.collisionRect.top - context.collisionRect.height / 2 };
};

const sectionCollision: CollisionDetection = (args) => {
  const zones = { ...args, droppableContainers: args.droppableContainers.filter((entry) => String(entry.id).startsWith("zone:")) };
  return args.pointerCoordinates ? pointerWithin(zones) : closestCenter(zones);
};

/** This DnD scope changes personal layout only, never membership or ownership. */
export function CloudWorkspaceSections({ orgId, projects, sections, filtered, onLifecycle }: { orgId: string; projects: CloudProject[]; sections: CloudSidebarSection[]; filtered: boolean; onLifecycle: Lifecycle }) {
  const catalog = useCloudCatalog();
  const dashboard = useCloudDashboard();
  const filter = useSidebarFilter();
  const { status } = useAccount();
  const scope = `${status.context?.account ?? status.identity?.email ?? ""}:${orgId}`;
  const viewer = catalog.orgs[orgId]?.source === "live" && !catalog.orgs[orgId]?.error ? catalog.viewerUserId : undefined;
  const personal = sections.filter((section) => !isBuiltInSection(section.id));
  const assigned = new Set<string>();
  const nodes = projects.flatMap((project) => project.workspaces).filter((node) => node.item.workspace.you?.role !== "none");
  const groups = personal.map((section) => {
    const ids = sectionWorkspaceIds(section, projects);
    const rows = nodes.filter((node) => ids.includes(node.item.workspace.id) && !assigned.has(node.key));
    rows.forEach((node) => assigned.add(node.key));
    return { section, rows };
  });
  const builtins = [MY_WORKSPACES, SHARED_WORKSPACES].map((id) => {
    const rows = nodes.filter((node) => workspaceBuiltIn(node, viewer) === id);
    // Counts describe real ownership, even for a workspace arranged in a personal section.
    return { section: { ...(sections.find((section) => section.id === id) ?? { id, projects: [] }), name: id === MY_WORKSPACES ? "My workspaces" : "Shared with me" }, rows: rows.filter((node) => !assigned.has(node.key)), count: viewer ? rows.length : null };
  });
  const classified = new Set([...assigned, ...builtins.flatMap((group) => group.rows.map((node) => node.key))]);
  const fallback = projects.map((project) => ({ ...project, workspaces: project.workspaces.filter((node) => !classified.has(node.key) && node.item.workspace.you?.role !== "none") })).filter((project) => project.workspaces.length || !projects.find((original) => original.key === project.key)?.workspaces.length);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sectionCoordinates }));
  const move = (workspaceId: string, target: string) => {
    const node = nodes.find((node) => node.item.workspace.id === workspaceId);
    if (!node || (isBuiltInSection(target) && workspaceBuiltIn(node, viewer) !== target)) return;
    moveWorkspaceToSection(orgId, workspaceId, isBuiltInSection(target) ? null : target, projects);
  };
  const show = (node: CloudWorkspaceNode) => !filtered || filter.showsWorkspace(node.key) || dashboard.some((session) => session.orgId === orgId && session.workspaceId === node.item.workspace.id && filter.shows(session.id));
  const renderGroup = ({ section, rows, count }: { section: CloudSidebarSection; rows: CloudWorkspaceNode[]; count?: number | null }) => {
    const visible = sortSectionWorkspaces(rows.filter(show), section.sort);
    if (filtered && !visible.length && !isCloudSectionDraft(orgId, section.id)) return null;
    return <WorkspaceSection key={`${scope}:${section.id}`} orgId={orgId} section={section} count={count === undefined ? rows.length : count} filtered={filtered}>
      <SortableContext items={visible.map((node) => node.key)} strategy={verticalListSortingStrategy}>
        {visible.map((node) => <WorkspaceEntry key={node.key} node={node} section={section.id} onLifecycle={onLifecycle}>
          <DropdownMenuSub><DropdownMenuSubTrigger><FolderPlus />Move to section</DropdownMenuSubTrigger><DropdownMenuSubContent>
            <DropdownMenuItem disabled={isBuiltInSection(section.id)} onSelect={() => moveWorkspaceToSection(orgId, node.item.workspace.id, null, projects)}>Main list</DropdownMenuItem>
            {[...builtins.map((group) => group.section), ...personal].map((target) => <DropdownMenuItem key={target.id} disabled={target.id === section.id || (isBuiltInSection(target.id) && workspaceBuiltIn(node, viewer) !== target.id)} onSelect={() => move(node.item.workspace.id, target.id)}>{target.name}</DropdownMenuItem>)}
            <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => createCloudSectionForWorkspace(orgId, node.item.workspace.id, projects)}><Plus />New section…</DropdownMenuItem>
          </DropdownMenuSubContent></DropdownMenuSub>
        </WorkspaceEntry>)}
      </SortableContext>
      {!visible.length && <p data-testid="cloud-section-empty" className="mx-2 my-1 rounded-md border border-dashed border-border px-2 py-2 text-[11px] text-faint">Drag a workspace here</p>}
    </WorkspaceSection>;
  };
  return <DndContext key={scope} sensors={sensors} collisionDetection={sectionCollision} accessibility={{ announcements: { onDragStart: ({ active }) => `Picked up ${active.data.current?.name ?? "workspace"}. Use arrow keys to choose a section.`, onDragOver: ({ over }) => over ? `Over ${over.data.current?.name ?? "section"}` : "Outside a section", onDragEnd: ({ over }) => over ? "Workspace layout updated" : "Move canceled", onDragCancel: () => "Move canceled" } }} onDragEnd={({ active, over }) => {
    const target = over?.data.current?.section;
    const workspaceId = active.data.current?.workspaceId;
    if (typeof target === "string" && typeof workspaceId === "string") move(workspaceId, target);
  }}>
    {builtins.map(renderGroup)}
    <WorkspaceFollowingSection orgId={orgId} />
    {groups.map(renderGroup)}
    {fallback.filter((project) => !filtered || filter.showsProject(project.key)).map((project) => <CloudProjectGroup key={project.key} project={project} onLifecycle={onLifecycle} />)}
  </DndContext>;
}

function WorkspaceSection({ orgId, section, count, filtered, children }: { orgId: string; section: CloudSidebarSection; count: number | null; filtered: boolean; children: ReactNode }) {
  const builtIn = isBuiltInSection(section.id);
  const personal = useCloudSidebarSections(orgId).filter((entry) => !isBuiltInSection(entry.id));
  const index = personal.findIndex((entry) => entry.id === section.id);
  const menu = useRowMenu();
  const [creating, setCreating] = useState(() => !builtIn && takeRenameRequest(section.id));
  const [renaming, setRenaming] = useState(creating);
  const open = !section.collapsed || filtered;
  const drop = useDroppable({ id: `zone:${section.id}`, data: { section: section.id, name: section.name } });
  const toggle = () => updateCloudSection(orgId, section.id, { collapsed: open });
  return <section role="group" ref={drop.setNodeRef} aria-label={`${section.name} section`} data-testid="cloud-section" data-section={section.id} className={cn("mb-1 min-w-0 rounded-md", drop.isOver && "bg-info/10 ring-1 ring-inset ring-info/45")}>
    <div className={cn(actionRow, "flex h-7 min-w-0 items-center gap-1 rounded-md pl-2 pr-1 hover:bg-selected/50")} data-testid="cloud-section-row" {...menu.surface} onKeyDown={(event) => { menu.surface.onKeyDown?.(event); if (!builtIn && !renaming && event.key === "F2") { event.preventDefault(); setRenaming(true); } }}>
      {renaming ? <SectionNameInput creating={creating} name={creating ? "" : section.name} onDone={(name) => { if (creating && (name === null || !name.trim())) deleteCloudSection(orgId, section.id); else if (name !== null) renameCloudSection(orgId, section.id, name); setCreating(false); setRenaming(false); }} /> : <button type="button" aria-expanded={open} aria-label={`${section.name} section`} onClick={toggle} onDoubleClick={() => { if (!builtIn) setRenaming(true); }} className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <ChevronDown aria-hidden className={cn("size-3 shrink-0 text-faint", !open && "-rotate-90")} />
        {section.icon ? <span aria-hidden className="shrink-0 text-xs">{section.icon}</span> : !builtIn && <Folder aria-hidden className="size-3 shrink-0 text-faint" />}
        <span data-testid="cloud-section-name" className={cn("min-w-0 flex-1 truncate text-muted-foreground", builtIn ? "text-[10px] uppercase tracking-wide" : "text-[12px] font-medium")}>{section.name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-faint" aria-label={count === null ? "Workspace ownership unavailable" : `${count} workspaces`}>{count ?? "—"}</span>
      </button>}
      {!renaming && <RowActions persistent className={menu.open ? "not-sr-only" : undefined}><DropdownMenu {...menu.root}>
        <DropdownMenuTrigger asChild {...menu.trigger}><Button variant="ghost" size="icon-xs" aria-label={`Menu for section ${section.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={keepFocusForNameField}>
          <DropdownMenuItem onSelect={() => createCloudSection(orgId)}><FolderPlus />New section…</DropdownMenuItem>
          <DropdownMenuItem disabled={builtIn} onSelect={() => { holdMenuFocus(); setRenaming(true); }}><Pencil />Rename section</DropdownMenuItem>
          <DropdownMenuSub><DropdownMenuSubTrigger disabled={builtIn}><Folder />Change icon</DropdownMenuSubTrigger><DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => updateCloudSection(orgId, section.id, { icon: "" })}>Default icon</DropdownMenuItem>
            {ICONS.map((icon) => <DropdownMenuItem key={icon} onSelect={() => updateCloudSection(orgId, section.id, { icon })}><span aria-hidden>{icon}</span>{({ "📁": "Folder", "🚀": "Rocket", "⭐": "Star", "🔧": "Tools", "📦": "Package", "🌱": "Seedling", "🎯": "Target", "💼": "Briefcase" })[icon as "📁"]}</DropdownMenuItem>)}
          </DropdownMenuSubContent></DropdownMenuSub>
          <DropdownMenuSub><DropdownMenuSubTrigger>Sort by<span className="ml-auto text-faint">{CLOUD_SECTION_SORTS.find((sort) => sort.id === (section.sort ?? "active"))?.label}</span></DropdownMenuSubTrigger><DropdownMenuSubContent>
            {CLOUD_SECTION_SORTS.map((sort) => <DropdownMenuItem key={sort.id} onSelect={() => updateCloudSection(orgId, section.id, { sort: sort.id })}>{sort.id === (section.sort ?? "active") && <Check />}{sort.label}</DropdownMenuItem>)}
          </DropdownMenuSubContent></DropdownMenuSub>
          <DropdownMenuItem onSelect={toggle}><ChevronDown />{open ? "Collapse section" : "Expand section"}</DropdownMenuItem>
          {!builtIn && <>
            <DropdownMenuItem disabled={index === 0} onSelect={() => moveCloudSection(orgId, section.id, -1)}><ArrowUp />Move up</DropdownMenuItem>
            <DropdownMenuItem disabled={index === personal.length - 1} onSelect={() => moveCloudSection(orgId, section.id, 1)}><ArrowDown />Move down</DropdownMenuItem>
          </>}
          <DropdownMenuSeparator /><DropdownMenuItem disabled={builtIn} destructive onSelect={() => deleteCloudSection(orgId, section.id)}><Trash2 />Delete section</DropdownMenuItem>
          {builtIn && <p className="px-2 py-1 text-[11px] text-faint">Built-in sections can't be deleted</p>}
        </DropdownMenuContent>
      </DropdownMenu></RowActions>}
    </div>
    {open && <div className="min-w-0">{children}</div>}
  </section>;
}

function WorkspaceEntry({ node, section, onLifecycle, children }: { node: CloudWorkspaceNode; section: string; onLifecycle: Lifecycle; children: ReactNode }) {
  const drag = useSortable({ id: node.key, data: { section, workspaceId: node.item.workspace.id, name: node.item.workspace.name } });
  return <div ref={drag.setNodeRef} className={cn("flex min-w-0 items-start", drag.isDragging && "opacity-40")}>
    <button ref={drag.setActivatorNodeRef} type="button" aria-label={`Move workspace ${node.item.workspace.name}`} className="mt-2 shrink-0 rounded-sm text-faint outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" style={{ touchAction: "none" }} {...drag.attributes} {...drag.listeners}><GripVertical className="size-3" /></button>
    <ul className="min-w-0 flex-1"><WorkspaceRows node={node} named open onLifecycle={onLifecycle} extraActions={children} /></ul>
  </div>;
}
