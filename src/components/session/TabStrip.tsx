import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Globe, Plus, TerminalSquare } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { closeEditor, useEditors } from "@/lib/editors";
import { useShortcut } from "@/lib/hotkeys";
import { useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { getPrefs } from "@/lib/prefs";
import { openBrowserTab } from "@/lib/browser";
import { closePeer, useTabRow } from "@/lib/sessionTabs";
import { addTab, useSessionStore } from "@/lib/sessions";
import type { ShortcutId } from "@/lib/shortcuts";
import { moveTabBy, openTabAt, reopenClosedTab, stepTab } from "@/lib/tabActions";
import { openTerminal, selectSessionTab, type SelectedSessionTab } from "@/lib/terminal";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { SessionEntry } from "@/types/session";

/**
 * The "+" that opens the new-tab menu. The menu's trigger is the button itself
 * (not a wrapper), so a mouse click, an accessibility press and Return all
 * open it, and the button reports the menu's expanded state.
 */
function NewTabTrigger({ trigger }: { trigger: ReturnType<typeof useRowMenu>["trigger"] }) {
  return (
    <WithTooltip label="New tab" shortcut="session.newTab">
      <DropdownMenuTrigger asChild {...trigger}>
        <Button variant="ghost" size="icon-sm" aria-label="New tab">
          <Plus />
        </Button>
      </DropdownMenuTrigger>
    </WithTooltip>
  );
}

/**
 * The "+" that opens a tab, and the tab shortcuts: new, close, next and
 * previous, by position (1 to 8 and the last), move left or right, and
 * reopen. They act on the workspace's row of tabs, which the title bar strip
 * and the sidebar both draw.
 */
export function TabActions({
  session,
  selected,
  cloud,
  onShowPorts,
}: {
  session: SessionEntry;
  selected: SelectedSessionTab | null;
  cloud?: CloudSessionModel;
  /** A cloud session's "Ports and previews" (PRO-28); absent for anyone who may not use previews. */
  onShowPorts?: () => void;
}) {
  if (cloud) return <CloudTabActions session={session} selected={selected} cloud={cloud} onShowPorts={onShowPorts} />;
  return <LocalTabActions session={session} selected={selected} />;
}

/** The tab shortcuts by position: 1 to 8, and the last tab. */
const TAB_POSITION_SHORTCUTS = ["session.tab1", "session.tab2", "session.tab3", "session.tab4", "session.tab5", "session.tab6", "session.tab7", "session.tab8"] as const satisfies readonly ShortcutId[];

/** One "switch to tab N" shortcut. The key is taken even when there is no tab there, so it is never typed into what has the focus. */
function TabPositionShortcut({ action, open }: { action: ShortcutId; open: () => void }) {
  useShortcut(action, open);
  return null;
}

function LocalTabActions({ session, selected }: { session: SessionEntry; selected: SelectedSessionTab | null }) {
  const store = useSessionStore();
  // The whole workspace's row: the shortcuts count and step through the tabs the strip shows, in its order.
  const row = useTabRow(session);
  const editors = useEditors();
  const hasEditors = editors.editors.some((editor) => editor.sessionId === session.id);
  const activeEditor = editors.active[session.id] ?? null;
  const picker = useRowMenu();
  // Read when a key is pressed, so the bindings are made once and not on every render.
  const now = useRef({ row, selected, hasEditors, activeEditor, lastFocused: editors.lastFocused });
  now.current = { row, selected, hasEditors, activeEditor, lastFocused: editors.lastFocused };
  const shown = () => now.current.row.tabs.find((tab) => tab.kind === now.current.selected?.kind && tab.id === now.current.selected.id);
  const openMenu = useCallback(() => picker.setOpen(true), [picker.setOpen]);
  const closeActive = useCallback(() => {
    const { row, selected, hasEditors, activeEditor, lastFocused } = now.current;
    if (lastFocused === "editor" && hasEditors && activeEditor) {
      void closeEditor(activeEditor);
      return;
    }
    const active = shown();
    if (active) void closePeer(row.session.id, active, row.tabs, selected);
  }, []);
  const next = useCallback(() => stepTab(now.current.row, now.current.selected, 1), []);
  const previous = useCallback(() => stepTab(now.current.row, now.current.selected, -1), []);
  const openLast = useCallback(() => void openTabAt(now.current.row, now.current.row.tabs.length), []);
  const move = useCallback((how: "left" | "right") => {
    const active = shown();
    if (active) moveTabBy(now.current.row, active, how);
  }, []);
  const moveLeft = useCallback(() => move("left"), [move]);
  const moveRight = useCallback(() => move("right"), [move]);
  const reopen = useCallback(() => void reopenClosedTab(now.current.row).catch((error) => console.error("reopening the tab failed", error)), []);
  const positions = useMemo(() => TAB_POSITION_SHORTCUTS.map((action, index) => ({ action, open: () => void openTabAt(now.current.row, index + 1) })), []);
  const add = async (harness: string) => {
    const prefs = getPrefs();
    await addTab(session.id, harness, prefs.lastModel[harness] ?? "", prefs.lastEffort[harness] ?? null, prefs.lastMode);
  };
  useShortcut("session.newTab", openMenu);
  useShortcut("session.closeTab", closeActive);
  useShortcut("session.nextTab", next);
  useShortcut("session.previousTab", previous);
  useShortcut("session.lastTab", openLast);
  useShortcut("session.moveTabLeft", moveLeft);
  useShortcut("session.moveTabRight", moveRight);
  useShortcut("session.reopenTab", reopen);

  return (
    <DropdownMenu {...picker.root}>
      {positions.map(({ action, open }) => <TabPositionShortcut key={action} action={action} open={open} />)}
      <NewTabTrigger trigger={picker.trigger} />
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>New agent tab with</DropdownMenuLabel>
        {store.harnesses.map((harness) => <DropdownMenuItem key={harness.id} disabled={!harness.available} onSelect={() => void add(harness.id)}>
          <AgentMark id={harness.id} decorative /><span>{harness.name}</span>
          {!harness.available ? <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span> : null}
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openTerminal(session.id, session.cwd)} aria-label="Terminal on this computer">
          <TerminalSquare /><span>Terminal</span><span className="ml-auto pl-3 text-[11px] text-faint">on this computer</span>
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
/** Why the cloud "New tab" menu's items are disabled, or null when they are not. */
export function newTabBlockedReason(cloud: Pick<CloudSessionModel, "backend" | "connected" | "asleep" | "canWakeForTerminal" | "manage">): string | null {
  if (cloud.backend.readOnlyReason) return cloud.backend.readOnlyReason;
  if (!cloud.connected) {
    if (!cloud.asleep) return "Connecting to the workspace…";
    return cloud.canWakeForTerminal
      ? "Stopped: sending a message or choosing Terminal wakes the workspace. Agent tabs are added once it runs."
      : "Stopped: sending a message wakes the workspace. Terminals and new tabs need a workspace admin.";
  }
  // A driver gets here too, so not "View only": tabs and terminals are a manager's.
  return cloud.manage ? null : "New tabs and terminals need a workspace admin.";
}

/** The disabled menu's reason: a plain sentence, not the uppercase section header. */
export function NewTabHint({ children }: { children: ReactNode }) {
  return <DropdownMenuLabel className="max-w-64 whitespace-normal normal-case tracking-normal text-[11px] font-normal text-muted-foreground" role="note">{children}</DropdownMenuLabel>;
}

function CloudTabActions({ session, selected, cloud, onShowPorts }: { session: SessionEntry; selected: SelectedSessionTab | null; cloud: CloudSessionModel; onShowPorts?: () => void }) {
  const { models, refresh } = usePickerModels(useModels(), true, cloud.asleep ? null : cloud.client);
  const picker = useRowMenu({ onOpenChange: (open) => open && void refresh() });
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
  const now = useRef(tabs);
  now.current = tabs;
  const openAt = useCallback((position: number) => {
    const tab = now.current[position - 1];
    if (tab) selectSessionTab(session.id, { kind: tab.kind, id: tab.id });
  }, [session.id]);
  const positions = useMemo(() => TAB_POSITION_SHORTCUTS.map((action, index) => ({ action, open: () => openAt(index + 1) })), [openAt]);
  const openLast = useCallback(() => openAt(now.current.length), [openAt]);
  useShortcut("session.newTab", () => picker.setOpen(true));
  useShortcut("session.nextTab", () => step(1));
  useShortcut("session.previousTab", () => step(-1));
  useShortcut("session.lastTab", openLast);
  const blocked = newTabBlockedReason(cloud);
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
      {positions.map(({ action, open }) => <TabPositionShortcut key={action} action={action} open={open} />)}
      <NewTabTrigger trigger={picker.trigger} />
      <DropdownMenuContent align="end">
        {(blocked || error) && <NewTabHint>{error ?? blocked}</NewTabHint>}
        <DropdownMenuLabel>New agent tab with</DropdownMenuLabel>
        {cloud.agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            disabled={!!blocked || !cloud.canAddTabs}
            onSelect={() => run(() => cloud.addAgentTab({ agent: agent.id, model: models.find((model) => model.harness === agent.id && model.id === prefs.lastModel[agent.id])?.id, effort: prefs.lastEffort[agent.id] ?? undefined, mode: prefs.lastMode }))}
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
        {onShowPorts && (
          <>
            <DropdownMenuSeparator />
            {/* Never wakes the workspace: the panel only says it is stopped. */}
            <DropdownMenuItem onSelect={onShowPorts}>
              <Globe /><span>Ports and previews</span><span className="ml-auto pl-3 text-[11px] text-faint">side panel</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
