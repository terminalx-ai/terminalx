import { useEffect, useRef, useState } from "react";
import { ShieldAlert, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { PendingAsk } from "@/lib/transcript";
import { shortPath } from "@/lib/paths";

/**
 * A held tool call. The buttons are the harness's own options; the app only
 * ever answers with an option id. The first option answers to Enter.
 */
export function PermissionCard({ ask, onAnswer, busy }: { ask: PendingAsk; onAnswer: (optionId: string) => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const input = (ask.input ?? {}) as Record<string, unknown>;
  const detail = detailFor(ask.toolName ?? "", input);
  return (
    <div
      ref={ref}
      className="animate-fade-in rounded-xl border border-warning/30 bg-warning/[0.06] p-3.5"
      onKeyDown={(e) => {
        if (e.key === "Enter" && ask.options?.[0] && !busy) {
          e.preventDefault();
          onAnswer(ask.options[0].id);
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {ask.toolName} wants to {verbFor(ask.toolName ?? "")}
          </div>
          {ask.description && <div className="mt-0.5 text-xs text-muted-foreground">{ask.description}</div>}
          {detail && (
            <pre className="mt-2 max-h-48 overflow-auto scrollbar-thin rounded-md bg-well px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all select-text">
              {detail}
            </pre>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {ask.options?.map((o, i) => (
              <Button
                key={o.id}
                size="sm"
                variant={o.kind === "deny" ? "outline" : i === 0 ? "accent" : "secondary"}
                disabled={busy}
                onClick={() => onAnswer(o.id)}
                className={cn(o.kind === "deny" && "ml-auto text-muted-foreground")}
              >
                {o.label}
                {i === 0 && <Kbd className="ml-1 bg-black/10">⏎</Kbd>}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function verbFor(tool: string): string {
  switch (tool) {
    case "Bash":
    case "shell":
      return "run a command";
    case "apply_patch":
      return "edit files";
    case "Edit":
    case "MultiEdit":
      return "edit a file";
    case "Write":
      return "write a file";
    case "Read":
      return "read a file";
    case "WebFetch":
      return "fetch a URL";
    case "WebSearch":
      return "search the web";
    default:
      return tool.startsWith("mcp__") ? "use an MCP tool" : "run";
  }
}

function detailFor(tool: string, input: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (tool) {
    case "Bash":
    case "shell":
      return s("command") ?? null;
    case "apply_patch": {
      const changes = input["changes"];
      return Array.isArray(changes) ? changes.map((c) => `${(c as { kind?: string }).kind ?? "update"} ${(c as { path?: string }).path ?? ""}`).join("\n") : null;
    }
    case "Edit":
      return `${shortPath(s("file_path") ?? "")}\n- ${s("old_string") ?? ""}\n+ ${s("new_string") ?? ""}`;
    case "Write":
      return `${shortPath(s("file_path") ?? "")}\n${(s("content") ?? "").slice(0, 2000)}`;
    case "Read":
      return shortPath(s("file_path") ?? "");
    case "WebFetch":
      return s("url") ?? null;
    default: {
      const keys = Object.keys(input);
      if (!keys.length) return null;
      return JSON.stringify(input, null, 2).slice(0, 2000);
    }
  }
}

/**
 * AskUserQuestion as a form. Item names are the question text, so the
 * answers map is already keyed the way the harness matches.
 */
export function QuestionCard({ ask, onAnswer, busy }: { ask: PendingAsk; onAnswer: (answers: Record<string, string>) => void; busy?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button[data-choice]")?.focus();
  }, []);
  const questions = ask.questions ?? [];

  const toggle = (q: string, label: string, multi: boolean) => {
    setAnswers((a) => {
      if (!multi) return { ...a, [q]: label };
      const cur = a[q] ? a[q].split(", ").filter(Boolean) : [];
      const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
      return { ...a, [q]: next.join(", ") };
    });
  };

  const submit = () => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const v = free[q.question]?.trim() || answers[q.question];
      if (v) out[q.question] = v;
    }
    onAnswer(out);
  };

  return (
    <form
      ref={ref}
      className="animate-fade-in rounded-xl border border-info/30 bg-info/[0.06] p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="min-w-0 flex-1 space-y-4">
          {questions.map((q) => {
            const picked = answers[q.question] ?? "";
            const pickedSet = new Set(picked.split(", ").filter(Boolean));
            return (
              <div key={q.question}>
                <div className="text-[13px] font-medium">{q.question}</div>
                <div className="mt-2 flex flex-col gap-1">
                  {q.options.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      data-choice
                      onClick={() => toggle(q.question, o.label, q.multiSelect)}
                      className={cn(
                        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        pickedSet.has(o.label) ? "border-ring bg-veil-raised" : "border-hairline hover:bg-veil-raised",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 size-2.5 shrink-0 rounded-full border",
                          pickedSet.has(o.label) ? "border-accent bg-accent" : "border-faint",
                        )}
                      />
                      <span>
                        <span>{o.label}</span>
                        {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                      </span>
                    </button>
                  ))}
                  {q.freeText && (
                    <input
                      value={free[q.question] ?? ""}
                      onChange={(e) => setFree((f) => ({ ...f, [q.question]: e.target.value }))}
                      placeholder="Or type your own answer"
                      className="mt-0.5 h-8 rounded-md border border-hairline bg-transparent px-2.5 text-[13px] outline-none placeholder:text-faint focus:border-ring"
                    />
                  )}
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="accent" type="submit" disabled={busy}>
              Answer <Kbd className="ml-1 bg-black/10">⏎</Kbd>
            </Button>
            <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => onAnswer({})}>
              Skip
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
