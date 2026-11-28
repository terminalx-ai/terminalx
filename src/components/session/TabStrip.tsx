import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Globe, Plus, TerminalSquare } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, MenuShortcut } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { closeEditor, isTabEditor, setLastFocused, useEditors } from "@/lib/editors";
import { useShortcut, useShortcutKeycaps } from "@/lib/hotkeys";
import { EFFORT_LABEL, prettyModelId, useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { getPrefs } from "@/lib/prefs";
import { openBrowserTab } from "@/lib/browser";
import { isShellPeer, paneRow, peerLabel, sessionOfPeer, useTabRow } from "@/lib/sessionTabs";
import { addTab, forkSession, getSessionStore, useSessionStore } from "@/lib/sessions";
import { closeRowTabTelling, closeTabTelling, openAgentTabTelling } from "@/components/session/TabMenu";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { useRemoteTabRow } from "@/lib/remoteTabRow";
import { REMOTE_LOCAL_ONLY } from "@/lib/sessionBackend";
import { dismissErrorKey, showError } from "@/lib/errorToasts";
import type { ShortcutId } from "@/lib/shortcuts";
import { moveTabBy, openTabAt, reopenClosedTab, stepTab } from "@/lib/tabActions";
import { openTerminal, selectSessionTab, type SelectedSessionTab } from "@/lib/terminal";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { MACHINE_LOCAL_ONLY } from "@/components/machines/MachineMessage";
import type { SessionEntry, TabEntry } from "@/types/session";
import { tabAccount, type ModelInfo } from "@/lib/api";
import { LOCAL_ACCOUNT, showsAccounts, type AgentAccount } from "@/lib/agentAccounts";
import { useAgentAccounts } from "@/lib/useSessionAgent";

/** How old a tab mark's accounts may be before a newly drawn mark reads them again. */
const TAB_ACCOUNTS_MAX_AGE_MS = 30_000;

/**
 * The account `tab`'s agent runs on (#980), only when that agent has more
 * than one account; with one, `null` and nothing is drawn. A tab that never
 * named one, or ran on This Mac's login, is on This Mac's login: the launch
 * records any other account it resolved to.
 */
export function useTabAccount(tab: Pick<TabEntry, "harness">): AgentAccount | null {
  const view = useAgentAccounts(tab.harness, TAB_ACCOUNTS_MAX_AGE_MS);
  if (!view || !showsAccounts(view)) return null;
  const id = tabAccount(tab as TabEntry) ?? LOCAL_ACCOUNT;
  return view.accounts.find((account) => account.id === id) ?? null;
}

/** The first letter of an account's label, for its mark in the tab strip. */
function accountInitial(account: Pick<AgentAccount, "email" | "label">): string {
  return (account.email ?? account.label).trim().charAt(0).toUpperCase() || "?";
}

/*
 * A machine session's tab carries the label its machine names (PRO-408) and
 * is never looked up in this computer's accounts; a tab of this computer is.
 */
function AccountMark({ account }: { account: Pick<AgentAccount, "email" | "label"> }) {
  return (
    <span data-testid="tab-account-mark" role="img" aria-label={`On ${account.label}`} title={account.label}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-veil-raised text-[12px] leading-none text-muted-foreground">
      {accountInitial(account)}
    </span>
  );
}

function AccountLabel({ account, className }: { account: Pick<AgentAccount, "label">; className?: string }) {
  return <span data-testid="tab-account-label" title={`This tab runs on ${account.label}`} className={className ?? "min-w-0 truncate text-[12px] text-muted-foreground"}>{account.label}</span>;
}

function LocalTabAccountMark({ tab }: { tab: TabEntry }) {
  const account = useTabAccount(tab);
  return account ? <AccountMark account={account} /> : null;
}

function LocalTabAccountLabel({ tab, className }: { tab: TabEntry; className?: string }) {
  const account = useTabAccount(tab);
  return account ? <AccountLabel account={account} className={className} /> : null;
}

/** A small mark on a tab in the strip: which of its agent's accounts it runs on. Nothing with one account. */
export function TabAccountMark({ tab }: { tab: TabEntry }) {
  if (tab.accountLabel === undefined) return <LocalTabAccountMark tab={tab} />;
  return tab.accountLabel ? <AccountMark account={{ email: null, label: tab.accountLabel }} /> : null;
}

/** The tab's account by name, for its header. Nothing with one account. */
export function TabAccountLabel({ tab, className }: { tab: TabEntry; className?: string }) {
  if (tab.accountLabel === undefined) return <LocalTabAccountLabel tab={tab} className={className} />;
  return tab.accountLabel ? <AccountLabel account={{ label: tab.accountLabel }} className={className} /> : null;
}

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
 *
 * With `newTabs` false there is no "+" and no new-tab or new-browser-tab key,
 * and the keys that switch, move, close and reopen tabs stay (a bot's chat,
 * PRO-533: a new chat with the bot starts from its list of chats).
 */
export function TabActions({
  session,
  selected,
  cloud,
  onShowPorts,
  newTabs = true,
}: {
  session: SessionEntry;
  selected: SelectedSessionTab | null;
  cloud?: CloudSessionModel;
  /** A cloud session's "Ports and previews" (PRO-28); absent for anyone who may not use previews. */
  onShowPorts?: () => void;
  newTabs?: boolean;
}) {
  if (cloud) return <CloudTabActions session={session} selected={selected} cloud={cloud} onShowPorts={onShowPorts} newTabs={newTabs} />;
  return <LocalTabActions session={session} selected={selected} newTabs={newTabs} />;
}

/** The tab shortcuts by position: 1 to 8, and the last tab. */
const TAB_POSITION_SHORTCUTS = ["session.tab1", "session.tab2", "session.tab3", "session.tab4", "session.tab5", "session.tab6", "session.tab7", "session.tab8"] as const satisfies readonly ShortcutId[];

/** One "switch to tab N" shortcut. The key is taken even when there is no tab there, so it is never typed into what has the focus. */
function TabPositionShortcut({ action, open }: { action: ShortcutId; open: () => void }) {
  useShortcut(action, open);
  return null;
}

function LocalTabActions({ session, selected, newTabs }: { session: SessionEntry; selected: SelectedSessionTab | null; newTabs: boolean }) {
  // Tab shortcuts act within the pane that contains this window's selected tab.
  const row = paneRow(useTabRow(session), selected ? `${selected.kind}:${selected.id}` : null);
  const editors = useEditors();
  // Files that are not tabs of the session (a cloud workspace's) are closed in their own pane.
  const hasEditors = editors.editors.some((editor) => editor.sessionId === session.id && !isTabEditor(editor));
  const activeEditor = editors.editors.find((e) => e.id === editors.active[session.id] && !isTabEditor(e))?.id ?? null;
  useEffect(() => { if (selected?.kind !== "review") setLastFocused("chat"); }, [selected?.kind, selected?.id]);
  const picker = useRowMenu();
  // Read when a key is pressed, so the bindings are made once and not on every render.
  const now = useRef({ row, selected, hasEditors, activeEditor, lastFocused: editors.lastFocused });
  now.current = { row, selected, hasEditors, activeEditor, lastFocused: editors.lastFocused };
  const shown = () => now.current.row.tabs.find((tab) => tab.kind === now.current.selected?.kind && tab.id === now.current.selected.id);
  const openMenu = useCallback(() => picker.setOpen(true), [picker.setOpen]);
  const closeActive = useCallback(() => {
    const { row, selected, hasEditors, activeEditor, lastFocused } = now.current;
    if (selected?.kind !== "review" && lastFocused === "editor" && hasEditors && activeEditor) {
      void closeEditor(activeEditor);
      return;
    }
    const active = shown();
    const harnessName = (id: string) => getSessionStore().harnesses.find((harness) => harness.id === id)?.name;
    if (active) void closeTabTelling(row.session.id, active, row.tabs, selected, peerLabel(active, row.layout, harnessName));
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
  const reopen = useCallback(() => void reopenClosedTab(now.current.row).catch((error) => showError("Couldn’t reopen the tab", error)), []);
  const positions = useMemo(() => TAB_POSITION_SHORTCUTS.map((action, index) => ({ action, open: () => void openTabAt(now.current.row, index + 1) })), []);
  useShortcut("session.newTab", openMenu, { enabled: newTabs });
  useShortcut("session.closeTab", closeActive);
  useShortcut("session.nextTab", next);
  useShortcut("session.previousTab", previous);
  useShortcut("session.lastTab", openLast);
  useShortcut("session.moveTabLeft", moveLeft);
  useShortcut("session.moveTabRight", moveRight);
  useShortcut("session.reopenTab", reopen);
  useShortcut("session.newBrowserTab", useCallback(() => void openLocalTab(now.current.row.session, "browser"), []), { enabled: newTabs });
  useShortcut("session.forkTab", useCallback(() => {
    const active = shown();
    if (active?.kind === "agent" && !isShellPeer(active)) void forkSession(sessionOfPeer(now.current.row.session.id, active), active.id).catch((error) => showError("Couldn’t fork the conversation", error));
  }, []));

  const positionKeys = positions.map(({ action, open }) => <TabPositionShortcut key={action} action={action} open={open} />);
  if (!newTabs) return <>{positionKeys}</>;
  return (
    <DropdownMenu {...picker.root}>
      {positionKeys}
      <NewTabTrigger trigger={picker.trigger} />
      <DropdownMenuContent align="start" className="w-[290px] max-w-[calc(100vw-1rem)]">
        <LocalNewTabItems session={session} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a new agent tab of `harness` starts with (PRO-381): the model and effort last picked, or the agent's default. */
/**
 * The saved model and effort a new tab on a cloud workspace starts with. On a
 * list that is only this computer's (`foreign`: the workspace has not said
 * what it runs) a pinned version may not run there, so only an alias is
 * carried; otherwise nothing, and the workspace uses its default (#1580).
 */
export function cloudTabModel(models: readonly ModelInfo[], foreign: boolean, harness: string, prefs: { lastModel: Record<string, string>; lastEffort: Record<string, string | null> }): { model?: string; effort?: string } {
  const model = models.find((candidate) => candidate.harness === harness && candidate.id === prefs.lastModel[harness]);
  if (foreign && !model?.alias) return {};
  return { model: model?.id, effort: prefs.lastEffort[harness] ?? undefined };
}

export function newChatStartsWith(models: readonly ModelInfo[] | null | undefined, harness: string, prefs: { lastModel: Record<string, string>; lastEffort: Record<string, string | null> }): string | null {
  const own = (models ?? []).filter((model) => model.harness === harness);
  const model = own.find((candidate) => candidate.id === prefs.lastModel[harness]) ?? own.find((candidate) => candidate.isDefault);
  const effort = prefs.lastEffort[harness] ?? model?.defaultEffort ?? null;
  const name = model?.label ?? (prefs.lastModel[harness] ? prettyModelId(prefs.lastModel[harness]) : null);
  return [name, effort ? EFFORT_LABEL[effort] ?? effort : null].filter(Boolean).join(" ") || null;
}

/**
 * What a local session's "New tab" offers (PRO-381, screen 03.29): a chat
 * with each installed agent, named for what it will start with, then a
 * terminal and a browser page.
 */
export function LocalNewTabItems({ session }: { session: SessionEntry }) {
  const store = useSessionStore();
  const models = useModels();
  const keys = useShortcutKeycaps();
  const prefs = getPrefs();
  const where = session.worktreeName ? "Same worktree" : "Same folder";
  const add = (harness: string) => {
    const prefs = getPrefs();
    return openAgentTabTelling(session, harness, () => addTab(session.id, harness, prefs.lastModel[harness] ?? "", prefs.lastEffort[harness] ?? null, prefs.lastMode));
  };
  // ⌘T opens this menu on its first chat, so the key is shown there.
  const first = store.harnesses.find((harness) => harness.available)?.id;
  return (
    <>
      <DropdownMenuLabel>New tab</DropdownMenuLabel>
      {store.harnesses.map((harness) => {
        const startsWith = harness.available ? newChatStartsWith(models, harness.id, prefs) : null;
        return (
          <DropdownMenuItem key={harness.id} disabled={!harness.available} onSelect={() => void add(harness.id)} aria-label={`${harness.name} chat`}>
            <AgentMark id={harness.id} decorative />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{harness.name} chat</span>
              <span className="block truncate text-[12px] text-faint">{harness.available ? [where, startsWith].filter(Boolean).join(" · ") : "Not installed"}</span>
            </span>
            {harness.id === first && keys("session.newTab").length ? <MenuShortcut keys={keys("session.newTab")} /> : null}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuItem onSelect={() => void openLocalTab(session, "terminal")}>
        <TerminalSquare /><span>Terminal</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void openLocalTab(session, "browser")}>
        <Globe /><span>Browser</span>
        {keys("session.newBrowserTab").length ? <MenuShortcut keys={keys("session.newBrowserTab")} /> : null}
      </DropdownMenuItem>
    </>
  );
}

/** Open a terminal or a browser page in a local session; one that would not open says so, and can be tried again (PRO-291). */
export function openLocalTab(session: SessionEntry, kind: "terminal" | "browser"): Promise<boolean> {
  const noun = kind === "terminal" ? "terminal" : "browser tab";
  const key = `open:${session.id}:${kind}`;
  const open = () => (kind === "terminal" ? openTerminal(session.id, session.cwd) : openBrowserTab(session.id, session.cwd));
  return open().then(
    () => { dismissErrorKey(key); return true; },
    (error: unknown) => {
      showError(`Couldn't open a new ${noun}`, error, { key, actions: [{ label: "Try again", icon: "retry", run: () => openLocalTab(session, kind) }] });
      return false;
    },
  );
}

/**
 * A cloud session's tab actions: agents the runtime has, and terminals on
 * the VM. Adding either needs a live connection and manage access; the
 * menu says why when it is not there.
 */
/** Why the cloud "New tab" menu's items are disabled, or null when they are not. */
export function newTabBlockedReason(cloud: Pick<CloudSessionModel, "backend" | "connected" | "asleep" | "canWakeForTerminal" | "manage" | "machine" | "unavailable">): string | null {
  if (cloud.backend.readOnlyReason) return cloud.backend.readOnlyReason;
  if (cloud.machine) return cloud.connected && cloud.manage ? null : `Tabs and terminals open once ${cloud.machine.name} is connected.`;
  if (!cloud.connected) {
    // #1582: nothing is connecting to a workspace that needs attention or was deleted; say why instead.
    if (cloud.unavailable) return `The workspace can't be reached, so no tabs or terminals can be opened. ${cloud.unavailable}`;
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
  return <DropdownMenuLabel className="max-w-64 whitespace-normal normal-case tracking-normal text-[12px] font-normal text-muted-foreground" role="note">{children}</DropdownMenuLabel>;
}

function CloudTabActions({ session, selected, cloud, onShowPorts, newTabs }: { session: SessionEntry; selected: SelectedSessionTab | null; cloud: CloudSessionModel; onShowPorts?: () => void; newTabs: boolean }) {
  const { models, refresh, foreign } = usePickerModels(useModels(), true, cloud.asleep ? null : cloud.client);
  const picker = useRowMenu({ onOpenChange: (open) => open && void refresh() });
  const [error, setError] = useState<string | null>(null);
  // A cloud workspace session's tabs in the order of its strip (#1325); a machine session's, agents then terminals.
  const row = useRemoteTabRow(session, cloud, !cloud.machine && !cloud.locked);
  const tabs = useMemo<SelectedSessionTab[]>(
    () =>
      row
        ? row.tabs.map((tab) => ({ kind: tab.kind, id: tab.id }))
        : [
            ...session.tabs.map((tab) => ({ kind: "agent" as const, id: tab.id })),
            ...cloud.terminals.map((terminal) => ({ kind: "terminal" as const, id: terminal.id })),
          ],
    [row, session.tabs, cloud.terminals],
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
  useShortcut("session.newTab", () => picker.setOpen(true), { enabled: newTabs });
  useShortcut("session.nextTab", () => step(1));
  useShortcut("session.previousTab", () => step(-1));
  useShortcut("session.lastTab", openLast);
  // Close Tab closes the one on screen on the runtime, as its × in the strip does.
  const latestRow = useRef(row);
  latestRow.current = row;
  useShortcut("session.closeTab", () => {
    const current = latestRow.current;
    const shown = current?.tabs.find((tab) => tab.kind === selected?.kind && tab.id === selected.id);
    if (!current || !shown || cloud.closeBlockedReason) return;
    void closeRowTabTelling(current, shown, selected, peerLabel(shown, current.layout, cloudAgentLabel));
  }, { enabled: !!row });
  const blocked = newTabBlockedReason(cloud);
  // A stopped workspace this attachment may manage: Terminal is the one item that wakes it, and only when chosen.
  // Not for a viewer or a driver (PRO-30): terminals are a manager's, so their wake would end in a refusal.
  const wakesForTerminal = cloud.canWakeForTerminal;
  const run = (label: string, action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showError(label, e);
    });
  };
  const prefs = getPrefs();
  const positionKeys = positions.map(({ action, open }) => <TabPositionShortcut key={action} action={action} open={open} />);
  if (!newTabs) return <>{positionKeys}</>;
  return (
    <DropdownMenu {...picker.root}>
      {positionKeys}
      <NewTabTrigger trigger={picker.trigger} />
      <DropdownMenuContent align="end">
        {(blocked || error) && <NewTabHint>{error ?? blocked}</NewTabHint>}
        <DropdownMenuLabel>New tab</DropdownMenuLabel>
        {cloud.agents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            disabled={!!blocked || !cloud.canAddTabs}
            onSelect={() => run(`Couldn’t open a new ${agent.name} tab`, () => cloud.addAgentTab({ agent: agent.id, ...cloudTabModel(models, foreign, agent.id, prefs), mode: prefs.lastMode }))}
          >
            <AgentMark id={agent.id} decorative /><span>{agent.name}</span>
            {!blocked && !cloud.canAddTabs ? <span className="ml-auto pl-3 text-[12px] text-faint">update the runtime</span> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {wakesForTerminal ? (
          <DropdownMenuItem onSelect={() => run("Couldn’t open a new terminal", () => cloud.openTerminal({ wake: true }))} aria-label="Terminal on the VM: wakes the workspace">
            <TerminalSquare /><span>Terminal</span><span className="ml-auto pl-3 text-[12px] text-warning">wakes the workspace</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={!!blocked} onSelect={() => run("Couldn’t open a new terminal", () => cloud.openTerminal())}>
            <TerminalSquare /><span>Terminal</span><span className="ml-auto pl-3 text-[12px] text-faint">{cloud.machine ? `on ${cloud.machine.name}` : "on the VM"}</span>
          </DropdownMenuItem>
        )}
        {/* Where a local session offers a browser page: a remote session says, once, what stays on this computer (MACHINES.md decision 7, #1325). */}
        <DropdownMenuSeparator />
        <NewTabHint>
          {cloud.machine ? <span data-testid="machine-local-only">{MACHINE_LOCAL_ONLY}</span> : <span data-testid="cloud-local-only">{REMOTE_LOCAL_ONLY}</span>}
        </NewTabHint>
        {onShowPorts && (
          <>
            <DropdownMenuSeparator />
            {/* Never wakes the workspace: the panel only says it is stopped. */}
            <DropdownMenuItem onSelect={onShowPorts}>
              <Globe /><span>Ports and previews</span><span className="ml-auto pl-3 text-[12px] text-faint">side panel</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
