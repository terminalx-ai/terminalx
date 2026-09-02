import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown, FileText, ImagePlus, Mic, SlashSquare, Square, X } from "lucide-react";
import { clearDictationError, dictationAvailable, startDictation, stopDictation, useDictation } from "@/lib/dictation";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { EFFORT_LABEL, PERMISSION_MODES, modeLabel, useModels } from "@/lib/models";
import { files as filesApi, type FileHit, type ImageInput, type SlashCommand } from "@/lib/api";
import type { TabEntry } from "@/types/session";
import { PickerMenu, type PickerItem } from "./PickerMenu";
import { tokenAtCaret } from "@/lib/pickers";

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  data: string; // base64
  previewUrl: string;
}

const commandCache = new Map<string, SlashCommand[]>();

/**
 * The composer inside a session. Enter sends, Shift+Enter breaks a line.
 * While a turn runs the send button becomes Stop and a new prompt queues.
 * `/` at the start opens the command list; `@` anywhere opens the file list.
 * Images attach as blocks; any other dropped file becomes an `@path` mention.
 */
export function Composer({
  tab,
  cwd,
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
  usageWindows,
  codexUsage,
  handoffs,
  disabledReason,
  autoFocus,
}: {
  tab: TabEntry;
  cwd?: string;
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
  /** Claude's rolling limits, keyed by window (five_hour, seven_day…). */
  usageWindows?: Record<string, { utilization: number; resetsAt: number }>;
  codexUsage?: { usedPercent: number; resetsAt: number; windowMins: number; plan?: string };
  /** Next-step prompts offered after a turn lands (commit, PR, run). */
  handoffs?: { label: string; prompt: string }[];
  disabledReason?: string | null;
  autoFocus?: boolean;
}) {
  const models = useModels(tab.harness);
  const model = models.find((m) => m.id === tab.model) ?? models.find((m) => m.isDefault);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [caret, setCaret] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>(() => commandCache.get(`${cwd}|${tab.harness}`) ?? []);
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
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

  // Slash commands come from the harness once per directory.
  useEffect(() => {
    if (!cwd) return;
    const key = `${cwd}|${tab.harness}`;
    if (commandCache.has(key)) {
      setCommands(commandCache.get(key)!);
      return;
    }
    let cancelled = false;
    filesApi
      .slashCommands(cwd, tab.harness)
      .then((c) => {
        commandCache.set(key, c);
        if (!cancelled) setCommands(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd, tab.harness]);

  // Dictation: the draft at the moment the mic opens is the base; partial
  // results replace what follows it, and each finished phrase extends it.
  const dictation = useDictation();
  const dictating = dictation.target === tab.id && dictation.phase !== "idle";
  const dictBase = useRef("");
  const [canDictate, setCanDictate] = useState<boolean | null>(null);
  useEffect(() => {
    void dictationAvailable().then(setCanDictate);
  }, []);
  useEffect(() => {
    if (!dictating || dictation.phase !== "listening") return;
    const base = dictBase.current;
    const sep = base && !/\s$/.test(base) && dictation.partial ? " " : "";
    onDraftChange(dictation.partial ? base + sep + dictation.partial : base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictation.partial, dictating, dictation.phase]);
  const toggleDictation = useCallback(() => {
    if (dictating) {
      void stopDictation();
      return;
    }
    if (dictation.phase !== "idle") return;
    dictBase.current = draft;
    void startDictation(tab.id, (text) => {
      const base = dictBase.current;
      const sep = base && !/\s$/.test(base) ? " " : "";
      dictBase.current = base + sep + text + " ";
      onDraftChange(dictBase.current);
      requestAnimationFrame(() => ref.current?.focus());
    });
  }, [dictating, dictation.phase, draft, tab.id, onDraftChange]);
  useHotkey("mod+shift+d", toggleDictation, { enabled: autoFocus });

  const token = useMemo(() => tokenAtCaret(draft, caret), [draft, caret]);
  const tokenKey = token ? `${token.kind}:${token.start}` : null;
  const pickerOpen = !!token && dismissedToken !== tokenKey && (token.kind === "mention" ? !!cwd : commands.length > 0);

  // File hits follow the query, lightly debounced.
  useEffect(() => {
    if (!token || token.kind !== "mention" || !cwd) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      filesApi
        .search(cwd, token.query, 30)
        .then((h) => !cancelled && setFileHits(h))
        .catch(() => {});
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [token?.kind, token?.query, cwd]);

  const items: PickerItem[] = useMemo(() => {
    if (!token) return [];
    if (token.kind === "slash") {
      const q = token.query.toLowerCase();
      return commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 30)
        .map((c) => ({ id: c.name, label: `/${c.name}`, detail: c.description, hint: c.argumentHint ?? (c.source !== "builtin" ? c.source : undefined), icon: <SlashSquare className="size-3.5" /> }));
    }
    return fileHits.map((h) => ({ id: h.path, label: h.name, detail: h.path, icon: <FileText className="size-3.5" /> }));
  }, [token, commands, fileHits]);

  useEffect(() => setHighlighted(0), [items.length, tokenKey]);

  const complete = useCallback(
    (item: PickerItem) => {
      if (!token) return;
      const replacement = token.kind === "slash" ? `/${item.id} ` : `@${item.id} `;
      const before = draft.slice(0, token.start);
      const after = draft.slice(caret);
      const next = before + replacement + after;
      onDraftChange(next);
      const pos = before.length + replacement.length;
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus();
          el.setSelectionRange(pos, pos);
          setCaret(pos);
        }
      });
    },
    [token, draft, caret, onDraftChange],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text && !attachments.length) return;
    const imgs = attachments.map((a) => ({ mediaType: a.mediaType, data: a.data, name: a.name }));
    onDraftChange("");
    setAttachments([]);
    await onSend(text, imgs);
    ref.current?.focus();
  }, [draft, attachments, onSend, onDraftChange]);

  const addFiles = useCallback(async (list: File[]) => {
    const out: Attachment[] = [];
    for (const f of list) {
      if (!f.type.startsWith("image/") || f.size > 5 * 1024 * 1024) continue;
      const data = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.readAsDataURL(f);
      });
      out.push({ id: crypto.randomUUID(), name: f.name, mediaType: f.type, data, previewUrl: URL.createObjectURL(f) });
    }
    if (out.length) setAttachments((a) => [...a, ...out]);
  }, []);

  // Dropped paths arrive from the window, not the DOM: images attach, the
  // rest become mentions the harness reads itself.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      try {
        const off = await getCurrentWebview().onDragDropEvent(async (e) => {
          const p = e.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            const mentions: string[] = [];
            for (const path of p.paths) {
              const img = await filesApi.readImage(path).catch(() => null);
              if (img) {
                setAttachments((a) => [...a, { id: crypto.randomUUID(), name: img.name, mediaType: img.mediaType, data: img.data, previewUrl: `data:${img.mediaType};base64,${img.data}` }]);
              } else {
                mentions.push(`@${path}`);
              }
            }
            if (mentions.length) {
              const sep = draft && !/\s$/.test(draft) ? " " : "";
              onDraftChange(draft + sep + mentions.join(" ") + " ");
            }
            ref.current?.focus();
          }
        });
        if (disposed) off();
        else unlisten = off;
      } catch {
        /* outside a webview */
      }
    })();
    return () => {
      disposed = true;
      const off = unlisten;
      unlisten = null;
      try {
        off?.();
      } catch {
        /* already gone */
      }
    };
  }, [draft, onDraftChange]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        complete(items[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedToken(tokenKey);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const placeholder = busy ? "Send a follow-up (it queues until the agent pauses)" : "Ask, build, or describe the next step";
  const pct = contextUsed && contextMax ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      {disabledReason && <div className="mb-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">{disabledReason}</div>}
      {dictation.error && dictation.target === null && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="flex-1">{dictation.error}</span>
          <button type="button" className="underline-offset-2 hover:underline" onClick={clearDictationError}>
            Dismiss
          </button>
        </div>
      )}
      {dictating && (
        <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", dictation.phase === "listening" ? "bg-destructive animate-pulse-soft" : "bg-faint")} />
          {dictation.phase === "starting" ? "Opening the microphone…" : dictation.phase === "finishing" ? "Finishing…" : "Listening. Speak, then press the mic again."}
        </div>
      )}
      <div
        className={cn(
          "relative rounded-2xl bg-composer glass p-2.5 shadow-surface hairline focus-within:ring-1 focus-within:ring-ring/40",
          dragging && "ring-2 ring-accent/60",
        )}
        onPaste={(e) => {
          const list = [...e.clipboardData.files];
          if (list.length) {
            e.preventDefault();
            void addFiles(list);
          }
        }}
      >
        {pickerOpen && (
          <PickerMenu
            items={items}
            highlighted={highlighted}
            onPick={complete}
            onHover={setHighlighted}
            title={token?.kind === "slash" ? "Commands" : "Files"}
            empty={token?.kind === "slash" ? "No matching command" : "No matching file"}
          />
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-composer/80 text-sm text-muted-foreground">
            Drop images to attach, other files to mention
          </div>
        )}
        {!busy && !draft && handoffs && handoffs.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5 px-1" aria-label="Next steps">
            {handoffs.map((h) => (
              <button
                key={h.label}
                type="button"
                onClick={() => {
                  onDraftChange(h.prompt);
                  requestAnimationFrame(() => ref.current?.focus());
                }}
                className="rounded-full bg-veil-raised px-2.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-veil-strong hover:text-foreground"
              >
                {h.label}
              </button>
            ))}
          </div>
        )}
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
          onChange={(e) => {
            onDraftChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedToken(null);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          className="max-h-60 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="mt-1 flex items-center gap-1">
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles([...e.target.files])} />
          <WithTooltip label="Attach image">
            <Button variant="ghost" size="icon-sm" aria-label="Attach image" onClick={() => fileRef.current?.click()}>
              <ImagePlus />
            </Button>
          </WithTooltip>
          {canDictate !== false && (
            <WithTooltip label={dictating ? "Stop dictating" : "Dictate"} keys={keycaps("mod+shift+d")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={dictating ? "Stop dictating" : "Dictate"}
                aria-pressed={dictating}
                onClick={toggleDictation}
                disabled={dictation.phase !== "idle" && !dictating}
                className={cn(dictating && "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive")}
              >
                <Mic className={cn(dictating && dictation.phase === "listening" && "animate-pulse-soft")} />
              </Button>
            </WithTooltip>
          )}
          {cwd && (
            <WithTooltip label="Mention a file">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Mention a file"
                onClick={() => {
                  const sep = draft && !/\s$/.test(draft) ? " " : "";
                  const next = draft + sep + "@";
                  onDraftChange(next);
                  setDismissedToken(null);
                  requestAnimationFrame(() => {
                    ref.current?.focus();
                    ref.current?.setSelectionRange(next.length, next.length);
                    setCaret(next.length);
                  });
                }}
              >
                <AtSign />
              </Button>
            </WithTooltip>
          )}

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
            <UsageBadge windows={usageWindows} codex={codexUsage} />
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
            <WithTooltip label={busy ? "Queue" : "Send"} keys={keycaps("enter")}>
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


function resetsIn(epochSeconds: number): string {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.round(h / 24)}d`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Plan usage as the harness reports it: how full each rolling window is. */
function UsageBadge({
  windows,
  codex,
}: {
  windows?: Record<string, { utilization: number; resetsAt: number }>;
  codex?: { usedPercent: number; resetsAt: number; windowMins: number; plan?: string };
}) {
  const parts: { label: string; pct: number; resetsAt: number }[] = [];
  if (windows) {
    const order: [string, string][] = [
      ["five_hour", "5h"],
      ["seven_day", "7d"],
      ["seven_day_sonnet", "7d Sonnet"],
      ["seven_day_opus", "7d Opus"],
    ];
    for (const [key, label] of order) {
      const w = windows[key];
      if (w) parts.push({ label, pct: Math.round(w.utilization * 100), resetsAt: w.resetsAt });
    }
  }
  if (codex) {
    const label = codex.windowMins >= 1440 ? `${Math.round(codex.windowMins / 1440)}d` : `${Math.round(codex.windowMins / 60)}h`;
    parts.push({ label, pct: Math.round(codex.usedPercent), resetsAt: codex.resetsAt });
  }
  if (!parts.length) return null;
  const worst = Math.max(...parts.map((p) => p.pct));
  return (
    <WithTooltip label={parts.map((p) => `${p.label} window ${p.pct}% used, resets in ${resetsIn(p.resetsAt)}`).join(" · ")}>
      <span
        className={cn(
          "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] tabular-nums",
          worst >= 90 ? "bg-destructive/15 text-destructive" : worst >= 70 ? "bg-warning/15 text-warning" : "text-faint",
        )}
        aria-label="Plan usage"
      >
        {parts.slice(0, 2).map((p) => (
          <span key={p.label}>
            {p.label} {p.pct}%
          </span>
        ))}
      </span>
    </WithTooltip>
  );
}
