import * as Crypto from "expo-crypto";

/**
 * The id a draft is sent under (#675). The phone learns that a message
 * arrived only from the Mac's reply. When the connection drops first,
 * sending the same draft again under the same id lets the Mac answer from
 * its first reply instead of giving the agent the prompt, or the worktree the
 * note, twice. Anything that changes what would be sent (where it goes, its
 * text, its attachments) is another message, under another id.
 *
 * `draft` is `draftContent` of what the id was made for. An id is retired
 * once a send under it succeeds: the same text sent after that is meant as a
 * second message.
 */
export interface DraftId { id: string; draft: string }

/** What a send would carry, as one comparable string. */
export function draftContent(target: "agent" | "note", text: string, attachmentIds: readonly string[]): string {
  return JSON.stringify([target, text, attachmentIds]);
}

/** The id to send `draft` under: the one it went under before, or a new one. */
export function draftIdFor(previous: DraftId | null, draft: string): DraftId {
  return previous?.draft === draft ? previous : { id: Crypto.randomUUID(), draft };
}

/** A saved id, or null for anything else. */
export function readDraftId(value: string | null): DraftId | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DraftId> | null;
    if (typeof parsed?.id === "string" && parsed.id && typeof parsed.draft === "string") return { id: parsed.id, draft: parsed.draft };
  } catch {
    // Not one this phone saved.
  }
  return null;
}
