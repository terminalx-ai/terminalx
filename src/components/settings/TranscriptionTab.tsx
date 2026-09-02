import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, Download, ExternalLink, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow, Switch } from "@/components/ui/controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorMessage, transcription, type DownloadProgress, type TranscriptionModel, type TranscriptionSettings } from "@/lib/api";
import { refreshDictationEngine } from "@/lib/dictation";

const APPLE = "apple";

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** A thin bar for the relative speed and accuracy scores. */
function Score({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <span className="relative h-1 w-20 overflow-hidden rounded-full bg-veil-strong">
        <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
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
  const [models, setModels] = useState<TranscriptionModel[]>([]);
  const [settings, setSettings] = useState<TranscriptionSettings | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([transcription.models(), transcription.settings()]);
      setModels(m);
      setSettings(s);
      const p: Record<string, DownloadProgress> = {};
      for (const row of m) if (row.progress && !row.progress.done) p[row.id] = row.progress;
      setProgress(p);
    } catch (e) {
      setError(errorMessage(e));
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
      unlisten?.();
    };
  }, [reload]);

  const choose = async (id: string) => {
    setError(null);
    try {
      await transcription.setModel(id);
      await reload();
      void refreshDictationEngine();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const download = async (id: string) => {
    setError(null);
    try {
      await transcription.download(id);
      setProgress((p) => ({ ...p, [id]: { id, received: 0, total: models.find((m) => m.id === id)?.sizeBytes ?? 0, done: false } }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await transcription.remove(id);
      await reload();
      void refreshDictationEngine();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const selected = settings?.model ?? APPLE;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-sm font-medium">Model</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Transcription runs on this Mac. Audio never leaves it.</p>
        {error && <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      </div>

      <div className="flex flex-col gap-2">
        <ModelCard
          selected={selected === APPLE}
          name="Built in"
          description="Apple's speech recognition, on-device where your language allows. Nothing to download."
          meta="System languages"
          onUse={() => void choose(APPLE)}
          action={null}
        />
        {models.map((m) => {
          const p = progress[m.id];
          const busy = !!p || m.downloading;
          return (
            <ModelCard
              key={m.id}
              selected={selected === m.id}
              name={m.name}
              badge={m.recommended ? "Recommended" : undefined}
              description={m.description}
              meta={
                <>
                  <button type="button" className="inline-flex items-center gap-1 underline decoration-hairline-strong underline-offset-2 hover:text-foreground" onClick={() => void openUrl(m.page)}>
                    {m.languages}
                    <ExternalLink className="size-3" />
                  </button>
                  <span> · {mb(m.sizeBytes)}</span>
                </>
              }
              scores={
                <>
                  <Score label="Speed" value={m.speed} />
                  <Score label="Accuracy" value={m.accuracy} />
                </>
              }
              onUse={m.installed ? () => void choose(m.id) : undefined}
              action={
                busy ? (
                  <div className="flex items-center gap-2">
                    <span className="relative h-1 w-24 overflow-hidden rounded-full bg-veil-strong">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${p && p.total ? Math.round((p.received / p.total) * 100) : 0}%` }} />
                    </span>
                    <span className="w-10 text-right text-[11px] tabular-nums text-faint">{p && p.total ? `${Math.round((p.received / p.total) * 100)}%` : ""}</span>
                    <WithTooltip label="Cancel download">
                      <Button variant="ghost" size="icon-xs" aria-label="Cancel download" onClick={() => void transcription.cancelDownload(m.id)}>
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
                      <Button variant="ghost" size="icon-xs" aria-label="Delete model" onClick={() => void remove(m.id)}>
                        <Trash2 />
                      </Button>
                    </WithTooltip>
                  </div>
                ) : (
                  <WithTooltip label={`Download ${mb(m.sizeBytes)}`}>
                    <Button variant="ghost" size="icon-sm" aria-label="Download" onClick={() => void download(m.id)}>
                      <Download />
                    </Button>
                  </WithTooltip>
                )
              }
            />
          );
        })}
      </div>

      <div>
        <div className="mb-1 text-sm font-medium">Input</div>
        <SettingRow
          label="Microphone"
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  {settings?.inputDevice ?? "System default"}
                  <ChevronDown className="size-3 text-faint" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[14rem]">
                <DropdownMenuRadioGroup
                  value={settings?.inputDevice ?? ""}
                  onValueChange={(v) => {
                    void transcription.setInput(v || null).then(reload).catch((e) => setError(errorMessage(e)));
                  }}
                >
                  <DropdownMenuRadioItem value="">System default</DropdownMenuRadioItem>
                  {settings?.inputs.map((d) => (
                    <DropdownMenuRadioItem key={d.id} value={d.id}>
                      {d.name}
                      {d.isDefault && <span className="ml-2 text-[11px] text-faint">default</span>}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <SettingRow
          label="Mute while recording"
          description="Keeps whatever is playing out of the transcript. Unmuted automatically when recording stops."
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
    </div>
  );
}

function ModelCard({
  selected,
  name,
  badge,
  description,
  meta,
  scores,
  onUse,
  action,
}: {
  selected: boolean;
  name: string;
  badge?: string;
  description: string;
  meta: React.ReactNode;
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
          aria-label={selected ? "In use" : `Use ${name}`}
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
