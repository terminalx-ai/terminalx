import { useEffect, useId, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, Ellipsis, Folder, FolderGit2, Pencil, Pin, PinOff, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { AsyncDropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { StatusMarkIcon, rowMeta } from "@/components/ui/SessionStatus";
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { RowTime } from "@/components/layout/SidebarRows";
import { useFold } from "@/components/layout/useFold";
import { sessionStatus as detailedStatus, statusText } from "@terminalx/portable/sessionStatus";
import { manualStatusLabel } from "@terminalx/portable/manualStatus";
import { errorMessage } from "@/lib/api";
import { machineSessionStatus, updateMachineSession, type MachineProjectNode, type MachineSessionRow } from "@/lib/machineCatalog";
import { conversationTime } from "@/lib/messageActivity";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { useReducedMotion } from "@/lib/reducedMotion";
import { selectCloudSession, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import { startMachineSession } from "./machineNewSession";

/**
 * A paired machine's projects in its sidebar section (PRO-346, screen 21.01):
 * each project (folder and name), then its sessions drawn as local session
 * rows are, with the status mark and the PR number or time. A row's menu pins,
 * archives and renames the session on the machine; what only means something
 * on this Mac (Reveal in Finder, local git, sections, drag order) is not
 * offered. While the machine cannot be reached the rows are its last known
 * ones, and changing them waits for it.
 */

/** Which sessions of a project the sidebar shows: archived ones only with Show archived, and what the filter passes. */
export function shownMachineSessions(sessions: readonly MachineSessionRow[], options: { showArchived: boolean; shows: (key: string) => boolean; selectedId: string | null }): MachineSessionRow[] {
  return sessions.filter((row) => (row.archived ? options.showArchived || row.key === options.selectedId : true) && (row.key === options.selectedId || options.shows(row.key)));
}

export function MachineProjectGroup({ node, sessions, reachable, filtered }: { node: MachineProjectNode; sessions: MachineSessionRow[]; reachable: boolean; filtered: boolean }) {
  const store = useSessionStore();
  const reduced = useReducedMotion();
  const [expanded, toggle] = useFold(node.key, true);
  // A filter shows what it found: the project is open while it is on.
  const open = expanded || filtered;
  const name = node.project.name;
  const holdsSelection = sessions.some((row) => row.key === store.selectedSessionId);
  // A selection inside opens the project, as local navigation does.
  useEffect(() => {
    if (holdsSelection && !expanded) setPrefs({ sidebarSections: { ...getPrefs().sidebarSections, [node.key]: "expanded" } });
  }, [holdsSelection, store.navigationVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const Glyph = node.project.kind === "git" ? FolderGit2 : Folder;
  return (
    <div role="group" aria-label={name} data-testid="machine-project" data-project={node.key}>
      <div className={cn(actionRow, "relative flex h-7 min-w-0 items-center gap-2 rounded-md px-2 hover:bg-selected/50")} title={node.project.path}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="relative size-4 shrink-0">
            <span className={cn("absolute inset-0 transition-opacity duration-150", open ? "group-hover/row:opacity-0 group-focus-within/row:opacity-0" : "opacity-0")} aria-hidden>
              <Glyph className="size-4 text-faint" />
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                "absolute inset-0 size-4 text-muted-foreground transition-[opacity,transform] duration-200",
                open ? "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100" : "-rotate-90 opacity-100",
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{name}</span>
        </button>
        <RowActions persistent>
          <WithTooltip label={`New session in ${name}`}>
            <Button variant="ghost" size="icon-xs" aria-label={`New session in ${name}`} onClick={() => startMachineSession(node.machineId, node.project.projectId)}>
              <Plus />
            </Button>
          </WithTooltip>
        </RowActions>
      </div>
      <div
        className={cn("grid", !reduced && "transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {sessions.length > 0 && (
            <ul className="flex flex-col gap-px" data-testid="machine-project-sessions">
              {sessions.map((row) => (
                <MachineSessionItem key={row.key} row={row} reachable={reachable} selected={store.selectedSessionId === row.key} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A session on a machine, as a local row: its status mark, its name, and the
 * open PR's number or when it was last active (PRO-159: a mark and metadata,
 * no status label).
 */
export function MachineSessionItem({ row, reachable, selected }: { row: MachineSessionRow; reachable: boolean; selected: boolean }) {
  const statusDescriptionId = useId();
  const status = detailedStatus(row.rowStatus ?? { tabs: [{ status: machineSessionStatus(row) }] });
  const meta = rowMeta(status, { additions: 0, deletions: 0 });
  const unread = row.tabs.some((tab) => tab.unread);
  const menu = useRowMenu();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const commitRename = () => {
    setRenaming(false);
    const next = title.trim();
    if (next && next !== row.title) void act(() => updateMachineSession(row.key, { title: next }));
  };
  const why = reachable ? undefined : "The machine is not connected";
  return (
    <li>
      <div
        className={cn(actionRow, "relative flex h-8 items-center gap-2 rounded-md pl-2 pr-1", selected ? "bg-selected text-foreground" : "text-foreground/85 hover:bg-selected/50")}
        title={row.branch ? `${row.branch} · ${row.title}` : row.title}
        data-testid="machine-session-row"
        data-session={row.key}
        data-status={status.id}
        {...menu.surface}
      >
        {renaming ? (
          <input
            autoFocus
            value={title}
            aria-label="Session name"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setTitle(row.title);
                setRenaming(false);
              }
              event.stopPropagation();
            }}
            className="h-6 min-w-0 flex-1 rounded-sm bg-well px-1.5 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
          />
        ) : (
          <button
            type="button"
            onClick={() => selectCloudSession(row.key)}
            aria-describedby={statusDescriptionId}
            aria-current={selected ? "true" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <StatusMarkIcon status={status} decorative />
            <span id={statusDescriptionId} hidden>
              {statusText(status)}. Status: {manualStatusLabel(row.manualStatus)}
            </span>
            {row.pinned && <Pin className="size-3 shrink-0 text-faint" aria-label="Pinned" />}
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", row.archived && "text-faint")}>{row.title}</span>
            {row.archived && <span className="shrink-0 text-[10px] text-faint">archived</span>}
            {unread && <span role="img" aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-info" />}
            {meta.kind === "pr" ? (
              <span data-row-meta="pr" className={cn("shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground", yieldsToRowActions)}>
                PR #{meta.number}
              </span>
            ) : (
              <span data-row-meta="time" className="font-mono text-[11px]">
                <RowTime at={conversationTime(row)} />
              </span>
            )}
          </button>
        )}
        {!renaming && (
          <RowActions persistent className={menu.open ? "not-sr-only" : undefined}>
            <AsyncDropdownMenu {...menu.root}>
              <DropdownMenuTrigger asChild {...menu.trigger}>
                <Button variant="ghost" size="icon-xs" aria-label={`Session menu for ${row.title}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  disabled={!reachable}
                  title={why}
                  onSelect={() => {
                    setTitle(row.title);
                    setRenaming(true);
                  }}
                >
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!reachable} title={why} onSelect={() => void act(() => updateMachineSession(row.key, { pinned: !row.pinned }))}>
                  {row.pinned ? <PinOff /> : <Pin />} {row.pinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!reachable} title={why} onSelect={() => void act(() => updateMachineSession(row.key, { archived: !row.archived }))}>
                  {row.archived ? <ArchiveRestore /> : <Archive />} {row.archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </AsyncDropdownMenu>
          </RowActions>
        )}
      </div>
      {error && <p className="ml-2 text-[10px] text-destructive">{error}</p>}
    </li>
  );
}
