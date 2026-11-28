import { useSettingsFile } from "@/lib/settingsFile";
import { isMac, thisComputer } from "@/lib/platform";
import { RegisteredSetting } from "./settingsRegistry";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Download, ExternalLink, Trash2, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/controls";
import { TranscriptionInputPicker } from "@/components/chat/TranscriptionInputPicker";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorMessage, transcription, type DownloadProgress, type TranscriptionModel, type TranscriptionPreferences } from "@/lib/api";
import { dictationAvailable, refreshDictationEngine } from "@/lib/dictation";

import { TranscriptionPersonalization } from "./TranscriptionPersonalization";

const APPLE = "apple";

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** A thin bar for the relative speed and accuracy scores. */
function Score({ label, value }: { label: string; value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-1 w-20 overflow-hidden rounded-full bg-veil-strong"
      >
        <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" style={{ width: `${Math.max(4, clamped)}%` }} />
      </span>
    </span>
  );
}

/**
 * Which engine turns speech into text, and where the audio comes from. The
 * system recogniser is always there; local models download once and then
 * work without a network. Selection is stored on the Rust side so dictation
 * reads it without a round trip through the webview.
 */
export function TranscriptionTab() {
  const { revision } = useSettingsFile();
  const [models, setModels] = useState<TranscriptionModel[]>([]);
  const [settings, setSettings] = useState<TranscriptionPreferences | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let live = true;
    void dictationAvailable().then((ok) => { if (live) setAvailable(ok); });
    return () => { live = false; };
  }, []);

  const reload = useCallback(async () => {
    const current = ++request.current;
    try {
      const [m, s] = await Promise.all([transcription.models(), transcription.preferences()]);
      if (current !== request.current) return;
      setModels(m);
      setSettings(s);
      const p: Record<string, DownloadProgress> = {};
      for (const row of m) if (row.progress && !row.progress.done) p[row.id] = row.progress;
      setProgress(p);
    } catch (e) {
      if (current === request.current) setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    let unlisten: (() => void) | null = null;
    let live = true;
    listen<DownloadProgress>("transcription_download", (e) => {
      const p = e.payload;
      setProgress((prev) => {
        const next = { ...prev };
        if (p.done || p.error) delete next[p.id];
        else next[p.id] = p;
        return next;
      });
      if (p.error) setError(p.error);
      if (p.done || p.error) void reload();
    })
      .then((u) => {
        if (live) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      live = false;
      request.current++;
      unlisten?.();
    };
  }, [reload, revision]);

  const choose = async (id: string) => {
    if (busyAction) return;
    setBusyAction(`choose:${id}`);
    setError(null);
    try {
      await transcription.setModel(id);
      await reload();
      void refreshDictationEngine();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyAction(null);
    }
  };

  const download = async (id: string) => {
    if (busyAction) return;
    setBusyAction(`download:${id}`);
    setError(null);
    try {
      await transcription.download(id);
      setProgress((p) => ({ ...p, [id]: { id, received: 0, total: models.find((m) => m.id === id)?.sizeBytes ?? 0, done: false } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyAction(null);
    }
  };

  const remove = async (id: string) => {
    if (busyAction) return;
    setBusyAction(`remove:${id}`);
    setError(null);
    try {
      await transcription.remove(id);
      setPendingDelete(null);
      await reload();
      void refreshDictationEngine();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyAction(null);
    }
  };

  const selected = settings?.model ?? APPLE;

  return (
    <div className="flex flex-col gap-5">
      {available === false && <p role="note" data-testid="dictation-unavailable" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{isMac ? `Dictation is not available on ${thisComputer}.` : "Dictation is available on macOS only. These settings take effect there."}</p>}
      {/* Off where dictation cannot run: the settings stay readable, and nothing here downloads or records. */}
      <fieldset disabled={available === false} className="contents">
      <div>
        <div className="text-sm font-medium">Model</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Transcription runs on {thisComputer}. Audio never leaves it.</p>
        {error && <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      </div>

      <RegisteredSetting setting="transcription.model"><div className="flex flex-col gap-2" role="radiogroup" aria-label="Transcription model">
        <ModelCard
          selected={selected === APPLE}
          name="Built in"
          description="Apple's speech recognition, on-device where your language allows. Nothing to download."
          meta="System languages"
          live
          onUse={busyAction ? undefined : () => void choose(APPLE)}
          action={null}
        />
        {models.map((m) => {
          const p = progress[m.id];
          const busy = !!p || m.downloading;
          const percent = p && p.total ? Math.round((p.received / p.total) * 100) : 0;
          return (
            <ModelCard
              key={m.id}
              selected={selected === m.id}
              name={m.name}
              badge={m.recommended ? "Recommended" : undefined}
              description={m.description}
              live={m.liveWords}
              meta={
                <>
                  <button type="button" className="inline-flex items-center gap-1 underline decoration-hairline-strong underline-offset-2 hover:text-foreground" onClick={() => void openUrl(m.page)}>
                    {m.languages}
                    <ExternalLink className="size-3" />
                  </button>
                  <span> · {mb(m.sizeBytes)}</span>
                  <span> · </span>
                  <button type="button" className="text-faint underline decoration-hairline-strong underline-offset-2 hover:text-foreground" onClick={() => void openUrl(m.licenseUrl)}>
                    {m.license}
                  </button>
                </>
              }
              scores={
                <>
                  <Score label="Speed" value={m.speed} />
                  <Score label="Accuracy" value={m.accuracy} />
                </>
              }
              onUse={m.installed && !busyAction ? () => void choose(m.id) : undefined}
              action={
                busy ? (
                  <div className="flex items-center gap-2">
                    <span
                      role="progressbar"
                      aria-label={`Downloading ${m.name}`}
                      aria-valuenow={percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="relative h-1 w-24 overflow-hidden rounded-full bg-veil-strong"
                    >
                      <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${percent}%` }} />
                    </span>
                    <span className="w-10 text-right text-[11px] tabular-nums text-faint">{p && p.total ? `${percent}%` : ""}</span>
                    <WithTooltip label="Cancel download">
                      <Button variant="ghost" size="icon-xs" aria-label={`Cancel download of ${m.name}`} disabled={Boolean(busyAction)} onClick={() => void transcription.cancelDownload(m.id)}>
                        <X />
                      </Button>
                    </WithTooltip>
                  </div>
                ) : m.installed ? (
                  <div className="flex items-center gap-1">
                    <span className="flex items-center gap-1 text-[11px] text-add">
                      <Check className="size-3" /> Downloaded
                    </span>
                    <WithTooltip label="Delete model">
                      <Button variant="ghost" size="icon-xs" aria-label={`Delete ${m.name} model`} disabled={Boolean(busyAction)} onClick={() => setPendingDelete({ id: m.id, name: m.name })}>
                        <Trash2 />
                      </Button>
                    </WithTooltip>
                  </div>
                ) : (
                  <WithTooltip label={`Download ${mb(m.sizeBytes)}`}>
                    <Button variant="ghost" size="icon-sm" aria-label={`Download ${m.name} (${mb(m.sizeBytes)})`} disabled={Boolean(busyAction)} onClick={() => void download(m.id)}>
                      <Download />
                    </Button>
                  </WithTooltip>
                )
              }
            />
          );
        })}
      </div></RegisteredSetting>

      <div>
        <div className="mb-1 text-sm font-medium">Input</div>
        <RegisteredSetting setting="transcription.microphone"
          control={<TranscriptionInputPicker />}
        />
        <RegisteredSetting setting="transcription.mute"
          control={
            <Switch
              checked={settings?.muteWhileRecording ?? false}
              onCheckedChange={(v) => {
                void transcription.setMute(v).then(reload).catch((e) => setError(errorMessage(e)));
              }}
            />
          }
        />
      </div>
      <TranscriptionPersonalization />
      </fieldset>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : "Delete model?"}
        action="Delete model"
        destructive
        busy={pendingDelete !== null && busyAction === `remove:${pendingDelete.id}`}
        onAction={() => { if (pendingDelete) void remove(pendingDelete.id); }}
        onCancel={() => setPendingDelete(null)}
      >
        This removes the downloaded weights from {thisComputer}. You will need to download it again to use it offline.
      </ConfirmDialog>
    </div>
  );
}

function ModelCard({
  selected,
  name,
  badge,
  description,
  meta,
  live,
  scores,
  onUse,
  action,
}: {
  selected: boolean;
  name: string;
  badge?: string;
  description: string;
  meta: React.ReactNode;
  /** Words appear while the reader speaks, or only once they stop. */
  live: boolean;
  scores?: React.ReactNode;
  /** Absent while the weights are not on disk. */
  onUse?: () => void;
  action: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border p-3 transition-colors", selected ? "border-ring bg-veil-raised" : "border-hairline-strong bg-well")}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={!onUse}
          onClick={onUse}
          className={cn(
            "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-accent bg-accent text-accent-foreground" : "border-hairline-strong",
            !onUse && "opacity-40",
          )}
          aria-label={selected ? `${name}, in use` : `Use ${name}`}
        >
          {selected && <Check className="size-3" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {badge && <span className="rounded-full bg-veil-strong px-2 py-0.5 text-[10.5px] text-muted-foreground">{badge}</span>}
            {selected && <span className="text-[11px] text-faint">in use</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          <div className="mt-1 text-xs text-muted-foreground">{meta}</div>
          <div className="mt-1 text-xs text-muted-foreground">{live ? "Words appear as you speak." : "Words appear when you stop."}</div>
          {(scores || action) && (
            <div className="mt-2 flex items-center gap-4">
              {scores}
              <span className="ml-auto">{action}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
