import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useDictation } from "@/lib/dictation";
import { refreshTranscriptionInputs, selectTranscriptionInput, useTranscriptionInput } from "@/lib/transcriptionInput";

export function TranscriptionInputPicker({ compact = false }: { compact?: boolean }) {
  const input = useTranscriptionInput();
  const { phase } = useDictation();
  const [open, setOpen] = useState(false);
  const busy = phase !== "idle" || input.saving;
  useEffect(() => { if (busy) setOpen(false); }, [busy]);
  const missing = input.selected !== null && input.inputs !== null && !input.inputs.some((device) => device.id === input.selected);
  const noInputs = input.inputs?.length === 0;
  const noDefault = input.inputs !== null && !input.inputs.some((device) => device.isDefault);
  const needsDefault = input.selected === null || missing;
  // This is a preference, not live capture telemetry. Devices may disconnect
  // after enumeration, so do not claim the saved device is actively recording.
  let label = input.loaded ? input.selected ?? "System default" : "Input unknown";
  if (input.loaded) {
    if (phase !== "idle") label = `Preferred: ${input.selected ?? "System default"}`;
    else if (noInputs) label = "No audio inputs";
    else if (needsDefault && noDefault) label = "No default input";
    else if (missing) label = "System default · fallback";
  }
  let detail = `Preferred input: ${input.selected ?? "System default"}. If unavailable when recording starts, the system default is used.`;
  if (!input.loaded) detail = "Could not read the saved audio input. Open to retry.";
  else if (missing) {
    const fallback = noInputs ? "No microphone is available."
      : noDefault ? "No system default microphone is available."
      : "The next recording will use the system default if available.";
    detail = `${input.selected} is unavailable. ${fallback}`;
  } else if (needsDefault && noDefault) {
    detail = "No system default microphone is available. Choose an available input.";
  }
  return (
    <DropdownMenu open={open && !busy} onOpenChange={(next) => {
      setOpen(next);
      if (next && !busy) void refreshTranscriptionInputs();
    }}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={compact ? "ghost" : "outline"} size="sm"
          disabled={busy}
          aria-label={`Transcription audio input: ${label}`}
          title={busy ? `${detail} Device changes are disabled until recording and saving finish.` : detail}
          className={`min-w-0 gap-1 ${compact ? "max-w-36 shrink px-1.5 text-xs" : "max-w-64"}`}>
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Audio input for the next recording</p>
        <DropdownMenuRadioGroup value={input.loaded ? input.selected ?? "" : undefined} onValueChange={(value) => {
          setOpen(false);
          if (!busy) void selectTranscriptionInput(value || null);
        }}>
          <DropdownMenuRadioItem value="">System default</DropdownMenuRadioItem>
          {missing && <DropdownMenuRadioItem value={input.selected!} disabled className="whitespace-normal break-words">
            {input.selected} · unavailable
          </DropdownMenuRadioItem>}
          {input.inputs?.map((device) => (
            <DropdownMenuRadioItem key={device.id} value={device.id} className="whitespace-normal break-words">
              <span className="min-w-0 break-words">{device.name}{device.isDefault && <span className="text-faint"> · default</span>}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {input.loading && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">Looking for audio inputs…</p>}
        {noInputs && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">No audio inputs available. Connect a microphone and reopen this picker.</p>}
        {!missing && !noInputs && needsDefault && noDefault && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">{detail}</p>}
        {missing && <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">{detail} Your saved preference is unchanged.</p>}
        {input.error && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{input.error} Reopen to retry.</p>}
      </DropdownMenuContent>
      {input.error && !open && <span role="alert" className="max-w-36 text-xs text-destructive" title={input.error}>Input error. Reopen to retry.</span>}
    </DropdownMenu>
  );
}
