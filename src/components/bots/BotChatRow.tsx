import { Ellipsis, Github, Hash, Home, Loader2, MessageSquare, Send, SquareKanban } from "@/icons";
import { RowActions, actionRow } from "@/components/layout/RowActions";
import { ConversationMenuItems, RowContextMenu, rowMenuKeys } from "@/components/layout/SessionSidebar";
import { ArchiveRowButton } from "@/components/layout/SessionRowExtras";
import { Button } from "@/components/ui/button";
import { AsyncContextMenu, AsyncDropdownMenu, ContextMenuTrigger, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { chatSource } from "@/lib/botChats";
import { keepFocusForNameField } from "@/lib/cloudSidebarSections";
import { cn } from "@/lib/cn";
import { openRenameSession } from "@/lib/dialogs";
import { conversationTitle } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";
import type { SessionEntry } from "@/types/session";

/** The name a bot's chat goes by in its bot's list: a home chat by its session's own title, "Home chat" until it is renamed. */
export function botChatTitle(chat: SessionEntry, home: boolean): string {
  return home ? chat.title?.trim() || "Home chat" : conversationTitle(chat);
}

/**
 * One of a bot's chats in its Chat tab (PRO-468). A bot's chat is an ordinary session (PRO-459), so its row has the
 * sidebar's own session actions and nothing of its own (PRO-521): the same right-click and ⋯ menu with its keys,
 * Rename… and a double-click open the app's one rename dialog, and Archive and Delete session… close it as they close
 * any session. The home chat is the bot's standing chat: it is renamed here, but not archived or deleted.
 */
export function ChatRow({ chat, selected, home, onOpen, sub }: { chat: SessionEntry; selected: boolean; home: boolean; onOpen: (chat: SessionEntry) => void; sub?: string }) {
  const working = chat.tabs.some((tab) => tab.status === "in_progress");
  const source = home ? null : chatSource(chat);
  const kind = chat.botChannel?.kind;
  const Icon = home ? Home : kind === "github" ? Github : kind === "linear" ? SquareKanban : kind === "slack" ? Hash : kind === "telegram" ? Send : MessageSquare;
  const title = botChatTitle(chat, home);
  const rename = () => openRenameSession(chat.id);
  return (
    <li>
      <AsyncDropdownMenu>
        <AsyncContextMenu>
          <ContextMenuTrigger asChild>
            <div className={cn(actionRow, "flex min-w-0 items-start rounded-md pr-1", selected ? "bg-veil-strong" : "hover:bg-veil")} data-bot-chat={chat.id}>
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onOpen(chat)}
                onDoubleClick={rename}
                className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground" data-testid="bot-chat-title">{title}</span>
                  <span className="block truncate text-[11.5px] text-faint" data-testid={!sub && source ? "bot-chat-source" : undefined}>
                    {sub ?? (source ? `${source} · ${relativeTime(chat.modified || chat.created)}` : relativeTime(chat.modified || chat.created))}
                  </span>
                </span>
                {working && <Loader2 aria-label="Working" className="mt-0.5 size-3.5 shrink-0 animate-spin text-warning" />}
              </button>
              <RowActions className="mt-1">
                {!home && <ArchiveRowButton session={chat} title={title} />}
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={`Menu for ${title}`}>
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
              </RowActions>
            </div>
          </ContextMenuTrigger>
          <RowContextMenu session={chat} branch={null} rename={rename} standing={home} />
        </AsyncContextMenu>
        <DropdownMenuContent align="end" className="w-56" onKeyDown={rowMenuKeys} onCloseAutoFocus={keepFocusForNameField}>
          <ConversationMenuItems session={chat} branch={null} rename={rename} standing={home} />
        </DropdownMenuContent>
      </AsyncDropdownMenu>
    </li>
  );
}
