import { useEffect, useState } from "react";
import { CircleAlert, Loader2, Send } from "@/icons";
import { Button } from "@/components/ui/button";
import { QueuedCard } from "@/components/chat/TurnBlock";
import { inputRefusalText } from "@/lib/cloudCollab";
import type { OutboxEntry } from "@/lib/cloudAgentApi";
import {
  nextGraceEnd,
  pendingCloudMessages,
  trackPending,
  waitingLine,
  type PendingCloudMessage,
  type PendingTrack,
  type WorkspaceStatus,
} from "@/lib/cloudPendingMessages";
import type { AgentEvent } from "@/types/events";

const STATE_TEXT: Record<string, string> = {
  unsent: "Not sent yet — will retry",
  queued: "Queued for the workspace",
  leased: "Delivering to the agent",
  applied: "Delivered",
  rejected: "Not delivered",
  cancelled: "Cancelled",
  "outcome-unknown": "May not have been sent",
};

/** A command's state, in words; a refusal because of sharing says whose turn it is. */
export function outboxStateText(entry: OutboxEntry, nameOf: (userId: string | null | undefined) => string): string {
  if (entry.state === "rejected" && entry.category === "lease-held") {
    const holder = entry.receipt?.holderId;
    return `${typeof holder === "string" ? nameOf(holder) : "Someone else"} is driving — your message was not sent`;
  }
  if (entry.state === "rejected" && entry.category === "access-revoked") return "Not sent: your access changed";
  // The runtime could not write its record of the command (a full disk, most often), so it did not touch the agent.
  if (entry.state === "rejected" && entry.category === "receipt-store-failed") return "Not sent: the workspace could not record it (its disk may be full)";
  const refused = entry.state === "rejected" ? inputRefusalText(entry.category, entry.receipt) : null;
  if (refused) return refused;
  const text = STATE_TEXT[entry.state] ?? entry.state;
  return entry.state === "rejected" && entry.category ? `${text} (${entry.category})` : text;
}

/**
 * What this window has seen of each message on its way, by tab, then by
 * command id: a tab's view coming back (another tab chosen meanwhile) keeps
 * following what it followed, and each tab lets go of its own messages once
 * neither the mailbox nor the runtime lists them.
 */
const tracksByTab = new Map<string, Map<string, PendingTrack>>();

/** The cloud messages to draw as Queued cards for a tab, followed until the conversation has each (#1291). */
export function usePendingCloudMessages(
  /** The tab, by a key unique across workspaces. */
  tabKey: string,
  entries: readonly OutboxEntry[],
  followUps: readonly { clientCommandId: string; text: string; actorId?: string | null }[],
  events: readonly AgentEvent[],
  /** The tab's history is read: only then is its newest event the one a message on its way comes after. */
  historyRead: boolean,
): PendingCloudMessage[] {
  const now = Date.now();
  let tracks = tracksByTab.get(tabKey);
  if (!tracks) tracksByTab.set(tabKey, (tracks = new Map()));
  // Idempotent: a message is noted once, when first seen on its way, and once when first seen typed.
  // Until the history is read nothing is noted: what waits is drawn, and none of it is taken for delivered.
  if (historyRead) trackPending(tracks, entries, followUps, events.at(-1)?.seq ?? 0, now);
  const messages = pendingCloudMessages(entries, followUps, events, tracks, now);
  // A typed message whose event never comes goes when its grace runs out: look again then.
  const [, setTick] = useState(0);
  const next = nextGraceEnd(messages, tracks);
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(0, next - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [next]);
  return messages;
}

/** A refusal sending again cannot change: what this person may send, or their access. */
function refusedForGood(entry: OutboxEntry): boolean {
  return entry.state === "rejected" && (entry.category === "access-revoked" || inputRefusalText(entry.category, entry.receipt) !== null);
}

/**
 * Messages on their way to a cloud tab's agent, as the Queued cards a local
 * session draws, at the end of the transcript: each with one line under it
 * that follows the workspace, or says why it was not delivered.
 */
export function CloudPendingMessages({
  messages,
  workspace,
  nameOf,
  onSendAgain,
  onSendNow,
}: {
  messages: readonly PendingCloudMessage[];
  workspace: WorkspaceStatus;
  nameOf: (userId: string | null | undefined) => string;
  onSendAgain?: (entry: OutboxEntry) => void;
  /** Interrupt the running turn so the runtime's held follow-ups go now; absent where the runtime cannot. */
  onSendNow?: () => void;
}) {
  if (!messages.length) return null;
  return (
    <div data-testid="cloud-pending-messages">
      {messages.map((message) => {
        const failed = message.phase === "failed" && message.entry;
        const line = failed ? outboxStateText(message.entry!, nameOf) : waitingLine(message, workspace);
        const moving = !failed && line.endsWith("…");
        return (
          <QueuedCard
            key={message.id}
            label={failed ? null : message.kind === "steer" ? "Steer" : "Queued"}
            author={message.actorId ? { userId: message.actorId, displayName: nameOf(message.actorId) } : null}
            text={message.text}
            files={message.images ? <span className="text-xs">{message.images === 1 ? "1 image" : `${message.images} images`}</span> : null}
            onSendNow={message.phase === "held" ? onSendNow : undefined}
            data-cloud-command={message.id}
            data-phase={message.phase}
            data-state={message.entry?.state}
          >
            {failed ? (
              <div className={"mt-2 flex flex-wrap items-center gap-2 text-xs text-warning"} role="status" data-testid="queued-status">
                <CircleAlert className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{line}</span>
                {onSendAgain && !refusedForGood(message.entry!) && (
                  <Button size="xs" variant="outline" className="shrink-0" onClick={() => onSendAgain(message.entry!)}>
                    <Send /> Send again
                  </Button>
                )}
              </div>
            ) : (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-faint" role="status" data-testid="queued-status">
                {moving && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
                <span className="min-w-0 break-words">{line}</span>
              </p>
            )}
          </QueuedCard>
        );
      })}
    </div>
  );
}
