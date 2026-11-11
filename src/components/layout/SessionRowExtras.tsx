import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Archive } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DiffStats, RowTime } from "./SidebarRows";
import { yieldsToRowActions } from "./RowActions";
import { rowMeta } from "@/components/ui/SessionStatus";
import type { StatusDescription } from "@terminalx/portable/sessionStatus";
import { cn } from "@/lib/cn";
import { getDraft, subscribeTabDrafts } from "@/lib/drafts";
import { pty } from "@/lib/api";
import { archiveSession, conversationTitle, refreshWorkspaces, useSessionStore } from "@/lib/sessions";
import { useTerminals } from "@/lib/terminal";
import { usePrefs } from "@/lib/prefs";
import { isPlaceholderBranch } from "@/lib/worktreeNames";
import type { SessionEntry } from "@/types/session";

const RunningSessions = createContext<{ commands: ReadonlySet<string>; ports: ReadonlySet<string> }>({ commands: new Set(), ports: new Set() });

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
        if (live) setRunning({ commands: new Set(entries.filter(([id]) => busy.has(id)).map(([, session]) => session)), ports: new Set(ports) });
      } catch { /* Keep the last successful observation until the next poll. */ }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [shells, directories]);
  return <RunningSessions.Provider value={running}>{children}</RunningSessions.Provider>;
}

/** Generated branch names and main checkouts say nothing about the task. */
export function readableBranchName(branch?: string | null): string | null {
  if (!branch || /^(main|master|develop|trunk|HEAD)$/.test(branch) || isPlaceholderBranch(branch)) return null;
  return branch.replace(/^[^/]+\//, "").replace(/[-_/]+/g, " ").trim() || null;
}

/** Shared checkouts keep distinct conversation names; isolated workspaces may use their branch. */
export function sidebarConversationTitle(session: SessionEntry, branch?: string | null, sessions: readonly SessionEntry[] = []): string {
  const tab = session.tabs.find((entry) => entry.id === session.activeTab) ?? session.tabs[0];
  const shared = !session.worktreeName || sessions.some((peer) => peer.id !== session.id && peer.cwd.replace(/\/+$/, "") === session.cwd.replace(/\/+$/, "") && !peer.archived && !peer.worktreeRemoved);
  if (tab?.titlePinned || session.worktreeRemoved || shared) return conversationTitle(session);
  return readableBranchName(branch) || conversationTitle(session);
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

export function DraftPreview({ text }: { text: string }) {
  return text ? <span className="block min-w-0 w-full truncate text-[11px] text-faint" data-testid="row-draft"><span className="text-warning">Draft:</span> {text}</span> : null;
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
  const paths = new Set(sessions.filter((s) => !s.worktreeRemoved).map((s) => s.cwd.replace(/\/+$/, "")));
  const seen = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const workspace of Object.values(workspaces).flat()) {
    const path = workspace.path.replace(/\/+$/, "");
    if (!paths.has(path) || seen.has(path)) continue;
    seen.add(path);
    additions += workspace.branchAdditions ?? workspace.additions;
    deletions += workspace.branchDeletions ?? workspace.deletions;
  }
  const command = sessions.some((session) => running.commands.has(session.id));
  const port = sessions.some((session) => running.ports.has(session.id));
  const activity = command && port ? "Running command and open port" : port ? "Open port" : "Running command";
  const meta = status ? rowMeta(status, { additions, deletions }) : { kind: "lines" as const };
  return <>
    {meta.kind === "pr" ? <span data-row-meta="pr" className={cn("shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground", yieldsToRowActions)}>PR #{meta.number}</span>
      : meta.kind === "time" ? (at ? <span data-row-meta="time" className="font-mono text-[11px]"><RowTime at={at} /></span> : null)
      : <span data-row-meta="lines" className={status ? "font-mono text-[11px]" : "text-[10px]"}><DiffStats additions={additions} deletions={deletions} unpushed={0} coloured={colourLineCounts || selected} /></span>}
    {(command || port) && <span role="img" aria-label={activity} title={activity} className="size-1.5 shrink-0 rounded-full bg-add" />}
  </>;
}

export function ArchiveRowButton({ session, title }: { session: SessionEntry; title: string }) {
  const [error, setError] = useState<string | null>(null);
  if (session.archived) return null;
  return <WithTooltip label={error ?? "Archive"} shortcut="session.archive">
    <Button variant="ghost" size="icon-xs" aria-label={`Archive ${title}`} onClick={() => {
      void archiveSession(session.id, true).catch(() => setError("Could not archive. Try again."));
    }}><Archive /></Button>
  </WithTooltip>;
}
