/**
 * Codex goals (PRO-380): what follows `/goal` in a message that is a goal
 * command, trimmed; null for any other message. `""` is a bare `/goal`,
 * which says nothing to set.
 */
export function goalCommand(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

/** Shared composer/held-edit policy, including provider-defined commands and attachments. */
export function goalCommandProblem(text: string, harness: string, hasAttachments = false, commands: readonly { name: string }[] = []): "unsupported" | "empty" | null {
  const goal = goalCommand(text);
  if (goal === null || (harness !== "codex" && commands.some(command => command.name === "goal"))) return null;
  if (harness !== "codex") return "unsupported";
  return !goal && !hasAttachments ? "empty" : null;
}
