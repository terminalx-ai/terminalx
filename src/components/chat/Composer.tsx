import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ImagePlus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { keycaps } from "@/lib/hotkeys";
import { EFFORT_LABEL, PERMISSION_MODES, modeLabel, useModels } from "@/lib/models";
import type { TabEntry } from "@/types/session";
import type { ImageInput } from "@/lib/api";

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  data: string; // base64
  previewUrl: string;
}

/**
 * The composer inside a session. Enter sends, Shift+Enter breaks a line.
 * While a turn runs the send button becomes Stop and a new prompt queues.
 */
export function Composer({
  tab,
  busy,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onSetModel,
  onSetEffort,
  onSetMode,
  contextUsed,
  contextMax,
  disabledReason,
  autoFocus,
}: {
  tab: TabEntry;
  busy: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: (text: string, images: ImageInput[]) => Promise<void> | void;
  onStop: () => void;
  onSetModel: (id: string) => void;
  onSetEffort: (e: string | null) => void;
  onSetMode: (m: string) => void;
  contextUsed?: number;
  contextMax?: number;
  disabledReason?: string | null;
  autoFocus?: boolean;
}) {
  const models = useModels(tab.harness);
  const model = models.find((m) => m.id === tab.model) ?? models.find((m) => m.isDefault);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Grow with content, up to ~10 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [draft]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, tab.id]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text && !attachments.length) return;
    const imgs = attachments.map((a) => ({ mediaType: a.mediaType, data: a.data, name: a.name }));
    onDraftChange("");
    setAttachments([]);
    await onSend(text, imgs);
    ref.current?.focus();
  }, [draft, attachments, onSend, onDraftChange]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    const out: Attachment[] = [];
    for (const f of list) {
      if (f.size > 5 * 1024 * 1024) continue;
      const data = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.readAsDataURL(f);
      });
      out.push({ id: crypto.randomUUID(), name: f.name, mediaType: f.type, data, previewUrl: URL.createObjectURL(f) });
    }
    if (out.length) setAttachments((a) => [...a, ...out]);
  }, []);

  const placeholder = busy ? "Send a follow-up (it queues until the agent pauses)" : "Ask, build, or describe the next step";
  const pct = contextUsed && contextMax ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      {disabledReason && (
        <div className="mb-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">{disabledReason}</div>
      )}
      <div
        className="rounded-2xl bg-composer glass p-2.5 shadow-surface hairline focus-within:ring-1 focus-within:ring-ring/40"
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {attachments.map((a) => (
              <div key={a.id} className="group relative size-14 overflow-hidden rounded-md hairline">
                <img src={a.previewUrl} alt={a.name} className="size-full object-cover" />
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                  className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          data-composer
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="max-h-60 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="mt-1 flex items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => e.target.files && void addFiles(e.target.files)}
          />
          <WithTooltip label="Attach image" keys={keycaps("alt+o")}>
            <Button variant="ghost" size="icon-sm" aria-label="Attach image" onClick={() => fileRef.current?.click()}>
              <ImagePlus />
            </Button>
          </WithTooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-muted-foreground">
                <AgentMark id={tab.harness} className="size-3.5" />
                <span className="text-foreground">{model?.label ?? tab.model ?? "Model"}</span>
                {tab.effort && model?.efforts.length ? <span className="text-faint">{EFFORT_LABEL[tab.effort] ?? tab.effort}</span> : null}
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[14rem]">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={model?.id ?? ""} onValueChange={onSetModel}>
                {models.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id}>
                    {m.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {model?.efforts.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Effort</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={tab.effort ?? model.defaultEffort ?? ""} onValueChange={(v) => onSetEffort(v)}>
                    {model.efforts.map((e) => (
                      <DropdownMenuRadioItem key={e} value={e}>
                        {EFFORT_LABEL[e] ?? e}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 px-2 text-muted-foreground">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    tab.permissionMode === "bypassPermissions" ? "bg-destructive" : tab.permissionMode === "plan" ? "bg-info" : "bg-add",
                  )}
                />
                {modeLabel(tab.permissionMode)}
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[16rem]">
              <DropdownMenuLabel>Permissions</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={tab.permissionMode} onValueChange={onSetMode}>
                {PERMISSION_MODES.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
                    <span>{m.label}</span>
                    <span className="text-[11px] text-faint">{m.hint}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center gap-1.5">
            {pct != null && (
              <WithTooltip label={`Context ${pct}% used (${Math.round((contextUsed ?? 0) / 1000)}k of ${Math.round((contextMax ?? 0) / 1000)}k)`}>
                <div className="relative size-4" aria-label={`Context ${pct}%`}>
                  <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
                    <circle cx="8" cy="8" r="6" fill="none" stroke="var(--hairline-strong)" strokeWidth="2" />
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      stroke={pct > 85 ? "var(--destructive)" : pct > 65 ? "var(--warning)" : "var(--ink-muted)"}
                      strokeWidth="2"
                      strokeDasharray={`${(pct / 100) * 37.7} 37.7`}
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </WithTooltip>
            )}
            {busy ? (
              <WithTooltip label="Stop" keys={["Esc"]}>
                <Button size="icon-sm" variant="secondary" aria-label="Stop" onClick={onStop}>
                  <Square className="size-3 fill-current" />
                </Button>
              </WithTooltip>
            ) : null}
            <WithTooltip label={busy ? "Queue" : "Send"} keys={["⏎"]}>
              <Button
                size="icon-sm"
                variant={draft.trim() || attachments.length ? "accent" : "secondary"}
                aria-label="Send"
                disabled={!draft.trim() && !attachments.length}
                onClick={() => void send()}
              >
                <ArrowUp />
              </Button>
            </WithTooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
