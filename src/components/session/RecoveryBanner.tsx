import type { RecoveryKind } from "@/types/events";
import { RECOVERY_MESSAGES } from "@/lib/recovery";
import type { PendingAsk } from "@/lib/transcript";
import { PermissionCard, QuestionCard } from "@/components/chat/AskCards";
import { Button } from "@/components/ui/button";
import type { ModelInfo } from "@/lib/api";

export function RecoveryBanner({ kind, waiting, asks, busy, answering = false, models, onPermission, onQuestions, onRetry, onStop, onContinue }: {
  kind: RecoveryKind | null;
  waiting: boolean;
  asks: PendingAsk[];
  busy: boolean;
  answering?: boolean;
  models: ModelInfo[];
  onPermission: (id: string, option: string) => void;
  onQuestions: (id: string, answers: Record<string, string>) => void;
  onRetry: (model?: string) => void;
  onStop: () => void;
  onContinue: () => void;
}) {
  if (!kind && !waiting) return null;
  return <section aria-label="Session recovery" role="status" className="max-h-[50vh] shrink-0 overflow-auto border-b border-warning/30 bg-warning/10 p-3 text-xs">
    <p className="font-medium">{asks.length ? "Waiting for input" : kind ? "Needs attention" : "Waiting for input"}</p>
    <p className="mt-1">{kind ? RECOVERY_MESSAGES[kind] : asks.length ? "Review the pending request to continue." : "Check the terminal for a pending decision, or stop the session."}</p>
    {asks.map(ask => <div key={ask.requestId} className="mt-2">{ask.kind === "permission"
      ? <PermissionCard ask={ask} busy={busy || answering} onAnswer={option => onPermission(ask.requestId, option)} />
      : <QuestionCard ask={ask} busy={busy || answering} onAnswer={answers => onQuestions(ask.requestId, answers)} />}</div>)}
    <div className="mt-2 flex flex-wrap gap-2">
      {kind && kind !== "permission_expired" && !asks.length && <Button size="sm" disabled={busy} onClick={() => onRetry()}>Retry safely</Button>}
      {kind === "capacity" && !asks.length && <select aria-label="Choose another model" disabled={busy} value="" onChange={e => onRetry(e.target.value)} className="rounded border border-hairline bg-background px-2">
        <option value="" disabled>Choose another model</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select>}
      <Button size="sm" variant="outline" disabled={busy} onClick={onStop}>Stop session</Button>
      {kind && <Button size="sm" variant="ghost" disabled={busy} onClick={onContinue}>Continue in new session</Button>}
    </div>
  </section>;
}
