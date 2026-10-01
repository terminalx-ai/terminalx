import { useCallback, useMemo, useState } from "react";
import { Globe, Plus, TerminalSquare } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { closeEditor, useEditors } from "@/lib/editors";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { getPrefs } from "@/lib/prefs";
import { openBrowserTab, pagesFor, useBrowser } from "@/lib/browser";
import { activatePeer, closePeer, peerOrder } from "@/lib/sessionTabs";
import { addTab, useSessionStore } from "@/lib/sessions";
import { openTerminal, selectSessionTab, useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { SessionEntry } from "@/types/session";

/**
 * The "+" that opens the new-tab menu. The menu's trigger is the button itself
 * (not a wrapper), so a mouse click, an accessibility press and Return all
 * open it, and the button reports the menu's expanded state.
 */
function NewTabTrigger({ trigger }: { trigger: ReturnType<typeof useRowMenu>["trigger"] }) {
  return (
    <WithTooltip label="New tab" keys={keycaps("mod+t")}>
      <DropdownMenuTrigger asChild {...trigger}>
        <Button variant="ghost" size="icon-sm" aria-label="New tab">
          <Plus />
        </Button>
      </DropdownMenuTrigger>
    </WithTooltip>
  );
}

/** Creation and mixed-tab shortcuts; all destinations live in the sidebar. */
export function TabActions({ session, selected, cloud }: { session: SessionEntry; selected: SelectedSessionTab | null; cloud?: CloudSessionModel }) {
  if (cloud) return <CloudTabActions session={session} selected={selected} cloud={cloud} />;
  return <LocalTabActions session={session} selected={selected} />;
}

function LocalTabActions({ session, selected }: { session: SessionEntry; selected: SelectedSessionTab | null }) {
  const store = useSessionStore();
  const { panes } = useTerminals();
  const browser = useBrowser();
  const tabs = useMemo(() => peerOrder(session, panes, pagesFor(browser.pages, session.cwd)), [session, panes, browser.pages]);
  const editors = useEditors();
  const hasEditors = editors.editors.some((editor) => editor.sessionId === session.id);
  const activeEditor = editors.active[session.id] ?? null;
  const picker = useRowMenu();
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
  useHotkey("mod+t", () => picker.setOpen(true));
  useHotkey("mod+w", closeActive);
  useHotkey("mod+shift+]", () => step(1));
  useHotkey("mod+shift+[", () => step(-1));

  return (
    <DropdownMenu {...picker.root}>
      <NewTabTrigger trigger={picker.trigger} />
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

/**
 * A cloud session's tab actions: agents the runtime has, and terminals on
 * the VM. Adding either needs a live connection and manage access; the
 * menu says why when it is not there.
 */
function CloudTabActions({ session, selected, cloud }: { session: SessionEntry; selected: SelectedSessionTab | null; cloud: CloudSessionModel }) {
  const picker = useRowMenu();
  const [error, setError] = useState<string | null>(null);
  const tabs = useMemo<(SelectedSessionTab & { created: string })[]>(
    () =>
      [
        ...session.tabs.map((tab) => ({ kind: "agent" as const, id: tab.id, created: tab.created })),
        ...cloud.terminals.map((terminal) => ({ kind: "terminal" as const, id: terminal.id, created: String(terminal.number).padStart(8, "0") })),
      ],
    [session.tabs, cloud.terminals],
  );
  const step = useCallback(
    (direction: 1 | -1) => {
      if (tabs.length < 2) return;
      const current = tabs.findIndex((tab) => tab.kind === selected?.kind && tab.id === selected.id);
      const next = current < 0 ? (direction === 1 ? 0 : tabs.length - 1) : (current + direction + tabs.length) % tabs.length;
      selectSessionTab(session.id, { kind: tabs[next].kind, id: tabs[next].id });
    },
    [selected, session.id, tabs],
  );
  useHotkey("mod+t", () => picker.setOpen(true));
  useHotkey("mod+shift+]", () => step(1));
  useHotkey("mod+shift+[", () => step(-1));
  const blocked =
    cloud.backend.readOnlyReason ??
    (!cloud.connected
      ? cloud.asleep
        ? cloud.canWakeForTerminal
          ? "Stopped: sending a message or choosing Terminal wakes the workspace. Agent tabs are added once it runs."
          : "Stopped: sending a message wakes the workspace. Terminals and new tabs need a workspace admin."
        : "Connecting to the workspace…"
      : !cloud.manage
        ? "View only: this attachment cannot add tabs."
        : null);
  // A stopped workspace this attachment may manage: Terminal is the one item that wakes it, and only when chosen.
  // Not for a viewer or a driver (PRO-30): terminals are a manager's, so their wake would end in a refusal.
  const wakesForTerminal = cloud.canWakeForTerminal;
  const run = (action: () => Promise<void>) => {
    setError(null);
    void action().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const prefs = getPrefs();
  return (
    <DropdownMenu {...picker.root}>
      <NewTabTrigger trigger={picker.trigger} />
      <DropdownMenuContent align="end">
        {(blocked || error) && <DropdownMenuLabel className="max-w-64 whitespace-normal text-[11px] font-normal text-muted-foreground">{error ?? blocked}</DropdownMenuLabel>}
        <DropdownMenuLabel>New agent tab with</DropdownMenuLabel>
        {cloud.agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            disabled={!!blocked || !cloud.canAddTabs}
            onSelect={() => run(() => cloud.addAgentTab({ agent: agent.id, model: prefs.lastModel[agent.id] || undefined, effort: prefs.lastEffort[agent.id] ?? undefined, mode: prefs.lastMode }))}
          >
            <AgentMark id={agent.id} decorative /><span>{agent.name}</span>
            {!blocked && !cloud.canAddTabs ? <span className="ml-auto pl-3 text-[11px] text-faint">update the runtime</span> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {wakesForTerminal ? (
          <DropdownMenuItem onSelect={() => run(() => cloud.openTerminal({ wake: true }))} aria-label="Terminal on the VM: wakes the workspace">
            <TerminalSquare /><span>Terminal</span><span className="ml-auto pl-3 text-[11px] text-warning">wakes the workspace</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={!!blocked} onSelect={() => run(() => cloud.openTerminal())}>
            <TerminalSquare /><span>Terminal</span><span className="ml-auto pl-3 text-[11px] text-faint">on the VM</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
