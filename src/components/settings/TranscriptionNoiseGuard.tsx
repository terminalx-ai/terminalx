import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { errorMessage, type DownloadProgress, type TranscriptionModel } from "@/lib/api";

/** Auxiliary weights never appear in the recognition-engine chooser. */
export function TranscriptionNoiseGuard() {
  const [model, setModel] = useState<TranscriptionModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    const refresh = () => invoke<TranscriptionModel>("transcription_detector")
      .then((value) => { if (live) setModel(value); })
      .catch((e) => { if (live) setError(errorMessage(e)); });
    void refresh();
    void listen<DownloadProgress>("transcription_download", ({ payload }) => {
      if (!live || payload.id !== "silero-vad-v6.2") return;
      if (payload.error) setError(payload.error);
      if (payload.done || payload.error) void refresh();
      else setModel((value) => value ? { ...value, downloading: true, progress: payload } : value);
    }).then((stop) => { if (live) off = stop; else stop(); })
      .catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; off?.(); };
  }, []);
  async function action(command: string) {
    if (!model) return;
    setBusy(true); setError(null);
    try {
      await invoke(command, { id: model.id });
      setModel(await invoke<TranscriptionModel>("transcription_detector"));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 text-xs text-muted-foreground">
    <p>The local-model noise guard uses a separate 1.24 MB speech detector. Recording never downloads it. Apple keeps its own speech detection. Quiet speech and environmental sounds can still be misclassified; use Test dictation to check results.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {model && <div className="flex flex-wrap items-center gap-2">
      <span>{model.name} · <button type="button" className="underline" onClick={() => void openUrl(model.licenseUrl)}>{model.license}</button></span>
      {model.downloading ? <><span>{Math.round((model.progress?.received ?? 0) / model.sizeBytes * 100)}%</span><Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_cancel_download")}>Cancel detector download</Button></>
        : model.installed ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_delete")}>Delete speech detector</Button>
          : <Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_download")}>Download speech detector</Button>}
    </div>}
    <p>Missing, damaged or failed detection keeps the recognized text. The test result reports the detector status.</p>
  </div>;
}
