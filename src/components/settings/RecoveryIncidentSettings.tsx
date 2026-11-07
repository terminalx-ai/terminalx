import { RegisteredSetting } from "./settingsRegistry";
import { useCallback, useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { errorMessage, recoveryIncidents, type RecoveryIncidentSummary } from "@/lib/api";

/** What is recorded, in a line: incidents, and those a person should look at. */
export function summaryText(summary: RecoveryIncidentSummary): string {
  if (!summary.incidents) return summary.lines ? "No warnings recorded yet." : "Nothing recorded yet.";
  const incidents = `${summary.incidents} ${summary.incidents === 1 ? "warning" : "warnings"} recorded`;
  const flagged = summary.suspected_false_positives.length;
  const review = flagged ? `, ${flagged} flagged as possibly false` : "";
  const lost = summary.lines_lost ? ` ${summary.lines_lost} ${summary.lines_lost === 1 ? "note" : "notes"} could not be written.` : "";
  return `${incidents}${review}.${lost}`;
}

/** Settings → Storage: the recovery incident log (#815), on this Mac only. */
export function RecoveryIncidentSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<RecoveryIncidentSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await recoveryIncidents.summary());
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => recoveryIncidents.settings())
      .then((settings) => live && setEnabled(settings.recoveryIncidents))
      .catch((e) => live && setResult({ ok: false, text: errorMessage(e) }));
    void refresh();
    return () => { live = false; };
  }, [refresh]);

  const change = async (next: boolean) => {
    setBusy(true);
    setResult(null);
    try {
      setEnabled((await recoveryIncidents.setEnabled(next)).recoveryIncidents);
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const exportLog = async () => {
    setResult(null);
    const path = await save({
      title: "Export recovery incidents",
      defaultPath: `terminalx-recovery-incidents-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (!path) return;
    setBusy(true);
    try {
      await recoveryIncidents.export(path);
      setResult({ ok: true, text: `Saved to ${path}` });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setResult(null);
    try {
      await recoveryIncidents.clear();
      setResult({ ok: true, text: "Recorded incidents cleared." });
      await refresh();
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 rounded-lg border border-hairline px-3 py-2" data-testid="recovery-incident-settings">
      <RegisteredSetting setting="storage.recoveryIncidents"
        control={<Switch aria-label="Record recovery incidents" checked={enabled ?? false} disabled={enabled === null || busy} onCheckedChange={(next) => void change(next)} />}
      />
      <div className="flex flex-wrap items-center gap-2 pb-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1" role="status">{summary ? summaryText(summary) : "Reading what is recorded…"}</span>
        <Button size="xs" variant="outline" disabled={busy || !summary?.lines} onClick={() => void exportLog()}><Download /> Export…</Button>
        <Button size="xs" variant="ghost" disabled={busy || !summary?.lines} onClick={() => void clear()}><Trash2 /> Clear</Button>
      </div>
      {result && <p role={result.ok ? "status" : "alert"} className={result.ok ? "pb-2 text-xs text-muted-foreground" : "pb-2 text-xs text-destructive"}>{result.text}</p>}
    </div>
  );
}
