import { useMemo, useState } from "react";
import { BotsSidebarSection } from "@/components/bots/BotsSidebarSection";
import { LocalSidebarSections } from "./LocalSidebarSections";
import { groupLocalSessions, useLocalSections } from "@/lib/localSections";
import { Settings, SquarePen } from "@/icons";
import { Button } from "@/components/ui/button";
import { UpdateButton } from "./UpdateNotice";
import { WithTooltip } from "@/components/ui/tooltip";
import { AccountSidebarEntry } from "@/components/account/AccountSidebarEntry";
import { AnnouncementCard } from "./AnnouncementCard";
import { SidebarTitlebar, ViewMenu } from "./SidebarTitlebar";
import { errorMessage } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { conversationTitle, startChat, useSessionStore } from "@/lib/sessions";
import { legacyReviewerSessions, useIssuePipelines } from "@/lib/issuePipeline";
import type { SessionEntry } from "@/types/session";
import { AppDestinations, type RailProps } from "./ProjectRail";
import { ArchivedSessions, ConversationRow, FilteredEmpty, ListHeading, PinnedGroup, RemovedWorkspaces, archivedConversations, conversationLink, locationOf, orderConversations } from "./SessionSidebar";
import { SidebarBulkBar } from "./SidebarBulkBar";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { MachinesSection } from "@/components/machines/MachinesSection";
import { CloudOrganizations } from "./CloudOrganizations";
import { useSidebarOrder } from "@/lib/sidebarOrder";
import { SortableStatusGroups, SidebarDragScope, SidebarSortList, SidebarOrderError } from "./SidebarSort";
import { listedUnderBot } from "@/lib/botChats";
import { useBotStore } from "@/lib/bots";

const canon = (path: string) => path.replace(/\/+$/, "");

/**
 * The session list without projects: grouped by status (02.13), or the reader's sections then one list (View →
 * Group by Sections). Rows are the same compact one-line rows as the project layout's: status mark, title, then
 * PR, line counts or age.
 */
export function ChatListSidebar({ onHide, onOpenSettings, onOpenAccount, onSearch, onOpenHome, onNewSession, onOpenIssues, onOpenAgents, onOpenAutomations }: RailProps) {
  const store = useSessionStore();
  const order = useSidebarOrder();
  const { sidebarLayout, sidebarSort } = usePrefs();
  const byStatus = sidebarLayout === "status";
  const [error, setError] = useState<string | null>(null);
  const chatsPath = store.chatsPath ? canon(store.chatsPath) : null;
  const filter = useSidebarFilter();
  // Archived conversations never pass a filter, so Show archived shows nothing more while one is on.
  const showArchived = store.showArchived && filter.filter === "all";
  // One row per session: a pipeline's reviewer that was opened as a session of its own folds under its author's (PRO-331).
  const pipelines = useIssuePipelines();
  const folded = useMemo(() => legacyReviewerSessions(pipelines, store.sessions), [pipelines, store.sessions]);
  // A bot's chats are listed under their bot (PRO-468), in this layout as in the projects one.
  const { bots } = useBotStore();
  const rows = useMemo(
    () => (folded.size || bots.length ? store.sessions.filter((session) => !folded.has(session.id) && !listedUnderBot(session, bots)) : store.sessions),
    [folded, bots, store.sessions],
  );
  const selectedRow = store.selectedSessionId ? (folded.get(store.selectedSessionId) ?? store.selectedSessionId) : null;
  const conversations = useMemo(
    () => orderConversations(filter.active ? rows.filter((session) => filter.shows(session.id)) : rows, selectedRow, showArchived, sidebarSort, order),
    [filter, rows, selectedRow, showArchived, sidebarSort, order],
  );
  // Show archived (#718): the archived ones, under a fold of their own at the end.
  const archived = useMemo(() => (showArchived ? archivedConversations(rows.filter((session) => filter.shows(session.id)), sidebarSort, order) : []), [showArchived, rows, filter, sidebarSort, order]);
  // Grouped by sections, pinned sessions leave their section for the Pinned group (02.19); by status, they keep their status.
  const pinned = byStatus ? [] : conversations.filter((session) => session.pinned);
  const pinnedIds = new Set(pinned.map((session) => session.id));
  const listed = [...conversations.filter((session) => !pinnedIds.has(session.id)), ...archived];
  // A removed workspace's conversations are kept, but set apart from the live ones under a fold (#696).
  const { sections: localSections } = useLocalSections();
  const sectioned = groupLocalSessions(listed, localSections);
  const ungrouped = new Set(sectioned.ungrouped.map((session) => session.id));
  const ungroupedArchived = archived.filter((session) => ungrouped.has(session.id));
  const ungroupedConversations = conversations.filter((session) => ungrouped.has(session.id));
  const live = ungroupedConversations.filter((session) => !session.worktreeRemoved);
  const removed = ungroupedConversations.filter((session) => session.worktreeRemoved);
  const row = (session: SessionEntry, inArchive = false, inPinned = false) => {
    const link = conversationLink(session, store.projects, chatsPath, store.workspaces);
    return (
      <ConversationRow
        key={session.id}
        session={session}
        selected={selectedRow === session.id}
        branch={link?.branch ?? null}
        locationLabel={link ? locationOf(link) : undefined}
        linkTo={null}
        inArchive={inArchive}
        inPinned={inPinned}
      />
    );
  };

  const run = (action: () => Promise<unknown>) => () => {
    action().then(() => setError(null), (cause) => setError(errorMessage(cause)));
  };
  const newChat = run(() => startChat());
  const hasSections = localSections.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-hairline" data-testid="sidebar-rail">
      <SidebarTitlebar onHide={onHide} />

      <div className="shrink-0 px-2">
        <AppDestinations onOpenHome={onOpenHome} onNewSession={onNewSession} onSearch={onSearch} onOpenIssues={onOpenIssues} onOpenAgents={onOpenAgents} onOpenAutomations={onOpenAutomations} />
      </div>

      {error && <div className="mx-2 mt-1 shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      <SidebarOrderError />
      <nav className="mt-3 min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain scrollbar-thin px-2 pb-2" aria-label="Conversations" data-testid="conversation-list">
        {/* Bots (PRO-467) sit above the project lists, only while their experimental switch is on. */}
        <BotsSidebarSection />
        <ListHeading label="Sessions" note={byStatus ? "by status" : hasSections ? "sections" : undefined} actions={<ViewMenu />} />
        {/* One drag scope: sessions move between the sections and the main list (PRO-174). */}
        <SidebarDragScope>
        <PinnedGroup sessions={pinned} selectedId={selectedRow} showArchived={showArchived}>{(session) => row(session, false, true)}</PinnedGroup>
        <LocalSidebarSections groups={sectioned.sections} filtered={filter.active} groupByStatus={byStatus} renderSession={(session) => row(session)} />
        {conversations.length === 0 && archived.length === 0 && filter.active ? (
          // Nothing local passed; the organizations below may still hold something that did.
          filter.count === 0 ? <FilteredEmpty text={filter.empty} /> : null
        ) : conversations.length === 0 && archived.length === 0 && !hasSections ? (
          <button
            type="button"
            onClick={newChat}
            className="flex w-full flex-col items-center gap-1 rounded-lg px-3 py-6 text-center text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <SquarePen className="size-4" />
            Start a chat.
          </button>
        ) : (
          <>
            {hasSections && (byStatus ? ungroupedConversations : live).length > 0 && <ListHeading label="Other sessions" className="mt-3" />}
            <ul className="flex flex-col" aria-label="Sessions">
              {byStatus ? <SortableStatusGroups sessions={ungroupedConversations} onAdd={onNewSession}>{(session) => row(session)}</SortableStatusGroups> : <SidebarSortList items={live.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>{live.map((session) => row(session))}</SidebarSortList>}
              {!byStatus && removed.length > 0 && (
                <RemovedWorkspaces
                  id="chats"
                  count={new Set(removed.map((session) => session.removedWorkspace?.path ?? session.id)).size}
                  opened={filter.active || removed.some((session) => session.id === store.selectedSessionId)}
                >
                  <SidebarSortList items={removed.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>{removed.map((session) => row(session))}</SidebarSortList>
                </RemovedWorkspaces>
              )}
              {ungroupedArchived.length > 0 && (
                <ArchivedSessions id="list" count={ungroupedArchived.length} opened={ungroupedArchived.some((session) => session.id === store.selectedSessionId)}>
                  {byStatus ? <SortableStatusGroups sessions={ungroupedArchived} scope="local:archived">{(session) => row(session, true)}</SortableStatusGroups> : <SidebarSortList items={ungroupedArchived.map((s) => ({ id: s.id, name: conversationTitle(s) }))}>{ungroupedArchived.map((session) => row(session, true))}</SidebarSortList>}
                </ArchivedSessions>
              )}
            </ul>
          </>
        )}
        </SidebarDragScope>
        <MachinesSection />
        <CloudOrganizations onOpenOrganizations={() => onOpenSettings("organizations")} />
      </nav>

      <AnnouncementCard />
      <SidebarBulkBar sessions={store.sessions} />
      <div className="flex shrink-0 items-center gap-1 border-t border-hairline px-2 pb-2 pt-1" data-testid="sidebar-account-row">
        {/* The account; Settings keeps the far end. */}
        <div className="min-w-0 max-w-[70%]">
          <AccountSidebarEntry onOpenAccount={onOpenAccount} />
        </div>
        <div className="flex-1" />
        <UpdateButton />
        <WithTooltip label="Settings" shortcut="app.settings" side="top">
          <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Settings" onClick={() => onOpenSettings()}>
            <Settings />
          </Button>
        </WithTooltip>
      </div>
    </div>
  );
}
