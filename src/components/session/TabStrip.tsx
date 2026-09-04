import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleStop, Lock, Plus, Sparkles, TerminalSquare, X } from "lucide-react";
import { useTabViews } from "@/lib/tabViews";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { addTab, openSkills, removeTab, setActiveTab, useSessionStore } from "@/lib/sessions";
import { skills as skillsApi } from "@/lib/api";
import { getPrefs } from "@/lib/prefs";
import { closeEditor, useEditors } from "@/lib/editors";
import { useMobileDrivenTabs } from "@/lib/mobileDriver";
import {
  closeTerminal,
  openTerminal,
  setActiveTerminal,
  setSelectedAgent,
  useTerminals,
  type SelectedSessionTab,
  type TerminalPane,
} from "@/lib/terminal";
import type { SessionEntry, TabEntry } from "@/types/session";
import type { DiscoveredSkill } from "@/types/skills";

type PeerTab =
  | { kind: "agent"; id: string; created: string; tab: TabEntry }
  | { kind: "terminal"; id: string; created: string; pane: TerminalPane };

function tabId(item: Pick<PeerTab, "kind" | "id">) {
  return `session-${item.kind}-tab-${encodeURIComponent(item.id)}`;
}

export function tabPanelId(item: Pick<PeerTab, "kind" | "id">) {
  return `session-${item.kind}-panel-${encodeURIComponent(item.id)}`;
}

function peerOrder(agents: TabEntry[], terminals: TerminalPane[]): PeerTab[] {
  return [
    ...agents.map((tab): PeerTab => ({ kind: "agent", id: tab.id, created: tab.created, tab })),
    ...terminals.map((pane): PeerTab => ({ kind: "terminal", id: pane.id, created: pane.created, pane })),
  ].sort((a, b) => a.created.localeCompare(b.created));
}

/**
 * Agent conversations and independent shells in creation order. Command-T
 * opens the agent picker; Command-J activates a shell. Command-Shift-[ and ]
 * cycle through this exact mixed order, wrapping at either end.
 */
export function TabStrip({ session, selected }: { session: SessionEntry; selected: SelectedSessionTab | null }) {
  const store = useSessionStore();
  const { panes } = useTerminals();
  const terminals = useMemo(() => panes.filter((pane) => pane.sessionId === session.id && !pane.hidden), [panes, session.id]);
  const tabViews = useTabViews();
  const ed = useEditors();
  const hasEditors = ed.editors.some((e) => e.sessionId === session.id);
  const activeEditor = ed.active[session.id] ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reachableSkills, setReachableSkills] = useState<DiscoveredSkill[]>([]);
  const mobileDriven = useMobileDrivenTabs();
  const tabs = useMemo(() => peerOrder(session.tabs, terminals), [session.tabs, terminals]);
  const selectedKey = selected ? `${selected.kind}:${selected.id}` : "";
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    skillsApi
      .list(session.cwd)
      .then((rows) => live && setReachableSkills(rows))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session.cwd]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedKey]);

  const activate = useCallback(
    (item: Pick<PeerTab, "kind" | "id">) => {
      if (item.kind === "agent") {
        setSelectedAgent(session.id, item.id);
        void setActiveTab(session.id, item.id);
      } else {
        setActiveTerminal(session.id, item.id);
      }
    },
    [session.id],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (tabs.length < 2) return;
      const current = tabs.findIndex((item) => `${item.kind}:${item.id}` === selectedKey);
      const nextIndex = current < 0 ? (dir === 1 ? 0 : tabs.length - 1) : (current + dir + tabs.length) % tabs.length;
      activate(tabs[nextIndex]);
    },
    [activate, selectedKey, tabs],
  );

  const closePeer = useCallback(
    async (item: PeerTab) => {
      const index = tabs.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id);
      const remaining = tabs.filter((candidate) => candidate !== item);
      const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      if (item.kind === "agent") await removeTab(session.id, item.id);
      else await closeTerminal(item.id);
      if (selected?.kind === item.kind && selected.id === item.id && next) activate(next);
    },
    [activate, selected, session.id, tabs],
  );

  // Command-W closes whichever surface was used last: an editor file or the
  // selected peer tab. A shell close never reaches an agent-owned PTY.
  const closeActive = useCallback(() => {
    if (ed.lastFocused === "editor" && hasEditors && activeEditor) {
      void closeEditor(activeEditor);
      return;
    }
    const active = tabs.find((item) => `${item.kind}:${item.id}` === selectedKey);
    if (active) void closePeer(active);
  }, [activeEditor, closePeer, ed.lastFocused, hasEditors, selectedKey, tabs]);

  const addAgent = useCallback(
    async (harness: string) => {
      const prefs = getPrefs();
      const tab = await addTab(session.id, harness, prefs.lastModel[harness] ?? "", prefs.lastEffort[harness] ?? null, prefs.lastMode);
      setSelectedAgent(session.id, tab.id);
    },
    [session.id],
  );

  useHotkey("mod+t", () => setPickerOpen(true));
  useHotkey("mod+w", closeActive);
  useHotkey("mod+shift+]", () => step(1));
  useHotkey("mod+shift+[", () => step(-1));

  const onTabKeyDown = (event: React.KeyboardEvent, item: PeerTab) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(item);
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const index = tabs.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      document.getElementById(tabId(next))?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      document.getElementById(tabId(tabs[event.key === "Home" ? 0 : tabs.length - 1]))?.focus();
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-0.5 rounded-md bg-well p-0.5">
      <div
        role="tablist"
        aria-label="Session tabs"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((item) => {
          const active = item.kind === selected?.kind && item.id === selected.id;
          if (item.kind === "terminal") {
            const { pane } = item;
            return (
              <div
                key={`terminal:${pane.id}`}
                ref={active ? selectedRef : undefined}
                id={tabId(item)}
                role="tab"
                aria-selected={active}
                aria-controls={tabPanelId(item)}
                aria-label={`${pane.title}${pane.exited ? ", exited" : ""}`}
                tabIndex={active ? 0 : -1}
                onClick={() => activate(item)}
                onKeyDown={(event) => onTabKeyDown(event, item)}
                onAuxClick={(event) => event.button === 1 && void closePeer(item)}
                className={cn(
                  "group/tab relative flex h-6 min-w-24 shrink-0 items-center gap-1.5 rounded-[5px] pl-2 pr-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  active ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("absolute left-0.5 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full", pane.exited ? "bg-faint" : "bg-info")} />
                {pane.exited ? <CircleStop className="size-3.5 shrink-0 text-faint" /> : <TerminalSquare className="size-3.5 shrink-0" />}
                <span className={cn("max-w-[9rem] truncate", pane.exited && "text-faint line-through")}>{pane.title}</span>
                <button
                  type="button"
                  aria-label={`Close ${pane.title} terminal tab`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closePeer(item);
                  }}
                  className="ml-0.5 rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          }

          const { tab } = item;
          const name = tab.title ?? store.harnesses.find((h) => h.id === tab.harness)?.name ?? tab.harness;
          const skillCount = reachableSkills.filter((skill) => skill.agents.includes(tab.harness)).length;
          return (
            <ContextMenu key={`agent:${tab.id}`}>
              <ContextMenuTrigger asChild>
                <div
                  ref={active ? selectedRef : undefined}
                  id={tabId(item)}
                  role="tab"
                  aria-selected={active}
                  aria-controls={tabPanelId(item)}
                  aria-label={name}
                  tabIndex={active ? 0 : -1}
                  onClick={() => activate(item)}
                  onKeyDown={(event) => onTabKeyDown(event, item)}
                  onAuxClick={(event) => event.button === 1 && void closePeer(item)}
                  className={cn(
                    "group/tab relative flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-[5px] pl-2 pr-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    active ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "absolute left-0.5 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full",
                      tab.status === "waiting" && "bg-warning",
                      tab.status === "in_progress" && "bg-info animate-pulse-soft",
                      tab.status === "completed" && "bg-add",
                    )}
                  />
                  <AgentMark id={tab.harness} className="size-3.5 shrink-0" />
                  <span className="max-w-[9rem] truncate">{name}</span>
                  {mobileDriven.has(tab.id) && <Lock className="size-3 shrink-0 text-warning" aria-label="Mobile is driving this terminal" />}
                  {tabViews.views[tab.id] === "terminal" && <TerminalSquare className="size-3 shrink-0 text-faint" aria-label="In terminal view" />}
                  <button
                    type="button"
                    aria-label={`Close ${name} agent tab`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closePeer(item);
                    }}
                    className="ml-0.5 rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => openSkills({ agent: tab.harness, projectPath: session.cwd })}>
                  <Sparkles /> {skillCount} {skillCount === 1 ? "skill" : "skills"} for this tab
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <WithTooltip label="New terminal">
        <Button variant="ghost" size="icon-xs" aria-label="New terminal" className="shrink-0" onClick={() => void openTerminal(session.id, session.cwd)}>
          <TerminalSquare />
        </Button>
      </WithTooltip>
      <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger asChild>
          <span className="shrink-0">
            <WithTooltip label="New agent tab" keys={keycaps("mod+t")}>
              <Button variant="ghost" size="icon-xs" aria-label="New agent tab">
                <Plus />
              </Button>
            </WithTooltip>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>New agent tab with</DropdownMenuLabel>
          {store.harnesses.map((h) => (
            <DropdownMenuItem key={h.id} disabled={!h.available} onSelect={() => void addAgent(h.id)}>
              <AgentMark id={h.id} />
              <span>{h.name}</span>
              {!h.available && <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
