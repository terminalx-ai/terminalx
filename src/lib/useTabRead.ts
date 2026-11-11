import { useEffect, useRef } from "react";
import type { TabEntry } from "@/types/session";

/** Reminders clear on entry; a reminder set during this visit waits for the next one. */
export function useTabRead(active: boolean, key: string, tab: Pick<TabEntry, "id" | "status" | "markedUnread">, markRead: (tabId: string) => Promise<void>) {
  const lastViewed = useRef<{ identity: string; status: TabEntry["status"] } | null>(null);
  const read = useRef(markRead);
  read.current = markRead;
  useEffect(() => {
    const identity = `${key}/${tab.id}`;
    const entered = active && lastViewed.current?.identity !== identity;
    const completed = tab.status === "completed" && lastViewed.current?.status !== "completed";
    lastViewed.current = active ? { identity, status: tab.status } : null;
    if (active && (entered ? tab.markedUnread || tab.status === "completed" : completed && !tab.markedUnread)) {
      void read.current(tab.id).catch(() => {});
    }
  }, [active, tab.status, tab.markedUnread, key, tab.id]);
}
