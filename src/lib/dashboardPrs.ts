import { useEffect, useRef, useState } from "react";
import { gh, type PrAssociation } from "@/lib/api";
import type { DashboardSession } from "@/lib/dashboard";

/** Read recorded session ownership, never one GitHub query per row or a cloud connection. */
export function useDashboardPrs(sessions: readonly DashboardSession[], enabled: boolean): ReadonlyMap<string, PrAssociation[]> {
  const [rows, setRows] = useState(new Map<string, PrAssociation[]>());
  const latest = useRef(sessions);
  latest.current = sessions;
  // Streaming updates must not restart a batch and starve its later rows.
  const signature = JSON.stringify(sessions.map(({ id }) => id).sort());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      const pending = [...latest.current];
      const next = new Map<string, PrAssociation[]>();
      // Bound disk reads even on a dashboard with hundreds of sessions.
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (live && pending.length) {
          const session = pending.shift()!;
          try {
            next.set(session.id, await gh.associations(session.id));
          } catch {
            // Unknown is distinct from a session with no recorded pull requests.
          }
        }
      }));
      if (live) setRows(next);
      reading = false;
    };
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled, signature]);
  return rows;
}
