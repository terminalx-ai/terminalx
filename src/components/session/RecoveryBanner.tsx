import type { RecoveryKind } from "@/types/events";
import { recoveryOffer } from "@/lib/recovery";
import type { PendingAsk } from "@/lib/transcript";
import { PermissionCard, QuestionCard } from "@/components/chat/AskCards";
import { Button } from "@/components/ui/button";
import type { ModelInfo } from "@/lib/api";
import { modelOptionText } from "@/lib/models";
import { formatResetCountdown, useCountdownNow } from "@/lib/statusTime";

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

export function RecoveryBanner({ placement = "top", kind, limit = null, waiting, asks, busy, answering = false, answerBlockedReason = null, askDetail = true, models, onOpenModels, onPermission, onQuestions, onRetry, onStop, onContinue, onSendContinue, onSignIn, onResend }: {
  /** Above the composer in the chat, or across the top of a terminal. */
  placement?: "top" | "composer";
  kind: RecoveryKind | null;
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
  /** Unsent: send the last prompt the agent never received again, as it was sent. */
  onResend?: () => void;
}) {
  const now = useCountdownNow([kind === "usage_limit" ? limit?.resetsAt ?? null : null]);
  if (!kind && !waiting) return null;
  const reset = kind === "usage_limit" && limit ? usageLimitText(limit, now) : null;
  const limitReset = kind === "usage_limit" && limit?.resetsAt != null && limit.resetsAt <= now;
  const offer = recoveryOffer(kind, { asks: asks.length, limitReset, canResend: !!onResend, canSendContinue: !!onSendContinue, canSignIn: !!onSignIn });
  // Only a request to answer: the request's own card says it all, with stopping in its action bar.
  if (!kind && asks.length) {
    const stop = <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={onStop}>Stop session</Button>;
    return <section aria-label="Session recovery" role="status" className={placement === "composer"
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
  return <section aria-label="Session recovery" role="status" className={placement === "composer"
    ? "mx-auto mb-2 max-h-[50vh] w-[calc(100%-2rem)] max-w-3xl shrink-0 overflow-auto rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs"
    : "max-h-[50vh] shrink-0 overflow-auto border-b border-warning/30 bg-warning/10 p-3 text-xs"}>
    <p className="font-medium">{offer.title}</p>
    <p className="mt-1">{offer.message}</p>
    {reset && <p className="mt-1 text-muted-foreground" data-testid="usage-limit-reset">{reset}</p>}
    {asks.map(ask => <div key={ask.requestId} className="mt-2">{ask.kind === "permission"
      ? <PermissionCard ask={ask} busy={busy || answering} blockedReason={answerBlockedReason} showDetail={askDetail} onAnswer={option => onPermission(ask.requestId, option)} />
      : <QuestionCard ask={ask} busy={busy || answering} blockedReason={answerBlockedReason} onAnswer={answers => onQuestions(ask.requestId, answers)} />}</div>)}
    <div className="mt-2 flex flex-wrap gap-2">
      {offer.signIn && <Button size="sm" disabled={busy} onClick={onSignIn}>Sign in</Button>}
      {offer.resend && <Button size="sm" disabled={busy} onClick={onResend}>Resend last prompt</Button>}
      {offer.retry && <Button size="sm" variant={kind === "signed_out" ? "outline" : undefined} disabled={busy} onClick={() => onRetry()}>{offer.retry}</Button>}
      {offer.sendContinue && <Button size="sm" variant="outline" disabled={busy} title={'Send "continue" to the agent in this conversation'} onClick={onSendContinue}>Continue here</Button>}
      {offer.chooseModel && <select onFocus={onOpenModels} onPointerDown={onOpenModels} aria-label="Choose another model" disabled={busy} value="" onChange={e => onRetry(e.target.value)} className="rounded border border-hairline bg-background px-2">
        <option value="" disabled>Choose another model</option>
        {models.map(model => <option key={model.id} value={model.id}>{modelOptionText(model, models)}</option>)}
      </select>}
      <Button size="sm" variant="outline" disabled={busy} onClick={onStop}>Stop session</Button>
      {offer.continueInNewSession && <Button size="sm" variant="ghost" disabled={busy} onClick={onContinue}>Continue in new session</Button>}
    </div>
  </section>;
}
