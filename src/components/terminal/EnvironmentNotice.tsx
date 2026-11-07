import { useEffect, useState } from "react";
import { environment } from "@/lib/localEnvironment";

/** Metadata-only polling also sees edits from another desktop window. */
export function EnvironmentNotice({ id, active = true }: { id: string; active?: boolean }) {
  const [status, setStatus] = useState({ changed: false, unavailable: false });
  useEffect(() => {
    setStatus({ changed: false, unavailable: false });
    if (!active) return;
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const status = await environment.changed(id); if (live) setStatus(status); }
      catch { /* A disconnected runtime has its own notice. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener("local-environment-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { live = false; clearInterval(timer); window.removeEventListener("local-environment-changed", refresh); window.removeEventListener("focus", refresh); };
  }, [id, active]);
  return (status?.changed || status?.unavailable) && active ? <p role="status" className="shrink-0 border-b border-hairline bg-raised px-3 py-2 text-xs text-muted-foreground">{status.unavailable ? "This tab started without environment overrides because they were unavailable. Open TerminalX Settings → Environment, then reopen this shell or restart this agent to retry." : "Environment changed. Restart to apply — reopen this shell or stop and resume this agent."}</p> : null;
}
