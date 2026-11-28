import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { archiveWithUndo } from "@/lib/archiveNotices";
import { Archive, Pencil } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DiffStats, RowTime } from "./SidebarRows";
import { yieldsToRowActions } from "./RowActions";
import { rowMeta } from "@/components/ui/SessionStatus";
import type { StatusDescription } from "@terminalx/portable/sessionStatus";
import { cn } from "@/lib/cn";
import { getDraft, subscribeTabDrafts } from "@/lib/drafts";
import { pty } from "@/lib/api";
import { refreshWorkspaces, useSessionStore } from "@/lib/sessions";
import { useTerminals } from "@/lib/terminal";
import { usePrefs } from "@/lib/prefs";
import type { SessionEntry, Workspace } from "@/types/session";

const RunningSessions = createContext<{ commands: ReadonlySet<string>; ports: ReadonlySet<string> }>({ commands: new Set(), ports: new Set() });

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

const workspaceByPathCache = new WeakMap<Record<string, Workspace[]>, Map<string, Workspace>>();
function getWorkspaceByPath(workspaces: Record<string, Workspace[]>): Map<string, Workspace> {
  let map = workspaceByPathCache.get(workspaces);
  if (!map) {
    map = new Map();
    for (const list of Object.values(workspaces)) {
      for (const workspace of list) {
        const key = workspace.path.replace(/\/+$/, "");
        if (!map.has(key)) map.set(key, workspace);
      }
    }
    workspaceByPathCache.set(workspaces, map);
  }
  return map;
}

/** One batch for the sidebar, independent of which conversation is open. */
export function SessionRowData({ children }: { children: ReactNode }) {
  const store = useSessionStore();
  const { panes } = useTerminals();
  const [running, setRunning] = useState({ commands: new Set<string>(), ports: new Set<string>() });
  const projects = JSON.stringify([...new Set(store.sessions.filter((s) => !s.archived && !s.worktreeRemoved && s.kind !== "quick").map((s) => s.projectPath))].sort());
  useEffect(() => {
    for (const path of JSON.parse(projects) as string[]) void refreshWorkspaces(path);
  }, [projects]);
  const shells = JSON.stringify(panes.filter((pane) => !pane.owned && !pane.exited).map((pane) => [pane.id, pane.sessionId]));
  const directories = JSON.stringify(store.sessions.filter((session) => !session.archived && !session.worktreeRemoved).map(({ id, cwd }) => ({ id, cwd })).sort((a, b) => a.id.localeCompare(b.id)));
  useEffect(() => {
    const entries = JSON.parse(shells) as [string, string][];
    const sessions = JSON.parse(directories) as Pick<SessionEntry, "id" | "cwd">[];
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const [commands, ports] = await Promise.all([
          entries.length ? pty.busy(entries.map(([id]) => id)) : [],
          pty.listeningSessions(sessions).catch(() => []),
        ]);
        const busy = new Set(commands);
        const nextCommands = new Set(entries.filter(([id]) => busy.has(id)).map(([, session]) => session));
        const nextPorts = new Set(ports);
        if (live) {
          setRunning((prev) => (setsEqual(prev.commands, nextCommands) && setsEqual(prev.ports, nextPorts) ? prev : { commands: nextCommands, ports: nextPorts }));
        }
      } catch { /* Keep the last successful observation until the next poll. */ }
      finally { reading = false; }
    };
    void read();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void read();
    };
    const timer = window.setInterval(() => void read(), 5_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [shells, directories]);
  return <RunningSessions.Provider value={running}>{children}</RunningSessions.Provider>;
}

export function useSessionDraft(sessions: readonly SessionEntry[]): string {
  return useSyncExternalStore(
    (changed) => subscribeTabDrafts(sessions.flatMap((session) => session.tabs.map((tab) => tab.id)), changed),
    () => {
      for (const session of sessions) {
        const active = getDraft(session.activeTab ?? "");
        if (active.trim()) return active.replace(/\s+/g, " ").trim();
        for (const tab of session.tabs) {
          const draft = getDraft(tab.id);
          if (draft.trim()) return draft.replace(/\s+/g, " ").trim();
        }
      }
      return "";
    },
    () => "",
  );
}

/** A row's unsent composer text, led by a pencil named "Draft" (for screen readers and as its tooltip) in the line's own faint colour. */
export function DraftPreview({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span className="flex min-w-0 w-full items-center gap-1 text-[11px] text-faint" data-testid="row-draft">
      <span role="img" aria-label="Draft" title="Draft" className="inline-flex shrink-0"><Pencil aria-hidden className="size-3" /></span>
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

/**
 * What follows a row's title: its line counts and live-process dot. Given the
 * row's `status`, the first is the one item 02.04 draws there instead: the
 * open PR's number, the line counts, or the time since `at` (see `rowMeta`).
 */
export function SessionRowExtras({ sessions, selected, status, at }: { sessions: readonly SessionEntry[]; selected: boolean; status?: StatusDescription; at?: string }) {
  const { workspaces } = useSessionStore();
  const { colourLineCounts } = usePrefs();
  const running = useContext(RunningSessions);
  const byPath = getWorkspaceByPath(workspaces);
  const seen = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const s of sessions) {
    if (s.worktreeRemoved) continue;
    const path = s.cwd.replace(/\/+$/, "");
    if (seen.has(path)) continue;
    seen.add(path);
    const workspace = byPath.get(path);
    if (!workspace) continue;
    additions += workspace.branchAdditions ?? workspace.additions;
    deletions += workspace.branchDeletions ?? workspace.deletions;
  }
  const command = sessions.some((session) => running.commands.has(session.id));
  const port = sessions.some((session) => running.ports.has(session.id));
  const activity = command && port ? "Running command and open port" : port ? "Open port" : "Running command";
  const meta = status ? rowMeta(status, { additions, deletions }) : { kind: "lines" as const };
  return <>
    {meta.kind === "pr" ? <span data-row-meta="pr" className={cn("shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground", yieldsToRowActions)}>PR #{meta.number}</span>
      : meta.kind === "time" ? (at ? <span data-row-meta="time" className="font-mono text-[12px]"><RowTime at={at} className="text-[12px]" /></span> : null)
      : <span data-row-meta="lines" className="font-mono text-[12px]"><DiffStats additions={additions} deletions={deletions} unpushed={0} coloured={colourLineCounts || selected} /></span>}
    {(command || port) && <span role="img" aria-label={activity} title={activity} className="size-1.5 shrink-0 rounded-full bg-add" />}
  </>;
}

export function ArchiveRowButton({ session, title }: { session: SessionEntry; title: string }) {
  const [error, setError] = useState<string | null>(null);
  if (session.archived) return null;
  return <WithTooltip label={error ?? "Archive"} shortcut="session.archive">
    <Button variant="ghost" size="icon-xs" aria-label={`Archive ${title}`} onClick={() => {
      void archiveWithUndo(session.id).catch(() => setError("Could not archive. Try again."));
    }}><Archive /></Button>
  </WithTooltip>;
}
