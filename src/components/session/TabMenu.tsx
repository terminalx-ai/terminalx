import type { ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  BellOff,
  BellRing,
  Copy,
  CopyPlus,
  FolderOpen,
  GitFork,
  Globe,
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
  Terminal,
  TerminalSquare,
  Trash2,
  Undo2,
  X,
} from "@/icons";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AgentMark } from "@/components/AgentMark";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, MenuShortcut } from "@/components/ui/menu";
import { isCompactWindow } from "@/lib/appWindow";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { openAgentHandoff, openCloseTabs, openRenameTab } from "@/lib/dialogs";
import { otherAgent } from "@/lib/agentHandoff";
import { showFloatingWindow } from "@/lib/floating";
import { isMac, useShortcutKeycaps } from "@/lib/hotkeys";
import { openSessionShare } from "@/lib/localSharing";
import { getPrefs } from "@/lib/prefs";
import { isQuickChat } from "@/lib/quickChats";
import { archiveSession, forkSession, getSessionStore, openSkills, removeTab, selectSession, useSessionStore } from "@/lib/sessions";
import { useTabRow, activatePeer, closePeer, hasOwnTitle, isShellPeer, peerAgent, peerIsLive, peerLabel, peerShell, peerStatus, sessionOfPeer, type PeerTab, type TabRow } from "@/lib/sessionTabs";
import { BULK_CLOSE_LABEL, canMoveTab, canReopenTab, canRestartAgent, duplicateTab, moveTabBy, newTab, moveTabToPane, otherPane, planBulkClose, renamePeer, reopenClosedTab, restartTab, setTabMuted, setTabPinned, type BulkClose, type NewTabKind, type TabMove } from "@/lib/tabActions";
import { tabViewIn } from "@/lib/tabFront";
import { panesOf, useTabState } from "@/lib/tabLayouts";
import { subscribeTabPty, toggleTabView, useTabViews } from "@/lib/tabViews";
import { getTerminalState, type SelectedSessionTab } from "@/lib/terminal";
import { IssueLinkContextItems } from "@/components/session/IssueLinkMenuItems";
import { copyText } from "@/lib/clipboard";
import { agent as agentApi, errorMessage } from "@/lib/api";
import { openChatLink, parseChatLink } from "@/lib/chatLinks";
import { dismissErrorKey, showError, type ErrorToastAction } from "@/lib/errorToasts";
import type { SessionEntry, TabEntry } from "@/types/session";

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
 * Open an agent tab and see its agent start (PRO-291). A tab that cannot be
 * added, or whose agent exits while starting, is not left behind empty: it
 * is closed, and the toast says why, with the agent's own last line under it,
 * Try again, and Open settings.json when that line names the agent's
 * settings file. Resolves whether the tab opened.
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
    showError("", undefined, { title: `Couldn't open a new ${name} tab: ${errorMessage(error).trim().replace(/[.:]+$/, "")}`, key, actions: [retry] });
    return false;
  }
  try {
    // Listening first, as the tab's own view does, so its pane is not missed.
    await subscribeTabPty().catch(() => undefined);
    await agentApi.startOnOpen(session.id, tab.id);
  } catch (error) {
    // Nothing to keep: a tab whose agent never got going is closed again.
    await removeTab(session.id, tab.id).catch(failed("closing the tab that did not start"));
    if (before && before.id !== tab.id) activatePeer(session.id, before);
    const [reason, ...rest] = errorMessage(error).trim().split("\n");
    const detail = rest.join("\n").trim();
    const file = settingsFileIn(detail);
    const actions: ErrorToastAction[] = [retry];
    if (file) actions.push({ label: `Open ${file.split("/").pop()}`, keepOpen: true, run: () => openSettingsFile(session.id, session.cwd, file) });
    showError("", detail || undefined, { title: `Couldn't open a new ${name} tab: ${reason.replace(/[.:]+$/, "")}`, key, actions });
    return false;
  }
  dismissErrorKey(key);
  return true;
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
      actions: [{ label: "Try again", icon: "retry", run: () => closeTabTelling(sessionId, tab, tabs, getTerminalState().selected[sessionId] ?? null, label) }],
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
 * The right-click menu of one tab, the same on the title bar strip and on
 * the sidebar's tab rows. It acts on the tab that was clicked, whether or
 * not it is the one on screen.
 *
 * An item that does not apply to the tab is left out, and a tab is what
 * runs in its terminal now (#437): one that is a terminal has a terminal's
 * items, whatever it was opened as. An item this person may not use
 * (`readOnlyReason`: a viewer of a shared session) is shown, off, under a
 * line that says why.
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
  const off = !!readOnlyReason;
  const floating = isCompactWindow();
  const wholeRow = useTabRow(row.session);
  const panes = panesOf(wholeRow.layout, wholeRow.tabs.map((peer) => peer.key));
  const muted = row.layout.muted.includes(tab.key);
  const inTerminalView = tab.kind === "agent" && tabViewIn(tabViews.views, tab.tab) === "terminal";
  // What is in the tab now: an agent with a conversation, or a terminal.
  const agentTab = tab.kind === "agent" && !isShellPeer(tab) ? tab.tab : null;
  const counterpart = agentTab && otherAgent(agentTab.harness, store.harnesses);
  const drawnAs = peerAgent(tab);
  const bulk = BULK.map((action) => ({ action, plan: planBulkClose(action, row.tabs, tab) })).filter(({ plan }) => plan.targets.length + plan.pinned.length > 0);
  const open = (what: NewTabKind) => void openTabTelling(row, what, tab);
  const move = (how: TabMove, text: string, icon: ReactNode, shortcut?: string[]) => (
    <ContextMenuItem disabled={off || !canMoveTab(row, tab, how)} onSelect={() => moveTabBy(row, tab, how)}>
      {icon} {text}
      {shortcut?.length ? <MenuShortcut keys={shortcut} /> : null}
    </ContextMenuItem>
  );
  const restart = async () => {
    // Restarting ends the turn in flight; that is asked about, not assumed.
    if (peerIsLive(tab) && !(await ask(`${label} is ${peerStatus(tab) === "waiting" ? "waiting for an answer" : "working"}. Restarting the agent stops this turn; the conversation is kept and resumes.`, { title: "Restart agent", kind: "warning", okLabel: "Restart", cancelLabel: "Cancel" }).catch(() => false))) return;
    await restartTab(row, tab);
  };

  return (
    <>
      {readOnlyReason ? <ContextMenuLabel className="max-w-64 whitespace-normal normal-case tracking-normal text-muted-foreground">{readOnlyReason}</ContextMenuLabel> : null}

      <ContextMenuItem disabled={off} onSelect={() => openRenameTab(row.session.id, tab.key)}>
        <Pencil /> Rename…
      </ContextMenuItem>
      {hasOwnTitle(tab, row.layout) ? (
        <ContextMenuItem disabled={off} onSelect={() => void renamePeer(row, tab, null).catch(failed("resetting the title"))}>
          <Undo2 /> Reset title
        </ContextMenuItem>
      ) : null}
      {tab.kind === "agent" ? (
        <ContextMenuItem disabled={off || !!tabViews.switching[tab.id]} onSelect={() => void toggleTabView(session, tab.tab)}>
          {inTerminalView ? <MessageSquare /> : <Terminal />} {inTerminalView ? "Switch to chat view" : "Switch to terminal view"}
        </ContextMenuItem>
      ) : null}
      {tab.kind !== "review" && <ContextMenuItem disabled={off} onSelect={() => void duplicateTab(row, tab).catch(failed("duplicating the tab"))}>
        <CopyPlus /> Duplicate tab
      </ContextMenuItem>}
      {agentTab ? (
        <ContextMenuItem disabled={off} onSelect={() => void forkSession(session.id, tab.id).catch(failed("forking the conversation"))}>
          <GitFork /> Fork conversation
        </ContextMenuItem>
      ) : null}
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
      <ContextMenuItem disabled={off} onSelect={() => setTabPinned(row, tab, !tab.pinned)}>
        {tab.pinned ? <PinOff /> : <Pin />} {tab.pinned ? "Unpin tab" : "Pin tab"}
      </ContextMenuItem>
      {tab.kind === "agent" ? (
        <ContextMenuItem disabled={off} onSelect={() => setTabMuted(row, tab, !muted)}>
          {muted ? <BellRing /> : <BellOff />} {muted ? "Unmute notifications for this tab" : "Mute notifications for this tab"}
        </ContextMenuItem>
      ) : null}
      {owner ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <MessageSquare /> <span className="max-w-56 truncate">Session “{owner.title}”</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem disabled={off} onSelect={() => void archiveSession(owner.id, !owner.archived).catch(failed("archiving the session"))}>
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
      {!floating && <ContextMenuItem disabled={off || (panes.length === 1 && wholeRow.tabs.length < 2) || (panes.length === 2 && panes[1].tabs.includes(tab.key))} onSelect={() => moveTabToPane(row, tab, "right", selected)}>
        <MoveHorizontal /> Split right
      </ContextMenuItem>}
      {!floating && row.layout.panes && <ContextMenuItem disabled={off} onSelect={() => moveTabToPane(row, tab, otherPane(wholeRow, tab), selected)}>
        <MoveHorizontal /> Move tab to other pane
        <MenuShortcut keys={keys("session.moveTabToOtherPane")} />
      </ContextMenuItem>}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <MoveHorizontal /> Move tab
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {move("left", "Move tab left", <ArrowLeft />, keys("session.moveTabLeft"))}
          {move("right", "Move tab right", <ArrowRight />, keys("session.moveTabRight"))}
          {move("start", "Move to start", <ArrowLeftToLine />)}
          {move("end", "Move to end", <ArrowRightToLine />)}
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />
      <ContextMenuItem destructive disabled={off} onSelect={() => void closeTabTelling(row.session.id, tab, row.tabs, selected, label)}>
        <X /> Close tab
        {shown && keys("session.closeTab").length ? <MenuShortcut keys={keys("session.closeTab")} /> : null}
      </ContextMenuItem>
      {bulk.map(({ action }) => (
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
              {!harness.available ? <span className="ml-auto pl-3 text-[11px] text-faint">not installed</span> : null}
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
    </>
  );
}
