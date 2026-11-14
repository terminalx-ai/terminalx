import type { ImageInput } from "@/lib/api";
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

export function followUpRoute(setting: "now" | "hold", alternate: boolean): "now" | "hold" | "interrupt" {
  return alternate ? (setting === "hold" ? "interrupt" : "hold") : setting;
}
