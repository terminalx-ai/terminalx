import { useCallback, useMemo, useState } from "react";
import { Globe, Plus, TerminalSquare } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { closeEditor, useEditors } from "@/lib/editors";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { getPrefs } from "@/lib/prefs";
import { openBrowserTab, pagesFor, useBrowser } from "@/lib/browser";
import { activatePeer, closePeer, peerOrder } from "@/lib/sessionTabs";
import { addTab, useSessionStore } from "@/lib/sessions";
import { openTerminal, useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import type { SessionEntry } from "@/types/session";

/** Creation and mixed-tab shortcuts; all destinations live in the sidebar. */
export function TabActions({ session, selected }: { session: SessionEntry; selected: SelectedSessionTab | null }) {
  const store = useSessionStore();
  const { panes } = useTerminals();
  const browser = useBrowser();
  const tabs = useMemo(() => peerOrder(session, panes, pagesFor(browser.pages, session.cwd)), [session, panes, browser.pages]);
  const editors = useEditors();
  const hasEditors = editors.editors.some((editor) => editor.sessionId === session.id);
  const activeEditor = editors.active[session.id] ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const step = useCallback((direction: 1 | -1) => {
    if (tabs.length < 2) return;
    const current = tabs.findIndex((tab) => tab.kind === selected?.kind && tab.id === selected.id);
    const next = current < 0 ? (direction === 1 ? 0 : tabs.length - 1) : (current + direction + tabs.length) % tabs.length;
    activatePeer(session.id, tabs[next]);
  }, [selected, session.id, tabs]);
  const closeActive = useCallback(() => {
    if (editors.lastFocused === "editor" && hasEditors && activeEditor) {
      void closeEditor(activeEditor);
      return;
    }
    const active = tabs.find((tab) => tab.kind === selected?.kind && tab.id === selected.id);
    if (active) void closePeer(session.id, active, tabs, selected);
  }, [activeEditor, editors.lastFocused, hasEditors, selected, session.id, tabs]);
  const add = async (harness: string) => {
    const prefs = getPrefs();
    await addTab(session.id, harness, prefs.lastModel[harness] ?? "", prefs.lastEffort[harness] ?? null, prefs.lastMode);
  };
  useHotkey("mod+t", () => setPickerOpen(true));
  useHotkey("mod+w", closeActive);
  useHotkey("mod+shift+]", () => step(1));
  useHotkey("mod+shift+[", () => step(-1));

  return (
    <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
      <DropdownMenuTrigger asChild>
        <span><WithTooltip label="New tab" keys={keycaps("mod+t")}><Button variant="ghost" size="icon-sm" aria-label="New tab"><Plus /></Button></WithTooltip></span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>New agent tab with</DropdownMenuLabel>
        {store.harnesses.map((harness) => <DropdownMenuItem key={harness.id} disabled={!harness.available} onSelect={() => void add(harness.id)}>
          <AgentMark id={harness.id} decorative /><span>{harness.name}</span>
          {!harness.available ? <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span> : null}
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openTerminal(session.id, session.cwd)}>
          <TerminalSquare /><span>Terminal</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openBrowserTab(session.id, session.cwd).catch((error) => console.error("browser open failed", error))}>
          <Globe /><span>Browser</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
