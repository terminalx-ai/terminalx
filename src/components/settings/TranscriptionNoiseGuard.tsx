import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { errorMessage, type DownloadProgress, type TranscriptionDetector } from "@/lib/api";

/** Auxiliary weights never appear in the recognition-engine chooser. */
export function TranscriptionNoiseGuard() {
  const [model, setModel] = useState<TranscriptionDetector | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every inspection and transition shares one owner. A late result (including
  // a rejected request) cannot replace state observed after a newer transition.
  const generation = useRef(0);
  const mounted = useRef(false);
  const hydrated = useRef(false);
  const hydrationOwner = useRef<number | null>(null);
  const hydrationProgress = useRef<DownloadProgress | null>(null);
  const refresh = useCallback(async () => {
    const owner = ++generation.current;
    const needsMetadata = !hydrated.current;
    hydrationOwner.current = needsMetadata ? owner : null;
    hydrationProgress.current = null;
    try {
      const value = await invoke<TranscriptionDetector>("transcription_detector");
      if (mounted.current && owner === generation.current) {
        hydrated.current = true;
        const progress = needsMetadata ? hydrationProgress.current : null;
        setModel(progress ? { ...value, downloading: true, progress } : value);
      }
    } catch (e) {
      if (mounted.current && owner === generation.current) setError(errorMessage(e));
    } finally {
      if (mounted.current && owner === generation.current) {
        hydrationOwner.current = null;
        setBusy(false);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    let off: (() => void) | undefined;
    void refresh();
    void listen<DownloadProgress>("transcription_download", ({ payload }) => {
      if (!live || payload.id !== "silero-vad-v6.2") return;
      setBusy(false);
      if (payload.error) setError(payload.error);
      if (payload.done || payload.error) {
        // Terminal transitions take a new owner, fencing pending hydration too.
        void refresh();
      } else if (!hydrated.current) {
        // Progress cannot supply metadata. Keep the current hydration alive and
        // merge the newest progress into its response instead of starving it.
        if (hydrationOwner.current !== generation.current) void refresh();
        hydrationProgress.current = payload;
      } else {
        ++generation.current;
        setModel((value) => value ? { ...value, downloading: true, progress: payload } : value);
      }
    }).then((stop) => { if (live) off = stop; else stop(); })
      .catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; mounted.current = false; ++generation.current; off?.(); };
  }, [refresh]);
  async function action(command: string) {
    if (!model) return;
    const owner = ++generation.current;
    setBusy(true); setError(null);
    try {
      if (command !== "transcription_detector") await invoke(command, { id: model.id });
      // A download event may already own a more recent inspection. Do not
      // start another from an older command's acknowledgement.
      if (mounted.current && owner === generation.current) await refresh();
    } catch (e) {
      if (mounted.current && owner === generation.current) {
        setError(errorMessage(e));
        setBusy(false);
      }
    }
  }
  return <div className="space-y-2 text-xs text-muted-foreground">
    <p>The local-model noise guard uses a separate 1.24 MB speech detector. Recording never downloads it. Apple keeps its own speech detection. Quiet speech and environmental sounds can still be misclassified; use Test dictation to check results.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {model && <div className="flex flex-wrap items-center gap-2">
      <span>{model.name} · <button type="button" className="underline" onClick={() => void openUrl(model.licenseUrl)}>{model.license}</button></span>
      <span role="status">{{ missing: "Detector file missing", invalid: "Detector file invalid", verifiedFile: "Detector file verified", error: "Detector file could not be verified. Check file access and retry." }[model.readiness]}</span>
      {model.downloading ? <><span>{Math.round((model.progress?.received ?? 0) / model.sizeBytes * 100)}%</span><Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_cancel_download")}>Cancel detector download</Button></>
        : model.readiness === "verifiedFile" ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_delete")}>Delete speech detector</Button>
          : model.readiness === "error" ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_detector")}>Retry file verification</Button>
            : <Button size="xs" variant="outline" disabled={busy} onClick={() => void action("transcription_download")}>{model.readiness === "invalid" ? "Reinstall speech detector" : "Download speech detector"}</Button>}
    </div>}
    <p>File verification checks size and checksum only; it does not confirm native loading or speech detection. Missing, damaged or failed detection keeps the recognized text. The test result reports the detector status.</p>
  </div>;
}
