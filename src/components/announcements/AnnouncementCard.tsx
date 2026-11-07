import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "@/icons";
import { dismissAnnouncement, markAnnouncementSeen, useAnnouncement } from "@/lib/announcements";

export function AnnouncementCard() {
  const announcement = useAnnouncement();
  const [failedId, setFailedId] = useState<string | null>(null);
  if (!announcement) return null;
  const read = async () => {
    try { await openUrl(announcement.link); markAnnouncementSeen(announcement.id); setFailedId(null); }
    catch { setFailedId(announcement.id); }
  };
  return <section aria-label="Announcement" className="mx-2 mb-2 max-h-[35vh] shrink-0 overflow-y-auto rounded-lg border border-hairline bg-veil-card p-3 text-xs">
    <div className="flex items-start gap-2">
      <h2 className="min-w-0 flex-1 break-words font-semibold">{announcement.title}</h2>
      {announcement.isNew && <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">NEW</span>}
      <button type="button" aria-label="Dismiss announcement" className="rounded p-1 text-muted-foreground hover:bg-veil-hover" onClick={() => dismissAnnouncement(announcement.id)}><X className="size-3" /></button>
    </div>
    <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{announcement.body}</p>
    <button type="button" className="mt-3 text-left font-medium underline underline-offset-2" onClick={() => void read()}>Read the changelog</button>
    {failedId === announcement.id && <p role="alert" className="mt-2 text-destructive">Could not open the changelog. Try again.</p>}
  </section>;
}
