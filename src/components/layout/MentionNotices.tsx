import { AtSign, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { dismissMentionNotice, openMention, readMention, useMentionNotices } from "@/lib/mentionNotices";

/** The newest few; older ones wait under the @ on their session rows. */
const SHOWN = 3;

/**
 * "Aisha Khan mentioned you" (PRO-141, design 13.03): the workspace and the
 * message, quoted from this device's own transcript when it has it, with Open
 * and Mark as read. Stays until one is pressed or it is dismissed.
 */
export function MentionNotices() {
  const notices = useMentionNotices();
  const privacy = useDataPrivacy();
  if (privacy.enabled || !notices.length) return null;
  return <>
    {notices.slice(-SHOWN).map((notice) => (
      <aside key={notice.id} role="status" className="pointer-events-auto flex gap-3 rounded-xl bg-popover p-3 text-[13px] shadow-surface hairline" data-testid="mention-notice">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-mention/15 text-mention">
          <AtSign className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 break-words font-medium text-foreground">{notice.actorName} mentioned you</p>
            <Button size="icon-xs" variant="ghost" className="-mr-1 -mt-0.5" aria-label="Dismiss mention" onClick={() => dismissMentionNotice(notice.id)}><X /></Button>
          </div>
          <p className="mt-0.5 line-clamp-2 break-words text-[12.5px] text-muted-foreground" data-testid="mention-notice-body">
            {notice.workspaceName}
            {notice.quote && <> · <span className="text-foreground/80">“{notice.quote}”</span></>}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-7" onClick={() => openMention(notice)}>Open</Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => readMention(notice)}>Mark as read</Button>
          </div>
        </div>
      </aside>
    ))}
  </>;
}
