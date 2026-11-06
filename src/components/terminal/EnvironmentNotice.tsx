import { useEffect, useState } from "react";
import { environment } from "@/lib/localEnvironment";

/** Metadata-only polling also sees edits from another desktop window. */
export function EnvironmentNotice({ id, active = true }: { id: string; active?: boolean }) {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    setChanged(false);
    if (!active) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const changed = await environment.changed(id); if (live) setChanged(changed); }
      catch { /* A disconnected runtime has its own notice. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener("local-environment-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { live = false; clearInterval(timer); window.removeEventListener("local-environment-changed", refresh); window.removeEventListener("focus", refresh); };
  }, [id, active]);
  return changed && active ? <p role="status" className="shrink-0 border-b border-hairline bg-raised px-3 py-2 text-xs text-muted-foreground">Environment changed. Restart to apply — reopen this shell or stop and resume this agent.</p> : null;
}
