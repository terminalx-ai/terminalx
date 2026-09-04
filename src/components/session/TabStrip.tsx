import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { closeEditor, useEditors } from "@/lib/editors";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { getPrefs } from "@/lib/prefs";
import { addTab, removeTab, setActiveTab, useSessionStore } from "@/lib/sessions";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * Header-level tab actions and shortcuts. Tab destinations themselves live in
 * the sidebar tree; this compact action preserves the existing creation flow.
 */
export function TabActions({ session, activeTab }: { session: SessionEntry; activeTab: TabEntry | undefined }) {
  const store = useSessionStore();
  const editors = useEditors();
  const hasEditors = editors.editors.some((editor) => editor.sessionId === session.id);
  const activeEditor = editors.active[session.id] ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const tabs = session.tabs;

  const step = useCallback(
    (direction: 1 | -1) => {
      if (tabs.length < 2 || !activeTab) return;
      const index = tabs.findIndex((tab) => tab.id === activeTab.id);
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      void setActiveTab(session.id, next.id);
    },
    [activeTab, session.id, tabs],
  );

  const closeActive = useCallback(() => {
    if (editors.lastFocused === "editor" && hasEditors && activeEditor) void closeEditor(activeEditor);
    else if (activeTab && tabs.length > 1) void removeTab(session.id, activeTab.id);
  }, [activeEditor, activeTab, editors.lastFocused, hasEditors, session.id, tabs.length]);

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
    <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
      <DropdownMenuTrigger asChild>
        <span>
          <WithTooltip label="New agent tab" keys={keycaps("mod+t")}>
            <Button variant="ghost" size="icon-sm" aria-label="New agent tab">
              <Plus />
            </Button>
          </WithTooltip>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>New tab with</DropdownMenuLabel>
        {store.harnesses.map((harness) => (
          <DropdownMenuItem key={harness.id} disabled={!harness.available} onSelect={() => void add(harness.id)}>
            <AgentMark id={harness.id} />
            <span>{harness.name}</span>
            {!harness.available ? <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
