import { useEffect, useState } from "react";
import type { RecoveryKind } from "@/types/events";
import { recoveryOffer } from "@/lib/recovery";
import type { PendingAsk } from "@/lib/transcript";
import { PermissionCard, QuestionCard } from "@/components/chat/AskCards";
import { Button } from "@/components/ui/button";
import type { ModelInfo } from "@/lib/api";
import { modelOptionText } from "@/lib/models";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";
import { inputOf, type ActionInput } from "@/lib/recoveryReports";
import type { AgentAccount } from "@/lib/agentAccounts";

/** The plan window a refused request ran out of, and when it refills. */
export type UsageLimit = { status?: string; resetsAt?: number; window?: string };

const WINDOW_NAMES: Record<string, string> = { five_hour: "5-hour limit", seven_day: "Weekly limit" };

/** "Weekly limit · resets Sat 11 Oct, 11:00 pm (in 23h 5m)", or as much of it as is known. */
export function usageLimitText(limit: UsageLimit, now: number): string | null {
  const name = WINDOW_NAMES[limit.window ?? ""] ?? "Usage limit";
  if (limit.resetsAt == null) return null;
  const when = new Date(limit.resetsAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const countdown = formatResetCountdown(limit.resetsAt, now, "");
  return `${name} · resets ${when}${countdown === "now" ? " (now)" : countdown ? ` (in ${countdown})` : ""}`;
}

export function RecoveryBanner({ placement = "top", kind, limit = null, waiting, native = false, asks, busy, answering = false, answerBlockedReason = null, askDetail = true, models, onOpenModels, onPermission, onQuestions, onRetry, onStop, onContinue, onSendContinue, onSignIn, signInPending = false, onResend, onPressed, accounts = null }: {
  /** Above the composer in the chat, or across the top of a terminal. */
  placement?: "top" | "composer";
  kind: RecoveryKind | null;
  /** A native Codex tab (#644), which has no terminal to check until it is moved to one. */
  native?: boolean;
  /** When the plan's usage limit is what stopped the turn: which window, and when it resets. */
  limit?: UsageLimit | null;
  waiting: boolean;
  asks: PendingAsk[];
  busy: boolean;
  answering?: boolean;
  /** Set when this reader may not answer requests (a shared cloud workspace's non-approver, PRO-30). */
  answerBlockedReason?: string | null;
  /** Quote the full command, file or tool for local and shared-workspace requests. */
  askDetail?: boolean;
  models: ModelInfo[];
  onOpenModels?: () => void;
  onPermission: (id: string, option: string) => void;
  onQuestions: (id: string, answers: Record<string, string>) => void;
  onRetry: (model?: string) => void;
  onStop: () => void;
  /** Continue in a new session, from a summary of this one. */
  onContinue: () => void;
  /** Send "continue" in this same conversation, with no stop first. */
  onSendContinue?: () => void;
  /** Signed out: sign the agent in again, where it can be (its terminal, or a shell running its login). */
  onSignIn?: () => void;
  /** One login is open; successful authentication will retry the interrupted turn. */
  signInPending?: boolean;
  /** Unsent: send the last prompt the agent never received again, as it was sent. */
  onResend?: () => void;
  /** How a control here was pressed, told before its handler runs, for the tab's recovery incidents (#815). */
  onPressed?: (input: ActionInput) => void;
  /**
   * The agent's other accounts to continue on (#980): at a usage limit, those
   * whose windows have room; signed out, every other signed-in one. Each is
   * "Continue with <label>", the person's click; none with one account.
   */
  accounts?: { choices: AgentAccount[]; switching: string | null; error?: string | null; onSwitch: (account: AgentAccount) => void } | null;
}) {
  // A button pressed with a key fires a click with no count; a choice made in the model list is not told how.
  const pressed = (run: () => void) => (event: { detail?: number }) => {
    onPressed?.(inputOf(event));
    run();
  };
  const [selectedModel, setSelectedModel] = useState("");
  useEffect(() => {
    setSelectedModel("");
  }, [kind]);
  const now = useCountdownNow([kind === "usage_limit" ? limit?.resetsAt ?? null : null]);
  if (!kind && !waiting) return null;
  const reset = kind === "usage_limit" && limit ? usageLimitText(limit, now) : null;
  const limitReset = kind === "usage_limit" && limit?.resetsAt != null && limit.resetsAt <= now;
  const offer = recoveryOffer(kind, { asks: asks.length, limitReset, canResend: !!onResend, canSendContinue: !!onSendContinue, canSignIn: !!onSignIn, native });
  // Only a request to answer: the request's own card says it all, with stopping in its action bar.
  if (!kind && asks.length) {
    const stop = <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={pressed(onStop)}>Stop session</Button>;
    return <section aria-label="Session recovery" className={placement === "composer"
      ? "mx-auto mb-2 flex max-h-[60vh] w-[calc(100%-2rem)] max-w-3xl shrink-0 flex-col gap-2 overflow-auto"
      : "flex max-h-[50vh] shrink-0 flex-col gap-2 overflow-auto border-b border-hairline p-3"}>
      {asks.map((ask, i) => {
        const aside = i === asks.length - 1 ? stop : null;
        return <div key={ask.requestId}>{ask.kind === "permission"
          ? <PermissionCard ask={ask} busy={busy || answering} blockedReason={answerBlockedReason} showDetail={askDetail} aside={aside} onAnswer={option => onPermission(ask.requestId, option)} />
          : <QuestionCard ask={ask} busy={busy || answering} blockedReason={answerBlockedReason} aside={aside} onAnswer={answers => onQuestions(ask.requestId, answers)} />}</div>;
      })}
    </section>;
  }
  // Above the composer it floats over the transcript's foot, so its ground is solid (the warning tint mixed into the
  // chat's own colour, not laid over what scrolls behind), and it is exactly as wide as the composer under it.
  const card = (
    <section aria-label="Session recovery" className={placement === "composer"
      ? "max-h-[50vh] overflow-auto rounded-xl border border-warning/30 bg-[color-mix(in_oklab,var(--color-warning)_10%,var(--color-chat))] p-3 text-xs shadow-surface"
      : "max-h-[50vh] shrink-0 overflow-auto border-b border-warning/30 bg-warning/10 p-3 text-xs"}>
    <p className="font-medium">{offer.title}</p>
    <p className="mt-1">{signInPending && kind === "signed_out" ? "Finish signing in in the terminal. After sign-in is verified, the interrupted turn will retry once." : offer.message}</p>
    {reset && <p className="mt-1 text-muted-foreground" data-testid="usage-limit-reset">{reset}</p>}
    {accounts?.error && (kind === "usage_limit" || kind === "signed_out") && <p role="alert" className="mt-1 text-warning" data-testid="account-switch-error">{accounts.error}</p>}
    {asks.map(ask => <div key={ask.requestId} className="mt-2">{ask.kind === "permission"
      ? <PermissionCard ask={ask} busy={busy || answering} blockedReason={answerBlockedReason} showDetail={askDetail} onAnswer={option => onPermission(ask.requestId, option)} />
      : <QuestionCard ask={ask} busy={busy || answering} blockedReason={answerBlockedReason} onAnswer={answers => onQuestions(ask.requestId, answers)} />}</div>)}
    <div className="mt-2 flex flex-wrap gap-2">
      {(kind === "usage_limit" || kind === "signed_out") && accounts?.choices.map(account => (
        <Button key={account.id} size="sm" disabled={busy || !!accounts.switching} data-testid="continue-with-account"
          title={`Restart the agent on ${account.label} and resume this conversation`} onClick={pressed(() => accounts.onSwitch(account))}>
          {accounts.switching === account.id ? `Switching to ${account.label}…` : `Continue with ${account.label}`}
        </Button>
      ))}
      {offer.signIn && onSignIn && <Button size="sm" disabled={busy || signInPending} onClick={pressed(onSignIn)}>Sign in</Button>}
      {offer.resend && onResend && <Button size="sm" disabled={busy} onClick={pressed(onResend)}>Resend last prompt</Button>}
      {offer.retry && <Button size="sm" variant={kind === "signed_out" ? "outline" : undefined} disabled={busy} onClick={pressed(() => onRetry())}>{offer.retry}</Button>}
      {offer.sendContinue && onSendContinue && <Button size="sm" variant="outline" disabled={busy} title={'Send "continue" to the agent in this conversation'} onClick={pressed(onSendContinue)}>Continue here</Button>}
      {offer.chooseModel && (
        <div className="flex items-center gap-1.5">
          <select onFocus={onOpenModels} onPointerDown={onOpenModels} aria-label="Choose another model" disabled={busy} value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className="h-7 rounded border border-hairline bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            <option value="" disabled>Choose another model</option>
            {models.map(model => <option key={model.id} value={model.id}>{modelOptionText(model, models)}</option>)}
          </select>
          {selectedModel && (
            <Button size="sm" variant="outline" disabled={busy} onClick={pressed(() => {
              const next = selectedModel;
              setSelectedModel("");
              onRetry(next);
            })}>
              Switch &amp; retry
            </Button>
          )}
        </div>
      )}
      <Button size="sm" variant="outline" disabled={busy} onClick={pressed(onStop)}>Stop session</Button>
      {offer.continueInNewSession && <Button size="sm" variant="ghost" disabled={busy} onClick={pressed(onContinue)}>Continue in new session</Button>}
    </div>
  </section>
  );
  // The space under it is the wrapper's, on the chat's colour: a margin there was a gap the transcript showed through.
  return placement === "composer" ? <div className="mx-auto w-full max-w-3xl shrink-0 bg-chat px-6 pb-2">{card}</div> : card;
}
