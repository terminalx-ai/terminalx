import { useRef } from "react";
import { ConversationView } from "@/lib/transcript";
import type { TabLog } from "@/lib/agentEvents";

/**
 * One conversation of a tab's log and its transcript, built on as the log
 * grows rather than built again for every event (#727). The log's own
 * array is appended to in place; a history read that merges into it replaces
 * it, and the conversation is read again from its start then.
 *
 * `conversation` `undefined`: the whole log, as `buildTranscript(log.events)`
 * reads it (a cloud tab's).
 */
export function useConversationView(log: TabLog, conversation: string | null | undefined): ConversationView {
  const view = useRef<ConversationView | null>(null);
  const known = log.compactionContinuityKnown ?? false;
  const whole = conversation === undefined;
  const current = view.current;
  if (!current || current.whole !== whole || current.conversation !== (conversation ?? null) || current.compactionContinuityKnown !== known) {
    view.current = new ConversationView(conversation ?? null, known, whole);
  }
  return view.current!.update(log.events);
}
