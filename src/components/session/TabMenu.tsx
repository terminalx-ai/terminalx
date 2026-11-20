import type { ReactNode } from "react";
import { archiveWithUndo } from "@/lib/archiveNotices";
import {
  Archive,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  BellOff,
  BellRing,
  Columns2,
  Copy,
  CopyPlus,
  Ellipsis,
  FolderOpen,
  GitFork,
  Globe,
  Link,
  Mail,
  MessageSquare,
  MoveHorizontal,
  Pencil,
  PictureInPicture2,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  RotateCw,
  Share2,
  Sparkles,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "@/icons";
import { confirmInApp } from "@/lib/confirm";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AgentMark } from "@/components/AgentMark";
import { cloudAgentLabel } from "@/lib/cloudAgentLabel";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, MenuShortcut } from "@/components/ui/menu";
import { isCompactWindow } from "@/lib/appWindow";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { openAgentHandoff, openCloseTabs, openRenameTab } from "@/lib/dialogs";
import { otherAgent } from "@/lib/agentHandoff";
import { showFloatingWindow } from "@/lib/floating";
import { isMac, useShortcutKeycaps } from "@/lib/hotkeys";
import type { ShortcutId } from "@/lib/shortcuts";
import { getTabLog, loadTab } from "@/lib/agentEvents";
import { tabLinkFor } from "@/lib/tabDeepLink";
import { transcriptText, type TranscriptFormat } from "@/lib/transcriptCopy";
import { openSessionShare } from "@/lib/localSharing";
import { getPrefs } from "@/lib/prefs";
import { isQuickChat } from "@/lib/quickChats";
import { archiveSession, forkSession, getSessionStore, openSkills, removeTab, selectSession, useSessionStore } from "@/lib/sessions";
import { useTabRow, activatePeer, closePeer, hasOwnTitle, isShellPeer, peerAgent, peerIsLive, peerLabel, peerShell, peerStatus, sessionOfPeer, type PeerTab, type TabRow } from "@/lib/sessionTabs";
import { BULK_CLOSE_LABEL, canMoveTab, closeRemoteTab, canReopenTab, canRestartAgent, duplicateTab, moveTabBy, newTab, moveTabToPane, otherPane, planBulkClose, renamePeer, reopenClosedTab, restartTab, setTabMuted, setTabPinned, type BulkClose, type NewTabKind, type TabMove } from "@/lib/tabActions";
import { tabPaneId, tabViewIn } from "@/lib/tabFront";
import { panesOf, useTabState } from "@/lib/tabLayouts";
import { subscribeTabPty, toggleTabView, useTabViews } from "@/lib/tabViews";
import { getTerminalState, type SelectedSessionTab } from "@/lib/terminal";
import { listen } from "@tauri-apps/api/event";
import { IssueLinkContextItems } from "@/components/session/IssueLinkMenuItems";
import { copyText } from "@/lib/clipboard";
import { agent as agentApi, errorMessage } from "@/lib/api";
import { openChatLink, parseChatLink } from "@/lib/chatLinks";
import { dismissErrorKey, showError, type ErrorToastAction } from "@/lib/errorToasts";
import type { SessionEntry, TabEntry } from "@/types/session";
import { switchTabAccount, useAccountSwitch } from "@/components/session/AccountSwitch";

const BULK: BulkClose[] = ["others", "right", "left", "idle", "all"];

const copy = (text: string) => void copyText(text).catch(() => {});

const failed = (what: string) => (error: unknown) => console.error(`${what} failed`, error);

// ------------------------------------------------- telling a failed open or close (PRO-291)

/** An agent's name as the app shows it: "Claude Code" for `claude`. */
const agentNameOf = (harness: string) => getSessionStore().harnesses.find((candidate) => candidate.id === harness)?.name ?? harness;

/** The agent settings file a startup error names, home folder written as `~`: what "Open settings.json" opens. */
export function settingsFileIn(text: string): string | null {
  return text.match(/(?:~|\/)[^\s:'"`()]*\/settings(?:\.local)?\.json\b/)?.[0] ?? null;
}

async function openSettingsFile(sessionId: string, cwd: string, file: string) {
  const path = file.startsWith("~/") ? `${(await import("@tauri-apps/api/path").then((paths) => paths.homeDir())).replace(/\/+$/, "")}${file.slice(1)}` : file;
  await openChatLink(parseChatLink(path), { sessionId, cwd });
}

/**
 * How long a new tab is watched for its agent exiting while starting: as long
 * as the backend tells its first start apart (`FIRST_START_WATCH`).
 */
export const START_WATCH_MS = 10_000;

/** The pane exits heard from now on: listening before an agent starts, so a quick exit is not missed. */
async function hearPaneExits() {
  const gone = new Set<string>();
  let wake: (() => void) | null = null;
  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<{ id: string }>("pty_exit", (event) => { gone.add(event.payload.id); wake?.(); });
  } catch { /* outside a webview */ }
  return {
    /** Whether one of `panes` exits within `ms`, or has. */
    within(panes: () => Iterable<string>, ms: number): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const finish = (exited: boolean) => { window.clearTimeout(timer); wake = null; resolve(exited); };
        const check = () => { if ([...panes()].some((pane) => gone.has(pane))) finish(true); };
        const timer = window.setTimeout(() => finish(false), ms);
        wake = check;
        check();
      });
    },
    stop: () => { wake = null; unlisten?.(); },
  };
}

/**
 * Open an agent tab and see its agent start (PRO-291). A tab that cannot be
 * added, or whose agent exits while starting, is not left behind empty: it
 * is closed, and the toast says why, with the agent's own last line under it,
 * Try again, and Open settings.json when that line names the agent's
 * settings file. Resolves whether the tab opened, as soon as its agent was
 * started: nothing waits on it, its pane is shown as it always is, and it is
 * watched for [`START_WATCH_MS`] after.
 */
export async function openAgentTabTelling(session: Pick<SessionEntry, "id" | "cwd">, harness: string, add: () => Promise<TabEntry>): Promise<boolean> {
  const key = `open:${session.id}:${harness}`;
  const retry: ErrorToastAction = { label: "Try again", icon: "retry", run: () => openAgentTabTelling(session, harness, add) };
  const name = agentNameOf(harness);
  // What was on screen before: it is again if the new tab does not stay.
  const before = getTerminalState().selected[session.id] ?? null;
  let tab: TabEntry;
  try {
    tab = await add();
  } catch (error) {
    showError("", undefined, { title: `Couldn't open a new ${name} tab: ${errorMessage(error).trim().replace(/[.:]+$/, "")}`, key, actions: [retry], copy: false });
    return false;
  }
  const notStarted = async (error: unknown) => {
    // Nothing to keep: a tab whose agent never got going is closed again,
    // and what was on screen before is again if this tab still was.
    const now = getTerminalState().selected[session.id];
    const shown = !now || (now.kind === "agent" && now.id === tab.id);
    await removeTab(session.id, tab.id).catch(failed("closing the tab that did not start"));
    if (shown && before && before.id !== tab.id) activatePeer(session.id, before);
    const [reason, ...rest] = errorMessage(error).trim().split("\n");
    const detail = rest.join("\n").trim();
    const file = settingsFileIn(detail);
    const actions: ErrorToastAction[] = [retry];
    if (file) actions.push({ label: `Open ${file.split("/").pop()}`, keepOpen: true, run: () => openSettingsFile(session.id, session.cwd, file) });
    showError("", detail || undefined, { title: `Couldn't open a new ${name} tab: ${reason.replace(/[.:]+$/, "")}`, key, actions, copy: false });
  };
  const exits = await hearPaneExits();
  try {
    // Listening first, as the tab's own view does, so its pane is not missed.
    await subscribeTabPty().catch(() => undefined);
    await agentApi.startOnOpen(session.id, tab.id);
  } catch (error) {
    exits.stop();
    await notStarted(error);
    return false;
  }
  dismissErrorKey(key);
  void watchStart(session.id, tab, exits, notStarted);
  return true;
}

/**
 * Watch a new tab whose agent was started: if its pane exits within
 * [`START_WATCH_MS`], ask the backend again, which says whether it exited
 * while starting (and starts nothing when it went otherwise, or was stopped).
 */
async function watchStart(sessionId: string, tab: TabEntry, exits: Awaited<ReturnType<typeof hearPaneExits>>, notStarted: (error: unknown) => Promise<void>) {
  const panes = new Set([tabPaneId(tab)]);
  void agentApi.tabPane(sessionId, tab.id).then((pane) => { if (pane) panes.add(pane.paneId); }, () => undefined);
  const exited = await exits.within(() => panes, START_WATCH_MS);
  exits.stop();
  if (!exited) return;
  try {
    await agentApi.startOnOpen(sessionId, tab.id);
  } catch (error) {
    // Only the backend's word that it exited while starting: a tab being
    // closed meanwhile is not found, which is no failure to tell.
    if (/exited while starting/.test(errorMessage(error))) await notStarted(error);
  }
}

/**
 * Close a tab and say so when it would not close (PRO-291): its agent did not
 * stop in time, so it is still open and back on screen if it was, and the
 * toast offers Try again. Resolves whether it closed.
 */
export async function closeTabTelling(sessionId: string, tab: PeerTab, tabs: PeerTab[], selected: SelectedSessionTab | null | undefined, label: string): Promise<boolean> {
  const key = `close:${tab.key}`;
  try {
    await closePeer(sessionId, tab, tabs, selected);
  } catch (error) {
    // The view went to a neighbour before the close was refused: it comes back.
    if (selected?.kind === tab.kind && selected.id === tab.id) {
      const owner = sessionOfPeer(sessionId, tab);
      if (getSessionStore().selectedSessionId !== owner) selectSession(owner);
      activatePeer(owner, selected);
    }
    const cause = errorMessage(error).trim().replace(/[.]+$/, "");
    const timedOut = /didn't stop within/i.test(cause);
    const chat = tab.kind === "agent" && !isShellPeer(tab);
    showError(timedOut ? `${cause}, so “${label}” is still open` : `“${label}” is still open`, timedOut ? undefined : cause, {
      title: chat ? "Couldn't close the chat. Try again." : "Couldn't close the tab. Try again.",
      key,
      // Try again alone, on one row (03.29): the sentence says all there is to copy.
      copy: false,
      actions: [{ label: "Try again", icon: "retry", run: () => closeTabTelling(sessionId, tab, tabs, getTerminalState().selected[sessionId] ?? null, label) }],
    });
    return false;
  }
  dismissErrorKey(key);
  return true;
}

/**
 * Close a tab of `row` and say so when it would not close: through the
 * runtime for a remote row (#1325), else as `closeTabTelling` does.
 */
export async function closeRowTabTelling(row: TabRow, tab: PeerTab, selected: SelectedSessionTab | null | undefined, label: string): Promise<boolean> {
  if (!row.remote) return closeTabTelling(row.session.id, tab, row.tabs, selected, label);
  const key = `close:${tab.key}`;
  try {
    await closeRemoteTab(row, tab, selected ?? null);
  } catch (error) {
    showError(`“${label}” is still open`, errorMessage(error), {
      title: tab.kind === "agent" ? "Couldn't close the chat. Try again." : "Couldn't close the tab. Try again.",
      key,
      copy: false,
      actions: [{ label: "Try again", icon: "retry", run: () => closeRowTabTelling(row, tab, getTerminalState().selected[row.session.id] ?? null, label) }],
    });
    return false;
  }
  dismissErrorKey(key);
  return true;
}

/** Open a tab of any kind from the menu, saying so when it could not be opened. */
export function openTabTelling(row: TabRow, what: NewTabKind, after?: PeerTab | null): Promise<boolean> {
  if (what.kind === "agent") {
    const sessionId = after ? sessionOfPeer(row.session.id, after) : row.session.id;
    const session = row.sessions.find((candidate) => candidate.id === sessionId) ?? row.session;
    // Placed by `newTab`; the tab it added is the one its agent is started for.
    return openAgentTabTelling(session, what.harness, async () => {
      const key = await newTab(row, what, after);
      const id = key.slice("agent:".length);
      const tab = getSessionStore().sessions.find((candidate) => candidate.id === session.id)?.tabs.find((candidate) => candidate.id === id);
      if (!tab) throw new Error("the new tab was not listed");
      return tab;
    });
  }
  const noun = what.kind === "terminal" ? "terminal" : "browser tab";
  const key = `open:${row.session.id}:${what.kind}`;
  return newTab(row, what, after).then(
    () => { dismissErrorKey(key); return true; },
    (error: unknown) => {
      showError(`Couldn't open a new ${noun}`, error, { key, actions: [{ label: "Try again", icon: "retry", run: () => openTabTelling(row, what, after) }] });
      return false;
    },
  );
}

/**
 * Switch account (#980): restart the tab's agent on another of its agent's
 * accounts and resume the conversation. Only when the agent has several;
 * off while a turn runs (it would be cut off) or before there is a
 * conversation to resume.
 */
function SwitchAccountItems({ session, tab, live, off }: { session: SessionEntry; tab: TabEntry; live: boolean; off: boolean }) {
  const { targets } = useAccountSwitch(session, tab);
  if (!targets.length) return null;
  const why = live ? "Wait for the turn to end, or stop it, before switching accounts."
    : !tab.providerSessionId ? "Send a message first: there is no conversation to continue yet." : null;
  const key = `switch-account:${session.id}:${tab.id}`;
  const run = (account: (typeof targets)[number]) => void switchTabAccount(session, tab, account).then(
    () => dismissErrorKey(key),
    (error: unknown) => showError(`Couldn't switch to ${account.label}`, error, { key }),
  );
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={off || !!why} title={why ?? undefined}>
        <UserRound /> Switch account
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {targets.map((account) => (
          <ContextMenuItem key={account.id} onSelect={() => run(account)}>{account.label}</ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * Copy what the agent and the reader said in a tab (PRO-381), read again
 * when it was never opened in this window, and say so when there is none.
 */
async function copyTranscript(session: SessionEntry, tab: TabEntry, format: TranscriptFormat, agentName: string) {
  const key = `copy-transcript:${session.id}:${tab.id}`;
  try {
    if (!getTabLog(session.id, tab.id).loaded) await loadTab(session.id, tab.id);
    const text = transcriptText(getTabLog(session.id, tab.id).events, format, agentName, tab.providerSessionId);
    if (!text) throw new Error("nothing has been said in this chat yet");
    await copyText(text);
    dismissErrorKey(key);
  } catch (error) {
    showError("Couldn't copy the transcript", error, { key });
  }
}

async function copyTabLink(session: SessionEntry, tab: TabEntry) {
  const key = `copy-tab-link:${session.id}:${tab.id}`;
  try {
    await copyText(await tabLinkFor(session.id, tab.id));
    dismissErrorKey(key);
  } catch (error) {
    showError("Couldn't copy a link to this tab", error, { key });
  }
}

/**
 * The right-click menu of one tab, the same on the title bar strip and on
 * the sidebar's tab rows. It acts on the tab that was clicked, whether or
 * not it is the one on screen.
 *
 * It is the design's four groups (PRO-381, screen 03.14): the tab itself
 * (rename, unread, pin, mute); where it is shown (the other pane, its
 * terminal view, a fork); what it holds (its transcript, a link to it, a
 * restart); and closing it. Everything else the tab can do is under
 * More ›, so nothing is lost and the menu keeps the design's height.
 *
 * An item that does not apply to the tab is left out, and a tab is what
 * runs in its terminal now (#437): one that is a terminal has a terminal's
 * items, whatever it was opened as. An item this person may not use
 * (`readOnlyReason`: a viewer of a shared session) is shown, off, under a
 * line that says why. A shortcut is shown beside an item when it acts on
 * this tab: the one on screen.
 */
export function TabMenuItems({
  row,
  tab,
  selected,
  readOnlyReason,
}: {
  row: TabRow;
  tab: PeerTab;
  /** The tab on screen in the open session: closing it hands the view to a neighbour. */
  selected: SelectedSessionTab | null;
  readOnlyReason?: string | null;
}) {
  const store = useSessionStore();
  const saved = useTabState();
  const tabViews = useTabViews();
  const keys = useShortcutKeycaps();
  const harnessName = (id: string) => store.harnesses.find((harness) => harness.id === id)?.name;
  const label = peerLabel(tab, row.layout, harnessName);
  // The session the tab belongs to; a browser page belongs to the workspace and is shown in the open one.
  const session = row.sessions.find((candidate) => candidate.id === tab.sessionId) ?? row.session;
  const owner = tab.sessionId ? session : null;
  const shown = tab.kind === selected?.kind && tab.id === selected.id;
  const shortcut = (action: ShortcutId) => (shown && keys(action).length ? <MenuShortcut keys={keys(action)} /> : null);
  const off = !!readOnlyReason;
  const floating = isCompactWindow();
  const wholeRow = useTabRow(row.session);
  const panes = panesOf(wholeRow.layout, wholeRow.tabs.map((peer) => peer.key));
  const muted = row.layout.muted.includes(tab.key);
  const inTerminalView = tab.kind === "agent" && tabViewIn(tabViews.views, tab.tab) === "terminal";
  // What is in the tab now: an agent with a conversation, or a terminal.
  const agentTab = tab.kind === "agent" && !isShellPeer(tab) ? tab.tab : null;
  const agentName = agentTab ? harnessName(agentTab.harness) ?? agentTab.harness : "";
  const counterpart = agentTab && otherAgent(agentTab.harness, store.harnesses);
  const drawnAs = peerAgent(tab);
  const bulk = BULK.map((action) => ({ action, plan: planBulkClose(action, row.tabs, tab) })).filter(({ plan }) => plan.targets.length + plan.pinned.length > 0);
  const closeOthers = bulk.some(({ action }) => action === "others");
  const open = (what: NewTabKind) => void openTabTelling(row, what, tab);
  // The other pane: the right one while there is one pane (the tab splits off), else the one it is not in.
  const toPane = otherPane(wholeRow, tab);
  const canSplit = !(panes.length === 1 && wholeRow.tabs.length < 2);
  const move = (how: TabMove, text: string, icon: ReactNode, action?: ShortcutId) => (
    <ContextMenuItem disabled={off || !canMoveTab(row, tab, how)} onSelect={() => moveTabBy(row, tab, how)}>
      {icon} {text}
      {action ? shortcut(action) : null}
    </ContextMenuItem>
  );
  const restart = async () => {
    // Restarting ends the turn in flight; that is asked about, not assumed.
    if (peerIsLive(tab) && !(await confirmInApp({
      title: "Restart the agent?",
      body: `${label} is ${peerStatus(tab) === "waiting" ? "waiting for an answer" : "working"}. Restarting stops this turn; the conversation is kept and resumes.`,
      action: "Restart",
      destructive: true,
    }))) return;
    await restartTab(row, tab);
  };
  const unread = !!agentTab && (!!agentTab.markedUnread || agentTab.status === "completed");
  const markUnread = () => void agentApi.setUnread(session.id, tab.id, true).catch(failed("marking the tab unread"));

  return (
    <>
      {readOnlyReason ? <ContextMenuLabel className="max-w-64 whitespace-normal normal-case tracking-normal text-muted-foreground">{readOnlyReason}</ContextMenuLabel> : null}

      <ContextMenuItem disabled={off} onSelect={() => openRenameTab(row.session.id, tab.key)}>
        <Pencil /> {agentTab ? "Rename chat…" : "Rename tab…"}
      </ContextMenuItem>
      {hasOwnTitle(tab, row.layout) ? (
        <ContextMenuItem disabled={off} onSelect={() => void renamePeer(row, tab, null).catch(failed("resetting the title"))}>
          <Undo2 /> Reset title
        </ContextMenuItem>
      ) : null}
      {agentTab ? (
        <ContextMenuItem disabled={off || unread} onSelect={markUnread}>
          <Mail /> Mark as unread
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem disabled={off} onSelect={() => setTabPinned(row, tab, !tab.pinned)}>
        {tab.pinned ? <PinOff /> : <Pin />} {tab.pinned ? "Unpin tab" : "Pin tab"}
      </ContextMenuItem>
      {tab.kind === "agent" ? (
        <ContextMenuItem disabled={off} onSelect={() => setTabMuted(row, tab, !muted)}>
          {muted ? <BellRing /> : <BellOff />} {muted ? "Unmute notifications for this tab" : "Mute notifications for this tab"}
        </ContextMenuItem>
      ) : null}

      <ContextMenuSeparator />
      {!floating ? (
        <ContextMenuItem disabled={off || !canSplit} onSelect={() => moveTabToPane(row, tab, toPane, selected)}>
          <Columns2 /> {toPane === "right" ? "Move to the right pane" : "Move to the left pane"}
          {shortcut("session.moveTabToOtherPane")}
        </ContextMenuItem>
      ) : null}
      {tab.kind === "agent" ? (
        <ContextMenuItem disabled={off || !!tabViews.switching[tab.id]} onSelect={() => void toggleTabView(session, tab.tab)}>
          {inTerminalView ? <MessageSquare /> : <SquareTerminal />} {inTerminalView ? "Switch to chat view" : "Switch to terminal view"}
          {shortcut("session.toggleTerminalView")}
        </ContextMenuItem>
      ) : null}
      {agentTab ? (
        <ContextMenuItem disabled={off} onSelect={() => void forkSession(session.id, tab.id).catch(failed("forking the conversation"))}>
          <GitFork /> Fork conversation to new session
          {shortcut("session.forkTab")}
        </ContextMenuItem>
      ) : null}

      <ContextMenuSeparator />
      {agentTab ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Copy /> Copy transcript
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => void copyTranscript(session, agentTab, "markdown", agentName)}>As Markdown</ContextMenuItem>
            <ContextMenuItem onSelect={() => void copyTranscript(session, agentTab, "text", agentName)}>As plain text</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      {agentTab ? (
        <ContextMenuItem onSelect={() => void copyTabLink(session, agentTab)}>
          <Link /> Copy link to this tab
        </ContextMenuItem>
      ) : null}
      {tab.kind === "browser" ? (
        <ContextMenuItem onSelect={() => void restartTab(row, tab).catch(failed("reloading the page"))}>
          <RotateCw /> Reload
        </ContextMenuItem>
      ) : null}
      {canRestartAgent(tab) ? (
        <ContextMenuItem disabled={off} onSelect={() => void restart().catch(failed("restarting the agent"))}>
          <RotateCw /> Restart agent
        </ContextMenuItem>
      ) : null}
      {tab.kind === "terminal" && peerShell(tab)?.exited ? (
        <ContextMenuItem disabled={off} onSelect={() => void restartTab(row, tab).catch(failed("restarting the shell"))}>
          <RotateCw /> Restart shell
        </ContextMenuItem>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Ellipsis /> More
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-h-(--radix-context-menu-content-available-height) overflow-y-auto">
          {tab.kind !== "review" && <ContextMenuItem disabled={off} onSelect={() => void duplicateTab(row, tab).catch(failed("duplicating the tab"))}>
            <CopyPlus /> Duplicate tab
          </ContextMenuItem>}
          {agentTab && counterpart ? (
            <ContextMenuItem disabled={off} onSelect={() => openAgentHandoff(session, agentTab, counterpart.id)}>
              <AgentMark id={counterpart.id} decorative /> Hand off to {counterpart.name}
            </ContextMenuItem>
          ) : null}
          {tab.kind === "agent" && !floating ? (
            <ContextMenuItem onSelect={() => void showFloatingWindow(session.id, tab.id).catch(failed("opening the floating window"))}>
              <PictureInPicture2 /> Open in floating window
            </ContextMenuItem>
          ) : null}
          {agentTab ? <SwitchAccountItems session={session} tab={agentTab} live={peerIsLive(tab)} off={off} /> : null}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Copy /> Copy
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => copy(label)}>Tab title</ContextMenuItem>
              {tab.kind !== "browser" ? <ContextMenuItem onSelect={() => copy(session.cwd)}>Working directory</ContextMenuItem> : null}
              {tab.kind === "agent" && tab.tab.providerSessionId ? <ContextMenuItem onSelect={() => copy(tab.tab.providerSessionId!)}>Conversation id</ContextMenuItem> : null}
              {tab.kind === "browser" && tab.page.url ? <ContextMenuItem onSelect={() => copy(tab.page.url)}>Page address</ContextMenuItem> : null}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {tab.kind !== "browser" ? (
            <ContextMenuItem onSelect={() => void revealItemInDir(session.cwd).catch(failed("revealing the working directory"))}>
              <FolderOpen /> {isMac ? "Reveal working directory in Finder" : "Reveal working directory in the file manager"}
            </ContextMenuItem>
          ) : null}
          {drawnAs ? (
            <ContextMenuItem onSelect={() => openSkills({ agent: drawnAs, projectPath: session.cwd })}>
              <Sparkles /> Skills for this agent…
            </ContextMenuItem>
          ) : null}
          {owner ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <MessageSquare /> <span className="max-w-56 truncate">Session “{owner.title}”</span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem disabled={off} onSelect={() => void (owner.archived ? archiveSession(owner.id, false) : archiveWithUndo(owner.id)).catch(failed("archiving the session"))}>
                  <Archive /> {owner.archived ? "Unarchive" : "Archive"}
                </ContextMenuItem>
                {/* The floating window has no share dialog to open. */}
                {!floating ? (
                  <ContextMenuItem disabled={off} onSelect={() => openSessionShare(owner.id)}>
                    <Share2 /> Share…
                  </ContextMenuItem>
                ) : null}
                {/* Nor a dialog to link an issue in. */}
                {!floating ? <IssueLinkContextItems session={owner} disabled={off} /> : null}
                <ContextMenuItem destructive disabled={off} onSelect={() => void confirmDeleteSession(owner)}>
                  <Trash2 /> {isQuickChat(owner) ? "Delete quick chat…" : "Delete…"}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <MoveHorizontal /> Move tab
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {move("left", "Move tab left", <ArrowLeft />, "session.moveTabLeft")}
              {move("right", "Move tab right", <ArrowRight />, "session.moveTabRight")}
              {move("start", "Move to start", <ArrowLeftToLine />)}
              {move("end", "Move to end", <ArrowRightToLine />)}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {bulk.some(({ action }) => action !== "others") || canReopenTab(row, saved) ? <ContextMenuSeparator /> : null}
          {bulk.filter(({ action }) => action !== "others").map(({ action }) => (
            <ContextMenuItem key={action} disabled={off} onSelect={() => openCloseTabs(row.session.id, action, tab.key)}>
              <X /> {BULK_CLOSE_LABEL[action]}…
            </ContextMenuItem>
          ))}
          {canReopenTab(row, saved) ? (
            <ContextMenuItem disabled={off} onSelect={() => void reopenClosedTab(row).catch(failed("reopening the tab"))}>
              <RotateCcw /> Reopen closed tab
              {keys("session.reopenTab").length ? <MenuShortcut keys={keys("session.reopenTab")} /> : null}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={off}>
              <Plus /> New agent tab
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {store.harnesses.map((harness) => (
                <ContextMenuItem key={harness.id} disabled={!harness.available} onSelect={() => open({ kind: "agent", harness: harness.id, model: getPrefs().lastModel[harness.id], effort: getPrefs().lastEffort[harness.id] ?? null, mode: getPrefs().lastMode })}>
                  <AgentMark id={harness.id} decorative />
                  <span>{harness.name}</span>
                  {!harness.available ? <span className="ml-auto pl-3 text-[12px] text-faint">not installed</span> : null}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem disabled={off} onSelect={() => open({ kind: "terminal" })}>
            <TerminalSquare /> New terminal
          </ContextMenuItem>
          <ContextMenuItem disabled={off} onSelect={() => open({ kind: "browser" })}>
            <Globe /> New browser tab
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />
      {/* In the menu's own colour (03.14): closing a tab keeps its conversation, so it is no destructive act. */}
      <ContextMenuItem disabled={off} onSelect={() => void closeTabTelling(row.session.id, tab, row.tabs, selected, label)}>
        <X /> Close tab
        {shortcut("session.closeTab")}
      </ContextMenuItem>
      {closeOthers ? (
        <ContextMenuItem disabled={off} onSelect={() => openCloseTabs(row.session.id, "others", tab.key)}>
          <span aria-hidden className="size-4 shrink-0" /> {BULK_CLOSE_LABEL.others}
        </ContextMenuItem>
      ) : null}
    </>
  );
}

/**
 * The right-click menu of a remote session's tab (#1325). Its tabs are the
 * runtime's, so the menu holds what is this viewer's (a pin, its place in the
 * row, which pane it is in), its terminal view where the runtime serves one,
 * and closing it, which closes it for everyone in the workspace. What the
 * runtime cannot do for a tab yet (rename, fork, mute, restart) is left out.
 */
export function RemoteTabMenuItems({ row, tab, selected, readOnlyReason }: { row: TabRow; tab: PeerTab; selected: SelectedSessionTab | null; readOnlyReason?: string | null }) {
  const keys = useShortcutKeycaps();
  const tabViews = useTabViews();
  const whole = row.remote!.current();
  const panes = panesOf(whole.layout, whole.tabs.map((peer) => peer.key));
  const shown = tab.kind === selected?.kind && tab.id === selected.id;
  const shortcut = (action: ShortcutId) => (shown && keys(action).length ? <MenuShortcut keys={keys(action)} /> : null);
  const off = !!readOnlyReason;
  const toPane = otherPane(whole, tab);
  const canSplit = !(panes.length === 1 && whole.tabs.length < 2);
  const toggleView = tab.kind === "agent" ? row.remote!.terminalView(tab.tab) : null;
  const inTerminalView = tab.kind === "agent" && tabViewIn(tabViews.views, tab.tab) === "terminal";
  const label = peerLabel(tab, row.layout, cloudAgentLabel);
  const move = (how: TabMove, text: string, icon: ReactNode, action?: ShortcutId) => (
    <ContextMenuItem disabled={!canMoveTab(row, tab, how)} onSelect={() => moveTabBy(row, tab, how)}>
      {icon} {text}
      {action ? shortcut(action) : null}
    </ContextMenuItem>
  );
  return (
    <>
      <ContextMenuItem onSelect={() => setTabPinned(whole, tab, !tab.pinned)}>
        {tab.pinned ? <PinOff /> : <Pin />} {tab.pinned ? "Unpin tab" : "Pin tab"}
      </ContextMenuItem>
      {!isCompactWindow() ? (
        <ContextMenuItem disabled={!canSplit} onSelect={() => moveTabToPane(whole, tab, toPane, selected)}>
          <Columns2 /> {toPane === "right" ? "Move to the right pane" : "Move to the left pane"}
          {shortcut("session.moveTabToOtherPane")}
        </ContextMenuItem>
      ) : null}
      {toggleView && tab.kind === "agent" ? (
        <ContextMenuItem disabled={!!tabViews.switching[tab.id]} onSelect={toggleView}>
          {inTerminalView ? <MessageSquare /> : <SquareTerminal />} {inTerminalView ? "Switch to chat view" : "Switch to terminal view"}
          {shortcut("session.toggleTerminalView")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <MoveHorizontal /> Move tab
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {move("left", "Move tab left", <ArrowLeft />, "session.moveTabLeft")}
          {move("right", "Move tab right", <ArrowRight />, "session.moveTabRight")}
          {move("start", "Move to start", <ArrowLeftToLine />)}
          {move("end", "Move to end", <ArrowRightToLine />)}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      {readOnlyReason ? <ContextMenuLabel className="max-w-64 whitespace-normal normal-case tracking-normal text-muted-foreground">{readOnlyReason}</ContextMenuLabel> : null}
      {/* Closing a runtime tab closes it for everyone in the workspace; an agent tab's process stops with it. */}
      <ContextMenuItem disabled={off} onSelect={() => void closeRowTabTelling(row, tab, selected, label)}>
        <X /> Close tab
        {shortcut("session.closeTab")}
      </ContextMenuItem>
    </>
  );
}
