import { useMemo, useState } from "react";
import { Archive, Ellipsis, GitBranch, Pin, Settings, SquarePen, Trash2 } from "@/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { RowActions, actionRow, yieldsToRowActions } from "@/components/layout/RowActions";
import { AccountSidebarEntry } from "@/components/account/AccountSidebarEntry";
import { SidebarTitlebar } from "./SidebarTitlebar";
import { AgentMark } from "@/components/AgentMark";
import { StatusMark } from "@/components/ui/StatusMark";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/api";
import { isUnread } from "@/lib/dashboard";
import { usePrefs } from "@/lib/prefs";
import { addProject, archiveSession, pinSession, selectSession, startChat, startSessionIn, useSessionStore } from "@/lib/sessions";
import { useSessionSummaries, type Summaries } from "@/lib/summaries";
import { openSettle } from "@/lib/dialogs";
import { confirmDeleteSession } from "@/lib/deleteSessionFlow";
import { relativeTime } from "@/lib/time";
import type { Project } from "@/types/session";
import { sessionStatus, type SessionEntry } from "@/types/session";
import { AppDestinations, ProjectGlyph, type RailProps } from "./ProjectRail";
import { PROJECT_COLORS, colorCss } from "./PixelMascot";
import { BotFace } from "./BotFace";
import { FilteredEmpty, conversationAgent, conversationLink, conversationTitle, mixesAgents, orderConversations } from "./SessionSidebar";
import { useSidebarFilter } from "@/lib/sidebarFilter";
import { DevelopmentSection } from "@/components/cloud/DevRuntime";
import { CloudOrganizations } from "./CloudOrganizations";

import { conversationTime } from "@/lib/messageActivity";

const canon = (path: string) => path.replace(/\/+$/, "");

/**
 * What a chat's row says under its name: the project and branch it works in.
 * A chat in no project yet says what it is waiting on, else the last thing
 * said in it. One line; the row truncates it.
 */
export function chatPreview(
  session: SessionEntry,
  summary: ReturnType<Summaries["get"]>,
  place: { name: string; branch: string | null } | null,
): { text: string; tone: "waiting" | "said" | "place" } {
  if (place) return { text: place.branch ? `${place.name} · ${place.branch}` : place.name, tone: "place" };
  if (summary?.waitingOn) return { text: summary.waitingOn, tone: "waiting" };
  const said = summary?.lastReply ?? summary?.lastPrompt;
  if (said) return { text: said.replace(/\s+/g, " ").trim(), tone: "said" };
  return { text: sessionStatus(session) === "in_progress" ? "Working…" : "New chat", tone: "place" };
}

/**
 * The sidebar as a messaging app draws it: every conversation in one list,
 * pinned first, then the newest, each with who it is (its project's mark),
 * what was last said in it, when, and a dot while it has something unread
 * or waits on you. Projects are not a level here; they are one click away
 * as the project view.
 */
export function ChatListSidebar({ onHide, onOpenSettings, onOpenAccount, onSearch, onOpenIssues, onOpenAgents, onOpenAutomations }: RailProps) {
  const store = useSessionStore();
  const [error, setError] = useState<string | null>(null);
  const chatsPath = store.chatsPath ? canon(store.chatsPath) : null;
  const projects = store.projects.filter((project) => !project.archived && canon(project.path) !== chatsPath).sort((a, b) => a.name.localeCompare(b.name));
  const filter = useSidebarFilter();
  // Unread or Needs you: only the conversations that pass, and the open one.
  const conversations = useMemo(
    () => orderConversations(filter.active ? store.sessions.filter((session) => filter.shows(session.id)) : store.sessions, store.selectedSessionId),
    [filter, store.sessions, store.selectedSessionId],
  );
  const showAgents = useMemo(() => mixesAgents(conversations), [conversations]);
  const summaries = useSessionSummaries(conversations, true);

  const run = (action: () => Promise<unknown>) => () => {
    action().then(() => setError(null), (cause) => setError(errorMessage(cause)));
  };
  const newChat = run(() => startChat());
  const addAndStart = run(async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Add a project" });
    if (typeof dir === "string") startSessionIn((await addProject(dir)).path, null);
  });

  return (
    <div className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-hairline" data-testid="sidebar-rail">
      <SidebarTitlebar onHide={onHide} onSearch={onSearch} onNewChat={newChat} onAddProject={addAndStart} projects={projects} />

      <div className="shrink-0 px-2">
        <AppDestinations onOpenIssues={onOpenIssues} onOpenAgents={onOpenAgents} onOpenAutomations={onOpenAutomations} />
      </div>

      {error && <div className="mx-2 mt-1 shrink-0 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      <nav className="mt-2 min-h-0 flex-1 basis-0 overflow-y-auto overscroll-contain scrollbar-thin border-t border-hairline px-2 py-1" aria-label="Conversations" data-testid="conversation-list">
        {conversations.length === 0 && filter.active ? (
          // Nothing local passed; the organizations below may still hold something that did.
          filter.count === 0 ? <FilteredEmpty text={filter.empty} /> : null
        ) : conversations.length === 0 ? (
          <button
            type="button"
            onClick={newChat}
            className="flex w-full flex-col items-center gap-1 rounded-lg px-3 py-6 text-center text-[12px] text-faint outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <SquarePen className="size-4" />
            Start a chat.
          </button>
        ) : (
          <ul className="flex flex-col gap-px">
            {conversations.map((session) => (
              <ChatRow
                key={session.id}
                session={session}
                selected={store.selectedSessionId === session.id}
                link={conversationLink(session, store.projects, chatsPath, store.workspaces)}
                summaries={summaries}
                showAgent={showAgents}
              />
            ))}
          </ul>
        )}
        <CloudOrganizations onOpenOrganizations={() => onOpenSettings("organizations")} />
        <DevelopmentSection />
      </nav>

      <div className="flex shrink-0 items-center gap-1 border-t border-hairline px-2 pb-2 pt-1" data-testid="sidebar-account-row">
        {/* The account; Settings keeps the far end. */}
        <div className="min-w-0 max-w-[70%]">
          <AccountSidebarEntry onOpenAccount={onOpenAccount} />
        </div>
        <div className="flex-1" />
        <WithTooltip label="Settings" shortcut="app.settings" side="top">
          <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Settings" onClick={() => onOpenSettings()}>
            <Settings />
          </Button>
        </WithTooltip>
      </div>
    </div>
  );
}

/** A chat as a messaging app lists it: its mark, its name, what was last said, when, and a dot while it wants a look. */
function ChatRow({
  session,
  selected,
  link,
  summaries,
  showAgent,
}: {
  session: SessionEntry;
  selected: boolean;
  link: ReturnType<typeof conversationLink>;
  summaries: Summaries;
  showAgent: boolean;
}) {
  const title = conversationTitle(session);
  const status = sessionStatus(session);
  const { animations } = usePrefs();
  const summary = summaries.get(session.id);
  const preview = chatPreview(session, summary, link ? { name: link.name, branch: link.branch } : null);
  // The last thing said stays within reach, on hover.
  const said = (summary?.waitingOn ?? summary?.lastReply ?? summary?.lastPrompt)?.replace(/\s+/g, " ").trim();
  const agent = showAgent ? conversationAgent(session) : null;
  return (
    <li>
      <DropdownMenu>
        <div
          className={cn(actionRow, "relative flex items-center gap-3 rounded-lg py-1.5 pl-2 pr-1", selected ? "bg-selected text-foreground" : "hover:bg-selected/50")}
          title={[title, session.worktreeRemoved ? `${session.removedWorkspace?.path ?? session.cwd} · workspace removed · resumes in ${session.cwd}` : null, preview.text, said && said !== preview.text ? said : null].filter(Boolean).join("\n")}
        >
          <button
            type="button"
            onClick={() => selectSession(session.id)}
            aria-current={selected ? "true" : undefined}
            aria-label={title}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChatMark session={session} project={link?.project ?? null} agent={agent} live={status === "in_progress" && animations} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5">
                {session.pinned && <Pin className="size-3 shrink-0 text-faint" />}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
                {session.worktreeRemoved && <span className="shrink-0 text-[10px] text-faint">removed</span>}
                <span className={cn("shrink-0 text-[10px] tabular-nums text-faint", yieldsToRowActions)}>{relativeTime(conversationTime(session))}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className={cn("flex min-w-0 flex-1 items-center gap-1 truncate text-[12px]", preview.tone === "waiting" ? "text-warning" : "text-faint")} data-testid="chat-preview">
                  {preview.tone === "place" && link?.branch && <GitBranch className="size-3 shrink-0" />}
                  <span className="truncate">{preview.text}</span>
                </span>
                {/* One sign: waiting on you first, then still working, then an answer nobody has read. */}
                <StatusMark status={status} unread={isUnread(session)} className={yieldsToRowActions} />
              </span>
            </span>
          </button>
          <RowActions>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${title}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </RowActions>
        </div>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => void pinSession(session.id, !session.pinned)}>
            <Pin /> {session.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archiveSession(session.id, !session.archived)}>
            <Archive /> {session.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {session.worktreeName && !session.worktreeRemoved && (
            <DropdownMenuItem onSelect={() => openSettle(session)}>
              <GitBranch /> Remove workspace, keep conversations…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem destructive onSelect={() => void confirmDeleteSession(session)}>
            <Trash2 /> Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * A project's colour for its mark: the one chosen for it, else one picked by
 * its name, so two projects are unlikely to share one and each keeps its own
 * between launches.
 */
export function projectHue(project: Pick<Project, "name" | "color">): string {
  if (project.color && project.color !== "slate") return colorCss(project.color);
  const hues = PROJECT_COLORS.filter((c) => c.id !== "slate");
  let hash = 0;
  for (const char of project.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length]!.css;
}

/**
 * The mark at a row's start: the chat's own bot face, in its project's colour
 * when it has one. A project with a logo keeps the logo. The agent, when
 * agents differ, sits in the corner.
 */
function ChatMark({ session, project, agent, live }: { session: SessionEntry; project: Project | null; agent: string | null; live: boolean }) {
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center" data-testid="chat-mark">
      {project?.logo ? (
        <span className="flex size-9 items-center justify-center rounded-full bg-veil-raised">
          <ProjectGlyph project={project} size={20} />
        </span>
      ) : (
        <BotFace seed={session.id} color={project ? projectHue(project) : null} size={36} live={live} />
      )}
      {agent && (
        <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-background">
          <AgentMark id={agent} className="size-3 text-faint" />
        </span>
      )}
    </span>
  );
}
