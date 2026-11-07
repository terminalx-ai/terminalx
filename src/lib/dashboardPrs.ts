import { useEffect, useRef, useState } from "react";
import { gh, type PrAssociation } from "@/lib/api";
import type { DashboardSession } from "@/lib/dashboard";

/** One indexed batch, without GitHub queries or cloud connections. */
export function useDashboardPrs(sessions: readonly DashboardSession[], enabled: boolean): ReadonlyMap<string, PrAssociation[]> {
  const [rows, setRows] = useState(new Map<string, PrAssociation[]>());
  const latest = useRef(sessions);
  latest.current = sessions;
  // Streaming updates and reordering must not restart an in-flight refresh.
  const signature = JSON.stringify(sessions.map(({ id }) => id).sort());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const ids = latest.current.map(({ id }) => id);
        const next = ids.length ? await gh.associationsBatch(ids) : {};
        if (live) setRows(new Map(Object.entries(next)));
      } catch {
        // Retain the last successful snapshot during a transient read failure.
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [enabled, signature]);
  return rows;
}
