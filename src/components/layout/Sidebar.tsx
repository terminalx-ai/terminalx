import { useMemo, useState } from "react";
import { Archive, ChevronDown, FolderPlus, GitFork, PanelLeft, Pin, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { keycaps } from "@/lib/hotkeys";
import {
  addProject,
  archiveSession,
  deleteSession,
  forkSession,
  pinSession,
  selectSession,
  setShowArchived,
  sortSessions,
  useSessionStore,
} from "@/lib/sessions";
import { api, errorMessage } from "@/lib/api";
import { openSettle } from "@/lib/dialogs";
import { sessionStatus, type SessionEntry } from "@/types/session";
import { TITLEBAR_INSET } from "./AppShell";
import { relativeTime } from "@/lib/time";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";

/** Deleting asks first, naming what would be lost with the worktree. */
async function confirmDelete(session: SessionEntry) {
  let detail = "Its transcript and attachments are removed.";
  if (session.worktreeName && !session.worktreeRemoved) {
    try {
      const d = await api.worktreeDisposition(session.id);
      const parts = [];
      if (d.unpushed > 0) parts.push(`${d.unpushed} unpushed commit${d.unpushed === 1 ? "" : "s"}`);
      if (d.uncommitted > 0) parts.push(`${d.uncommitted} uncommitted file${d.uncommitted === 1 ? "" : "s"}`);
      detail = parts.length
        ? `Its worktree has ${parts.join(" and ")}; deleting loses them along with the transcript.`
        : "Its worktree, transcript and attachments are removed.";
    } catch {
      /* ask anyway */
    }
  }
  const yes = await ask(`Delete "${session.title}"? ${detail}`, { title: "Delete session", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" }).catch(() => false);
  if (yes) await deleteSession(session.id, true);
}

export function Sidebar({
  onToggle,
  onOpenSettings,
  onNewSession,
}: {
  onToggle: () => void;
  onOpenSettings: () => void;
  onNewSession: () => void;
}) {
  const store = useSessionStore();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = store.sessions.filter(
      (s) => s.archived === store.showArchived && (!q || s.title.toLowerCase().includes(q)),
    );
    const byProject = new Map<string, SessionEntry[]>();
    for (const s of sortSessions(visible)) {
      const list = byProject.get(s.projectPath) ?? [];
      list.push(s);
      byProject.set(s.projectPath, list);
    }
    const order = store.projects.map((p) => p.path);
    return [...byProject.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }, [store.sessions, store.projects, store.showArchived, query]);

  const pickProject = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Add a project" });
      if (typeof dir === "string") await addProject(dir);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <aside className="flex h-full w-(--sidebar-w) shrink-0 flex-col border-r border-hairline">
      <div
        data-tauri-drag-region="deep"
        className="flex h-(--titlebar-h) shrink-0 items-center justify-end gap-0.5 pr-2"
        style={{ paddingLeft: TITLEBAR_INSET }}
      >
        <WithTooltip label="Settings" keys={keycaps("mod+,")}>
          <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={onOpenSettings}>
            <Settings />
          </Button>
        </WithTooltip>
        <WithTooltip label="Hide sidebar" keys={keycaps("mod+b")}>
          <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={onToggle}>
            <PanelLeft />
          </Button>
        </WithTooltip>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="flex-1 justify-start gap-2 px-2 text-foreground" onClick={onNewSession}>
            <Plus />
            New session
            <span className="ml-auto flex gap-0.5 text-[10px] text-faint">
              {keycaps("mod+n").map((k) => (
                <kbd key={k} className="rounded-sm bg-veil-raised px-1 font-sans">
                  {k}
                </kbd>
              ))}
            </span>
          </Button>
        </div>
        {searching ? (
          <div className="flex items-center gap-1 rounded-md bg-well px-2">
            <Search className="size-3.5 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearching(false);
                }
              }}
              placeholder="Search sessions"
              className="h-7 w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
            <button
              type="button"
              className="text-faint hover:text-foreground"
              onClick={() => {
                setQuery("");
                setSearching(false);
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <Button variant="ghost" className="justify-start gap-2 px-2" onClick={() => setSearching(true)}>
            <Search />
            Search
          </Button>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between px-3">
        <button
          type="button"
          onClick={() => setShowArchived(!store.showArchived)}
          className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-faint hover:text-muted-foreground"
        >
          {store.showArchived ? "Archived" : "Sessions"}
          <ChevronDown className="size-3" />
        </button>
        <WithTooltip label="Add project">
          <Button variant="ghost" size="icon-xs" aria-label="Add project" onClick={pickProject}>
            <FolderPlus />
          </Button>
        </WithTooltip>
      </div>
      {error && <div className="mx-3 mt-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1">
        {groups.length === 0 && (
          <div className="rounded-md px-2 py-6 text-center text-xs text-muted-foreground">
            {store.projects.length === 0 ? (
              <>
                Add a project to start.
                <div className="mt-2">
                  <Button variant="secondary" size="sm" onClick={pickProject}>
                    <FolderPlus /> Add project
                  </Button>
                </div>
              </>
            ) : store.showArchived ? (
              "Nothing archived."
            ) : (
              "No sessions yet. Start one to open a worktree."
            )}
          </div>
        )}
        {groups.map(([projectPath, sessions]) => {
          const project = store.projects.find((p) => p.path === projectPath);
          return (
            <div key={projectPath} className="mb-2">
              <div className="flex items-center px-2 py-1 text-[11px] font-medium text-muted-foreground" title={projectPath}>
                <span className="truncate">{project?.name ?? projectPath.split("/").pop()}</span>
              </div>
              {sessions.map((s) => (
                <SessionRow key={s.id} session={s} selected={store.selectedSessionId === s.id} />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function SessionRow({ session, selected }: { session: SessionEntry; selected: boolean }) {
  const status = sessionStatus(session);
  const harnesses = [...new Set(session.tabs.map((t) => t.harness))];
  return (
    <DropdownMenu>
      <div
        role="button"
        tabIndex={0}
        onClick={() => selectSession(session.id)}
        onKeyDown={(e) => e.key === "Enter" && selectSession(session.id)}
        className={cn(
          "group relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          selected ? "bg-selected" : "hover:bg-selected/50",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full",
            status === "waiting" && "bg-warning",
            status === "completed" && "bg-add",
            status === "in_progress" && "bg-info animate-pulse-soft",
          )}
        />
        <div className="flex -space-x-1">
          {harnesses.map((h) => (
            <AgentMark key={h} id={h} className="size-4 rounded-full bg-background" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {session.pinned && <Pin className="size-3 shrink-0 text-faint" />}
            <span className="truncate text-[13px]">{session.title}</span>
          </div>
          <div className="truncate text-[11px] text-faint">
            {session.branch ?? "no branch"}
            {session.tabs.length > 1 ? ` · ${session.tabs.length} tabs` : ""}
          </div>
        </div>
        <span className="text-[11px] text-faint tabular-nums group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">{relativeTime(session.modified)}</span>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Session menu"
            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => pinSession(session.id, !session.pinned)}>
          <Pin /> {session.pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => archiveSession(session.id, !session.archived)}>
          <Archive /> {session.archived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void forkSession(session.id, session.activeTab ?? session.tabs[0]?.id ?? "")} disabled={!session.tabs.length}>
          <GitFork /> Fork session
        </DropdownMenuItem>
        {session.worktreeName && !session.worktreeRemoved && (
          <DropdownMenuItem onSelect={() => openSettle(session.id)}>
            <X /> Settle worktree…
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => void confirmDelete(session)}>
          <Trash2 /> Delete session…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
