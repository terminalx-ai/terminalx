import { useEffect, useState } from "react";
import { errorMessage, localRuntime, type LocalRuntimeSettings as Settings, type QuitBehavior } from "@/lib/api";

export function LocalRuntimeSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [available, setAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([localRuntime.status(), localRuntime.settings()]).then(([runtime, found]) => {
      if (cancelled) return;
      // During the staged native cutover, the legacy owner must not advertise
      // a quit policy that it cannot implement yet.
      setAvailable(runtime.state !== "inProcess");
      setSettings(found);
    }).catch((reason: unknown) => {
      if (!cancelled) { setAvailable(true); setError(errorMessage(reason)); }
    });
    return () => { cancelled = true; };
  }, []);

  async function save(quitBehavior: QuitBehavior) {
    setSaving(true);
    setError(null);
    try { setSettings(await localRuntime.setQuitBehavior(quitBehavior)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  if (!available) return null;
  return (
    <section aria-label="Quitting TerminalX" className="space-y-2">
      <label className="block text-[13px]" htmlFor="local-runtime-quit-behavior">When quitting TerminalX</label>
      <select id="local-runtime-quit-behavior" className="w-full rounded-md border border-hairline bg-background px-2 py-1.5 text-xs" value={settings?.quitBehavior ?? "keepRunning"} disabled={!settings || saving} onChange={(event) => void save(event.target.value as QuitBehavior)}>
        <option value="keepRunning">Quit and keep agents running (default)</option>
        <option value="stopAll">Quit and stop all agents and terminals</option>
      </select>
      <p className="text-xs text-muted-foreground">Keeping work running lets agents and terminal commands continue in the background. Reopening TerminalX reconnects to them. You can always stop everything from the app menu or menu-bar item.</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
