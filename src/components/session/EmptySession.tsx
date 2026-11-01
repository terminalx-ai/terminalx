import { useCallback, useRef, useState } from "react";
import { ChevronDown, Loader2, Plus, RotateCcw } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyView } from "@/components/start/EmptyView";
import { errorMessage } from "@/lib/api";
import { useShortcut } from "@/lib/hotkeys";
import { useSessionStore } from "@/lib/sessions";
import { keycaps, useKeymap } from "@/lib/shortcuts";
import { reopenClosedAgentTab } from "@/lib/tabActions";
import { tabLabel } from "@/lib/tabFront";
import { closedTabsOf, useTabState } from "@/lib/tabLayouts";
import { relativeTime } from "@/lib/time";
import type { SessionEntry } from "@/types/session";
import { LocalNewTabItems } from "./TabStrip";

/** When a tab was closed, in words: "just now", "5m ago", "on Oct 30". */
function closedWhen(iso: string): string {
  const when = relativeTime(iso);
  if (!when) return "earlier";
  if (when === "now") return "just now";
  return /^\d+[mhd]$/.test(when) ? `${when} ago` : `on ${when}`;
}

/**
 * A local session with no tabs open: its own page (#721). Opening a session
 * shows that session, never another one in the same folder, so this is where
 * one whose tabs were all closed is reached again: its closed tabs, newest
 * first, each reopened on its conversation in this session; a new tab; and
 * "Reopen closed tab", the action welcome keeps after the last tab closes.
 *
 * Everything here is this session's own: Reopen closed tab, and ⌘⌥T while
 * the page is shown, bring back this session's newest closed tab, never a
 * sibling's from the branch's row of tabs (which ⌘⌥T reopens elsewhere).
 */
export function EmptySession({ session }: { session: SessionEntry }) {
  const store = useSessionStore();
  const saved = useTabState();
  const keymap = useKeymap();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closed = closedTabsOf(saved, [session.id]).sort((a, b) => (Date.parse(b.closedAt) || 0) - (Date.parse(a.closedAt) || 0));
  const agentName = (harness: string) => store.harnesses.find((candidate) => candidate.id === harness)?.name ?? harness;
  // Read when a key is pressed: the binding is made once.
  const now = useRef({ busy, newest: closed[0]?.tab.id ?? null });
  now.current = { busy, newest: closed[0]?.tab.id ?? null };
  const run = useCallback((key: string, work: () => Promise<unknown>) => {
    if (now.current.busy) return;
    now.current.busy = key;
    setBusy(key);
    setError(null);
    void work()
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(null));
  }, []);
  const reopen = useCallback((tabId: string) => run(tabId, () => reopenClosedAgentTab(session.id, tabId)), [run, session.id]);
  // Ahead of the row's own ⌘⌥T; with nothing of this session's to bring back, the row's handles it.
  useShortcut("session.reopenTab", useCallback(() => {
    const { newest } = now.current;
    if (!newest) return false;
    reopen(newest);
  }, [reopen]), { priority: 1 });
  const reopenKeys = keymap["session.reopenTab"][0];
  return (
    <EmptyView
      title="No tabs open"
      guidance={closed.length ? "Its agents are stopped. Reopen a closed tab to resume its conversation here, or open a new tab." : "Open an agent, a terminal or a browser tab in this session."}
    >
      <div className="mt-5 flex flex-wrap justify-center gap-2" data-testid="empty-session">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="accent" size="sm">
              <Plus aria-hidden /> New tab <ChevronDown aria-hidden className="opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <LocalNewTabItems session={session} />
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="secondary" size="sm" disabled={!!busy || !closed.length} onClick={() => closed.length && reopen(closed[0].tab.id)}>
          <RotateCcw aria-hidden /> Reopen closed tab
          {reopenKeys ? (
            <span className="ml-1 flex gap-0.5" aria-hidden>
              {keycaps(reopenKeys).map((cap, index) => (
                <kbd key={index} className="rounded border border-hairline bg-veil-card px-1 font-sans text-[10px] text-muted-foreground">{cap}</kbd>
              ))}
            </span>
          ) : null}
        </Button>
      </div>
      {error && <p role="alert" className="mt-3 text-center text-sm text-destructive">{error}</p>}
      {closed.length > 0 && (
        <section aria-labelledby={`closed-tabs-${session.id}`} className="mt-8">
          <h3 id={`closed-tabs-${session.id}`} className="mb-2 text-xs font-medium text-muted-foreground">Closed tabs</h3>
          <ul className="flex flex-col gap-1">
            {closed.map(({ tab, closedAt }) => {
              const label = tabLabel(tab, agentName);
              return (
                <li key={tab.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hairline">
                  <AgentMark id={tab.harness} className="size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground" title={label}>{label}</div>
                    <div className="truncate text-[11px] text-faint">
                      {agentName(tab.harness)} · closed {closedWhen(closedAt)}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" aria-label={`Reopen ${label}`} disabled={!!busy} onClick={() => reopen(tab.id)}>
                    {busy === tab.id ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />} Reopen
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </EmptyView>
  );
}
