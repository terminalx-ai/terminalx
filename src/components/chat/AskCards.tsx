import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ShieldAlert, MessageCircleQuestion } from "@/icons";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/tooltip";
import { revealInOwnScroller } from "@/lib/shellScroll";
import { cn } from "@/lib/cn";
import { usePromptTextProps } from "@/lib/autocorrect";
import type { PendingAsk } from "@/lib/transcript";
import { LinkedText } from "./LinkedText";

/**
 * A held tool call. The buttons are the harness's own options; the app only
 * ever answers with an option id. The first option answers to Enter.
 */
function field(input: unknown, ...names: string[]): string | null {
  if (!input || typeof input !== "object") return null;
  for (const name of names) {
    const value = (input as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * What the reader is approving. Preserve the full command, including its
 * whitespace: a suffix or a second line can change what it does.
 */
export function askDetail(ask: Pick<PendingAsk, "toolName" | "input" | "title">): string | null {
  const tool = ask.toolName ?? "";
  const detail =
    ["Bash", "shell", "shell_command", "exec_command", "functions.exec_command", "functions.shell_command"].includes(tool)
      ? field(ask.input, "command", "cmd")
      : tool === "WebFetch"
        ? field(ask.input, "url")
        : tool === "WebSearch"
          ? field(ask.input, "query")
          : (field(ask.input, "file_path", "path", "notebook_path") ?? (tool.startsWith("mcp__") ? tool.replace(/^mcp__/, "").replace(/__/g, " · ") : null));
  const text = detail ?? ask.title?.trim() ?? (tool || null);
  if (!text) return null;
  return text;
}

/** The one look both requests share: a labelled card, its body, and a bar of actions. */
const AskShell = forwardRef<HTMLDivElement, { icon: ReactNode; label: string; tone: "warning" | "info"; children: ReactNode; actions: ReactNode; aside?: ReactNode; note?: ReactNode }>(
  function AskShell({ icon, label, tone, children, actions, aside, note }, ref) {
    return (
      <div ref={ref} className="animate-fade-in overflow-hidden rounded-xl border border-hairline-strong bg-card">
        <div className={cn("flex items-center gap-1.5 px-4 pt-3 text-[11px] font-medium uppercase tracking-wide", tone === "warning" ? "text-warning" : "text-info")}>
          {icon}
          {label}
        </div>
        <div className="px-4 pb-3.5 pt-1.5">{children}</div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline bg-veil-card px-3 py-2">
          {aside && <div className="mr-auto flex items-center gap-1.5">{aside}</div>}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
        </div>
        {note && <p className="border-t border-hairline px-4 py-2 text-xs text-muted-foreground" data-testid="answer-blocked">{note}</p>}
      </div>
    );
  },
);

/** The Return hint on a request's default action. */
function EnterKey() {
  return <Kbd className="ml-1.5 h-4 min-w-4 bg-black/15 text-[10px] text-current">⏎</Kbd>;
}

export function PermissionCard({
  ask,
  onAnswer,
  busy,
  blockedReason = null,
  showDetail = true,
  aside,
}: {
  ask: PendingAsk;
  onAnswer: (optionId: string) => void;
  busy?: boolean;
  /**
   * Why this reader may not answer at all (a shared workspace's non-approver).
   * Every option is then plainly off: none keeps the accent that says "press
   * me", and the reason is written under them.
   */
  blockedReason?: string | null;
  /** Quote what is asked for (the command, file or tool) under the heading. */
  showDetail?: boolean;
  /** At the start of the action bar, such as stopping the session. */
  aside?: ReactNode;
}) {
  const detail = showDetail ? askDetail(ask) : null;
  const workdir = showDetail ? field(ask.input, "workdir", "cwd") : null;
  const directory = showDetail ? workdir ?? ask.cwd : null;
  const reason = showDetail ? field(ask.input, "justification", "description") ?? ask.description : null;
  const blocked = !!blockedReason;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The card is shown by its own scroller; focus alone would scroll every box above it too, the window included.
    const first = ref.current?.querySelector<HTMLButtonElement>("button");
    first?.focus({ preventScroll: true });
    if (first) revealInOwnScroller(first);
  }, []);
  return (
    <AskShell
      ref={ref}
      icon={<ShieldAlert className="size-3.5" />}
      label="Permission"
      tone="warning"
      aside={aside}
      note={blocked ? blockedReason : null}
      actions={ask.options?.map((o, i) => (
        <Button
          key={o.id}
          size="sm"
          // Blocked: the same quiet outline for every option, so Allow reads as off as Deny does.
          variant={blocked || o.kind === "deny" ? "outline" : i === 0 ? "accent" : "secondary"}
          disabled={busy || blocked}
          title={blockedReason ?? undefined}
          onClick={() => onAnswer(o.id)}
          className={cn((blocked || o.kind === "deny") && "text-muted-foreground")}
        >
          {o.kind === "deny" ? "Deny" : o.kind === "allow_once" ? "Allow" : o.kind === "allow_always" ? "Always allow" : o.kind === "allow_session" ? "Allow for session" : "Change permission mode"}
          {/* Return answers nothing for someone who may not answer. */}
          {i === 0 && !blocked && <EnterKey />}
        </Button>
      ))}
    >
      <div className="text-[14px] font-medium leading-snug text-foreground">
        Waiting for permission to {verbFor(ask.toolName ?? "")}
      </div>
      {detail && (
        <pre className="mt-2 max-h-60 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-well px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="permission-detail"><code>{detail}</code></pre>
      )}
      {directory && <p className="mt-2 break-words text-xs text-muted-foreground">{workdir ? "Working directory" : "Session directory"}: <code>{directory}</code></p>}
      {reason && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{reason}</p>}
    </AskShell>
  );
}

function verbFor(tool: string): string {
  switch (tool) {
    case "Bash":
    case "shell":
    case "shell_command":
    case "exec_command":
    case "functions.exec_command":
    case "functions.shell_command":
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

/**
 * AskUserQuestion as a form. Item names are the question text, so the
 * answers map is already keyed the way the harness matches.
 */
export function QuestionCard({
  ask,
  onAnswer,
  busy,
  blockedReason = null,
  aside,
}: {
  ask: PendingAsk;
  onAnswer: (answers: Record<string, string>) => void;
  busy?: boolean;
  /** Why this reader may not answer (see PermissionCard): Answer and Skip are plainly off, with the reason. */
  blockedReason?: string | null;
  /** At the start of the action bar, such as stopping the session. */
  aside?: ReactNode;
}) {
  const blocked = !!blockedReason;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const textProps = usePromptTextProps();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("button[data-choice]");
    first?.focus({ preventScroll: true });
    if (first) revealInOwnScroller(first);
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
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <AskShell
        icon={<MessageCircleQuestion className="size-3.5" />}
        label={questions.length > 1 ? `${questions.length} questions` : "Question"}
        tone="info"
        aside={aside}
        note={blocked ? blockedReason : null}
        actions={
          <>
            <Button size="sm" variant="ghost" type="button" disabled={busy || blocked} title={blockedReason ?? undefined} onClick={() => onAnswer({})} className="text-muted-foreground">
              Skip
            </Button>
            <Button size="sm" variant={blocked ? "outline" : "accent"} type="submit" disabled={busy || blocked} title={blockedReason ?? undefined} className={cn(blocked && "text-muted-foreground")}>
              Answer {!blocked && <EnterKey />}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {questions.map((q) => {
            const picked = answers[q.question] ?? "";
            const pickedSet = new Set(picked.split(", ").filter(Boolean));
            return (
              <div key={q.question}>
                <div className="text-[14px] font-medium leading-snug text-foreground"><LinkedText text={q.question} /></div>
                {q.multiSelect && <div className="mt-0.5 text-[12px] text-faint">Choose any that apply</div>}
                <div className="mt-3 flex flex-col gap-1.5">
                  {q.options.map((o) => {
                    const on = pickedSet.has(o.label);
                    return (
                      <div
                        key={o.label}
                        onClick={() => toggle(q.question, o.label, q.multiSelect)}
                        className={cn(
                          "group flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                          on ? "border-accent/50 bg-accent/[0.07]" : "border-hairline hover:border-hairline-strong hover:bg-veil-card",
                        )}
                      >
                        {/* The choice itself: a radio, or a checkbox where several may be picked. Links in the text stay outside it. */}
                        <button
                          type="button"
                          data-choice
                          aria-label={o.label}
                          aria-pressed={on}
                          onClick={(event) => { event.stopPropagation(); toggle(q.question, o.label, q.multiSelect); }}
                          className={cn(
                            "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            q.multiSelect ? "rounded-[4px]" : "rounded-full",
                            on ? "border-accent bg-accent" : "border-muted-foreground/50 group-hover:border-muted-foreground",
                          )}
                        >
                          {on && (q.multiSelect ? <Check className="size-3 text-accent-foreground" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-accent-foreground" />)}
                        </button>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium leading-5 text-foreground"><LinkedText text={o.label} /></span>
                          {o.description && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground"><LinkedText text={o.description} /></span>}
                        </span>
                      </div>
                    );
                  })}
                  {q.freeText && (
                    <input
                      {...textProps}
                      value={free[q.question] ?? ""}
                      onChange={(e) => setFree((f) => ({ ...f, [q.question]: e.target.value }))}
                      placeholder="Or type your own answer"
                      className="mt-1 h-9 rounded-lg border border-hairline bg-well px-3 text-[13px] outline-none placeholder:text-faint focus:border-ring/60"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </AskShell>
    </form>
  );
}
