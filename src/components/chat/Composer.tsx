import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown, FileText, SlashSquare, Square } from "lucide-react";
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
import { EFFORT_LABEL, PERMISSION_MODES, modeLabel, refreshModels, upgradeHint, useModels } from "@/lib/models";
import { chooseMode } from "@/lib/dialogs";
import { files as filesApi, type FileHit, type ImageInput, type SlashCommand } from "@/lib/api";
import type { TabEntry } from "@/types/session";
import { DictationStatus, MicButton, useDictationInto } from "./Dictation";
import { PickerMenu, type PickerItem } from "./PickerMenu";
import { AttachButton, AttachmentThumbs, DropHint, useImageAttachments } from "./useImageAttachments";
import { tokenAtCaret } from "@/lib/pickers";

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
  /** Next-step prompts offered after a turn lands (commit, PR, run). */
  handoffs?: { label: string; prompt: string }[];
  disabledReason?: string | null;
  autoFocus?: boolean;
}) {
  const models = useModels(tab.harness);
  const model = models.find((m) => m.id === tab.model) ?? models.find((m) => m.isDefault);
  const [caret, setCaret] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>(() => commandCache.get(`${cwd}|${tab.harness}`) ?? []);
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const attach = useImageAttachments({ textareaRef: ref, draft, onDraftChange });
  const { attachments } = attach;

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

  const dictation = useDictationInto(tab.id, draft, onDraftChange, ref);
  useHotkey("mod+shift+d", dictation.toggle, { enabled: autoFocus });

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
    if ((!text && !attachments.length) || sending) return;
    setSending(true);
    try {
      await onSend(text, attach.images);
    } catch {
      // The owning tab renders the send error. Keep the draft and attachments
      // here so the reader can retry without selecting them again.
      return;
    } finally {
      setSending(false);
    }
    onDraftChange("");
    attach.clear();
    ref.current?.focus();
  }, [draft, attachments, attach, sending, onSend, onDraftChange]);

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
      <DictationStatus dictation={dictation} />
      <div
        className={cn(
          "relative rounded-2xl bg-composer glass p-2.5 shadow-surface hairline focus-within:ring-1 focus-within:ring-ring/40",
          attach.dragging && "ring-2 ring-accent/60",
        )}
        {...attach.dropZoneProps}
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
        <DropHint dragging={attach.dragging} />
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
        <AttachmentThumbs attach={attach} />
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
          <AttachButton attach={attach} />
          <MicButton dictation={dictation} />
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

          <DropdownMenu onOpenChange={(open) => open && void refreshModels()}>
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
                {models.map((m) => {
                  const upgrade = upgradeHint(m, models);
                  return (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      {m.label}
                      {upgrade ? <span className="ml-1.5 text-faint">→ {upgrade}</span> : null}
                    </DropdownMenuRadioItem>
                  );
                })}
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
              <DropdownMenuRadioGroup value={tab.permissionMode} onValueChange={(v) => chooseMode(tab.harness, v, onSetMode)}>
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
            <WithTooltip label={busy ? "Queue" : "Send"} keys={keycaps("enter")}>
              <Button
                size="icon-sm"
                variant={draft.trim() || attachments.length ? "accent" : "secondary"}
                aria-label="Send"
                disabled={sending || (!draft.trim() && !attachments.length)}
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
