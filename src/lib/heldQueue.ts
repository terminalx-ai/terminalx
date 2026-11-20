import type { ImageInput } from "@/lib/api";
import type { HeldFollowUpInfo } from "@terminalx/portable/workspace";
import type { AgentEvent, FileRef, HeldQueue } from "@/types/events";

export type HeldQueueChange =
  /** `files`: attachments already stored for the session (PRO-290); they go with the follow-up when it is sent. */
  | { type: "enqueue"; text: string; images: ImageInput[]; files?: FileRef[]; sendNow?: boolean }
  | { type: "edit"; id: string; text: string }
  | { type: "delete"; id: string }
  | { type: "move"; id: string; beforeId: string | null }
  | { type: "pause"; paused: boolean }
  | { type: "sendNow"; id: string };

const EMPTY: HeldQueue = { items: [], paused: false, sending: null, next: null, error: null };

/** Runtime snapshots are authoritative; a claimed delivery's user message
 * removes it even if the runtime exited before its final queue snapshot. */
export function heldQueueFrom(events: readonly AgentEvent[]): HeldQueue {
  let queue = EMPTY;
  for (const { payload, subagent } of events) {
    if (subagent) continue;
    if (payload.type === "held_queue") queue = payload.queue;
    else if (payload.type === "user_message" && queue.items.some(item => item.id === queue.sending && item.text === payload.text && item.images.length === (payload.images?.length ?? 0) && (item.files?.length ?? 0) === (payload.files?.length ?? 0))) {
      queue = { ...queue, items: queue.items.filter(item => item.id !== queue.sending), sending: null, next: null };
    }
  }
  return queue;
}

/**
 * The follow-ups a cloud or machine tab's runtime holds (#1328), as the held
 * queue a local tab keeps, by the id of the command that sent each. Their
 * images and files stay on the runtime: only their names are shown here.
 * The runtime sends them one after each turn; nothing pauses them.
 */
export function heldQueueFromFollowUps(followUps: readonly HeldFollowUpInfo[]): HeldQueue {
  if (!followUps.length) return EMPTY;
  return {
    items: followUps.map((followUp) => ({
      id: followUp.clientCommandId,
      text: followUp.text,
      images: Array.from({ length: followUp.images ?? 0 }, () => ({ url: "", name: "Image" })),
      ...(followUp.files?.length ? { files: followUp.files.map((name) => ({ path: "", name })) } : {}),
    })),
    paused: false,
    sending: null,
    next: null,
    error: null,
  };
}

export function followUpRoute(setting: "now" | "hold", alternate: boolean): "now" | "hold" | "interrupt" {
  return alternate ? (setting === "hold" ? "interrupt" : "hold") : setting;
}
