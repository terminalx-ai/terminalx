import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, Trash2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { confirmDeleteSessions } from "@/lib/deleteSessionFlow";
import { clearPicked, usePickedSessions } from "@/lib/rowSelection";
import { archiveSessions } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

/**
 * What can be done to the conversations picked in the sidebar, all at once (#718): archive them, bring them back, or
 * delete them. Shown while anything is picked; Escape, or the ×, lets go of them. `sessions`: every local session,
 * so one deleted or gone meanwhile is never acted on.
 */
export function SidebarBulkBar({ sessions }: { sessions: SessionEntry[] }) {
  const picked = usePickedSessions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = sessions.filter((session) => picked.includes(session.id));
  const active = chosen.length > 0;

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) clearPicked();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  useEffect(() => {
    if (!active) setError(null);
  }, [active]);

  if (!active) return null;
  const open = chosen.filter((session) => !session.archived);
  const archived = chosen.filter((session) => session.archived);
  const run = (action: () => Promise<boolean | void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      // A delete the reader cancelled leaves the rows picked.
      if ((await action()) !== false) clearPicked();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const count = chosen.length === 1 ? "1 conversation" : `${chosen.length} conversations`;

  return (
    <div role="toolbar" aria-label={`${count} selected`} className="shrink-0 border-t border-hairline px-2 py-1.5" data-testid="sidebar-bulk-bar">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate px-1 text-[12px] text-muted-foreground" aria-live="polite">{count} selected</span>
        <WithTooltip label="Clear selection (Esc)">
          <Button variant="ghost" size="icon-xs" aria-label="Clear selection" onClick={clearPicked}>
            <X />
          </Button>
        </WithTooltip>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button variant="ghost" size="xs" disabled={busy || open.length === 0} onClick={run(() => archiveSessions(open.map((session) => session.id), true))}>
          <Archive /> Archive{archived.length && open.length ? ` ${open.length}` : ""}
        </Button>
        <Button variant="ghost" size="xs" disabled={busy || archived.length === 0} onClick={run(() => archiveSessions(archived.map((session) => session.id), false))}>
          <ArchiveRestore /> Unarchive{archived.length && open.length ? ` ${archived.length}` : ""}
        </Button>
        <Button variant="destructive" size="xs" className="ml-auto" disabled={busy} onClick={run(() => confirmDeleteSessions(chosen))}>
          <Trash2 /> Delete…
        </Button>
      </div>
      {error && <p role="alert" className="mt-1 px-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
