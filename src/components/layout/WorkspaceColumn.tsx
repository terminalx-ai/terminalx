import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowUp, CalendarClock, ChevronDown, FolderOpen, GitBranch, GitFork, Pin, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { AgentMark } from "@/components/AgentMark";
import { FileTreeView } from "@/components/files/FileTreeView";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { api, errorMessage } from "@/lib/api";
import { openSettle, openWorkspaceDelete } from "@/lib/dialogs";
import {
  archiveSession,
  deleteSession,
  forkSession,
  pinSession,
  openAutomations,
  refreshWorkspaces,
  selectSession,
  sortSessions,
  startSessionIn,
  useSessionStore,
} from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import { sessionStatus, type SessionEntry, type Workspace } from "@/types/session";

/**
 * The second column: one project's checkouts, each with the sessions that
 * run in it. A workspace with no sessions still shows, so a worktree made
 * outside the app is a place to start rather than a mystery. The Explorer
 * tab browses whichever workspace is in focus.
 */
export function WorkspaceColumn({ projectPath, onNewSession }: { projectPath: string; onNewSession: () => void }) {
  const store = useSessionStore();
  const project = store.projects.find((p) => p.path === projectPath);
  const [tab, setTab] = useState<"sessions" | "explorer">("sessions");
  const [query, setQuery] = useState("");
  const workspaces = store.workspaces[projectPath] ?? [];
  const loading = !!store.workspacesLoading[projectPath];
  const selected = store.sessions.find((s) => s.id === store.selectedSessionId);

  useEffect(() => {
    if (!store.workspaces[projectPath]) void refreshWorkspaces(projectPath);
  }, [projectPath, store.workspaces]);

  useEffect(() => {
    if (store.sessionSearch) setQuery("");
  }, [store.sessionSearch]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sessions = sortSessions(store.sessions.filter((s) => s.projectPath === projectPath && s.archived === store.showArchived && (!q || s.title.toLowerCase().includes(q))));
    const canon = (p: string) => p.replace(/\/+$/, "");
    const byPath = new Map<string, SessionEntry[]>();
    for (const s of sessions) {
      const key = canon(s.cwd);
      byPath.set(key, [...(byPath.get(key) ?? []), s]);
    }
    const known = new Set(workspaces.map((w) => canon(w.path)));
    const rows: { ws: Workspace | null; key: string; sessions: SessionEntry[] }[] = workspaces.map((w) => ({ ws: w, key: canon(w.path), sessions: byPath.get(canon(w.path)) ?? [] }));
    // Sessions whose checkout is gone still need a home in the list.
    for (const [key, list] of byPath) if (!known.has(key)) rows.push({ ws: null, key, sessions: list });
    return q ? rows.filter((r) => r.sessions.length) : rows;
  }, [store.sessions, store.showArchived, projectPath, workspaces, query]);

  const explorerRoot = selected?.projectPath === projectPath ? selected.cwd : (workspaces.find((w) => w.isMain)?.path ?? projectPath);
  const explorerName = workspaces.find((w) => w.path === explorerRoot)?.name ?? project?.name ?? "project";

  return (
    <div className="flex h-full w-(--column-w) shrink-0 flex-col border-r border-hairline">
      <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={projectPath}>
          {project?.name ?? "Project"}
        </span>
        <WithTooltip label="Refresh workspaces">
          <Button variant="ghost" size="icon-xs" aria-label="Refresh workspaces" onClick={() => void refreshWorkspaces(projectPath)}>
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
        </WithTooltip>
        <WithTooltip label="New session">
          <Button variant="ghost" size="icon-xs" aria-label="New session" onClick={onNewSession}>
            <Plus />
          </Button>
        </WithTooltip>
      </div>

      <div className="mx-2 mb-1 flex gap-0.5 rounded-md bg-well p-0.5">
        {(["sessions", "explorer"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn("flex-1 rounded-[5px] py-1 text-xs capitalize", tab === t ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground")}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "sessions" ? (
        <>
          <div className="mx-2 mb-1 flex items-center gap-1 rounded-md bg-well px-2">
            <Search className="size-3.5 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search sessions"
              data-session-search
              className="h-7 w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
            {query && (
              <button type="button" className="text-faint hover:text-foreground" onClick={() => setQuery("")}>
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
            {groups.length === 0 && (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">{loading ? "Reading workspaces…" : query ? "No sessions match." : "No workspaces found."}</div>
            )}
            {groups.map((g) => (
              <WorkspaceGroup key={g.key} projectPath={projectPath} ws={g.ws} path={g.key} sessions={g.sessions} selectedId={store.selectedSessionId} />
            ))}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1">
          <FileTreeView sessionId={selected?.projectPath === projectPath ? selected.id : `project:${projectPath}`} root={explorerRoot} rootName={explorerName} active mentionTabId={selected?.activeTab ?? null} />
        </div>
      )}
    </div>
  );
}

function WorkspaceGroup({
  projectPath,
  ws,
  path,
  sessions,
  selectedId,
}: {
  projectPath: string;
  ws: Workspace | null;
  path: string;
  sessions: SessionEntry[];
  selectedId: string | null;
}) {
  const [open, setOpen] = useState(true);
  const name = ws?.name ?? path.split("/").pop() ?? path;
  const kind = ws ? (ws.isMain ? "main" : ws.managed ? "" : "external") : "missing";
  return (
    <div className="mb-1.5">
      <div className="group/ws relative flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-selected/40" title={path}>
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform", !open && "-rotate-90")} />
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate font-mono text-foreground/90">{ws?.branch ?? name}</span>
          {kind && <span className="shrink-0 rounded-sm bg-veil-raised px-1 text-[10px] text-faint">{kind}</span>}
        </button>
        {ws && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums group-hover/ws:opacity-0 group-has-[[data-state=open]]/ws:opacity-0">
            {ws.additions > 0 && <span className="text-add">+{ws.additions}</span>}
            {ws.deletions > 0 && <span className="text-destructive">−{ws.deletions}</span>}
            {ws.unpushed > 0 && (
              <span className="flex items-center text-warning" title={`${ws.unpushed} unpushed commit${ws.unpushed === 1 ? "" : "s"}`}>
                <ArrowUp className="size-3" />
                {ws.unpushed}
              </span>
            )}
          </span>
        )}
        {ws && (
          <span className="absolute right-1 flex items-center opacity-0 group-hover/ws:opacity-100 has-[[data-state=open]]:opacity-100">
            <WithTooltip label="New session here">
              <Button variant="ghost" size="icon-xs" aria-label="New session in this workspace" onClick={() => startSessionIn(projectPath, ws.path)}>
                <Plus />
              </Button>
            </WithTooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Workspace menu">
                  <span className="text-[13px] leading-none">…</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void revealItemInDir(ws.path)}>
                  <FolderOpen /> Reveal in Finder
                </DropdownMenuItem>
                {!ws.isMain && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => openWorkspaceDelete(projectPath, ws.path, name)}>
                      <Trash2 /> Delete workspace…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </div>
      {open && sessions.map((s) => <SessionRow key={s.id} session={s} selected={selectedId === s.id} />)}
      {open && !sessions.length && ws?.isMain && <div className="px-6 py-1 text-[11px] text-faint">No sessions yet. Press + on a workspace to start one.</div>}
    </div>
  );
}

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
  if (yes) {
    try {
      await deleteSession(session.id, true);
    } catch (e) {
      console.error(errorMessage(e));
    }
  }
}

export function SessionRow({ session, selected }: { session: SessionEntry; selected: boolean }) {
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
          "group relative ml-3 flex cursor-default items-center gap-2 rounded-md py-1 pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
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
          {session.automation ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openAutomations();
              }}
              className="flex max-w-full items-center gap-1 truncate text-[11px] text-faint hover:text-muted-foreground"
            >
              <CalendarClock className="size-3 shrink-0" />
              <span className="truncate">Automation · {session.automation.name} #{session.automation.runNumber}</span>
            </button>
          ) : session.tabs.length > 1 ? (
            <div className="truncate text-[11px] text-faint">{session.tabs.length} tabs</div>
          ) : null}
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
