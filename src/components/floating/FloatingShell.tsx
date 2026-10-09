import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ChevronDown, Ellipsis, MessageCirclePlus, Pin, PinOff, Trash2 } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { Toasts } from "@/components/ui/Toasts";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { BypassDialog } from "@/components/session/BypassDialog";
import { NewSessionView } from "@/components/session/NewSessionView";
import { QuickChatMenuItems, RenameSessionItem } from "@/components/session/QuickChatMenuItems";
import { SessionDialogs } from "@/components/session/SessionDialogs";
import { SessionView, type SessionChrome } from "@/components/session/SessionView";
import { applyEvent, subscribeAgentEvents } from "@/lib/agentEvents";
import { agent, floatingWindow, type ImageInput, type OpenTarget } from "@/lib/api";
import { cn } from "@/lib/cn";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { bootFloating, hideFloatingWindow, saveFloatingSettings, setFloatingSession, useFloating } from "@/lib/floating";
import { hasEscapeOverlay, inTerminal, useShortcut } from "@/lib/hotkeys";
import { loadModels } from "@/lib/models";
import { startNotifications } from "@/lib/notify";
import { isQuickChat, quickChatsOf } from "@/lib/quickChats";
import { bootSessions, openTarget, selectSession, useSessionStore } from "@/lib/sessions";
import { subscribeTabPty } from "@/lib/tabViews";
import { getTerminalState } from "@/lib/terminal";
import { sessionStatus, TAB_STATUS_LABEL, type SessionEntry, type TabStatus } from "@/types/session";

/** How many quick chats the switcher lists before it points at the main window for the rest. */
const RECENT_LIMIT = 12;

const STATUS_DOT: Partial<Record<TabStatus, string>> = {
  waiting: "bg-warning",
  completed: "bg-add",
  in_progress: "bg-info animate-pulse-soft",
};

/** Put the caret where the reader types: the composer of the tab on screen, or the start screen's prompt. */
function focusPrompt() {
  const fields = [...document.querySelectorAll<HTMLTextAreaElement>("[data-composer], [data-new-session-prompt]")];
  // Every agent tab keeps its composer mounted; only the one on screen is outside a hidden panel.
  fields.find((field) => !field.closest('[aria-hidden="true"], [hidden]'))?.focus({ preventScroll: true });
}

/**
 * The floating chat window: one session in a compact column, or the start
 * screen for a new quick chat.
 *
 * It draws the same session components as the main window (`SessionView`,
 * the composer, the tab actions, the continuation dialog) and decides only
 * the chrome around them: no sidebar and no right panel, a switcher where the
 * breadcrumb is, and the session's tabs in a strip. Everything it shows is
 * app state the main window shows too; hiding it stops nothing.
 */
export function FloatingShell() {
  const store = useSessionStore();
  const floating = useFloating();
  /** A session this window was asked to show before the session list had loaded. */
  const [asked, setAsked] = useState<OpenTarget | null>(null);
  /** The session to open on has been decided; from then on this window's own selection is what is remembered. */
  const settled = useRef(false);

  useEffect(() => {
    void subscribeAgentEvents();
    void subscribeTabPty();
    void bootSessions();
    void loadModels();
    startNotifications();
    void bootFloating((target) => setAsked(target));
  }, []);

  // Open on what was asked for; failing that, on the chat this window showed last.
  useEffect(() => {
    if (!store.loaded) return;
    if (asked) {
      settled.current = true;
      setAsked(null);
      // An empty id asks for the start screen: a new quick chat.
      if (!asked.sessionId) selectSession(null);
      else openTarget(asked);
      return;
    }
    if (settled.current) return;
    settled.current = true;
    const last = store.sessions.find((session) => session.id === floating.sessionId && !session.archived);
    if (last) selectSession(last.id);
  }, [store.loaded, asked, store.sessions, floating.sessionId]);

  const selected = store.sessions.find((session) => session.id === store.selectedSessionId) ?? null;
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (settled.current) setFloatingSession(selectedId);
  }, [selectedId]);

  // The first prompt of a new chat is sent once its session exists, as in the main window.
  const onCreated = useCallback((sessionId: string, tabId: string, text: string, images?: ImageInput[]) => {
    void agent
      .send(sessionId, tabId, text, images)
      .then((out) => out.events.forEach(applyEvent))
      .catch((e) => console.error("first send failed", e));
  }, []);

  const newChat = useCallback(() => {
    selectSession(null);
    requestAnimationFrame(focusPrompt);
  }, []);
  useShortcut("app.newSession", newChat);

  // Shown again (the shortcut, the tray, a notification): ready to type.
  const visible = floating.visible;
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(focusPrompt);
    return () => cancelAnimationFrame(frame);
  }, [visible, selectedId]);

  // Escape puts the window away when nothing else wanted the key: a menu or a
  // dialog closes first, a running turn is stopped first, and a terminal keeps
  // its Escape. This listens after all of those (the bubble phase).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (hasEscapeOverlay() || inTerminal(event.target)) return;
      event.preventDefault();
      void hideFloatingWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const chrome: SessionChrome = {
    compact: true,
    tabStrip: true,
    leading: <QuickChatSwitcher current={selected} onNew={newChat} />,
    trailing: selected ? <WindowActions session={selected} /> : null,
  };

  return (
    <div data-app-shell data-floating-shell className="flex h-full w-full flex-col">
      <div className="pointer-events-none fixed bottom-3 right-3 z-(--z-toast) flex max-h-[calc(100dvh-1.5rem)] w-[320px] max-w-[calc(100vw-1.5rem)] flex-col gap-2">
        <Toasts />
      </div>
      <BypassDialog />
      <SessionDialogs />
      {/* A hidden window shows nothing to anyone: its session view is not kept on screen for it, so a
          finished tab is not marked read behind the reader's back. What the view held is in the stores.
          The start screen stays: it reads nothing, and a prompt half typed there must survive a hide. */}
      {selected && !visible ? null : selected ? (
        <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip">
          <ErrorBoundary key={selected.id} label="the session">
            <SessionView session={selected} sidebarOpen={false} onToggleSidebar={() => undefined} chrome={chrome} />
          </ErrorBoundary>
        </main>
      ) : (
        <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip">
          <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2" style={{ paddingLeft: TITLEBAR_INSET }}>
            <div className="flex min-w-0 flex-1 items-center gap-1 text-sm">
              <QuickChatSwitcher current={null} onNew={newChat} />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <PinButton />
              <WithTooltip label="Open the main window">
                <Button variant="ghost" size="icon-sm" aria-label="Open the main window" onClick={() => void floatingWindow.openInMain("")}>
                  <AppWindow />
                </Button>
              </WithTooltip>
            </div>
          </header>
          <div className="min-h-0 flex-1">
            {store.loaded ? <NewSessionView quick compact onCreated={onCreated} /> : null}
          </div>
        </main>
      )}
    </div>
  );
}

/** Keeps the window above other apps' windows, or lets it go behind them. */
function PinButton() {
  const status = useFloating().status;
  const pinned = status?.alwaysOnTop ?? true;
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setError(null);
    saveFloatingSettings({ alwaysOnTop: !pinned }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <WithTooltip label={error ?? (pinned ? "Stays on top of other windows. Click to unpin." : "Keep on top of other windows")}>
      <Button variant="ghost" size="icon-sm" aria-label="Keep on top" aria-pressed={pinned} onClick={toggle} className={cn(pinned && "bg-veil-strong text-foreground")}>
        {pinned ? <Pin /> : <PinOff />}
      </Button>
    </WithTooltip>
  );
}

/** The window's own actions on the session it shows, after the session's own (new tab, handoff, terminal view). */
function WindowActions({ session }: { session: SessionEntry }) {
  const menu = useRowMenu();
  const openInMain = () => {
    // On the tab this window shows, so the main window opens where the reader was.
    const shown = getTerminalState().selected[session.id];
    const tabId = shown?.kind === "agent" ? shown.id : (session.activeTab ?? null);
    void floatingWindow.openInMain(session.id, tabId);
  };
  return (
    <>
      <PinButton />
      <WithTooltip label="Open in main window">
        <Button variant="ghost" size="icon-sm" aria-label="Open in main window" onClick={openInMain}>
          <AppWindow />
        </Button>
      </WithTooltip>
      <DropdownMenu {...menu.root}>
        <WithTooltip label="More">
          <DropdownMenuTrigger asChild {...menu.trigger}>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="end" className="min-w-[13rem]">
          <RenameSessionItem session={session} />
          <QuickChatMenuItems session={session} />
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => void confirmDeleteSession(session)}>
            <Trash2 /> {isQuickChat(session) ? "Delete quick chat…" : "Delete session…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * Names the chat on screen and switches between recent quick chats, or
 * starts a new one. It stands where the main window has its breadcrumb.
 */
function QuickChatSwitcher({ current, onNew }: { current: SessionEntry | null; onNew: () => void }) {
  const store = useSessionStore();
  const menu = useRowMenu();
  const chats = quickChatsOf(store.sessions);
  const recent = chats.slice(0, RECENT_LIMIT);
  const harnessOf = (session: SessionEntry) => session.tabs.find((tab) => tab.id === session.activeTab)?.harness ?? session.tabs[0]?.harness ?? null;
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger}>
        <Button variant="ghost" size="sm" className="min-w-0 max-w-full gap-1.5 px-1.5" aria-label={current ? `${current.title}: switch chat` : "Switch chat"} data-testid="quick-chat-switcher">
          <span className="truncate font-medium text-foreground" title={current?.title}>{current ? current.title : "New quick chat"}</span>
          <ChevronDown className="shrink-0 text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[18rem] max-w-[calc(100vw-1rem)]">
        <DropdownMenuItem onSelect={onNew}>
          <MessageCirclePlus /> New quick chat
        </DropdownMenuItem>
        {recent.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Recent quick chats</DropdownMenuLabel>
            {recent.map((session) => {
              const status = sessionStatus(session);
              const harness = harnessOf(session);
              return (
                <DropdownMenuItem key={session.id} onSelect={() => selectSession(session.id)} aria-current={session.id === current?.id ? "true" : undefined} className={cn(session.id === current?.id && "bg-veil-raised")}>
                  {harness ? <AgentMark id={harness} decorative /> : <span className="size-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  {STATUS_DOT[status] && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} aria-label={TAB_STATUS_LABEL[status]} />}
                </DropdownMenuItem>
              );
            })}
            {chats.length > recent.length && (
              <div role="note" className="px-2 py-1 text-[11px] text-muted-foreground">
                {chats.length - recent.length} older {chats.length - recent.length === 1 ? "chat is" : "chats are"} listed under Quick chats in the main window.
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
