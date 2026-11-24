import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { joinKeycaps } from "@/lib/shortcuts";
import { Check, ShieldAlert, MessageCircleQuestion, SquareTerminal } from "@/icons";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/tooltip";
import { revealInOwnScroller } from "@/lib/shellScroll";
import { hasEscapeOverlay, useShortcut, useShortcutKeys } from "@/lib/hotkeys";
import { cn } from "@/lib/cn";
import { usePromptTextProps } from "@/lib/autocorrect";
import { askAgentNote, questionAnswers, questionsLabel, toggleQuestionChoice, type PendingAsk, type QuestionChoices } from "@/lib/transcript";
import { approvalFiles, rawPatch } from "@/lib/approvalDiff";
import { ApprovalDiff, Counts } from "./ApprovalDiff";
import type { ScreenPrompt } from "@/types/events";
import { LinkedText } from "./LinkedText";

/**
 * A held tool call. The buttons are the harness's own options; the app only
 * ever answers with an option id. The first option answers to Enter, and
 * sits last in the bar; the first deny answers to Escape.
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
          : tool === "apply_patch"
            // The whole patch, when the card cannot show it as a diff: its first line says nothing.
            ? rawPatch(ask.input)
            : (field(ask.input, "file_path", "path", "notebook_path") ?? (tool.startsWith("mcp__") ? tool.replace(/^mcp__/, "").replace(/__/g, " · ") : null));
  const text = detail ?? ask.title?.trim() ?? (tool || null);
  if (!text) return null;
  return text;
}

/**
 * The one look both requests share: a labelled card, its body, and a bar of
 * actions. `heading` puts what is asked on the label's own line, with
 * `meta` at its end; its body is then flush, each part divided by a rule.
 */
const AskShell = forwardRef<HTMLDivElement, { icon: ReactNode; label: string; tone: "warning" | "info"; children: ReactNode; actions: ReactNode; aside?: ReactNode; note?: ReactNode; heading?: ReactNode; meta?: string | null }>(
  function AskShell({ icon, label, tone, children, actions, aside, note, heading, meta }, ref) {
    const labelText = (
      <span className={cn("flex shrink-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide", tone === "warning" ? "text-warning" : "text-info")}>
        {icon}
        {label}
      </span>
    );
    return (
      // A toast rising off the composer rises past this card too, never onto its Allow and Deny (PRO-386).
      // Its ground is the popover's, which glass mode never veils: --card turns near-transparent there, and a card
      // drawn over the transcript let the reply's words show through its own (#1293).
      <div ref={ref} data-ask-card data-toast-avoid="" className="animate-fade-in overflow-hidden rounded-xl border border-hairline-strong bg-popover">
        {heading ? (
          <>
            <div className="flex min-w-0 items-center gap-2.5 px-4 py-2.5" data-testid="ask-header">
              {labelText}
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13.5px] font-medium leading-snug text-foreground">{heading}</div>
              {meta && <span className="ml-auto min-w-0 shrink truncate pl-2 text-[12px] text-faint" title={meta} data-testid="ask-meta">{meta}</span>}
            </div>
            <div className="divide-y divide-hairline border-t border-hairline empty:hidden">{children}</div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 px-4 pt-3">{labelText}</div>
            <div className="px-4 pb-3.5 pt-1.5">{children}</div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline bg-veil-card px-3 py-2">
          {aside && <div className="mr-auto flex items-center gap-1.5 pl-1">{aside}</div>}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5" data-ask-actions>{actions}</div>
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

/** The option a request's Escape answers: its first deny. */
export function denyOption(ask: Pick<PendingAsk, "options">) {
  return ask.options?.find((o) => o.kind === "deny") ?? null;
}

/**
 * The options in the order the bar shows them, the primary last where the
 * eye ends: Deny first, then the rest as the harness lists them, then the
 * first option (the one Return answers).
 */
function barOrder<T extends { kind: string }>(options: T[]): { option: T; primary: boolean }[] {
  const tagged = options.map((option, i) => ({ option, primary: i === 0 }));
  return [
    ...tagged.filter((t) => t.option.kind === "deny" && !t.primary),
    ...tagged.filter((t) => t.option.kind !== "deny" && !t.primary),
    ...tagged.filter((t) => t.primary),
  ];
}

export function PermissionCard({
  ask,
  onAnswer,
  busy,
  blockedReason = null,
  showDetail = true,
  aside,
  meta = null,
  takesKeys = false,
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
  /** Show what is asked for: an edit as its diff, anything else quoted (the command, file or tool). */
  showDetail?: boolean;
  /** At the start of the action bar, such as stopping the session; by default, that the agent waits. */
  aside?: ReactNode;
  /** At the end of the header: the session's permission mode and project, as "Ask every time · tx-review-lab". */
  meta?: string | null;
  /** The card's view has the keys: the chat's Escape (the interrupt) denies the request instead. */
  takesKeys?: boolean;
}) {
  // An edit is shown as what it changes; anything else, or an edit that cannot be read exactly, as asked.
  const files = useMemo(() => (showDetail ? approvalFiles(ask.toolName, ask.input) : null), [showDetail, ask.toolName, ask.input]);
  const detail = showDetail && !files ? askDetail(ask) : null;
  // A command's own working directory, where it says one: the session's is the project the header names.
  const workdir = showDetail ? field(ask.input, "workdir", "cwd") : null;
  // Why the card is up, in the app's words: in bypass mode, Claude Code's own safety check (#775). Never the agent's.
  const why = ask.reason?.trim() || null;
  // What the agent says of the call: what the command does, or why it wants it. Labelled as the agent's, so it is not read as why the card is up.
  const agentNote = showDetail ? askAgentNote(ask) : null;
  const note = showDetail && !agentNote ? ask.description?.trim() || null : null;
  const blocked = !!blockedReason;
  const deny = denyOption(ask);
  const escKeys = useShortcutKeys("session.interrupt");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The card is shown by its own scroller; focus alone would scroll every box above it too, the window included.
    // The primary answer, not Deny before it nor a control in the diff above it: Return still answers.
    const primary = ref.current?.querySelector<HTMLButtonElement>("[data-ask-actions] button[data-primary]");
    primary?.focus({ preventScroll: true });
    if (primary) revealInOwnScroller(primary);
  }, []);
  // Escape denies, ahead of the interrupt it otherwise is: the turn is held on this card anyway.
  const denyKey = useCallback(() => {
    if (!deny || busy || blocked || hasEscapeOverlay() || document.activeElement?.closest(".editor-pane")) return false;
    onAnswer(deny.id);
    return true;
  }, [deny, busy, blocked, onAnswer]);
  useShortcut("session.interrupt", denyKey, { enabled: takesKeys && !!deny && !blocked, priority: 1 });
  const verb = verbFor(ask.toolName ?? "", files?.length);
  const what = verb.charAt(0).toUpperCase() + verb.slice(1);
  return (
    <AskShell
      ref={ref}
      icon={<ShieldAlert className="size-3.5" />}
      label="Approval"
      tone="warning"
      heading={
        <>
          <span data-testid="permission-title">{what}</span>
          {files && files.length > 1 && <Counts added={files.reduce((n, f) => n + f.added, 0)} removed={files.reduce((n, f) => n + f.removed, 0)} className="font-normal" />}
        </>
      }
      meta={meta}
      aside={aside ?? <span className="text-[12px] text-muted-foreground">The agent waits until you decide.</span>}
      note={blocked ? blockedReason : null}
      actions={barOrder(ask.options ?? []).map(({ option: o, primary }) => (
        <Button
          key={o.id}
          size="sm"
          // Blocked: the same quiet outline for every option, so Allow reads as off as Deny does.
          variant={blocked || o.kind === "deny" ? "outline" : primary ? "accent" : "outline"}
          disabled={busy || blocked}
          title={blockedReason ?? undefined}
          onClick={() => onAnswer(o.id)}
          data-primary={primary || undefined}
          className={cn((blocked || o.kind === "deny") && "text-muted-foreground")}
        >
          {o.kind === "deny" ? "Deny" : o.kind === "allow_once" ? "Allow" : o.kind === "allow_always" ? "Always allow" : o.kind === "allow_session" ? o.label : "Change permission mode"}
          {/* Return answers nothing for someone who may not answer. */}
          {primary && !blocked && <EnterKey />}
          {o.kind === "deny" && !primary && !blocked && takesKeys && o.id === deny?.id && escKeys.length > 0 && (
            <Kbd className="ml-1.5 h-4 min-w-4 px-1 text-[10px] lowercase text-current">{joinKeycaps(escKeys)}</Kbd>
          )}
        </Button>
      ))}
    >
      {why && <p className="whitespace-pre-wrap break-words px-4 py-2.5 text-xs leading-relaxed text-foreground/80" data-testid="permission-reason">{why}</p>}
      {files && <ApprovalDiff files={files} cwd={workdir ?? ask.cwd ?? undefined} />}
      {(detail || workdir || agentNote || note) && (
        <div className="space-y-2 px-4 py-2.5">
          {detail && (
            <pre className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-well px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground [overflow-wrap:anywhere]" data-testid="permission-detail"><code>{detail}</code></pre>
          )}
          {workdir && <p className="break-words text-xs text-muted-foreground">Working directory: <code>{workdir}</code></p>}
          {agentNote && (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground" data-testid="permission-agent-note">
              <span className="font-medium text-foreground/70">Agent:</span> <span>{agentNote}</span>
            </p>
          )}
          {note && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{note}</p>}
        </div>
      )}
    </AskShell>
  );
}

/** `files`: how many files an edit the card shows as a diff touches. */
function verbFor(tool: string, files?: number): string {
  switch (tool) {
    case "Bash":
    case "shell":
    case "shell_command":
    case "exec_command":
    case "functions.exec_command":
    case "functions.shell_command":
      return "run a command";
    case "apply_patch":
      return files === 1 ? "edit a file" : files ? `edit ${files} files` : "edit files";
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
      return tool.startsWith("mcp__") ? "use an MCP tool" : tool ? `use ${tool}` : "run a tool";
  }
}

/**
 * AskUserQuestion as a form. Choices are kept by position (question index →
 * the indices of its chosen options), so a label holding ", ", or two equal
 * labels or questions, stay distinct. Only Answer turns them into the agent's
 * format: keyed by question text, labels joined with ", ".
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
  /** Per question index, the chosen option indices, in the order they were picked. */
  const [chosen, setChosen] = useState<QuestionChoices>({});
  /** Per question index, the typed answer. */
  const [free, setFree] = useState<Record<number, string>>({});
  const textProps = usePromptTextProps();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("button[data-choice]");
    first?.focus({ preventScroll: true });
    if (first) revealInOwnScroller(first);
  }, []);
  const questions = ask.questions ?? [];

  const toggle = (question: number, option: number, multi: boolean) => setChosen((c) => toggleQuestionChoice(c, question, option, multi));

  // The phone's card sends the same (`questionAnswers`), so the agent reads one format from either device.
  const submit = () => onAnswer(questionAnswers(questions, chosen, free));

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
        label={questionsLabel(questions.length)}
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
          {questions.map((q, qi) => {
            const picked = chosen[qi] ?? [];
            return (
              <div key={qi}>
                <div className="text-[14px] font-medium leading-snug text-foreground"><LinkedText text={q.question} /></div>
                {q.multiSelect && <div className="mt-0.5 text-[12px] text-faint">Choose any that apply</div>}
                <div className="mt-3 flex flex-col gap-1.5">
                  {q.options.map((o, oi) => {
                    const on = picked.includes(oi);
                    return (
                      <div
                        key={oi}
                        onClick={() => toggle(qi, oi, q.multiSelect)}
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
                          onClick={(event) => { event.stopPropagation(); toggle(qi, oi, q.multiSelect); }}
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
                      value={free[qi] ?? ""}
                      onChange={(e) => setFree((f) => ({ ...f, [qi]: e.target.value }))}
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

/**
 * A question the agent's CLI drew in its own terminal and is stopped on
 * (PRO-460), such as Claude Code's "We recommend compacting earlier": no hook
 * reports it, so the app read it off the screen. Its options are answered
 * with the keys the CLI's hint names; one that could not be read only sends
 * the reader to the terminal.
 */
export function TerminalPromptCard({
  prompt,
  agent,
  onAnswer,
  onOpenTerminal,
  busy,
  blockedReason = null,
  aside,
}: {
  prompt: ScreenPrompt;
  /** The agent's name, as the header calls it. */
  agent: string;
  /** Answer with an option's index, or null for what Escape does. Absent where the chat cannot type into the terminal. */
  onAnswer?: (choice: number | null) => void;
  onOpenTerminal?: () => void;
  busy?: boolean;
  blockedReason?: string | null;
  aside?: ReactNode;
}) {
  const readable = prompt.options.length > 0;
  const [chosen, setChosen] = useState<number>(prompt.selected ?? 0);
  // A new question, or the pointer moved in the terminal: start from where the CLI is.
  useEffect(() => setChosen(prompt.selected ?? 0), [prompt.id, prompt.selected]);
  const blocked = !!blockedReason;
  const answering = !!onAnswer && readable;
  const open = onOpenTerminal && (
    <Button size="sm" variant={readable ? "ghost" : "accent"} type="button" disabled={busy} onClick={onOpenTerminal} className={cn(readable && "text-muted-foreground")}>
      Open terminal
    </Button>
  );
  const actions = (
    <>
      {open}
      {answering && prompt.dismiss && (
        <Button size="sm" variant="ghost" type="button" disabled={busy || blocked} title={blockedReason ?? "Escape, in the terminal"} onClick={() => onAnswer(null)} className="text-muted-foreground">
          {prompt.dismiss}
        </Button>
      )}
      {answering && (
        <Button size="sm" variant={blocked ? "outline" : "accent"} type="submit" disabled={busy || blocked} title={blockedReason ?? undefined} className={cn(blocked && "text-muted-foreground")}>
          Choose {!blocked && <EnterKey />}
        </Button>
      )}
    </>
  );
  const heading = readable ? prompt.title ?? `${agent} is asking in its terminal` : `${agent} is waiting on a decision in its terminal`;
  return (
    <form
      data-testid="terminal-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (answering && !busy && !blocked) onAnswer(chosen);
      }}
    >
      <AskShell icon={<SquareTerminal className="size-3.5" />} label="In the terminal" tone="info" aside={aside} note={answering && blocked ? blockedReason : null} actions={actions} heading={<span>{heading}</span>}>
        <div className="space-y-3 px-4 py-3">
          {!readable && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              It stopped on a prompt of its own that TerminalX cannot show here. Open the terminal view to read it and answer there.
            </p>
          )}
          {prompt.text?.split("\n\n").map((paragraph, i) => (
            <p key={i} className="text-[13px] leading-relaxed text-muted-foreground"><LinkedText text={paragraph} /></p>
          ))}
          {readable && (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={prompt.title ?? "Options"}>
              {prompt.options.map((option, i) => {
                const on = chosen === i;
                return (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!answering}
                    onClick={() => setChosen(i)}
                    className={cn(
                      "group flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      answering ? "cursor-pointer" : "cursor-default",
                      on ? "border-accent/50 bg-accent/[0.07]" : "border-hairline enabled:hover:border-hairline-strong enabled:hover:bg-veil-card",
                    )}
                  >
                    <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-accent bg-accent" : "border-muted-foreground/50")}>
                      {on && <span className="size-1.5 rounded-full bg-accent-foreground" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium leading-5 text-foreground">{option.label}</span>
                      {option.description && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">{option.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {readable && !onAnswer && <p className="text-[12px] text-muted-foreground">Answer it in the terminal view.</p>}
          {readable && prompt.hint && <p className="text-[11.5px] text-faint" data-testid="terminal-prompt-hint">In the terminal: {prompt.hint}</p>}
        </div>
      </AskShell>
    </form>
  );
}
