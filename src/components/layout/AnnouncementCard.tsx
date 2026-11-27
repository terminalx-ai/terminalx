import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { announcementOrg, useAnnouncement } from "@/lib/announcements";
import { useDataPrivacy } from "@/lib/dataPrivacy";

/** The sidebar footer's announcement (PRO-241, 01.06 and 13.17): NEW, a title, a line, and Read the changelog. */
export function AnnouncementCard() {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const { announcement, dismiss } = useAnnouncement(announcementOrg(status, privacy));
  if (!announcement) return null;
  return (
    <section aria-label="Announcement" data-testid="announcement-card" className="mx-2 mb-2 shrink-0 rounded-lg border border-border bg-raised px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        {announcement.badge && <span className="mt-px shrink-0 rounded bg-accent px-1.5 text-[10.5px] font-semibold leading-4 text-accent-foreground">NEW</span>}
        <h2 className="min-w-0 flex-1 text-[13px] font-medium leading-5">{announcement.title}</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close announcement" className="-mr-1 -mt-0.5 shrink-0" onClick={dismiss}><X /></Button>
      </div>
      <p className="mt-1 leading-[18px] text-muted-foreground">{announcement.body}</p>
      {announcement.link && (
        <button type="button" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void openUrl(announcement.link!).catch(console.error)}>
          Read the changelog <ArrowUpRight aria-hidden className="size-3" />
        </button>
      )}
    </section>
  );
}
