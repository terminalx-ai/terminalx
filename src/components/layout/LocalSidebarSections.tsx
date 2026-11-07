import type { ReactNode } from "react";
import { ChevronDown, Ellipsis, FolderPlus, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { useFold } from "./useFold";
import { cn } from "@/lib/cn";
import { holdMenuFocus, keepFocusForNameField } from "@/lib/cloudSidebarSections";
import { openSectionDialog, runSectionEdit, useLocalSections, type LocalSection } from "@/lib/localSections";
import { startSessionInSection } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

function openDialog(dialog: Parameters<typeof openSectionDialog>[0]) { holdMenuFocus(); openSectionDialog(dialog); }

/** Same menu for single sessions and rows representing several sessions on a branch. */
export function MoveToLocalSectionItems({ sessionIds, contextMenu = false }: { sessionIds: string[]; contextMenu?: boolean }) {
  const { sections } = useLocalSections();
  const Sub = contextMenu ? ContextMenuSub : DropdownMenuSub;
  const Trigger = contextMenu ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const Content = contextMenu ? ContextMenuSubContent : DropdownMenuSubContent;
  const Item = contextMenu ? ContextMenuItem : DropdownMenuItem;
  return <Sub>
    <Trigger><FolderPlus /> Move to section</Trigger>
    <Content className="max-h-72 w-56 overflow-y-auto">
      <Item disabled={!sections.some((section) => section.sessions.some((id) => sessionIds.includes(id)))} onSelect={() => runSectionEdit({ kind: "move", sessionIds, sectionId: null })}>Main list</Item>
      {sections.map((section) => <Item key={section.id} disabled={sessionIds.every((id) => section.sessions.includes(id))} onSelect={() => runSectionEdit({ kind: "move", sessionIds, sectionId: section.id })}><span className="truncate">{section.emoji} {section.name}</span></Item>)}
      <Item onSelect={() => openDialog({ kind: "create", sessionIds })}><Plus /> New section…</Item>
    </Content>
  </Sub>;
}

export function LocalSidebarSections({ groups, filtered, renderSession }: {
  groups: { section: LocalSection; items: SessionEntry[] }[];
  filtered: boolean;
  renderSession: (session: SessionEntry) => ReactNode;
}) {
  const { error } = useLocalSections();
  return <>
    {groups.map(({ section, items }, index) => (!filtered || items.length > 0) && <Section key={section.id} section={section} sessions={items} index={index} count={groups.length} filtered={filtered} renderSession={renderSession} />)}
    {/* No standing "New section…" row: a section is made from a chat's menu, Move to section → New section…, where there is a chat to put in it. */}
    {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
  </>;
}

function Section({ section, sessions, index, count, filtered, renderSession }: {
  section: LocalSection; sessions: SessionEntry[]; index: number; count: number; filtered: boolean; renderSession: (session: SessionEntry) => ReactNode;
}) {
  const [expanded, toggle] = useFold(`local-section:${section.id}`, true);
  const menu = useRowMenu();
  const open = expanded || filtered;
  return <section aria-label={`${section.name} section`} className="mb-2" data-local-section={section.id}>
    <DropdownMenu {...menu.root}>
      <div className="flex h-7 items-center gap-1" {...menu.surface}>
        <button type="button" aria-expanded={open} onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
          <ChevronDown className={cn("size-3 shrink-0", !open && "-rotate-90")} />
          {section.emoji && <span aria-hidden className="max-w-6 shrink-0 truncate">{section.emoji}</span>}<span className="truncate">{section.name}</span>
        </button>
        <Button variant="ghost" size="icon-xs" aria-label={`New session in ${section.name}`} onClick={() => startSessionInSection(section.id)}><Plus /></Button>
        <DropdownMenuTrigger asChild {...menu.trigger}><Button variant="ghost" size="icon-xs" aria-label={`Menu for section ${section.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
      </div>
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
    {open && (sessions.length ? <ul className="flex flex-col gap-px">{sessions.map(renderSession)}</ul> : <p className="mx-2 rounded-md border border-dashed border-border px-3 py-3 text-xs text-faint">Move sessions here using their menu or ⌘K.</p>)}
  </section>;
}
