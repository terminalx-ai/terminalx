/**
 * Codex goals (PRO-380): what follows `/goal` in a message that is a goal
 * command, trimmed; null for any other message. `""` is a bare `/goal`,
 * which says nothing to set.
 */
export function goalCommand(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}
