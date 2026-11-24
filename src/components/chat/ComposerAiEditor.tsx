import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Sparkles } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AiEdit, AiEditorBackend, AiEditStyle } from "@/lib/aiEdit";
import { cn } from "@/lib/cn";
import { changeCount, wordDiff } from "@/lib/wordDiff";

type Mode = "fix" | "style" | "translate";

const STYLES: { value: AiEditStyle; label: string; hint: string }[] = [
  { value: "clear", label: "Clear prompt", hint: "A direct request to the agent" },
  { value: "improve", label: "Improve prompt", hint: "Goal, context and acceptance criteria" },
  { value: "short", label: "Short", hint: "As brief as possible" },
  { value: "detailed", label: "Detailed", hint: "Fuller, more precise wording" },
  { value: "formal", label: "Formal", hint: "A professional tone" },
  { value: "friendly", label: "Friendly", hint: "A warm tone" },
];

const LANGUAGES = ["English", "Hindi", "Gujarati", "Spanish", "French", "German", "Portuguese", "Arabic", "Russian", "Japanese", "Korean", "Chinese (Simplified)"];

type Run =
  | { state: "idle" }
  | { state: "running"; id: string }
  | { state: "done"; source: string; result: string; mode: Mode }
  | { state: "failed"; message: string };

const ACTION: Record<Mode, string> = { fix: "Check my text", style: "Rewrite", translate: "Translate" };

function ResultText({ source, result, mode }: { source: string; result: string; mode: Mode }) {
  const parts = useMemo(() => (mode === "translate" ? null : wordDiff(source, result)), [mode, source, result]);
  if (!parts) return <p className="whitespace-pre-wrap break-words">{result}</p>;
  return (
    <p className="whitespace-pre-wrap break-words" data-testid="ai-editor-diff">
      {parts.map((part, index) =>
        part.kind === "same" ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === "add" ? (
          <ins key={index} className="text-add underline underline-offset-2">{part.text}</ins>
        ) : (
          <del key={index} className="text-destructive line-through">{part.text}</del>
        ),
      )}
    </p>
  );
}

/**
 * Fix, restyle or translate the draft. The result is only shown until the
 * person applies it, and a draft edited meanwhile is never overwritten.
 */
export function ComposerAiEditor({ draft, backend, disabled, reason, open, onOpenChange, onApply, onApplyAndSend, canSend }: {
  draft: string;
  backend: AiEditorBackend | null;
  disabled: boolean;
  /** Why it can't be used now. */
  reason: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (text: string) => void;
  onApplyAndSend: (text: string) => void;
  canSend: boolean;
}) {
  const [mode, setMode] = useState<Mode>("fix");
  const [style, setStyle] = useState<AiEditStyle>("clear");
  const [language, setLanguage] = useState("English");
  const [run, setRun] = useState<Run>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const current = useRef<string | null>(null);

  const stop = () => {
    if (current.current) backend?.cancel(current.current);
    current.current = null;
  };
  useEffect(() => () => {
    if (current.current) backend?.cancel(current.current);
    current.current = null;
  }, [backend]);
  useEffect(() => {
    if (open) return;
    if (current.current) backend?.cancel(current.current);
    current.current = null;
    setRun({ state: "idle" });
    setCopied(false);
  }, [open, backend]);

  const start = async () => {
    if (!backend || !draft.trim()) return;
    stop();
    const id = crypto.randomUUID();
    const source = draft;
    const asked = mode;
    const edit: AiEdit = asked === "fix" ? { kind: "fix" } : asked === "style" ? { kind: "style", style } : { kind: "translate", language };
    current.current = id;
    setCopied(false);
    setRun({ state: "running", id });
    try {
      const result = await backend.run(edit, source, id);
      if (current.current !== id) return;
      current.current = null;
      setRun({ state: "done", source, result, mode: asked });
    } catch (error) {
      if (current.current !== id) return;
      current.current = null;
      setRun({ state: "failed", message: String(error) });
    }
  };

  const choose = (next: Mode) => {
    stop();
    setMode(next);
    setRun({ state: "idle" });
  };

  const done = run.state === "done" ? run : null;
  const stale = !!done && done.source !== draft;
  const unchanged = !!done && done.result === done.source;
  const changes = done && done.mode !== "translate" ? changeCount(wordDiff(done.source, done.result)) : 0;
  const usable = !!done && !stale && !unchanged;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="AI Editor" title={reason ?? "AI Editor: fix, restyle or translate"} disabled={disabled} data-testid="ai-editor">
          <Sparkles />
        </Button>
      </PopoverTrigger>
      <PopoverContent label="AI Editor" side="top" align="end" className="w-[26rem]" data-testid="ai-editor-panel">
        <Segmented<Mode>
          aria-label="What to do"
          className="mb-2 w-full"
          value={mode}
          onChange={choose}
          options={[{ value: "fix", label: "Fix" }, { value: "style", label: "Style" }, { value: "translate", label: "Translate" }]}
        />
        {mode === "style" && (
          <div role="radiogroup" aria-label="Style" className="mb-2 flex flex-wrap gap-1">
            {STYLES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={style === option.value}
                title={option.hint}
                onClick={() => { stop(); setStyle(option.value); setRun({ state: "idle" }); }}
                className={cn("rounded-full px-2.5 py-0.5 text-xs transition-colors", style === option.value ? "bg-accent text-accent-foreground" : "bg-veil-raised text-muted-foreground hover:bg-veil-strong hover:text-foreground")}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        {mode === "translate" && (
          <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            Into
            <select
              value={language}
              onChange={(event) => { stop(); setLanguage(event.target.value); setRun({ state: "idle" }); }}
              className="h-7 min-w-0 flex-1 rounded-md bg-well px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {LANGUAGES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
        <div className="mb-2 rounded-md bg-well p-2 text-[13px] leading-relaxed">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{done ? "Result" : "Original"}</div>
          <div className="max-h-52 overflow-y-auto">
            {done ? <ResultText source={done.source} result={done.result} mode={done.mode} /> : <p className="whitespace-pre-wrap break-words">{draft}</p>}
          </div>
        </div>
        <div role="status" className="mb-2 min-h-4 text-xs text-muted-foreground">
          {run.state === "running" && "Working…"}
          {run.state === "failed" && <span className="text-destructive">{run.message}</span>}
          {done && stale && <span className="text-warning">The draft changed, so this result can't be applied. Run it again.</span>}
          {done && !stale && unchanged && "Looks good. Nothing to change."}
          {done && !stale && !unchanged && done.mode !== "translate" && `${changes} ${changes === 1 ? "suggestion" : "suggestions"}`}
        </div>
        <div className="flex items-center gap-1.5">
          {run.state === "running" ? (
            <Button variant="secondary" size="sm" onClick={() => { stop(); setRun({ state: "idle" }); }}>Cancel</Button>
          ) : usable ? (
            <>
              <Button variant="accent" size="sm" onClick={() => onApply(done.result)} data-testid="ai-editor-apply">Apply</Button>
              <Button variant="secondary" size="sm" disabled={!canSend} onClick={() => onApplyAndSend(done.result)} data-testid="ai-editor-apply-send">Apply &amp; send</Button>
            </>
          ) : (
            <Button variant="accent" size="sm" disabled={!draft.trim()} onClick={() => void start()} data-testid="ai-editor-run">{ACTION[mode]}</Button>
          )}
          {done && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={copied ? "Copied" : "Copy result"}
              onClick={() => { void navigator.clipboard.writeText(done.result).then(() => setCopied(true), () => setCopied(false)); }}
            >
              <Copy />
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
