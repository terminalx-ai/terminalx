import type { ReactNode } from "react";
import { Check, ChevronDown, Ellipsis, Folder, FolderInput, FolderMinus, FolderPlus, Layers, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, MenuItemText } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { useFold } from "./useFold";
import { cn } from "@/lib/cn";
import { holdMenuFocus, keepFocusForNameField } from "@/lib/cloudSidebarSections";
import { openSectionDialog, runSectionEdit, useLocalSections, type LocalSection } from "@/lib/localSections";
import { conversationTitle, startSessionInSection, useSessionStore } from "@/lib/sessions";
import { customSessionOrder, useSidebarOrder } from "@/lib/sidebarOrder";
import { SortableStatusGroups, SidebarDragScope, SidebarSection, SidebarSectionOrder, SidebarSortList, useInSidebarDragScope, useSidebarSectionDrag } from "./SidebarSort";
import type { SessionEntry } from "@/types/session";

function openDialog(dialog: Parameters<typeof openSectionDialog>[0]) { holdMenuFocus(); openSectionDialog(dialog); }

/**
 * Same menu for single sessions and rows representing several sessions on a branch (02.19): a heading, each section
 * with its mark and how many sessions it holds, a check on the one they are in, New section…, and, while they are in
 * one, Remove from section, which says where they go back to (`home`, their project).
 */
export function MoveToLocalSectionItems({ sessionIds, home, contextMenu = false }: { sessionIds: string[]; home?: string | null; contextMenu?: boolean }) {
  const { sections } = useLocalSections();
  const known = useSessionStore().sessions;
  const Sub = contextMenu ? ContextMenuSub : DropdownMenuSub;
  const Trigger = contextMenu ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const Content = contextMenu ? ContextMenuSubContent : DropdownMenuSubContent;
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem;
  const Separator = contextMenu ? ContextMenuSeparator : DropdownMenuSeparator;
  const Label = contextMenu ? ContextMenuLabel : DropdownMenuLabel;
  const inSome = sections.some((section) => section.sessions.some((id) => sessionIds.includes(id)));
  // Only sessions that are still here count: a section keeps the ids of ones deleted since.
  const live = new Set(known.filter((session) => !session.archived).map((session) => session.id));
  return <Sub>
    <Trigger><FolderInput /> Move to section</Trigger>
    <Content className="max-h-80 w-[236px] overflow-y-auto">
      {sections.length > 0 && <Label className="px-2 pt-1.5 pb-1 font-normal tracking-[.08em]">Move to section</Label>}
      {sections.map((section) => {
        const current = sessionIds.every((id) => section.sessions.includes(id));
        return <Item key={section.id} role="menuitemradio" aria-checked={current} onSelect={() => { if (!current) runSectionEdit({ kind: "move", sessionIds, sectionId: section.id }); }}>
          {section.emoji ? <span aria-hidden className="grid size-4 shrink-0 place-items-center text-[13px] leading-none">{section.emoji}</span> : <Folder />}
          <span className="min-w-0 flex-1 truncate">{section.name}</span>
          <span aria-hidden className="font-mono text-[11px] text-faint tabular-nums">{section.sessions.filter((id) => live.has(id)).length}</span>
          <span className="grid w-4 shrink-0 place-items-center">{current && <Check className="text-foreground!" />}</span>
        </Item>;
      })}
      {sections.length > 0 && <Separator />}
      <Item onSelect={() => openDialog({ kind: "create", sessionIds })}><FolderPlus /> New section…</Item>
      {inSome && <Item className="items-start" onSelect={() => runSectionEdit({ kind: "move", sessionIds, sectionId: null })}>
        <FolderMinus className="mt-0.5" /> <MenuItemText label="Remove from section" hint={home ? `Back under ${home}` : "Back to the main list"} />
      </Item>}
    </Content>
  </Sub>;
}

/**
 * A group's header in the session list (02.14): its icon, name and count, then its actions on hover and its fold
 * at the end. A section, the Pinned group.
 */
export function GroupHeader({ icon, name, count, open, onToggle, handle, actions, surface, headerRef, className }: {
  icon: ReactNode; name: string; count: number; open: boolean; onToggle: () => void; actions?: ReactNode;
  /** A keyboard grip that drags the group: always reachable, drawn on hover or focus by itself. */
  handle?: ReactNode;
  surface?: Record<string, unknown>; headerRef?: (node: HTMLElement | null) => void; className?: string;
}) {
  return (
    <div ref={headerRef} className={cn("group/row relative mt-2 flex h-7 min-w-0 items-center gap-0.5 rounded-md pr-1 hover:bg-selected/50", className)} {...surface}>
      <button type="button" aria-expanded={open} aria-label={`${name} ${count}`} onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2.5 text-left text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 truncate text-[12.5px] font-medium">{name}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{count}</span>
      </button>
      {handle}
      {actions && <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex group-has-[[data-state=open]]/row:flex">{actions}</span>}
      <button type="button" aria-hidden tabIndex={-1} onClick={onToggle} className={cn("flex size-5 shrink-0 items-center justify-center rounded-sm text-faint outline-none hover:text-muted-foreground", open && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100")}>
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
      </button>
    </div>
  );
}

export function LocalSidebarSections({ groups, filtered, groupByStatus = false, renderSession }: {
  groups: { section: LocalSection; items: SessionEntry[] }[];
  filtered: boolean;
  groupByStatus?: boolean;
  renderSession: (session: SessionEntry) => ReactNode;
}) {
  const { error } = useLocalSections();
  const order = useSidebarOrder();
  const scoped = useInSidebarDragScope();
  const content = <>
    <SidebarSectionOrder ids={groups.map(({ section }) => section.id)}>
      {groups.map(({ section, items }, index) => (!filtered || items.length > 0) && <Section key={section.id} section={section} sessions={order.custom ? customSessionOrder(items, order) : items} index={index} count={groups.length} filtered={filtered} groupByStatus={groupByStatus} renderSession={renderSession} />)}
    </SidebarSectionOrder>
    {/* No standing "New section…" row: a section is made from a chat's menu, Move to section → New section…, where there is a chat to put in it. */}
    {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
  </>;
  // Inside the sidebar's own drag scope the main list is a drop target too. Alone (the simple layout), sessions move
  // between sections, leave them by a target after the last one, and come in from the project tree by SidebarSort's bridge.
  return scoped ? content : <SidebarDragScope main={false} mainTarget>{content}</SidebarDragScope>;
}

function Section({ section, sessions, index, count, filtered, groupByStatus, renderSession }: {
  section: LocalSection; sessions: SessionEntry[]; index: number; count: number; filtered: boolean; groupByStatus: boolean; renderSession: (session: SessionEntry) => ReactNode;
}) {
  const [expanded, toggle] = useFold(`local-section:${section.id}`, true);
  const menu = useRowMenu();
  const open = expanded || filtered;
  const drag = useSidebarSectionDrag(section, count > 1);
  // The section's emoji is its icon; one with none has a line icon in the accent colour (02.14).
  const icon = section.emoji ? <span className="max-w-6 truncate text-[13px] leading-none">{section.emoji}</span> : <Layers className="size-3.5 text-accent" />;
  return <section ref={drag.ref} style={drag.style} aria-label={`${section.name} section`} className={cn("mb-2 rounded-md", drag.over && "bg-info/10 ring-1 ring-inset ring-info/45")} data-local-section={section.id} data-drop-over={drag.over || undefined}>
    <DropdownMenu {...menu.root}>
      <GroupHeader
        headerRef={drag.headerRef}
        surface={menu.surface}
        icon={icon}
        name={section.name}
        count={sessions.length}
        open={open}
        onToggle={toggle}
        handle={drag.handle}
        actions={<>
          <Button variant="ghost" size="icon-xs" aria-label={`New session in ${section.name}`} onClick={() => startSessionInSection(section.id)}><Plus /></Button>
          <DropdownMenuTrigger asChild {...menu.trigger}><Button variant="ghost" size="icon-xs" aria-label={`Menu for section ${section.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
        </>}
      />
      <DropdownMenuContent align="end" onCloseAutoFocus={keepFocusForNameField}>
        <DropdownMenuItem onSelect={() => { holdMenuFocus(); startSessionInSection(section.id); }}>New session in section</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "rename", section })}>Rename section…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "emoji", section })}>Change emoji…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={index === 0} onSelect={() => runSectionEdit({ kind: "reorder", id: section.id, by: -1 })}>Move section up</DropdownMenuItem>
        <DropdownMenuItem disabled={index === count - 1} onSelect={() => runSectionEdit({ kind: "reorder", id: section.id, by: 1 })}>Move section down</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => openDialog({ kind: "delete", section })}>Delete section…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {open && <SidebarSection id={section.id} name={section.name}>{sessions.length ? <ul className="flex flex-col [--indent:10px]">{groupByStatus ? <SortableStatusGroups sessions={sessions} scope={`local-section:${section.id}`} onAdd={() => startSessionInSection(section.id)}>{renderSession}</SortableStatusGroups> : <SidebarSortList items={sessions.map((session) => ({ id: session.id, name: conversationTitle(session) }))}>{sessions.map(renderSession)}</SidebarSortList>}</ul> : <p className={cn("mx-2 grid h-8 place-items-center rounded-md border border-dashed border-border text-[12px] text-faint", drag.over && "border-info/60 text-foreground")}>Drag sessions here</p>}</SidebarSection>}
  </section>;
}
