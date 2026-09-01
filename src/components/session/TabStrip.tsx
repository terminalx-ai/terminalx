import { useCallback, useState } from "react";
import { FileCode2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { addTab, removeTab, setActiveTab, useSessionStore } from "@/lib/sessions";
import { getPrefs } from "@/lib/prefs";
import { closeEditor, setActiveEditor, useEditors } from "@/lib/editors";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * One tab per agent conversation in a session. The strip sits in the header;
 * ⌘T opens the agent picker, ⌘W closes the active tab (never the last one),
 * ⌘⇧[ and ⌘⇧] step through them in drawn order.
 */
export function TabStrip({ session, activeTab }: { session: SessionEntry; activeTab: TabEntry | undefined }) {
  const store = useSessionStore();
  const ed = useEditors();
  const editors = ed.editors.filter((e) => e.sessionId === session.id);
  const activeEditor = ed.active[session.id] ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const tabs = session.tabs;

  const pickAgentTab = useCallback(
    (id: string) => {
      setActiveEditor(session.id, null);
      void setActiveTab(session.id, id);
    },
    [session.id],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (tabs.length < 2 || !activeTab) return;
      const i = tabs.findIndex((t) => t.id === activeTab.id);
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      void setActiveTab(session.id, next.id);
    },
    [tabs, activeTab, session.id],
  );

  const closeActive = useCallback(() => {
    if (activeEditor) void closeEditor(activeEditor);
    else if (activeTab && tabs.length > 1) void removeTab(session.id, activeTab.id);
  }, [activeEditor, activeTab, tabs.length, session.id]);

  const add = useCallback(
    async (harness: string) => {
      const prefs = getPrefs();
      await addTab(session.id, harness, prefs.lastModel[harness] ?? "", prefs.lastEffort[harness] ?? null, prefs.lastMode);
    },
    [session.id],
  );

  useHotkey("mod+t", () => setPickerOpen(true));
  useHotkey("mod+w", closeActive);
  useHotkey("mod+shift+]", () => step(1));
  useHotkey("mod+shift+[", () => step(-1));

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-md bg-well p-0.5">
      {tabs.map((t) => {
        const active = t.id === activeTab?.id && !activeEditor;
        const name = t.title ?? store.harnesses.find((h) => h.id === t.harness)?.name ?? t.harness;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => pickAgentTab(t.id)}
            onKeyDown={(e) => e.key === "Enter" && pickAgentTab(t.id)}
            onAuxClick={(e) => e.button === 1 && tabs.length > 1 && removeTab(session.id, t.id)}
            className={cn(
              "group/tab relative flex h-6 min-w-0 items-center gap-1.5 rounded-[5px] pl-2 pr-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              active ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "absolute left-0.5 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full",
                t.status === "waiting" && "bg-warning",
                t.status === "in_progress" && "bg-info animate-pulse-soft",
                t.status === "completed" && "bg-add",
              )}
            />
            <AgentMark id={t.harness} className="size-3.5 shrink-0" />
            <span className="max-w-[9rem] truncate">{name}</span>
            <button
              type="button"
              aria-label="Close tab"
              disabled={tabs.length <= 1}
              onClick={(e) => {
                e.stopPropagation();
                void removeTab(session.id, t.id);
              }}
              className={cn(
                "ml-0.5 rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100",
                tabs.length <= 1 && "hidden",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      {editors.map((e) => {
        const active = e.id === activeEditor;
        return (
          <div
            key={e.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={e.rel}
            onClick={() => setActiveEditor(session.id, e.id)}
            onKeyDown={(k) => k.key === "Enter" && setActiveEditor(session.id, e.id)}
            onAuxClick={(k) => k.button === 1 && void closeEditor(e.id)}
            className={cn(
              "group/tab relative flex h-6 min-w-0 items-center gap-1.5 rounded-[5px] pl-2 pr-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              active ? "bg-(--surface-thumb) text-foreground shadow-button" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileCode2 className="size-3.5 shrink-0 text-faint" />
            <span className="max-w-[9rem] truncate">{e.name}</span>
            {e.dirty && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Unsaved" />}
            <button
              type="button"
              aria-label="Close file"
              onClick={(k) => {
                k.stopPropagation();
                void closeEditor(e.id);
              }}
              className="ml-0.5 rounded-sm p-0.5 text-faint opacity-0 hover:bg-veil-strong hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger asChild>
          <span>
            <WithTooltip label="New tab" keys={keycaps("mod+t")}>
              <Button variant="ghost" size="icon-xs" aria-label="New tab">
                <Plus />
              </Button>
            </WithTooltip>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>New tab with</DropdownMenuLabel>
          {store.harnesses.map((h) => (
            <DropdownMenuItem key={h.id} disabled={!h.available} onSelect={() => void add(h.id)}>
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
